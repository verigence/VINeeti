// The allocation engine: gives free cars to waiting bookings.
//
// A car fits a booking when both name the same vehicle-master variant and colour. Who is served first,
// which car they get and how far allocation may reach across outlets are the dealership's own rules,
// set on the Allocation rules screen (see rules.ts). This file applies them and records the result.
// The database's unique indexes guarantee one active allocation per car and per booking even if two
// requests run at the same moment.

import type { Ctx } from "../env";
import { all, alertStmt, auditStmt, first, isGuardFailure, isUniqueViolation, stmt } from "../lib/db";
import { conflict, iso, localParts, newId } from "../lib/util";
import { messageStmt } from "../whatsapp/outbox";
import { salesExecMessage } from "./staff-notify";
import type { EventKey } from "../whatsapp/templates";
import { queueKey, waitingQueues } from "./queue";
import { matchBookings, queueCompare, type Match as RuleMatch } from "./rules";

export { matchBookings };

export interface Config {
  model: string;
  variant: string;
  colour: string;
}

export interface BookingRow {
  id: string;
  booking_no: string;
  outlet_id: string;
  customer_name: string;
  customer_mobile: string;
  wa_opt_in: number;
  model: string;
  variant: string;
  colour: string;
  /** When the customer booked. The place in the queue (priority_ts) starts as this and changes only by an approved exception or a payment timeout. */
  booking_date?: string;
  priority_ts: string;
  status: string;
  on_hold: number;
  hold_until: string | null;
  sales_exec_id?: string | null;
  expected_delivery_date?: string | null;
  booking_amount?: number | null;
  priority_override_json?: string | null;
}

export interface VehicleRow {
  id: string;
  vin: string;
  outlet_id: string;
  model: string;
  variant: string;
  colour: string;
  status: string;
  is_blocked: number;
  expected_arrival_date: string | null;
  dispatch_date: string | null;
  wholesale_invoice_date: string | null;
  received_at: string | null;
  ever_allocated: number;
  /** The booking that held this car most recently, if any. */
  last_booking_id?: string | null;
}

export interface AllocationOutcome {
  allocationId: string;
  bookingId: string;
  bookingNo: string;
  vehicleId: string;
  vin: string;
  type: "IN_TRANSIT" | "FREE_STOCK" | "REALLOCATED";
  needsTransfer: boolean;
}

export function formatDate(date: string): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const [y, m, d] = date.slice(0, 10).split("-").map(Number);
  return `${d} ${months[m - 1]} ${y}`;
}

/** "XUV700 AX7 L DIESEL AT, NAPOLI BLACK". Master variant names usually begin with the model, which is then not repeated. */
export function vehicleLabel(c: Config): string {
  const key = (x: string) => x.replace(/[^A-Z0-9]/gi, "").toUpperCase();
  const car = key(c.variant).startsWith(key(c.model)) ? c.variant : `${c.model} ${c.variant}`;
  return `${car} ${c.colour}`.trim();
}

export async function dealershipLabel(ctx: Ctx, outletId: string): Promise<string> {
  let names = ctx.cache.get("outlets") as Map<string, string> | undefined;
  if (!names) {
    names = new Map((await all<{ id: string; name: string }>(ctx.db, `SELECT id, name FROM outlets WHERE tenant_id = ?`, ctx.tenantId)).map((o) => [o.id, o.name]));
    ctx.cache.set("outlets", names);
  }
  const name = names.get(outletId);
  return name ? `${ctx.tenant.name}, ${name}` : ctx.tenant.name;
}

async function waitingBookings(ctx: Ctx, cfg: Config): Promise<BookingRow[]> {
  const today = localParts(ctx.now, ctx.tenant.timezone).date;
  return all<BookingRow>(
    ctx.db,
    `SELECT b.* FROM bookings b
     WHERE b.tenant_id = ? AND b.model = ? AND b.variant = ? AND b.colour = ? AND b.status = 'APPROVED'
       AND (b.on_hold = 0 OR (b.hold_until IS NOT NULL AND b.hold_until <= ?))
       AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.booking_id = b.id AND a.status = 'ACTIVE')
     ORDER BY b.priority_ts ASC, b.booking_no ASC`,
    ctx.tenantId,
    cfg.model,
    cfg.variant,
    cfg.colour,
    today,
  );
}

const LAST_BOOKING = `(SELECT a2.booking_id FROM allocations a2 WHERE a2.vehicle_id = v.id ORDER BY a2.allocated_at DESC, a2.released_at DESC LIMIT 1) AS last_booking_id`;

