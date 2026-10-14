// Day-end reconciliation. Once a day (and on demand) the system checks that what it believes about
// stock, bookings and allocations is consistent, and lists every difference for a person to resolve.
// It reports; it never corrects data on its own.

import { alarmStmts } from "./alarms";
import { recordStockPositions } from "./analytics";
import type { Ctx } from "../env";
import { all, first, run, stmt } from "../lib/db";
import { addDays, iso, localDayBounds, localParts, newId, safeJson } from "../lib/util";
import { DEFAULT_TEMPLATES } from "../whatsapp/templates";
import { formatDate } from "./allocation";
import { dataStatus } from "./data-status";
import { STOCK_ISSUES } from "../dms/reports";
import { queueKey, waitingQueues, type Waiting } from "./queue";
import { queueCompare } from "./rules";
import { windowSchedule } from "./timers";

const STATUS_WORDS: Record<string, string> = {
  DRAFT: "a draft", SUBMITTED: "awaiting approval", APPROVED: "waiting for a car", ALLOCATED: "allocated", INVOICED: "invoiced", DELIVERED: "delivered",
  CANCELLED: "cancelled", REJECTED: "rejected", IN_TRANSIT: "in transit", RECEIVED: "at the dealership", REMOVED: "removed from stock",
};
const word = (status: string) => STATUS_WORDS[status] ?? status.toLowerCase();
const eventTitle = (key: string) => DEFAULT_TEMPLATES.find((t) => t.event_key === key)?.title ?? key;

type Severity = "HIGH" | "MEDIUM" | "LOW";
interface Item {
  category: string;
  severity: Severity;
  outlet_id?: string | null;
  entity_type?: string;
  entity_id?: string;
  message: string;
  detail?: unknown;
}

export const RECON_CATEGORIES: Record<string, string> = {
  STOCK_MOVEMENT: "Stock count does not follow from the day's movements",
  BYPASS: "Car billed to a different booking than the one it was allocated to",
  OUTSIDE_ALLOCATION: "Car billed in the DMS without a system allocation",
  ALLOCATION_INTEGRITY: "Allocation and booking or car status disagree",
  QUEUE_ORDER: "A later booking holds a car while an earlier one waits",
  UNMATCHED_STOCK: "Free car and waiting booking not matched",
  STALE_DATA: "DMS files not updated",
  CAR_LEFT_STOCK: "Reserved car no longer in the stock report",
  CANCELLED_STILL_ALLOTTED: "DMS still shows a car allotted to a cancelled booking",
  OUT_OF_TURN: "Car given ahead of an earlier booking without approval",
  PAYMENT_UNVERIFIED: "Payment reported but not verified by Finance",
  NOT_IN_BOOKING_SHEET: "Cars allotted in the DMS to orders that are in no booking sheet loaded",
  DMS_DATA: "Stock report rows whose own data disagree",
  COLOUR_NAMES: "Colour named differently in the booking sheet and the stock report",
  TRANSIT_OVERDUE: "Car in transit past its expected arrival",
  WINDOW_OVERDUE: "Payment window passed without release",
  TRANSFER_PENDING: "Allocated car still at another outlet",
  DELIVERY_OVERDUE: "Booking past its committed delivery date",
  APPROVAL_PENDING: "Approval waiting longer than the agreed time",
  MESSAGE_FAILED: "WhatsApp message failed or not sent",
  BACKDATED_BOOKING: "Booking date earlier than the day it was entered",
  RULES_CHANGED: "Allocation rules changed",
  NOT_RECOGNISED: "Model Description not in a known pattern",
  UPLOAD_ERRORS: "Rows reported in today's file loads",
};

export interface ReconSummary {
  business_date: string;
  stock: { outlet_id: string; outlet: string; in_transit: number; in_yard_free: number; in_yard_allocated: number; blocked: number; opening: number; added: number; left: number; closing: number; expected_closing: number }[];
  bookings: { waiting: number; on_hold: number; allocated: number; awaiting_approval: number; invoiced_today: number; delivered_today: number; cancelled_today: number };
  day: { allocations: number; releases: number; received: number; reminders: number; escalations: number; exceptions_decided: number; messages_sent: number; messages_failed: number; uploads: number };
  items: { total: number; high: number; medium: number; low: number; by_category: Record<string, number> };
}