async function freeVehicles(ctx: Ctx, cfg: Config): Promise<VehicleRow[]> {
  return all<VehicleRow>(
    ctx.db,
    `SELECT v.*, ${LAST_BOOKING} FROM vehicles v
     WHERE v.tenant_id = ? AND v.model = ? AND v.variant = ? AND v.colour = ? AND v.status IN (${allocatable(ctx)}) AND v.is_blocked = 0
       AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.vehicle_id = v.id AND a.status = 'ACTIVE')`,
    ctx.tenantId,
    cfg.model,
    cfg.variant,
    cfg.colour,
  );
}

/** Car statuses that may be allocated: cars in transit only if the dealership's rules say so. */
export const allocatable = (ctx: Ctx) => (ctx.settings.allocate_in_transit ? "'RECEIVED','IN_TRANSIT'" : "'RECEIVED'");

type Match = Pick<RuleMatch<BookingRow, VehicleRow>, "booking" | "vehicle" | "queuePosition" | "pass">;

/**
 * Out of turn: the bookings that were waiting for this same car and that the dealership's queue rules
 * rank ahead of this booking on what each booked with (date, commitment, amount), before any approved
 * change of priority. A named car given by an approved request passes over all of them; a booking whose
 * priority was changed passes over those it now stands ahead of.
 */
export async function bookingsPassedOver(ctx: Ctx, b: BookingRow, car: Config, manual: boolean): Promise<{ id: string; booking_no: string }[]> {
  const queue = (await waitingQueues(ctx, car)).get(queueKey(ctx.settings, { ...car, outlet_id: b.outlet_id })) ?? [];
  const rank = queueCompare(ctx.settings);
  const asBooked = <T extends { priority_ts: string; booking_date?: string; priority_override_json?: string | null }>(x: T) => ({ ...x, priority_ts: x.booking_date ?? x.priority_ts, priority_override_json: null });
  return queue.filter((w) => w.id !== b.id && rank(asBooked(w), asBooked(b)) < 0 && (manual || rank(b, w) < 0)).map((w) => ({ id: w.id, booking_no: w.booking_no }));
}

/**
 * Records one allocation. Everything that belongs to it (the allocation, the booking's new status, the
 * audit entry, the customer's message and the staff alerts) is written in a single batch, so an
 * allocation can never exist without its record and its message, whatever interrupts the request.
 * `before` and `also` let a caller put its own statements in the same batch (for example releasing the
 * booking's previous car, or marking the exception request that authorised this as approved).
 * Returns null when the car or the booking was taken by another request in the meantime.
 */
async function commitMatch(
  ctx: Ctx,
  m: Match,
  by: string,
  exceptionId: string | null,
  extra: { before?: D1PreparedStatement[]; also?: D1PreparedStatement[] } = {},
): Promise<AllocationOutcome | null> {
  const { booking: b, vehicle: v } = m;
  const id = newId("alc");
  const at = iso(ctx.now);
  // "Re-allocated" means the car was earlier promised to a different customer. A booking that gets back the
  // car it held before (for example after a hold is lifted) is told about it as ordinary stock.
  const type: AllocationOutcome["type"] = v.ever_allocated && v.last_booking_id && v.last_booking_id !== b.id ? "REALLOCATED" : v.status === "RECEIVED" ? "FREE_STOCK" : "IN_TRANSIT";
  const needsTransfer = v.outlet_id !== b.outlet_id;
  // Only an approved request (a named car, or a change of priority) can put a booking ahead of an earlier one; when it does, it is recorded.
  const manual = m.pass === "MANUAL_APPROVED_EXCEPTION";
  const moved = Boolean(b.priority_override_json) || (b.booking_date !== undefined && b.priority_ts < b.booking_date);
  const passed = manual || moved ? await bookingsPassedOver(ctx, b, v, manual) : [];
  const priorityException = passed.length && !exceptionId ? (await first<{ id: string }>(ctx.db, `SELECT id FROM exceptions WHERE tenant_id = ? AND booking_id = ? AND type = 'PRIORITY_CHANGE' AND status = 'APPROVED' ORDER BY decided_at DESC LIMIT 1`, ctx.tenantId, b.id))?.id ?? null : null;
  const trace = { rule: m.pass, queue_position: m.queuePosition, outlet_scope: ctx.settings.outlet_scope, vehicle_status: v.status, priority_ts: b.priority_ts, ...(priorityException ? { priority_exception_id: priorityException } : {}) };
  const eventKey: EventKey = type === "IN_TRANSIT" ? "ALLOC_IN_TRANSIT" : type === "FREE_STOCK" ? "ALLOC_FREE_STOCK" : "ALLOC_REALLOCATED";
  const eta = v.expected_arrival_date ? `by ${formatDate(v.expected_arrival_date)}` : `in ${ctx.settings.in_transit_eta_text}`;
  const actorCtx = { ...ctx, actor: by };
  const stmts: D1PreparedStatement[] = [
    ...(extra.before ?? []),
    // Guarded insert: only while the booking is still waiting and the car is still free. If either has
    // changed, booking_id becomes NULL, the insert fails and the whole batch is rolled back. The payment
    // clock starts here if the car is already at the dealership at this moment.
    stmt(
      ctx.db,
      `INSERT INTO allocations (id, tenant_id, booking_id, vehicle_id, type, status, needs_transfer, allocated_at, allocated_by, exception_id, clock_started_at, rule_trace_json, source, out_of_turn, bypassed_booking_id, bypassed_count)
       SELECT ?, ?,
         CASE WHEN EXISTS (SELECT 1 FROM bookings WHERE id = ? AND tenant_id = ? AND status = 'APPROVED')
               AND EXISTS (SELECT 1 FROM vehicles WHERE id = ? AND tenant_id = ? AND status IN ('RECEIVED','IN_TRANSIT') AND is_blocked = 0)
              THEN ? ELSE NULL END,
         ?, ?, 'ACTIVE', ?, ?, ?, ?,
         (SELECT CASE WHEN status = 'RECEIVED' THEN ? ELSE NULL END FROM vehicles WHERE id = ?),
         ?, ?, ?, ?, ?`,
      id, ctx.tenantId, b.id, ctx.tenantId, v.id, ctx.tenantId, b.id, v.id, type, needsTransfer ? 1 : 0, at, by, exceptionId, at, v.id, JSON.stringify(trace),
      exceptionId ? "EXCEPTION" : "SYSTEM", passed.length ? 1 : 0, passed[0]?.id ?? null, passed.length,
    ),
    stmt(ctx.db, `UPDATE bookings SET status = 'ALLOCATED', on_hold = 0, hold_reason = NULL, hold_until = NULL, updated_at = ? WHERE id = ? AND tenant_id = ?`, at, b.id, ctx.tenantId),
    stmt(ctx.db, `UPDATE vehicles SET ever_allocated = 1, updated_at = ? WHERE id = ? AND tenant_id = ?`, at, v.id, ctx.tenantId),
    auditStmt(actorCtx, "ALLOCATED", "booking", b.id, { allocation_id: id, vehicle_id: v.id, vin: v.vin, type, needs_transfer: needsTransfer, exception_id: exceptionId, ...trace }),
    await messageStmt(ctx, {
      eventKey,
      toMobile: b.customer_mobile,
      toName: b.customer_name,
      bookingId: b.id,
      optIn: Boolean(b.wa_opt_in),
      params: { customer_name: b.customer_name, vehicle: vehicleLabel(v), booking_no: b.booking_no, dealership: await dealershipLabel(ctx, b.outlet_id), eta },
    }),
  ];
  // The sales executive handling the customer is told as well.
  if (b.sales_exec_id) {
    const detail = `${vehicleLabel(v)} (${v.vin}) is allocated to booking ${b.booking_no}, ${b.customer_name}. ${v.status === "RECEIVED" ? "The car is at the dealership; the payment window has started." : `The car is in transit, expected ${eta}.`}`;
    stmts.push(alertStmt(ctx, { targetUser: b.sales_exec_id, outletId: b.outlet_id, kind: "ALLOCATED", title: "Car allocated to your booking", body: detail, entityType: "booking", entityId: b.id }), ...(await salesExecMessage(ctx, b, "Car allocated to your booking", detail)));
  }
  if (needsTransfer) {
    stmts.push(alertStmt(ctx, { targetRole: "STOCK_INCHARGE", outletId: v.outlet_id, kind: "TRANSFER_NEEDED", title: "Transfer needed", body: `${vehicleLabel(v)} (${v.vin}) is allocated to booking ${b.booking_no} at another outlet.`, entityType: "vehicle", entityId: v.id }));
  }
  stmts.push(...(extra.also ?? []));
  try {
    await ctx.db.batch(stmts);
  } catch (e) {
    if (isUniqueViolation(e) || isGuardFailure(e)) return null; // another request allocated this car or booking first
    throw e;
  }
  return { allocationId: id, bookingId: b.id, bookingNo: b.booking_no, vehicleId: v.id, vin: v.vin, type, needsTransfer };
}