/** Builds the reconciliation for today (the dealership's local date) and stores it. */
export async function runReconciliation(ctx: Ctx, trigger: string): Promise<{ run_id: string; summary: ReconSummary }> {
  const tz = ctx.tenant.timezone;
  const date = localParts(ctx.now, tz).date;
  const { start, end } = localDayBounds(date, tz);
  const today = date;
  const T = ctx.tenantId;
  const items: Item[] = [];
  const outlets = await all<{ id: string; name: string }>(ctx.db, `SELECT id, name FROM outlets WHERE tenant_id = ? ORDER BY name`, T);
  const outletName = new Map(outlets.map((o) => [o.id, o.name]));

  // 1. Stock position per outlet, and whether closing stock follows from opening stock and the day's movements.
  const position = await all<{ outlet_id: string; in_transit: number; in_yard_free: number; in_yard_allocated: number; blocked: number; closing: number }>(
    ctx.db,
    `SELECT v.outlet_id,
       SUM(CASE WHEN v.status = 'IN_TRANSIT' THEN 1 ELSE 0 END) AS in_transit,
       SUM(CASE WHEN v.status = 'RECEIVED' AND a.id IS NULL THEN 1 ELSE 0 END) AS in_yard_free,
       SUM(CASE WHEN v.status = 'RECEIVED' AND a.id IS NOT NULL THEN 1 ELSE 0 END) AS in_yard_allocated,
       SUM(v.is_blocked) AS blocked, COUNT(*) AS closing
     FROM vehicles v LEFT JOIN allocations a ON a.vehicle_id = v.id AND a.status = 'ACTIVE'
     WHERE v.tenant_id = ? AND v.status IN ('IN_TRANSIT','RECEIVED') GROUP BY v.outlet_id`,
    T,
  );
  // Opening stock is the closing stock of the last run of an earlier day, so the movements counted are
  // those since that run was taken (a car added after last night's run belongs to today's movements).
  const prev = await first<{ summary_json: string; started_at: string }>(ctx.db, `SELECT summary_json, started_at FROM recon_runs WHERE tenant_id = ? AND business_date < ? AND finished_at IS NOT NULL ORDER BY business_date DESC, started_at DESC LIMIT 1`, T, date);
  const since = prev ? prev.started_at : start;
  const allEvents = await all<{ vehicle_id: string; type: string; from_status: string | null; to_status: string | null; detail_json: string; outlet_id: string; at: string }>(
    ctx.db,
    `SELECT e.vehicle_id, e.type, e.from_status, e.to_status, e.detail_json, e.at, v.outlet_id FROM vehicle_events e JOIN vehicles v ON v.id = e.vehicle_id
     WHERE e.tenant_id = ? AND e.at >= ? AND e.at < ? ORDER BY e.at`,
    T, since < start ? since : start, end,
  );
  const events = allEvents.filter((e) => e.at >= start); // today's
  const live = (s: string | null) => s === "IN_TRANSIT" || s === "RECEIVED";
  const added = new Map<string, number>(), left = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const e of allEvents) {
    if (prev ? e.at <= since : e.at < since) continue;
    const d = safeJson<Record<string, any>>(e.detail_json, {});
    // Stock here is cars in transit or in the yard. A car first seen already invoiced never entered it; a car the DMS lists again re-enters it.
    if (e.type === "TRANSFERRED") { bump(left, d.from_outlet_id); bump(added, d.to_outlet_id); }
    else if (!live(e.from_status) && live(e.to_status)) bump(added, d.outlet_id ?? e.outlet_id);
    else if (live(e.from_status) && !live(e.to_status)) bump(left, e.outlet_id);
  }
  const received = events.filter((e) => e.type === "RECEIVED").length;
  const prevClosing = new Map((safeJson<ReconSummary | null>(prev?.summary_json, null)?.stock ?? []).map((s) => [s.outlet_id, s.closing]));
  const stock = outlets.map((o) => {
    const p = position.find((x) => x.outlet_id === o.id);
    const closing = p?.closing ?? 0;
    const a = added.get(o.id) ?? 0, l = left.get(o.id) ?? 0;
    const opening = prevClosing.has(o.id) ? prevClosing.get(o.id)! : closing - a + l;
    const expected = opening + a - l;
    if (expected !== closing) items.push({ category: "STOCK_MOVEMENT", severity: "HIGH", outlet_id: o.id, message: `${o.name}: opening ${opening} + ${a} added - ${l} left should give ${expected}, but the system holds ${closing}.`, detail: { opening, added: a, left: l, closing } });
    return { outlet_id: o.id, outlet: o.name, in_transit: p?.in_transit ?? 0, in_yard_free: p?.in_yard_free ?? 0, in_yard_allocated: p?.in_yard_allocated ?? 0, blocked: p?.blocked ?? 0, opening, added: a, left: l, closing, expected_closing: expected };
  });

  // 2. Allocation bypass and billing outside the system, detected when the DMS data came in today.
  for (const a of await all<{ action: string; entity_id: string; detail_json: string }>(ctx.db, `SELECT action, entity_id, detail_json FROM audit_log WHERE tenant_id = ? AND at >= ? AND at < ? AND action IN ('BYPASS_DETECTED','INVOICED_OUTSIDE_ALLOCATION')`, T, start, end)) {
    const d = safeJson<Record<string, any>>(a.detail_json, {});
    if (a.action === "BYPASS_DETECTED") items.push({ category: "BYPASS", severity: "HIGH", entity_type: "vehicle", entity_id: a.entity_id, message: `Chassis ${d.vin} was reserved for booking ${d.allocated_booking_no} but the DMS shows it ${d.stock_type === "ALLOTED" ? "allotted" : "invoiced"} to ${d.dms_booking_no ?? d.invoiced_booking_no}.`, detail: d });
    else items.push({ category: "OUTSIDE_ALLOCATION", severity: "MEDIUM", entity_type: "booking", entity_id: a.entity_id, message: `Chassis ${d.vin} was invoiced in the DMS to a booking the system had not allocated it to.`, detail: d });
  }

  // 3. Allocation integrity.
  for (const r of await all<{ id: string; booking_no: string; vin: string; b_status: string; v_status: string; outlet_id: string; booking_id: string }>(
    ctx.db,
    `SELECT a.id, b.booking_no, v.vin, b.status AS b_status, v.status AS v_status, b.outlet_id, b.id AS booking_id FROM allocations a JOIN bookings b ON b.id = a.booking_id JOIN vehicles v ON v.id = a.vehicle_id
     WHERE a.tenant_id = ? AND a.status = 'ACTIVE' AND NOT (
       (b.status = 'ALLOCATED' AND v.status IN ('IN_TRANSIT','RECEIVED')) OR (b.status = 'INVOICED' AND v.status = 'INVOICED'))`,
    T,
  )) {
    // A booking the booking sheet shows invoiced whose car the stock report does not yet show invoiced is what the gap between the two files looks like.
    const between = r.b_status === "INVOICED" && ["IN_TRANSIT", "RECEIVED"].includes(r.v_status);
    items.push({ category: "ALLOCATION_INTEGRITY", severity: between ? "MEDIUM" : "HIGH", outlet_id: r.outlet_id, entity_type: "booking", entity_id: r.booking_id, message: between ? `Booking ${r.booking_no} is invoiced in the booking sheet, but the stock report does not yet show its reserved car ${r.vin} as invoiced. Load the latest stock report.` : `Booking ${r.booking_no} is ${word(r.b_status)} but its allocated car ${r.vin} is ${word(r.v_status)}.` });
  }
  for (const r of await all<{ id: string; booking_no: string; outlet_id: string }>(ctx.db, `SELECT b.id, b.booking_no, b.outlet_id FROM bookings b WHERE b.tenant_id = ? AND b.status = 'ALLOCATED' AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.booking_id = b.id AND a.status = 'ACTIVE')`, T))
    items.push({ category: "ALLOCATION_INTEGRITY", severity: "HIGH", outlet_id: r.outlet_id, entity_type: "booking", entity_id: r.id, message: `Booking ${r.booking_no} is marked allocated but holds no car.` });
  for (const r of await all<{ id: string; booking_no: string; vin: string; outlet_id: string; booking_id: string }>(ctx.db, `SELECT a.id, b.booking_no, v.vin, b.outlet_id, b.id AS booking_id FROM allocations a JOIN bookings b ON b.id = a.booking_id JOIN vehicles v ON v.id = a.vehicle_id WHERE a.tenant_id = ? AND a.status = 'ACTIVE' AND v.is_blocked = 1`, T))
    items.push({ category: "ALLOCATION_INTEGRITY", severity: "MEDIUM", outlet_id: r.outlet_id, entity_type: "booking", entity_id: r.booking_id, message: `Booking ${r.booking_no} holds car ${r.vin}, which is blocked.` });

  // 4. Queue order: a booking was given a car today by the system while a booking that the dealership's
  //    queue rules rank ahead of it (same car, same outlet) was already waiting, and nothing explains it:
  //    no approved exception, no hold lifted or car released since, no change of the rules since.
  const rulesChangedAt = (await first<{ at: string }>(ctx.db, `SELECT MAX(at) AS at FROM audit_log WHERE tenant_id = ? AND action = 'ALLOCATION_RULES_CHANGED'`, T))?.at ?? "";
  const todays = await all<Waiting & { vin: string; allocated_at: string }>(
    ctx.db,
    `SELECT j.id, j.booking_no, j.outlet_id, j.model, j.variant, j.colour, j.priority_ts, j.expected_delivery_date, j.booking_amount, j.priority_override_json, v.vin, a.allocated_at
     FROM allocations a JOIN bookings j ON j.id = a.booking_id JOIN vehicles v ON v.id = a.vehicle_id
     WHERE a.tenant_id = ? AND a.status = 'ACTIVE' AND j.status = 'ALLOCATED' AND a.exception_id IS NULL AND a.allocated_by = 'SYSTEM' AND a.allocated_at >= ? AND a.allocated_at > ?`,
    T, start, rulesChangedAt,
  );
  if (todays.length) {
    const queues = await waitingQueues(ctx);
    const ahead = queueCompare(ctx.settings);
    for (const j of todays) {
      for (const s of queues.get(queueKey(ctx.settings, j)) ?? []) {
        if (s.outlet_id !== j.outlet_id || ahead(s, j) >= 0 || (s.approved_at ?? s.created_at) >= j.allocated_at) continue;
        const explained = await first(ctx.db, `SELECT id FROM audit_log WHERE tenant_id = ? AND entity_id = ? AND action IN ('HOLD_LIFTED','ALLOCATION_RELEASED','EXCEPTION_APPROVED') AND at >= ? LIMIT 1`, T, s.id, j.allocated_at);
        if (!explained) items.push({ category: "QUEUE_ORDER", severity: "HIGH", outlet_id: s.outlet_id, entity_type: "booking", entity_id: s.id, message: `Booking ${j.booking_no} holds car ${j.vin} while booking ${s.booking_no}, which the queue rules place ahead of it, is still waiting, with no approved exception.` });
      }
    }
  }
  for (const a of await all<{ actor_name: string | null; detail_json: string }>(ctx.db, `SELECT u.name AS actor_name, l.detail_json FROM audit_log l LEFT JOIN users u ON u.id = l.actor WHERE l.tenant_id = ? AND l.action = 'ALLOCATION_RULES_CHANGED' AND l.at >= ? AND l.at < ?`, T, start, end))
    items.push({ category: "RULES_CHANGED", severity: "MEDIUM", message: `The allocation rules were changed today by ${a.actor_name ?? "an administrator"}: ${(safeJson<{ changed?: string[] }>(a.detail_json, {}).changed ?? []).join(", ") || "see the audit trail"}. The new rules apply to allocations made after the change.`, detail: safeJson(a.detail_json, {}) });

  // 5. Free cars and waiting bookings that should have been matched.
  for (const r of await all<{ model: string; variant: string; colour: string; cars: number; waiting: number }>(
    ctx.db,
    `SELECT b.model, b.variant, b.colour, COUNT(DISTINCT v.id) AS cars, COUNT(DISTINCT b.id) AS waiting
     FROM bookings b JOIN vehicles v ON v.tenant_id = b.tenant_id AND v.model = b.model AND v.variant = b.variant AND v.colour = b.colour
       AND v.status IN (${ctx.settings.allocate_in_transit ? "'IN_TRANSIT','RECEIVED'" : "'RECEIVED'"}) AND v.is_blocked = 0 ${ctx.settings.outlet_scope === "SAME_OUTLET_ONLY" ? "AND v.outlet_id = b.outlet_id" : ""}
     WHERE b.tenant_id = ? AND b.status = 'APPROVED' AND b.on_hold = 0
       AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.vehicle_id = v.id AND a.status = 'ACTIVE')
     GROUP BY b.model, b.variant, b.colour`,
    T,
  )) items.push({ category: "UNMATCHED_STOCK", severity: "MEDIUM", message: `${r.model} ${r.variant} ${r.colour}: ${r.cars} free car(s) and ${r.waiting} waiting booking(s) are not matched. Run allocation.`, detail: r });

  // 6. The DMS files: how fresh they are, and what they say that needs a person.
  const uploadsToday = await all<{ id: string; kind: string; mode: string; error_count: number; errors_json: string; filename: string | null }>(ctx.db, `SELECT id, kind, mode, error_count, errors_json, filename FROM uploads WHERE tenant_id = ? AND at >= ? AND at < ? ORDER BY at`, T, start, end);
  const files = await dataStatus(ctx);
  const liveStock = stock.reduce((n, s) => n + s.closing, 0);
  if (files.stale) {
    const part = (label: string, f: typeof files.stock) => (f ? `${label} is as on ${formatDate(f.report_date)} (${f.age_days} day(s) old)` : `${label} has not been loaded`);
    items.push({ category: "STALE_DATA", severity: "HIGH", message: `${[files.stale_files.includes("STOCK") ? part("the stock report", files.stock) : "", files.stale_files.includes("BOOKINGS") ? part("the booking sheet", files.bookings) : ""].filter(Boolean).join("; ").replace(/^./, (c) => c.toUpperCase())}. The files are expected every ${files.expected_every_days} day(s). Availability and queue positions may be out of date, and no car is re-allocated automatically until they are loaded.` });
  } else if (!files.stock && !files.bookings && !events.length && liveStock > 0) {
    items.push({ category: "STALE_DATA", severity: "MEDIUM", message: "No stock was updated today. Availability shown to the sales team may be out of date." });
  }
  for (const b of await all<{ id: string; booking_no: string; outlet_id: string; customer_name: string }>(ctx.db, `SELECT id, booking_no, outlet_id, customer_name FROM bookings WHERE tenant_id = ? AND status = 'APPROVED' AND on_hold = 1 AND hold_reason = 'CAR_LEFT_STOCK'`, T))
    items.push({ category: "CAR_LEFT_STOCK", severity: "HIGH", outlet_id: b.outlet_id, entity_type: "booking", entity_id: b.id, message: `Booking ${b.booking_no} (${b.customer_name}) held a car that is no longer in the stock report, and the booking is not invoiced. It is on hold until someone establishes what happened to the car.` });
  for (const v of await all<{ id: string; vin: string; outlet_id: string; booking_no: string }>(ctx.db, `SELECT v.id, v.vin, v.outlet_id, b.booking_no FROM vehicles v JOIN bookings b ON b.tenant_id = v.tenant_id AND b.booking_no = v.dms_booking_no WHERE v.tenant_id = ? AND v.status IN ('IN_TRANSIT','RECEIVED','INVOICED') AND b.status = 'CANCELLED'`, T))
    items.push({ category: "CANCELLED_STILL_ALLOTTED", severity: "HIGH", outlet_id: v.outlet_id, entity_type: "vehicle", entity_id: v.id, message: `The stock report shows chassis ${v.vin} allotted to booking ${v.booking_no}, which is cancelled. The system treats the car as free; remove the allotment in the DMS.` });
  for (const a of await all<{ booking_id: string; booking_no: string; outlet_id: string; vin: string; bypassed: string | null; bypassed_count: number; source: string }>(
    ctx.db,
    `SELECT b.id AS booking_id, b.booking_no, b.outlet_id, v.vin, x.booking_no AS bypassed, a.bypassed_count, a.source FROM allocations a JOIN bookings b ON b.id = a.booking_id JOIN vehicles v ON v.id = a.vehicle_id LEFT JOIN bookings x ON x.id = a.bypassed_booking_id
     WHERE a.tenant_id = ? AND a.out_of_turn = 1 AND a.exception_id IS NULL AND json_extract(a.rule_trace_json, '$.priority_exception_id') IS NULL AND a.reviewed_at IS NULL AND a.allocated_at >= ?`,
    T, new Date(new Date(start).getTime() - 30 * 86_400_000).toISOString(),
  )) items.push({ category: "OUT_OF_TURN", severity: "MEDIUM", outlet_id: a.outlet_id, entity_type: "booking", entity_id: a.booking_id, message: `Chassis ${a.vin} went to booking ${a.booking_no} ${a.source === "DMS" ? "in the DMS " : ""}while ${a.bypassed ? `booking ${a.bypassed}` : "an earlier booking"}${a.bypassed_count > 1 ? ` and ${a.bypassed_count - 1} more` : ""} was waiting for the same car, with no approval on record. To be reviewed by the Dealer Principal or the Business Head.` });
  const verifyCut = new Date(ctx.now.getTime() - ctx.settings.payment_verify_hours * 3_600_000).toISOString();
  for (const b of await all<{ id: string; booking_no: string; outlet_id: string; payment_ref: string | null }>(ctx.db, `SELECT id, booking_no, outlet_id, payment_ref FROM bookings WHERE tenant_id = ? AND status = 'ALLOCATED' AND payment_reported_at IS NOT NULL AND payment_received_at IS NULL AND payment_reported_at <= ?`, T, verifyCut))
    items.push({ category: "PAYMENT_UNVERIFIED", severity: "MEDIUM", outlet_id: b.outlet_id, entity_type: "booking", entity_id: b.id, message: `Booking ${b.booking_no}: a payment (reference ${b.payment_ref ?? "not given"}) was reported more than ${ctx.settings.payment_verify_hours} hours ago and Finance has not verified it.` });
  const known = await first<{ n: number }>(ctx.db, `SELECT COUNT(*) AS n FROM bookings b WHERE b.tenant_id = ? AND b.source = 'DMS_STOCK' AND EXISTS (SELECT 1 FROM allocations a WHERE a.booking_id = b.id AND a.status = 'ACTIVE')`, T);
  if (known?.n) items.push({ category: "NOT_IN_BOOKING_SHEET", severity: "LOW", message: `${known.n} car(s) are allotted in the DMS to orders that are in no booking sheet loaded so far (they may predate the sheets). Their customers' details are missing here; load a booking sheet that includes those orders.` });
  if (files.stock) {
    const last = await first<{ summary_json: string }>(ctx.db, `SELECT summary_json FROM uploads WHERE id = ? AND tenant_id = ?`, files.stock.upload_id, T);
    const sum = safeJson<{ issues?: Record<string, number>; not_recognised?: number }>(last?.summary_json, {});
    for (const [issue, n] of Object.entries(sum.issues ?? {})) if (issue !== "description_not_recognised") items.push({ category: "DMS_DATA", severity: "LOW", message: `Stock report as on ${formatDate(files.stock.report_date)}: ${n} car(s): ${STOCK_ISSUES[issue] ?? issue}.`, detail: { issue, cars: n } });
    if (sum.not_recognised) items.push({ category: "NOT_RECOGNISED", severity: "MEDIUM", message: `${sum.not_recognised} car(s) in the stock report as on ${formatDate(files.stock.report_date)} have a Model Description the parser does not recognise. They were loaded under the DMS's own model name, with trim, transmission, fuel and drive blank; the parser needs the new pattern.` });
  }
  if (files.bookings) {
    const last = await first<{ summary_json: string }>(ctx.db, `SELECT summary_json FROM uploads WHERE id = ? AND tenant_id = ?`, files.bookings.upload_id, T);
    const n = safeJson<{ not_recognised?: number }>(last?.summary_json, {}).not_recognised;
    if (n) items.push({ category: "NOT_RECOGNISED", severity: "MEDIUM", message: `${n} booking(s) in the latest booking sheet have a Model Description the parser does not recognise. They were loaded under the DMS's own model name; the parser needs the new pattern.` });
  }
  const colourGaps = await all<{ model: string; booking_says: string; stock_says: string; n: number }>(
    ctx.db,
    `SELECT b.model, b.dms_colour AS booking_says, v.dms_colour AS stock_says, COUNT(*) AS n FROM allocations a JOIN bookings b ON b.id = a.booking_id JOIN vehicles v ON v.id = a.vehicle_id
     WHERE a.tenant_id = ? AND a.source = 'DMS' AND a.status = 'ACTIVE' AND b.dms_colour IS NOT NULL AND v.dms_colour IS NOT NULL AND b.dms_colour <> v.dms_colour AND v.paint_alias = ''
       AND NOT EXISTS (SELECT 1 FROM vehicle_aliases x WHERE x.tenant_id = a.tenant_id AND x.kind = 'COLOUR' AND x.model = b.model AND x.colour IS NOT NULL AND (UPPER(x.alias) = b.dms_colour OR UPPER(x.alias) = v.dms_colour))
     GROUP BY 1, 2, 3 ORDER BY n DESC LIMIT 20`,
    T,
  );
  for (const g of colourGaps) items.push({ category: "COLOUR_NAMES", severity: "LOW", message: `${g.model}: the DMS has allotted ${g.n} car(s) the stock report calls ${g.stock_says} to bookings the booking sheet calls ${g.booking_says}. If these are the same colour, say so on the Vehicle master screen so waiting bookings can be matched to those cars.`, detail: g });
  for (const u of uploadsToday) if (u.error_count > 0) items.push({ category: "UPLOAD_ERRORS", severity: "LOW", entity_type: "upload", entity_id: u.id, message: `${u.error_count} row(s) were rejected in the ${u.kind.toLowerCase()} upload${u.filename ? ` "${u.filename}"` : ""}.` });

  // 7. Things that are late.
  for (const v of await all<{ id: string; vin: string; outlet_id: string; expected_arrival_date: string; model: string; variant: string; colour: string }>(ctx.db, `SELECT id, vin, outlet_id, expected_arrival_date, model, variant, colour FROM vehicles WHERE tenant_id = ? AND status = 'IN_TRANSIT' AND expected_arrival_date IS NOT NULL AND expected_arrival_date < ?`, T, today))
    items.push({ category: "TRANSIT_OVERDUE", severity: "MEDIUM", outlet_id: v.outlet_id, entity_type: "vehicle", entity_id: v.id, message: `${v.model} ${v.variant} ${v.colour} (${v.vin}) was expected on ${formatDate(v.expected_arrival_date)} and has not been received.` });
  for (const w of await all<{ id: string; booking_id: string; booking_no: string; outlet_id: string; clock_started_at: string; window_extension_days: number; vin: string }>(
    ctx.db,
    `SELECT a.id, a.booking_id, b.booking_no, b.outlet_id, a.clock_started_at, a.window_extension_days, v.vin FROM allocations a JOIN bookings b ON b.id = a.booking_id JOIN vehicles v ON v.id = a.vehicle_id
     WHERE a.tenant_id = ? AND a.status = 'ACTIVE' AND a.clock_started_at IS NOT NULL AND b.status = 'ALLOCATED' AND b.payment_received_at IS NULL`,
    T,
  )) {
    const sch = windowSchedule(ctx, w.clock_started_at, w.window_extension_days);
    if (today > sch.release_on) items.push({ category: "WINDOW_OVERDUE", severity: "HIGH", outlet_id: w.outlet_id, entity_type: "booking", entity_id: w.booking_id, message: `Booking ${w.booking_no} should have released car ${w.vin} on ${formatDate(sch.release_on)}.` });
  }
  for (const r of await all<{ booking_id: string; booking_no: string; vin: string; outlet_id: string; allocated_at: string }>(ctx.db, `SELECT b.id AS booking_id, b.booking_no, v.vin, b.outlet_id, a.allocated_at FROM allocations a JOIN bookings b ON b.id = a.booking_id JOIN vehicles v ON v.id = a.vehicle_id WHERE a.tenant_id = ? AND a.status = 'ACTIVE' AND a.needs_transfer = 1 AND v.status = 'RECEIVED' AND a.allocated_at < ?`, T, new Date(new Date(end).getTime() - 2 * 86_400_000).toISOString()))
    items.push({ category: "TRANSFER_PENDING", severity: "MEDIUM", outlet_id: r.outlet_id, entity_type: "booking", entity_id: r.booking_id, message: `Car ${r.vin} allocated to booking ${r.booking_no} has not been moved to the customer's outlet.` });
  for (const b of await all<{ id: string; booking_no: string; outlet_id: string; expected_delivery_date: string; status: string }>(ctx.db, `SELECT id, booking_no, outlet_id, expected_delivery_date, status FROM bookings WHERE tenant_id = ? AND status IN ('APPROVED','ALLOCATED','INVOICED') AND expected_delivery_date IS NOT NULL AND expected_delivery_date < ?`, T, today))
    items.push({ category: "DELIVERY_OVERDUE", severity: "MEDIUM", outlet_id: b.outlet_id, entity_type: "booking", entity_id: b.id, message: `Booking ${b.booking_no} was committed for ${formatDate(b.expected_delivery_date)} and is not delivered (${word(b.status)}).` });
  const slaCut = new Date(ctx.now.getTime() - ctx.settings.approval_sla_hours * 3_600_000).toISOString();
  for (const b of await all<{ id: string; booking_no: string; outlet_id: string }>(ctx.db, `SELECT id, booking_no, outlet_id FROM bookings WHERE tenant_id = ? AND status = 'SUBMITTED' AND submitted_at < ?`, T, slaCut))
    items.push({ category: "APPROVAL_PENDING", severity: "LOW", outlet_id: b.outlet_id, entity_type: "booking", entity_id: b.id, message: `Booking ${b.booking_no} has waited more than ${ctx.settings.approval_sla_hours} hours for approval.` });
  for (const e of await all<{ id: string; type: string; booking_no: string; outlet_id: string }>(ctx.db, `SELECT e.id, e.type, b.booking_no, b.outlet_id FROM exceptions e JOIN bookings b ON b.id = e.booking_id WHERE e.tenant_id = ? AND e.status = 'PENDING' AND e.requested_at < ?`, T, slaCut))
    items.push({ category: "APPROVAL_PENDING", severity: "LOW", outlet_id: e.outlet_id, entity_type: "exception", entity_id: e.id, message: `Exception request (${e.type.replace(/_/g, " ").toLowerCase()}) on booking ${e.booking_no} has waited more than ${ctx.settings.approval_sla_hours} hours.` });
  for (const m of await all<{ id: string; to_mobile: string; event_key: string; error: string | null }>(ctx.db, `SELECT id, to_mobile, event_key, error FROM wa_messages WHERE tenant_id = ? AND status = 'FAILED' AND created_at >= ? AND created_at < ?`, T, start, end))
    items.push({ category: "MESSAGE_FAILED", severity: "LOW", entity_type: "wa_message", entity_id: m.id, message: `WhatsApp message "${eventTitle(m.event_key)}" to ${m.to_mobile} failed: ${m.error ?? "unknown error"}.` });

  for (const m of await all<{ id: string; to_mobile: string; event_key: string }>(ctx.db, `SELECT id, to_mobile, event_key FROM wa_messages WHERE tenant_id = ? AND status = 'QUEUED' AND created_at < ?`, T, new Date(ctx.now.getTime() - 2 * 3_600_000).toISOString()))
    items.push({ category: "MESSAGE_FAILED", severity: "LOW", entity_type: "wa_message", entity_id: m.id, message: `WhatsApp message "${eventTitle(m.event_key)}" to ${m.to_mobile} has been waiting to be sent for more than two hours.` });

  // 8. Bookings entered today with an earlier booking date. The booking date decides the place in the
  //    queue, so each one entered on the screen is listed; a file load is listed once with its count.
  const enteredToday = await all<{ id: string; booking_no: string; outlet_id: string; booking_date: string; created_at: string; source: string; status: string }>(ctx.db, `SELECT id, booking_no, outlet_id, booking_date, created_at, source, status FROM bookings WHERE tenant_id = ? AND created_at >= ? AND created_at < ? AND booking_date < ?`, T, start, end, new Date(new Date(start).getTime() - 86_400_000).toISOString());
  const backDays = (b: { booking_date: string; created_at: string }) => Math.round((new Date(`${localParts(new Date(b.created_at), tz).date}T00:00:00Z`).getTime() - new Date(`${localParts(new Date(b.booking_date), tz).date}T00:00:00Z`).getTime()) / 86_400_000);
  for (const b of enteredToday.filter((x) => x.source === "APP" && !["DRAFT", "CANCELLED", "REJECTED"].includes(x.status)))
    items.push({ category: "BACKDATED_BOOKING", severity: "MEDIUM", outlet_id: b.outlet_id, entity_type: "booking", entity_id: b.id, message: `Booking ${b.booking_no} was entered today with a booking date ${backDays(b)} days earlier (${formatDate(localParts(new Date(b.booking_date), tz).date)}). Check the docket and payment proof dates.` });
  // Summary counts.
  const count = async (sql: string, ...p: unknown[]) => (await first<{ n: number }>(ctx.db, sql, ...p))?.n ?? 0;
  const auditCount = (action: string) => count(`SELECT COUNT(*) AS n FROM audit_log WHERE tenant_id = ? AND action = ? AND at >= ? AND at < ?`, T, action, start, end);
  const summary: ReconSummary = {
    business_date: date,
    stock,
    bookings: {
      waiting: await count(`SELECT COUNT(*) AS n FROM bookings WHERE tenant_id = ? AND status = 'APPROVED' AND on_hold = 0`, T),
      on_hold: await count(`SELECT COUNT(*) AS n FROM bookings WHERE tenant_id = ? AND status = 'APPROVED' AND on_hold = 1`, T),
      allocated: await count(`SELECT COUNT(*) AS n FROM bookings WHERE tenant_id = ? AND status = 'ALLOCATED'`, T),
      awaiting_approval: await count(`SELECT COUNT(*) AS n FROM bookings WHERE tenant_id = ? AND status = 'SUBMITTED'`, T),
      invoiced_today: await count(`SELECT COUNT(*) AS n FROM bookings WHERE tenant_id = ? AND invoiced_at >= ? AND invoiced_at < ?`, T, start, end),
      delivered_today: await count(`SELECT COUNT(*) AS n FROM bookings WHERE tenant_id = ? AND delivered_at >= ? AND delivered_at < ?`, T, start, end),
      cancelled_today: await count(`SELECT COUNT(*) AS n FROM bookings WHERE tenant_id = ? AND cancelled_at >= ? AND cancelled_at < ?`, T, start, end),
    },
    day: {
      allocations: await auditCount("ALLOCATED"),
      releases: await auditCount("ALLOCATION_RELEASED"),
      received,
      reminders: await auditCount("PAYMENT_REMINDER_SENT"),
      escalations: await auditCount("PAYMENT_ESCALATED"),
      exceptions_decided: (await auditCount("EXCEPTION_APPROVED")) + (await auditCount("EXCEPTION_REJECTED")),
      messages_sent: await count(`SELECT COUNT(*) AS n FROM wa_messages WHERE tenant_id = ? AND status IN ('SENT','DELIVERED','READ') AND created_at >= ? AND created_at < ?`, T, start, end),
      messages_failed: await count(`SELECT COUNT(*) AS n FROM wa_messages WHERE tenant_id = ? AND status = 'FAILED' AND created_at >= ? AND created_at < ?`, T, start, end),
      uploads: uploadsToday.length,
    },
    items: { total: items.length, high: 0, medium: 0, low: 0, by_category: {} },
  };
  for (const it of items) {
    summary.items[it.severity.toLowerCase() as "high" | "medium" | "low"]++;
    summary.items.by_category[it.category] = (summary.items.by_category[it.category] ?? 0) + 1;
  }

  const runId = newId("rec");
  const at = iso(ctx.now);
  const stmts = [stmt(ctx.db, `INSERT INTO recon_runs (id, tenant_id, business_date, trigger, started_at, finished_at, summary_json) VALUES (?,?,?,?,?,?,?)`, runId, T, date, trigger, at, at, JSON.stringify(summary))];
  for (const it of items)
    stmts.push(stmt(ctx.db, `INSERT INTO recon_items (id, tenant_id, run_id, category, severity, outlet_id, entity_type, entity_id, message, detail_json) VALUES (?,?,?,?,?,?,?,?,?,?)`, newId("rci"), T, runId, it.category, it.severity, it.outlet_id ?? null, it.entity_type ?? null, it.entity_id ?? null, it.message, JSON.stringify(it.detail ?? {})));
  // High-severity findings are an alarm for management: once for a business day, however often the reconciliation is run.
  if (summary.items.high > 0) {
    const { start } = localDayBounds(date, ctx.tenant.timezone);
    if (!(await first(ctx.db, `SELECT id FROM alerts WHERE tenant_id = ? AND kind = 'RECON_HIGH' AND created_at >= ? LIMIT 1`, T, start))) {
      const counts = new Map<string, number>();
      for (const it of items) if (it.severity === "HIGH") counts.set(it.category, (counts.get(it.category) ?? 0) + 1);
      const what = [...counts].map(([c, n]) => `${RECON_CATEGORIES[c] ?? c}: ${n}`).join("; ");
      stmts.push(...(await alarmStmts(ctx, { kind: "RECON_HIGH", title: "Day-end reconciliation found high-severity differences", body: `Reconciliation for ${date}: ${summary.items.high} high-severity finding(s). ${what}. Each one needs a person to look at it and close it with a note.`, entityType: "recon_run", entityId: runId })));
    }
  }
  for (let i = 0; i < stmts.length; i += 40) await ctx.db.batch(stmts.slice(i, i + 40));
  await recordStockPositions(ctx, "DAY_END");
  void outletName;
  return { run_id: runId, summary };
}

/** Whether the scheduled day-end run is due: the local day-end time has passed and no scheduled run exists for today. */
export async function dayEndDue(ctx: Ctx): Promise<boolean> {
  const { date, time } = localParts(ctx.now, ctx.tenant.timezone);
  if (time < ctx.settings.day_end_time) return false;
  return !(await first(ctx.db, `SELECT id FROM recon_runs WHERE tenant_id = ? AND business_date = ? AND trigger = 'SCHEDULED'`, ctx.tenantId, date));
}

export async function resolveItem(ctx: Ctx, itemId: string, note: string): Promise<void> {
  if (!note?.trim()) throw new Error("A note is required to close an item");
  await run(ctx.db, `UPDATE recon_items SET status = 'RESOLVED', resolved_by = ?, resolved_at = ?, resolution_note = ? WHERE id = ? AND tenant_id = ? AND status = 'OPEN'`, ctx.actor, iso(ctx.now), note.trim(), itemId, ctx.tenantId);
}

export { addDays };