/** Runs allocation for one model / variant / colour, for at most `limit` matches. */
export async function allocateConfig(ctx: Ctx, cfg: Config, limit = 100): Promise<AllocationOutcome[]> {
  if (limit <= 0) return [];
  const [bookings, vehicles] = await Promise.all([waitingBookings(ctx, cfg), freeVehicles(ctx, cfg)]);
  if (!bookings.length || !vehicles.length) return [];
  const out: AllocationOutcome[] = [];
  for (const m of matchBookings(bookings, vehicles, ctx.settings)) {
    if (out.length >= limit) break; // the scheduled sweep picks up the rest within minutes
    const done = await commitMatch(ctx, m, "SYSTEM", null);
    if (done) out.push(done);
  }
  return out;
}

/**
 * Runs allocation for every configuration that has a waiting booking and a free car that booking may be
 * given, up to `maxMatches`. Where the outlet rule keeps a customer to their own (or nearby) outlets, a car
 * elsewhere does not count: a configuration that cannot produce a match is never looked at. The number of
 * configurations examined in one call is bounded as well, and when there are more the starting point moves
 * from one call to the next, so the work of a request stays inside the platform's allowance whatever the
 * data looks like and nothing waits forever.
 */
export async function allocateAll(ctx: Ctx, maxMatches = 100): Promise<AllocationOutcome[]> {
  if (maxMatches <= 0) return [];
  const today = localParts(ctx.now, ctx.tenant.timezone).date;
  const scope = ctx.settings.outlet_scope;
  // Which outlets' cars a booking may take, as the matching rules have it.
  const near = Object.entries(ctx.settings.nearby_outlets ?? {}).flatMap(([from, list]) => (list ?? []).map((to) => ({ from, to })));
  const reach =
    scope === "SAME_OUTLET_ONLY" ? "AND v.outlet_id = b.outlet_id"
    : scope === "SAME_OUTLET_NEARBY" ? "AND (v.outlet_id = b.outlet_id OR EXISTS (SELECT 1 FROM json_each(?3) AS j WHERE json_extract(j.value,'$.from') = b.outlet_id AND json_extract(j.value,'$.to') = v.outlet_id))"
    : "";
  const configs = await all<Config>(
    ctx.db,
    `SELECT DISTINCT b.model, b.variant, b.colour FROM bookings b
     WHERE b.tenant_id = ?1 AND b.status = 'APPROVED' AND (b.on_hold = 0 OR (b.hold_until IS NOT NULL AND b.hold_until <= ?2))
       AND EXISTS (SELECT 1 FROM vehicles v WHERE v.tenant_id = b.tenant_id AND v.model = b.model AND v.variant = b.variant AND v.colour = b.colour
                   AND v.status IN (${allocatable(ctx)}) AND v.is_blocked = 0 ${reach}
                   AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.vehicle_id = v.id AND a.status = 'ACTIVE'))
     ORDER BY b.model, b.variant, b.colour`,
    ...(scope === "SAME_OUTLET_NEARBY" ? [ctx.tenantId, today, JSON.stringify(near)] : [ctx.tenantId, today]),
  );
  const examine = Math.min(configs.length, maxMatches + CONFIGS_BEYOND_MATCHES);
  const from = configs.length > examine ? Math.floor(ctx.now.getTime() / 60_000) % configs.length : 0;
  const out: AllocationOutcome[] = [];
  for (let i = 0; i < examine; i++) {
    if (out.length >= maxMatches) break;
    out.push(...(await allocateConfig(ctx, configs[(from + i) % configs.length], maxMatches - out.length)));
  }
  return out;
}
/** A configuration examined normally yields a match, so this margin is only reached when something else holds the matches back. */
const CONFIGS_BEYOND_MATCHES = 25;

export interface ActiveAllocation {
  id: string;
  booking_id: string;
  vehicle_id: string;
  type: string;
  status: string;
  needs_transfer: number;
  clock_started_at: string | null;
  window_extension_days: number;
  reminder_sent_at: string | null;
  escalated_at: string | null;
}

export async function activeAllocationForBooking(ctx: Ctx, bookingId: string) {
  return first<ActiveAllocation>(ctx.db, `SELECT * FROM allocations WHERE tenant_id = ? AND booking_id = ? AND status = 'ACTIVE'`, ctx.tenantId, bookingId);
}
export async function activeAllocationForVehicle(ctx: Ctx, vehicleId: string) {
  return first<ActiveAllocation>(ctx.db, `SELECT * FROM allocations WHERE tenant_id = ? AND vehicle_id = ? AND status = 'ACTIVE'`, ctx.tenantId, vehicleId);
}

type Hold = { reason: string; until: string | null };

/**
 * The statements that release an allocation and return its booking to the queue (or put it on hold).
 * The first one is guarded: if the allocation is no longer active the batch they are part of is rolled back.
 */
export function releaseStmts(ctx: Ctx, alloc: Pick<ActiveAllocation, "id" | "booking_id" | "vehicle_id">, reason: string, hold?: Hold): D1PreparedStatement[] {
  const at = iso(ctx.now);
  return [
    auditStmt(ctx, "ALLOCATION_RELEASED", "booking", alloc.booking_id, { allocation_id: alloc.id, vehicle_id: alloc.vehicle_id, reason, hold: hold ?? null }, { sql: `SELECT 1 FROM allocations WHERE id = ? AND tenant_id = ? AND status = 'ACTIVE'`, params: [alloc.id, ctx.tenantId] }),
    stmt(ctx.db, `UPDATE allocations SET status = 'RELEASED', released_at = ?, release_reason = ? WHERE id = ? AND tenant_id = ? AND status = 'ACTIVE'`, at, reason, alloc.id, ctx.tenantId),
    stmt(
      ctx.db,
      `UPDATE bookings SET status = CASE WHEN status = 'ALLOCATED' THEN 'APPROVED' ELSE status END, on_hold = ?, hold_reason = ?, hold_until = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`,
      hold ? 1 : 0,
      hold?.reason ?? null,
      hold?.until ?? null,
      at,
      alloc.booking_id,
      ctx.tenantId,
    ),
  ];
}

/**
 * Releases an allocation. The booking goes back to the queue with its original priority unless a
 * hold is given. The freed car is offered to the next eligible booking straight away. Statements in
 * `also` are committed in the same batch as the release.
 */
export async function releaseAllocation(
  ctx: Ctx,
  alloc: Pick<ActiveAllocation, "id" | "booking_id" | "vehicle_id">,
  reason: string,
  opts: { hold?: Hold; reallocate?: boolean; also?: D1PreparedStatement[] } = {},
): Promise<AllocationOutcome[]> {
  try {
    await ctx.db.batch([...releaseStmts(ctx, alloc, reason, opts.hold), ...(opts.also ?? [])]);
  } catch (e) {
    if (isGuardFailure(e)) throw conflict("This was changed by someone else a moment ago. Refresh and try again.");
    throw e;
  }
  if (opts.reallocate === false) return [];
  const v = await first<Config>(ctx.db, `SELECT model, variant, colour FROM vehicles WHERE id = ? AND tenant_id = ?`, alloc.vehicle_id, ctx.tenantId);
  return v ? allocateConfig(ctx, v) : [];
}

/**
 * An approved manual allocation: a named car to a named booking, outside the queue order. Releasing the
 * booking's current car (if any), allocating the named one and the caller's `also` statements (the
 * approval itself) are one batch: either all of it happens or none of it.
 */
export async function manualAllocate(ctx: Ctx, bookingId: string, vehicleId: string, approver: string, exceptionId: string, also: D1PreparedStatement[] = []): Promise<AllocationOutcome> {
  const b = await first<BookingRow>(ctx.db, `SELECT * FROM bookings WHERE id = ? AND tenant_id = ?`, bookingId, ctx.tenantId);
  const v = await first<VehicleRow>(ctx.db, `SELECT v.*, ${LAST_BOOKING} FROM vehicles v WHERE v.id = ? AND v.tenant_id = ?`, vehicleId, ctx.tenantId);
  if (!b || !v) throw new Error("Booking or vehicle not found");
  if (!["APPROVED", "ALLOCATED"].includes(b.status)) throw new Error("Only a booking that is waiting for a car, or holding one that is not yet invoiced, can be allocated a car");
  if (v.model !== b.model || v.variant !== b.variant || v.colour !== b.colour) throw new Error("The vehicle does not match the booking's model, variant and colour");
  if (!["RECEIVED", "IN_TRANSIT"].includes(v.status) || v.is_blocked) throw new Error("The vehicle is not available for allocation");
  if (await activeAllocationForVehicle(ctx, v.id)) throw new Error("The vehicle is allocated to another booking; release that allocation first");
  const existing = await activeAllocationForBooking(ctx, b.id);
  const done = await commitMatch(ctx, { booking: b, vehicle: v, queuePosition: 0, pass: "MANUAL_APPROVED_EXCEPTION" }, approver, exceptionId, {
    // The booking's current car is freed first, inside the same batch, so the booking is waiting when the new allocation is written.
    before: existing ? releaseStmts(ctx, existing, "REPLACED_BY_MANUAL_ALLOCATION") : [],
    also,
  });
  if (!done) throw new Error("The vehicle or the booking was changed by someone else just now");
  if (existing) await allocateConfig(ctx, v); // the car the booking held before can now go to the next customer
  return done;
}
