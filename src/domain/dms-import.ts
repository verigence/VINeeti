// Applying the two DMS files.
//
// The dealership uploads the stock report and the booking sheet every day (or every few days). Each
// upload is the DMS's statement of fact at that moment, and this module brings the system in line
// with it:
//
//   Stock report   every car (VIN) is created or updated; "Unalloted" cars are free stock, "Alloted" and
//                  "IBND" cars are tied to the booking their Order ID names. A car billed to a booking
//                  other than the one the system reserved it for is a bypass: the reservation is undone,
//                  the waiting customer keeps their place and the Business Head is told. A car no longer
//                  in the report has left stock.
//   Booking sheet  every booking is created or updated; Booked bookings wait in the queue by their DMS
//                  date; Invoiced ones leave it; a cancelled booking gives its car back, and the car goes
//                  to the next customer in line.
//
// Both loads are repeatable: the same file loaded twice changes nothing the second time. The file is
// written in a few bulk statements; only steps that message a customer or move a reservation are taken
// one at a time, and when a file needs more of those than one request may do, the result says `more`
// and the same file is sent again to continue.

import type { Ctx } from "../env";
import { alertStmt, all, auditStmt, chunk, first, isGuardFailure, isUniqueViolation, run, stmt } from "../lib/db";
import { readExport } from "../lib/xlsx";
import { bad, conflict, HttpError, iso, localDayBounds, localParts, newId, norm } from "../lib/util";
import { dateInFilename, readRetailReport, reportInstant, STOCK_ISSUES, type BookingSheetRow, type RowError, type StockRow } from "../dms/reports";
import { alarmStmts } from "./alarms";
import { recordStockPositions } from "./analytics";
import { oemAdapter, SUPPORTED_OEMS } from "../oem";
import { allocateAll, releaseAllocation, releaseStmts, vehicleLabel } from "./allocation";
import { cancelBooking } from "./bookings";
import { receiveVehicle } from "./inventory";
import { bookingColour, canonColour, keyOf, loadMaster, refreshBookingColours, registerColours, registerDmsCars, type DmsCarInput, type Master } from "./master";
import { queueKey, waitingQueues, type Waiting } from "./queue";
import { queueCompare } from "./rules";

/** Steps per request that message a customer or move a reservation. Each costs several database calls. */
const STEP_BUDGET = 50;
/** Cars the system allocates itself straight after a load; the scheduled run continues with the rest. */
const ALLOCATE_AFTER_LOAD = 40;
const MAX_ROWS = 6000;

export interface StockSummary {
  dealer_name: string;
  report_date: string;
  /** What the report says. */
  cars: number;
  unallocated: number;
  unallocated_received: number;
  unallocated_in_transit: number;
  allocated: number;
  alloted: number;
  ibnd: number;
  demo: number;
  /** What changed in the system. */
  new_cars: number;
  received: number;
  invoiced: number;
  returned: number;
  left_stock: { delivered: number; removed: number; on_hold: number };
  /** Cars the report ties to a booking (Order ID), and what became of each link. */
  orders: { total: number; in_booking_data: number; known_only_from_stock: number; recorded: number; confirmed: number; bypassed: number; to_cancelled_booking: number; released_in_dms: number; out_of_turn: number };
  /**
   * Allocations this system made that the DMS still does not show, and that were already made
   * before the last report came in. Each has now survived a whole cycle of the DMS without anybody
   * keying it in, so this is not "not yet" -- it is "it did not happen".
   */
  not_keyed_in: { cars: number; oldest_days: number | null };
  outlets_created: string[];
  variants_added: number;
  not_recognised: number;
  issues: Record<string, number>;
  master_conflicts: string[];
}

export interface BookingSummary {
  dealer_name: string;
  sheet_date: string;
  /** What the sheet says. */
  bookings: number;
  booked: number;
  invoiced: number;
  delivered: number;
  cancelled: number;
  /** What changed in the system. */
  new_bookings: number;
  entered_queue: number;
  cancelled_now: number;
  cars_released: number;
  invoiced_now: number;
  delivered_now: number;
  details_completed: number;
  outlets_created: string[];
  variants_added: number;
  not_recognised: number;
  consultants_not_linked: number;
  master_conflicts: string[];
}

export interface DmsUploadResult {
  upload_id: string;
  kind: "STOCK" | "BOOKINGS" | "RETAIL";
  report_date: string;
  /** True when the file still has steps left: send the same file again with `continue` set to upload_id. */
  more: boolean;
  row_count: number;
  created: number;
  updated: number;
  unchanged: number;
  errors: RowError[];
  /** Cars the system allocated to waiting bookings after the load. */
  allocations: number;
  summary: StockSummary | BookingSummary | RetailSummary;
}

const RANK: Record<string, number> = { IN_TRANSIT: 0, RECEIVED: 1, INVOICED: 2 };
const today = (ctx: Ctx) => localParts(ctx.now, ctx.tenant.timezone).date;
const jx = (f: string) => `json_extract(j.value,'$.${f}')`;

/** The dealership's name as its DMS writes it is fixed by the first file; a file for another dealer is refused. */
/** The manufacturer's file layout for this dealership. */
function adapterFor(ctx: Ctx) {
  const a = oemAdapter(ctx.tenant.oem);
  if (!a) throw bad(`DMS files for ${ctx.tenant.oem} are not configured in this version (supported: ${SUPPORTED_OEMS.join(", ")}). The dealership can be worked from the screens; its file layout is added from real exports.`, "OEM_NOT_SUPPORTED");
  return a;
}

async function checkDealer(ctx: Ctx, dealerName: string): Promise<void> {
  if (!dealerName) return;
  const have = ctx.settings.dms_dealer_name;
  if (have && norm(have) !== norm(dealerName)) throw bad(`This file is for the dealer "${dealerName}". This dealership's DMS files are for "${have}". Nothing was loaded.`, "WRONG_DEALER");
  if (!have) {
    await ctx.db.batch([
      stmt(ctx.db, `UPDATE tenants SET settings_json = json_set(CASE WHEN json_valid(settings_json) THEN settings_json ELSE '{}' END, '$.dms_dealer_name', ?) WHERE id = ?`, dealerName, ctx.tenantId),
      auditStmt(ctx, "DMS_DEALER_SET", "tenant", ctx.tenantId, { dealer_name: dealerName }),
    ]);
    ctx.settings.dms_dealer_name = dealerName;
  }
}

/**
 * Outlets are the DMS's Dealer Location Codes. One the system has not seen is created (by someone who
 * may see every outlet).
 *
 * `by: "name"` is for the one export that carries no location code at all: its outlets are matched
 * against the names the stock report gave them, and nothing is ever created, because an outlet
 * invented from a name would collide with the real one the moment a file with codes arrives.
 */
async function outletsFor(ctx: Ctx, seen: Map<string, string>, scope: string[] | null, by: "code" | "name" = "code"): Promise<{ byCode: Map<string, string>; created: string[] }> {
  const rows = await all<{ id: string; code: string; name: string }>(ctx.db, `SELECT id, code, name FROM outlets WHERE tenant_id = ?`, ctx.tenantId);
  const byCode = new Map(rows.map((o) => [norm(by === "name" ? o.name : o.code), o.id]));
  const created: string[] = [];
  if (by === "name") return { byCode, created };
  if (scope === null) {
    const stmts: D1PreparedStatement[] = [];
    for (const [code, name] of seen) {
      if (byCode.has(code)) continue;
      const id = newId("out");
      stmts.push(stmt(ctx.db, `INSERT INTO outlets (id, tenant_id, code, name, is_active, created_at) VALUES (?,?,?,?,1,?)`, id, ctx.tenantId, code, name, iso(ctx.now)), auditStmt(ctx, "OUTLET_CREATED", "outlet", id, { code, name, source: "DMS file" }));
      byCode.set(code, id);
      created.push(`${code} ${name}`);
    }
    if (stmts.length) {
      await ctx.db.batch(stmts);
      ctx.cache.delete("outlets");
    }
  }
  return { byCode, created };
}

async function startUpload(ctx: Ctx, kind: "STOCK" | "BOOKINGS" | "RETAIL", continueId: string | null | undefined): Promise<{ id: string; continued: boolean; prior: Record<string, any> }> {
  if (continueId) {
    const row = await first<{ id: string; summary_json: string }>(ctx.db, `SELECT id, summary_json FROM uploads WHERE id = ? AND tenant_id = ? AND kind = ? AND status = 'RUNNING' AND uploaded_by = ?`, continueId, ctx.tenantId, kind, ctx.actor);
    if (row) return { id: row.id, continued: true, prior: JSON.parse(row.summary_json || "{}") };
  }
  return { id: newId("upl"), continued: false, prior: {} };
}

/** Adds the counts of an earlier step of the same upload to this step's summary. */
function addInto<T extends Record<string, any>>(now: T, prior: Record<string, any>, keys: string[]): T {
  for (const path of keys) {
    const parts = path.split(".");
    let a: any = now, b: any = prior;
    for (let i = 0; i < parts.length - 1; i++) (a = a?.[parts[i]]), (b = b?.[parts[i]]);
    const k = parts[parts.length - 1];
    if (a && b && typeof b[k] === "number") a[k] += b[k];
  }
  return now;
}

async function saveUpload(ctx: Ctx, u: { id: string; continued: boolean }, r: DmsUploadResult, mode: string, filename: string | undefined, outlets: string[], prior: Record<string, any>) {
  const counts = { created: r.created + (prior._created ?? 0), updated: r.updated + (prior._updated ?? 0) };
  const summary = JSON.stringify({ ...r.summary, _created: counts.created, _updated: counts.updated, _allocations: r.allocations + (prior._allocations ?? 0) });
  const errors = JSON.stringify({ errors: r.errors.slice(0, 500) });
  // A file from which not one row was applied does not count as the dealership's latest file: it vouches for nothing.
  const status = r.more ? "RUNNING" : counts.created + counts.updated + r.unchanged === 0 ? "EMPTY" : "DONE";
  if (u.continued) {
    await run(ctx.db, `UPDATE uploads SET created_count = ?, updated_count = ?, unchanged_count = ?, error_count = ?, errors_json = ?, summary_json = ?, status = ?, at = ? WHERE id = ? AND tenant_id = ?`, counts.created, counts.updated, r.unchanged, r.errors.length, errors, summary, status, iso(ctx.now), u.id, ctx.tenantId);
  } else {
    await run(
      ctx.db,
      `INSERT INTO uploads (id, tenant_id, kind, mode, filename, row_count, created_count, updated_count, unchanged_count, error_count, errors_json, outlets_json, report_date, summary_json, status, uploaded_by, at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      u.id, ctx.tenantId, r.kind, mode, filename ?? null, r.row_count, r.created, r.updated, r.unchanged, r.errors.length, errors, JSON.stringify(outlets), r.report_date, summary, status, ctx.actor, iso(ctx.now),
    );
  }
  r.created = counts.created;
  r.updated = counts.updated;
  r.allocations += prior._allocations ?? 0;
}

// ---------------------------------------------------------------- stock report

interface VehicleRow {
  id: string; vin: string; outlet_id: string; variant_id: string | null; model: string; variant: string; colour: string; status: string;
  is_blocked: number; block_reason: string | null; engine_no: string | null; wholesale_invoice_no: string | null; wholesale_invoice_date: string | null;
  received_at: string | null; invoiced_at: string | null; dms_booking_no: string | null; description: string | null; oem_model_code: string | null;
  oem_colour_code: string | null; paint_alias: string; dms_colour: string | null; seating: string | null; is_demo: number; net_dealer_price: number | null;
  grn_no: string | null; dms_stock_type: string | null; dms_order_date: string | null; dms_customer_name: string | null; dms_sc_name: string | null;
  dms_allotment_id: string | null; dms_allotment_date: string | null; dms_invoice_id: string | null; dms_invoice_date: string | null; dms_issues_json: string;
  report_date: string | null;
}

/** The columns a stock report decides. */
const V_COLS = [
  "outlet_id", "variant_id", "model", "variant", "colour", "status", "is_blocked", "block_reason", "engine_no", "wholesale_invoice_no", "wholesale_invoice_date", "received_at", "invoiced_at",
  "dms_booking_no", "description", "oem_model_code", "oem_colour_code", "paint_alias", "dms_colour", "seating", "is_demo", "net_dealer_price", "grn_no", "dms_stock_type", "dms_order_date",
  "dms_customer_name", "dms_sc_name", "dms_allotment_id", "dms_allotment_date", "dms_invoice_id", "dms_invoice_date", "dms_issues_json",
] as const;
type VWant = Record<(typeof V_COLS)[number], string | number | null>;

interface AllocRow {
  id: string; booking_id: string; vehicle_id: string; source: string; dms_confirmed_at: string | null;
  booking_no: string; booking_status: string; booking_source: string; booking_invoiced_at?: string | null;
}

interface BookingLite {
  id: string; booking_no: string; outlet_id: string; status: string; source: string; model: string; variant: string; colour: string; on_hold: number;
  booking_date: string; priority_ts: string; expected_delivery_date: string | null; booking_amount: number | null; priority_override_json: string | null; customer_name: string;
}

const DEMO_REASON = "Demo vehicle";

export async function importStockReport(
  ctx: Ctx,
  bytes: Uint8Array,
  opts: {
    filename?: string;
    /** The date the report describes (YYYY-MM-DD). Taken from the file name ("... as on 05.10.2026") when not given, else today. */
    reportDate?: string | null;
    /** COMPLETE: the file is the whole stock of the outlets in it, so a car missing from it has left stock. PARTIAL: only the rows given. */
    mode?: "COMPLETE" | "PARTIAL";
    /** Outlets the uploader may change; null means all. */
    outletScope?: string[] | null;
    /** The uploader has confirmed that the many cars missing from this file really have left stock. */
    confirmMissing?: boolean;
    continueUpload?: string | null;
  } = {},
): Promise<DmsUploadResult> {
  const tz = ctx.tenant.timezone;
  const scope = opts.outletScope ?? null;
  const mode = opts.mode ?? "COMPLETE";
  const asOf = opts.reportDate || dateInFilename(opts.filename) || today(ctx);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw bad("The report date is not valid");
  if (asOf > today(ctx)) throw bad(`The report date ${asOf} is in the future`);
  const report = adapterFor(ctx).readStockReport(await readExport(bytes, opts.filename), { timeZone: tz, asOf });
  if (report.rows.length > MAX_ROWS) throw bad(`The report has more than ${MAX_ROWS} cars`);
  await checkDealer(ctx, report.dealer_name);
  const newer = await first<{ report_date: string }>(ctx.db, `SELECT MAX(report_date) AS report_date FROM uploads WHERE tenant_id = ? AND kind = 'STOCK' AND status = 'DONE'`, ctx.tenantId);
  if (newer?.report_date && newer.report_date > asOf) throw bad(`A newer stock report (as on ${newer.report_date}) has already been loaded. This one is as on ${asOf}; loading it would take stock back in time.`, "OLDER_REPORT");
  const opening = !newer?.report_date;
  // From the day this system controls allocation, an allotment that appears in the DMS without
  // having come through it is a violation. Before that day -- and while no day is set -- the DMS's
  // allotments are simply the history of a dealership that was not running on this yet.
  const control = ctx.settings.allocation_control_from;
  const controlled = Boolean(control && asOf >= control);

  const upload = await startUpload(ctx, "STOCK", opts.continueUpload);
  const uctx: Ctx = { ...ctx, actor: `UPLOAD:${upload.id}` };
  const at = iso(ctx.now);
  const errors: RowError[] = [...report.errors];

  // ---- outlets, and who may load what
  const seenOutlets = new Map(report.rows.map((r) => [r.outlet_code, r.outlet_name]));
  const { byCode: outletByCode, created: outletsCreated } = await outletsFor(ctx, seenOutlets, scope);
  let rows = report.rows.filter((r) => {
    const id = outletByCode.get(r.outlet_code);
    if (!id) { errors.push({ row: r.row, key: r.vin, message: `Outlet ${r.outlet_code} (${r.outlet_name}) is not set up; ask the administrator to load this report once` }); return false; }
    if (scope && !scope.includes(id)) { errors.push({ row: r.row, key: r.vin, message: `Outlet ${r.outlet_code} is not one of your outlets` }); return false; }
    return true;
  });

  // ---- the cars named become master variants; colours and paint codes are noted
  const reg = await registerDmsCars(ctx, rows.map((r): DmsCarInput => ({ ...r, fuel_source: r.fuel ? (r.parsed && r.transmission.includes("EV") ? "Description" : "Description") : undefined })));
  let master: Master = await loadMaster(ctx, true);
  await registerColours(
    ctx,
    rows.map((r) => ({ model: r.model, colour: canonColour(master, r.model, r.dms_colour) })),
    rows.filter((r) => r.oem_colour_code).map((r) => ({ model: r.model, oem_colour_code: r.oem_colour_code, paint_alias: r.paint_alias, colour: canonColour(master, r.model, r.dms_colour), dms_colour: r.dms_colour })),
  );
  master = await loadMaster(ctx, true);

  // ---- what the system holds now
  const vins = JSON.stringify(rows.map((r) => r.vin));
  const existing = new Map((await all<VehicleRow>(ctx.db, `SELECT * FROM vehicles WHERE tenant_id = ? AND (status IN ('IN_TRANSIT','RECEIVED','INVOICED') OR vin IN (SELECT value FROM json_each(?)))`, ctx.tenantId, vins)).map((v) => [v.vin, v]));
  const allocs = await all<AllocRow>(
    ctx.db,
    `SELECT a.id, a.booking_id, a.vehicle_id, a.source, a.dms_confirmed_at, b.booking_no, b.status AS booking_status, b.source AS booking_source, b.invoiced_at AS booking_invoiced_at
     FROM allocations a JOIN bookings b ON b.id = a.booking_id WHERE a.tenant_id = ? AND a.status = 'ACTIVE'`,
    ctx.tenantId,
  );
  const allocByVehicle = new Map(allocs.map((a) => [a.vehicle_id, a]));
  const allocByBooking = new Map(allocs.map((a) => [a.booking_id, a]));
  const orderIds = [...new Set(rows.map((r) => r.order_id).filter((x): x is string => Boolean(x)))];
  const B_COLS = `id, booking_no, outlet_id, status, source, model, variant, colour, on_hold, booking_date, priority_ts, expected_delivery_date, booking_amount, priority_override_json, customer_name`;
  const bookings = new Map((await all<BookingLite>(ctx.db, `SELECT ${B_COLS} FROM bookings WHERE tenant_id = ? AND booking_no IN (SELECT value FROM json_each(?))`, ctx.tenantId, JSON.stringify(orderIds))).map((b) => [b.booking_no, b]));

  // ---- cars missing from a complete report have left stock. Checked before anything is written.
  const outletsInFile = new Set(rows.map((r) => outletByCode.get(r.outlet_code)!));
  const inFile = new Set(rows.map((r) => r.vin));
  const gone = mode === "COMPLETE" ? [...existing.values()].filter((v) => ["IN_TRANSIT", "RECEIVED", "INVOICED"].includes(v.status) && outletsInFile.has(v.outlet_id) && !inFile.has(v.vin)) : [];
  const inStockBefore = [...existing.values()].filter((v) => ["IN_TRANSIT", "RECEIVED", "INVOICED"].includes(v.status) && outletsInFile.has(v.outlet_id)).length;
  if (!opts.confirmMissing && !upload.continued && gone.length > Math.max(25, Math.floor(inStockBefore * 0.3))) {
    throw new HttpError(409, `${gone.length} of the ${inStockBefore} cars the system holds at these outlets are not in this file. If the file is the complete stock report, confirm to mark them as having left stock. If it is a filtered or partial export, load it as a partial file instead.`, "CONFIRM_MISSING");
  }

  const result: DmsUploadResult = { upload_id: upload.id, kind: "STOCK", report_date: asOf, more: false, row_count: report.rows.length, created: 0, updated: 0, unchanged: 0, errors, allocations: 0, summary: null as unknown as StockSummary };
  const s: StockSummary = {
    dealer_name: report.dealer_name, report_date: asOf,
    cars: report.rows.length,
    unallocated: report.rows.filter((r) => r.stock_type === "UNALLOTED").length,
    unallocated_received: report.rows.filter((r) => r.stock_type === "UNALLOTED" && r.status === "RECEIVED").length,
    unallocated_in_transit: report.rows.filter((r) => r.stock_type === "UNALLOTED" && r.status === "IN_TRANSIT").length,
    allocated: report.rows.filter((r) => r.stock_type !== "UNALLOTED").length,
    alloted: report.rows.filter((r) => r.stock_type === "ALLOTED").length,
    ibnd: report.rows.filter((r) => r.stock_type === "IBND").length,
    demo: report.rows.filter((r) => r.is_demo).length,
    new_cars: 0, received: 0, invoiced: 0, returned: 0,
    left_stock: { delivered: 0, removed: 0, on_hold: 0 },
    orders: { total: orderIds.length, in_booking_data: 0, known_only_from_stock: 0, recorded: 0, confirmed: 0, bypassed: 0, to_cancelled_booking: 0, released_in_dms: 0, out_of_turn: 0 },
    not_keyed_in: { cars: 0, oldest_days: null },
    outlets_created: outletsCreated, variants_added: reg.added, not_recognised: report.rows.filter((r) => !r.parsed).length,
    issues: {}, master_conflicts: reg.conflicts,
  };
  for (const r of report.rows) for (const i of r.issues) s.issues[i] = (s.issues[i] ?? 0) + 1;
  result.summary = s;

  // ---- phase A: the cars themselves
  const inserts: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const arrivals: { row: StockRow; v: VehicleRow }[] = []; // reserved cars that have now arrived: the customer is told
  const vehicleId = new Map<string, string>();
  const statusNow = new Map<string, string>();
  const carOf = new Map<string, { id: string; vin: string; outlet_id: string; model: string; variant: string; colour: string; status: string }>();
  const kept: StockRow[] = [];
  for (const r of rows) {
    const variant = reg.byKey.get(keyOf(r.variant));
    if (!variant) { errors.push({ row: r.row, key: r.vin, message: `Variant ${r.variant} could not be registered in the vehicle master` }); continue; }
    const cur = existing.get(r.vin);
    const outletId = outletByCode.get(r.outlet_code)!;
    if (cur && scope && !scope.includes(cur.outlet_id)) { errors.push({ row: r.row, key: r.vin, message: "This car is held at an outlet that is not one of yours" }); continue; }
    const colour = canonColour(master, variant.model, r.dms_colour);
    const target = r.stock_type === "IBND" && r.invoice_id ? "INVOICED" : r.status;
    const back = cur ? !(cur.status in RANK) : false; // was marked delivered or removed, and the DMS lists it again
    let status = !cur || back ? target : RANK[target] >= RANK[cur.status] ? target : cur.status;
    // A retail invoice the DMS showed before and no longer shows was cancelled there.
    const invoiceReversed = Boolean(cur && cur.status === "INVOICED" && cur.dms_invoice_id && !r.invoice_id);
    if (invoiceReversed) status = r.status;
    const alloc = cur ? allocByVehicle.get(cur.id) : undefined;
    const configChanged = cur && (cur.model !== variant.model || cur.variant !== variant.variant || cur.colour !== colour);
    if (configChanged && alloc && alloc.source !== "DMS") {
      errors.push({ row: r.row, key: r.vin, message: `The report describes this car as ${vehicleLabel({ model: variant.model, variant: variant.variant, colour })}; the system has it as ${vehicleLabel(cur!)} and it is reserved for booking ${alloc.booking_no}. Its description was not changed; check the reservation.` });
    }
    const keepConfig = Boolean(configChanged && alloc && alloc.source !== "DMS");
    // A reserved car that has arrived is received in its own step, with the customer's message. Not when this same
    // report ties the car to a different order: that customer is about to lose the car, and is not first told it is here.
    const arriving = Boolean(cur && cur.status === "IN_TRANSIT" && status === "RECEIVED" && alloc && alloc.booking_status === "ALLOCATED" && (!r.order_id || r.order_id === alloc.booking_no));
    const demoBlock = r.is_demo ? 1 : cur && cur.block_reason === DEMO_REASON ? 0 : cur?.is_blocked ?? 0;
    const want: VWant = {
      outlet_id: outletId,
      variant_id: keepConfig ? cur!.variant_id : variant.id,
      model: keepConfig ? cur!.model : variant.model,
      variant: keepConfig ? cur!.variant : variant.variant,
      colour: keepConfig ? cur!.colour : colour,
      // An arriving reserved car is received in its own step below, with the customer's message.
      status: arriving ? "IN_TRANSIT" : status,
      is_blocked: demoBlock,
      block_reason: r.is_demo ? DEMO_REASON : demoBlock ? cur?.block_reason ?? null : null,
      engine_no: r.engine_no ?? cur?.engine_no ?? null,
      wholesale_invoice_no: r.oem_invoice_no ?? cur?.wholesale_invoice_no ?? null,
      wholesale_invoice_date: r.oem_invoice_date ?? cur?.wholesale_invoice_date ?? null,
      received_at: arriving ? null : status === "IN_TRANSIT" ? null : r.grn_at ?? cur?.received_at ?? at,
      invoiced_at: status === "INVOICED" ? (r.invoice_date ? reportInstant(r.invoice_date, tz) : cur?.invoiced_at ?? at) : null,
      dms_booking_no: r.order_id,
      description: r.description,
      oem_model_code: r.oem_model_code || null,
      oem_colour_code: r.oem_colour_code || null,
      paint_alias: r.paint_alias,
      dms_colour: r.dms_colour,
      seating: r.seater || null,
      is_demo: r.is_demo ? 1 : 0,
      net_dealer_price: r.net_dealer_price,
      grn_no: r.grn_no,
      dms_stock_type: r.stock_type,
      dms_order_date: r.order_date,
      dms_customer_name: r.customer_name,
      dms_sc_name: r.sc_name,
      dms_allotment_id: r.allotment_id,
      dms_allotment_date: r.allotment_date,
      dms_invoice_id: r.invoice_id,
      dms_invoice_date: r.invoice_date,
      dms_issues_json: JSON.stringify(r.issues),
    };
    const id = cur?.id ?? newId("veh");
    vehicleId.set(r.vin, id);
    statusNow.set(r.vin, status);
    carOf.set(r.vin, { id, vin: r.vin, outlet_id: outletId, model: String(want.model), variant: String(want.variant), colour: String(want.colour), status });
    kept.push(r);
    if (!cur) {
      inserts.push({ id, vin: r.vin, ...want });
      events.push({ id: newId("vev"), vehicle_id: id, type: "CREATED", from: null, to: status, detail: JSON.stringify({ source: "DMS stock report", report_date: asOf, outlet_id: outletId, stock_type: r.stock_type }) });
      s.new_cars++;
      result.created++;
      continue;
    }
    const changed = V_COLS.filter((c) => (cur as unknown as Record<string, unknown>)[c] !== want[c] && !(c === "received_at" && arriving));
    if (arriving) arrivals.push({ row: r, v: cur });
    if (!changed.length && !arriving) { result.unchanged++; continue; }
    result.updated++;
    if (changed.length) updates.push({ id, ...want });
    const from = cur.status;
    if (back) { events.push({ id: newId("vev"), vehicle_id: id, type: "RETURNED", from, to: status, detail: JSON.stringify({ reason: "Listed again in the stock report", report_date: asOf }) }); s.returned++; }
    else if (invoiceReversed) events.push({ id: newId("vev"), vehicle_id: id, type: "INVOICE_REVERSED", from, to: status, detail: JSON.stringify({ report_date: asOf, invoice_id: cur.dms_invoice_id }) });
    else if (from !== status && !arriving) {
      if (from === "IN_TRANSIT") { events.push({ id: newId("vev"), vehicle_id: id, type: "RECEIVED", from, to: "RECEIVED", detail: JSON.stringify({ source: "DMS stock report", grn_no: r.grn_no }) }); s.received++; }
      if (status === "INVOICED") { events.push({ id: newId("vev"), vehicle_id: id, type: "INVOICED", from: from === "IN_TRANSIT" ? "RECEIVED" : from, to: "INVOICED", detail: JSON.stringify({ source: "DMS stock report", dms_booking_no: r.order_id, invoice_id: r.invoice_id }) }); s.invoiced++; }
    }
    if (cur.outlet_id !== outletId && !back) events.push({ id: newId("vev"), vehicle_id: id, type: "TRANSFERRED", from: status, to: status, detail: JSON.stringify({ from_outlet_id: cur.outlet_id, to_outlet_id: outletId, source: "DMS stock report" }) });
  }
  rows = kept;

  const insertCols = ["id", "vin", ...V_COLS];
  const writes: D1PreparedStatement[] = [];
  for (const part of chunk(inserts, 150)) {
    writes.push(stmt(ctx.db, `INSERT INTO vehicles (${insertCols.join(", ")}, tenant_id, source, last_upload_id, report_date, created_at, updated_at) SELECT ${insertCols.map(jx).join(", ")}, ?2, 'DMS', ?3, ?4, ?5, ?5 FROM json_each(?1) AS j`, JSON.stringify(part), ctx.tenantId, upload.id, asOf, at));
  }
  for (const part of chunk(updates, 150)) {
    writes.push(stmt(ctx.db, `UPDATE vehicles SET ${V_COLS.map((c) => `${c} = ${jx(c)}`).join(", ")}, delivered_at = NULL, left_stock_on = NULL, last_upload_id = ?3, updated_at = ?5 FROM json_each(?1) AS j WHERE vehicles.id = ${jx("id")} AND vehicles.tenant_id = ?2`, JSON.stringify(part), ctx.tenantId, upload.id, asOf, at));
  }
  for (const part of chunk(events, 300)) {
    writes.push(stmt(ctx.db, `INSERT INTO vehicle_events (id, tenant_id, vehicle_id, type, from_status, to_status, detail_json, actor, at) SELECT ${jx("id")}, ?2, ${jx("vehicle_id")}, ${jx("type")}, ${jx("from")}, ${jx("to")}, ${jx("detail")}, ?3, ?4 FROM json_each(?1) AS j`, JSON.stringify(part), ctx.tenantId, uctx.actor, at));
  }
  // Every car in the report is marked as seen in it; a reserved car whose outlet changed may now need (or no longer need) a transfer.
  writes.push(stmt(ctx.db, `UPDATE vehicles SET report_date = ?2 WHERE tenant_id = ?1 AND vin IN (SELECT value FROM json_each(?3)) AND (report_date IS NULL OR report_date <> ?2)`, ctx.tenantId, asOf, JSON.stringify(rows.map((r) => r.vin))));
  writes.push(stmt(ctx.db, `UPDATE allocations SET needs_transfer = (SELECT CASE WHEN b.outlet_id = v.outlet_id THEN 0 ELSE 1 END FROM bookings b, vehicles v WHERE b.id = allocations.booking_id AND v.id = allocations.vehicle_id) WHERE tenant_id = ? AND status = 'ACTIVE' AND vehicle_id IN (SELECT id FROM vehicles WHERE last_upload_id = ?)`, ctx.tenantId, upload.id));
  for (const part of chunk(writes, 20)) await ctx.db.batch(part);

  // ---- steps taken one at a time, within this request's allowance
  let budget = STEP_BUDGET;
  const step = async (fn: () => Promise<void>, key: string, row: number): Promise<boolean> => {
    if (budget <= 0) { result.more = true; return false; }
    budget--;
    try {
      await fn();
      return true;
    } catch (e) {
      if (isGuardFailure(e) || isUniqueViolation(e)) errors.push({ row, key, message: "This car or booking was changed by someone else during the load; load the file again" });
      else errors.push({ row, key, message: (e as Error).message });
      return false;
    }
  };

  // Reserved cars that have reached the dealership: the customer is told and the payment window starts.
  for (const a of arrivals) {
    const ok = await step(async () => {
      await receiveVehicle(uctx, a.v.id);
      if (a.row.grn_at) await run(ctx.db, `UPDATE vehicles SET received_at = ?, grn_no = ? WHERE id = ? AND tenant_id = ?`, a.row.grn_at, a.row.grn_no, a.v.id, ctx.tenantId);
    }, a.row.vin, a.row.row);
    if (ok) s.received++;
  }

  // ---- phase B: the links the DMS states (Order ID = DMS Booking Number)
  const queues = opening ? null : await waitingQueues(ctx);
  const rank = queueCompare(ctx.settings);
  const stubs: Record<string, unknown>[] = [];
  const newAllocs: Record<string, unknown>[] = [];
  const bookingStatus: Record<string, unknown>[] = [];
  const confirms: string[] = [];
  const audits: Record<string, unknown>[] = [];
  /** Allotments made outside this system, once it is the one in control. */
  const violations: { kind: "OVERTURNED" | "UNKNOWN_BOOKING" | "NOT_THROUGH_SYSTEM" | "REFUSED"; booking_id: string; detail: Record<string, unknown> }[] = [];
  /** Audits and alarms for allotments this import refused to take on. Written with the violations. */
  const refused: D1PreparedStatement[] = [];
  const reversedBookings: string[] = [];
  const outOfTurn: string[] = [];
  const allocatedCars: string[] = [];

  /** What a DMS link does to the booking's status. */
  const statusFor = (r: StockRow, b: { status: string }) => (r.stock_type === "IBND" && r.invoice_id ? "INVOICED" : b.status === "INVOICED" ? "INVOICED" : "ALLOCATED");
  const allocRecord = (r: StockRow, v: { id: string; status: string; outlet_id: string; model: string; variant: string; colour: string }, b: BookingLite, wasWaiting: boolean) => {
    const invoiced = statusFor(r, b) === "INVOICED";
    let bypassed: Waiting[] = [];
    if (queues && !invoiced || (queues && wasWaiting)) {
      // Out of turn: bookings the dealership's queue rules rank ahead of this one were waiting for this same car.
      const q = queues!.get(queueKey(ctx.settings, { model: v.model, variant: v.variant, colour: v.colour, outlet_id: b.outlet_id })) ?? [];
      bypassed = q.filter((w) => w.id !== b.id && rank(w, b) < 0);
    }
    if (bypassed.length) { s.orders.out_of_turn++; outOfTurn.push(`${b.booking_no} (ahead of ${bypassed[0].booking_no}${bypassed.length > 1 ? ` and ${bypassed.length - 1} more` : ""})`); }
    return {
      id: newId("alc"), booking_id: b.id, vehicle_id: v.id, type: v.status === "IN_TRANSIT" ? "IN_TRANSIT" : "FREE_STOCK", needs_transfer: v.outlet_id !== b.outlet_id ? 1 : 0,
      // For a car the DMS already had allotted when the system first saw it, the payment window starts on the day of loading.
      clock: !invoiced && v.status === "RECEIVED" ? at : null,
      trace: JSON.stringify({ rule: opening ? "OPENING_FROM_DMS" : "DMS_ALLOTMENT", stock_type: r.stock_type, allotment_id: r.allotment_id, allotment_date: r.allotment_date, report_date: asOf }),
      out_of_turn: bypassed.length ? 1 : 0, bypassed_booking_id: bypassed[0]?.id ?? null, bypassed_count: bypassed.length,
    };
  };
  const allocInsert = (rec: Record<string, unknown>) =>
    stmt(
      ctx.db,
      `INSERT INTO allocations (id, tenant_id, booking_id, vehicle_id, type, status, needs_transfer, allocated_at, allocated_by, clock_started_at, rule_trace_json, source, dms_confirmed_at, out_of_turn, bypassed_booking_id, bypassed_count)
       SELECT ${jx("id")}, ?2, ${jx("booking_id")}, ${jx("vehicle_id")}, ${jx("type")}, 'ACTIVE', ${jx("needs_transfer")}, ?3, 'DMS', ${jx("clock")}, ${jx("trace")}, 'DMS', ?3, ${jx("out_of_turn")}, ${jx("bypassed_booking_id")}, ${jx("bypassed_count")} FROM json_each(?1) AS j`,
      JSON.stringify(Array.isArray(rec) ? rec : [rec]), ctx.tenantId, at,
    );
  const bookingStatusStmt = (list: Record<string, unknown>[]) =>
    stmt(
      ctx.db,
      `UPDATE bookings SET status = ${jx("status")}, invoiced_at = CASE WHEN ${jx("status")} = 'INVOICED' THEN COALESCE(${jx("invoiced_at")}, invoiced_at, ?3) ELSE invoiced_at END,
         on_hold = 0, hold_reason = NULL, hold_until = NULL, updated_at = ?3
       FROM json_each(?1) AS j WHERE bookings.id = ${jx("id")} AND bookings.tenant_id = ?2 AND bookings.status NOT IN ('DELIVERED','CANCELLED')`,
      JSON.stringify(list), ctx.tenantId, at,
    );

  for (const r of rows) {
    const v = carOf.get(r.vin)!;
    const cur = existing.get(r.vin);
    const alloc = allocByVehicle.get(v.id);
    if (cur && cur.status === "INVOICED" && cur.dms_invoice_id && !r.invoice_id && alloc) reversedBookings.push(alloc.booking_id);

    if (!r.order_id) {
      // The DMS has released a car it had allotted: the booking goes back to waiting (one known only from the stock report waits on hold).
      if (alloc && alloc.source === "DMS") {
        const stubOnly = alloc.booking_source === "DMS_STOCK";
        const ok = await step(async () => {
          await releaseAllocation(uctx, alloc, "RELEASED_IN_DMS", { reallocate: false, hold: stubOnly ? { reason: "NOT_IN_BOOKING_SHEET", until: null } : undefined, also: [stmt(ctx.db, `UPDATE bookings SET status = CASE WHEN status = 'INVOICED' THEN 'APPROVED' ELSE status END, invoiced_at = NULL WHERE id = ? AND tenant_id = ?`, alloc.booking_id, ctx.tenantId)] });
          allocByVehicle.delete(v.id);
          allocByBooking.delete(alloc.booking_id);
        }, r.vin, r.row);
        if (ok) s.orders.released_in_dms++;
      } else if (alloc && ["INVOICED", "DELIVERED"].includes(alloc.booking_status) && alloc.booking_invoiced_at && asOf >= localParts(new Date(alloc.booking_invoiced_at), tz).date && !(cur && cur.status === "INVOICED" && !cur.dms_invoice_id)) {
        // (A car the system itself invoiced to this booking, in the app, stays with it: a report exported before the DMS caught up is not a release.)
        // The booking sheet shows the booking invoiced, yet in a stock report at least as recent the car reserved for it is
        // still unallotted: the customer was billed with a different car. This one is free again for the next customer.
        const ok = await step(async () => {
          await releaseAllocation(uctx, alloc, "BILLED_WITH_ANOTHER_CAR", { reallocate: false, also: [auditStmt(uctx, "RESERVED_CAR_NOT_USED", "vehicle", v.id, { vin: r.vin, booking_no: alloc.booking_no, report_date: asOf })] });
          allocByVehicle.delete(v.id);
          allocByBooking.delete(alloc.booking_id);
        }, r.vin, r.row);
        if (ok) s.orders.released_in_dms++;
      }
      continue;
    }

    let b = bookings.get(r.order_id);
    // A person limited to some outlets cannot, through the Order ID of a car at their outlet, change a booking of another.
    if (b && scope && !scope.includes(b.outlet_id)) { errors.push({ row: r.row, key: r.vin, message: `This car is shown allotted to booking ${b.booking_no}, which belongs to an outlet that is not one of yours. The allotment was not applied.` }); continue; }
    if (!b) {
      // The order is not in any booking sheet loaded so far (it may predate them). What the stock report says about it is kept.
      const id = newId("bkg");
      const date = reportInstant(r.order_date ?? r.allotment_date ?? asOf, tz);
      b = { id, booking_no: r.order_id, outlet_id: v.outlet_id, status: "APPROVED", source: "DMS_STOCK", model: v.model, variant: v.variant, colour: v.colour, on_hold: 0, booking_date: date, priority_ts: date, expected_delivery_date: null, booking_amount: 0, priority_override_json: null, customer_name: r.customer_name ?? "Not in the booking sheet" };
      stubs.push({ ...b, variant_id: reg.byKey.get(keyOf(r.variant))?.id ?? null, description: r.text, oem_model_code: r.oem_model_code || null, paint_alias: r.paint_alias, dms_colour: r.dms_colour, seating: r.seater || null, sc_name: r.sc_name, status: statusFor(r, { status: "APPROVED" }), invoiced_at: r.invoice_date ? reportInstant(r.invoice_date, tz) : null });
      bookings.set(r.order_id, b);
      s.orders.known_only_from_stock++;
    } else if (b.source === "DMS_STOCK") s.orders.known_only_from_stock++;
    else s.orders.in_booking_data++;

    if (b.status === "CANCELLED") { s.orders.to_cancelled_booking++; continue; }
    if (b.status === "DELIVERED") { errors.push({ row: r.row, key: r.vin, message: `The report shows this car with booking ${b.booking_no}, which the system has as delivered. Nothing was changed.` }); continue; }
    const wanted = statusFor(r, b);
    const invoicedAt = r.invoice_date ? reportInstant(r.invoice_date, tz) : null;

    if (alloc && alloc.booking_id === b.id) {
      // The DMS agrees with the reservation.
      if (!alloc.dms_confirmed_at) { confirms.push(alloc.id); s.orders.confirmed++; }
      if (b.status !== wanted) bookingStatus.push({ id: b.id, status: wanted, invoiced_at: invoicedAt });
      continue;
    }
    const held = allocByBooking.get(b.id);
    const wasWaiting = b.status === "APPROVED" && b.source !== "DMS_STOCK";
    if (!alloc && !held) {
      newAllocs.push(allocRecord(r, v, b, wasWaiting));
      bookingStatus.push({ id: b.id, status: wanted, invoiced_at: invoicedAt });
      audits.push({ id: newId("aud"), entity_id: b.id, action: "ALLOCATED", detail: JSON.stringify({ vehicle_id: v.id, vin: r.vin, source: "DMS", stock_type: r.stock_type, rule: opening ? "OPENING_FROM_DMS" : "DMS_ALLOTMENT" }) });
      // The DMS is the record, so a car can be allotted there directly and this is where we find out.
      // The system had nothing for this booking and nothing against this car, so the allotment was
      // made outside it: from the day this system controls allocation that is a violation, reported
      // and put in front of the approvers rather than quietly taken on as our own.
      //
      // Only a car reserved and not yet invoiced. The allocation decision is the one this system is
      // meant to own; a car that arrives already billed was decided and sold before we saw it, which
      // is ordinary for a booking that never passed through here and is OUTSIDE_ALLOCATION's business
      // rather than this.
      if (controlled && r.stock_type === "ALLOTED") {
        violations.push({
          // Two shapes, and they are not the same conversation. A booking the system never had was
          // taken and allotted entirely outside it. One the system had, waiting in the queue, was
          // allotted without being asked — the queue was there and was gone round.
          kind: b.source === "DMS_STOCK" ? "UNKNOWN_BOOKING" : "NOT_THROUGH_SYSTEM",
          booking_id: b.id,
          detail: { vin: r.vin, booking_no: b.booking_no, customer_name: b.customer_name, vehicle_id: v.id, outlet_id: v.outlet_id, allotment_id: r.allotment_id, allotment_date: r.allotment_date, report_date: asOf },
        });
      }
      allocatedCars.push(v.id);
      allocByVehicle.set(v.id, { id: "new", booking_id: b.id, vehicle_id: v.id, source: "DMS", dms_confirmed_at: at, booking_no: b.booking_no, booking_status: wanted, booking_source: b.source });
      allocByBooking.set(b.id, allocByVehicle.get(v.id)!);
      s.orders.recorded++;
      continue;
    }
    // The DMS ties this car to a different booking than the system does, or this booking to a different car.
    const booking = b;

    // Allocation is the one decision this system owns: the DMS holds the data but cannot do the
    // rules or the approvals, which is the whole reason this system exists. So once allocation is
    // under its control, an allotment made straight in the DMS over a car this system is already
    // holding for a customer does not win by being there first. The allocation stands, the
    // allotment is refused, and the correction goes onto the sheet the DMS is updated from.
    //
    // The exception is a sale that has already happened. A car the DMS has invoiced or delivered is
    // gone -- there is a customer with paperwork and, very likely, the car. Undoing that is not a
    // data correction, so there the DMS's state is taken on and the VP is told instead.
    const sold = r.stock_type === "IBND" || ["INVOICED", "DELIVERED"].includes(alloc?.booking_status ?? "");
    if (controlled && alloc && !sold) {
      const common = { vin: r.vin, booking_no: booking.booking_no, customer_name: booking.customer_name, vehicle_id: v.id, outlet_id: v.outlet_id, report_date: asOf };
      violations.push({ kind: "REFUSED", booking_id: booking.id, detail: { ...common, held_for_booking_no: alloc.booking_no, held_for_booking_id: alloc.booking_id, allotment_id: r.allotment_id, allotment_date: r.allotment_date } });
      refused.push(
        auditStmt(uctx, "DMS_ALLOTMENT_REFUSED", "vehicle", v.id, { vin: r.vin, allocated_booking_no: alloc.booking_no, dms_booking_no: booking.booking_no, stock_type: r.stock_type, report_date: asOf }),
        ...(await alarmStmts(ctx, {
          kind: "BYPASS",
          outletId: v.outlet_id,
          title: "Allotment made in the DMS over a car this system is holding",
          body: `${vehicleLabel(v)} (${r.vin}) is allocated here to booking ${alloc.booking_no} and was allotted in the DMS to ${booking.booking_no}. The allocation stands: ${alloc.booking_no} keeps the car, and putting the DMS back in step is on the DMS update sheet.`,
          entityType: "vehicle",
          entityId: v.id,
        })),
      );
      s.orders.bypassed++;
      continue;
    }

    const ok = await step(async () => {
      const rec = allocRecord(r, v, booking, wasWaiting);
      // A car taken from the booking it was reserved for is out of turn by definition: that booking is the one passed over.
      if (alloc && !["INVOICED", "DELIVERED"].includes(alloc.booking_status)) {
        if (!rec.out_of_turn) s.orders.out_of_turn++;
        Object.assign(rec, { out_of_turn: 1, bypassed_booking_id: alloc.booking_id, bypassed_count: Math.max(1, Number(rec.bypassed_count)) });
      }
      const stmts: D1PreparedStatement[] = [];
      if (alloc) {
        // Bypass: the car was reserved for one customer and the DMS gave it to another. The reservation is undone and the first customer keeps their place.
        stmts.push(
          ...releaseStmts(uctx, alloc, "ALLOTTED_IN_DMS_TO_ANOTHER_BOOKING"),
          auditStmt(uctx, "BYPASS_DETECTED", "vehicle", v.id, { vin: r.vin, allocated_booking_no: alloc.booking_no, dms_booking_no: booking.booking_no, stock_type: r.stock_type }),
          ...(await alarmStmts(ctx, { kind: "BYPASS", outletId: v.outlet_id, title: "Car given to a different booking in the DMS", body: `${vehicleLabel(v)} (${r.vin}) was reserved for booking ${alloc.booking_no}, but the DMS shows it ${r.stock_type === "IBND" ? "invoiced" : "allotted"} to ${booking.booking_no}. Booking ${alloc.booking_no} is back in the queue with its place kept.`, entityType: "vehicle", entityId: v.id })),
        );
      }
      if (held) {
        // The system had chosen a different car for this booking and the DMS was given another. The
        // customer is no worse off, but a decision this system made was overturned somewhere else.
        stmts.push(...releaseStmts(uctx, held, "ALLOTTED_ANOTHER_CAR_IN_DMS"));
      }
      stmts.push(allocInsert(rec), bookingStatusStmt([{ id: booking.id, status: wanted, invoiced_at: invoicedAt }]), stmt(ctx.db, `UPDATE vehicles SET ever_allocated = 1 WHERE id = ? AND tenant_id = ?`, v.id, ctx.tenantId), auditStmt(uctx, "ALLOCATED", "booking", booking.id, { vehicle_id: v.id, vin: r.vin, source: "DMS", stock_type: r.stock_type, rule: "DMS_ALLOTMENT" }));
      await ctx.db.batch(stmts);
      // Recorded only once the change has actually applied: a batch that failed means the allotment
      // never happened, and there is nothing to answer for.
      // A decision this system made, overturned somewhere else — either the car it was holding for
      // this customer was swapped, or the car it was holding for someone else was taken for them.
      // Reaching here with an allocation in hand means the car was already invoiced or delivered,
      // so the sale stands and this is what the approvers are told about instead of a correction.
      // Without one, the allotment is the only decision there was: a violation while this system is
      // in control, and nothing at all before that or once the car is billed.
      const overturned = held || alloc;
      if (controlled && (overturned || r.stock_type === "ALLOTED")) {
        const common = { vin: r.vin, booking_no: booking.booking_no, customer_name: booking.customer_name, vehicle_id: v.id, outlet_id: v.outlet_id, report_date: asOf };
        if (held) violations.push({ kind: "OVERTURNED", booking_id: booking.id, detail: { ...common, instead_of_vehicle_id: held.vehicle_id, sold: r.stock_type === "IBND" } });
        if (alloc) violations.push({ kind: "OVERTURNED", booking_id: booking.id, detail: { ...common, taken_from_booking_no: alloc.booking_no, sold: r.stock_type === "IBND" } });
      }
      if (alloc) { allocByBooking.delete(alloc.booking_id); s.orders.bypassed++; }
      if (held) allocByVehicle.delete(held.vehicle_id);
      const mine: AllocRow = { id: String(rec.id), booking_id: booking.id, vehicle_id: v.id, source: "DMS", dms_confirmed_at: at, booking_no: booking.booking_no, booking_status: wanted, booking_source: booking.source };
      allocByVehicle.set(v.id, mine);
      allocByBooking.set(booking.id, mine);
      s.orders.recorded++;
    }, r.vin, r.row);
    if (!ok && budget <= 0) continue;
  }

  const sync: D1PreparedStatement[] = [];
  for (const part of chunk(stubs, 150)) {
    sync.push(
      stmt(
        ctx.db,
        `INSERT INTO bookings (id, tenant_id, outlet_id, booking_no, customer_name, customer_mobile, wa_opt_in, variant_id, model, variant, colour, booking_date, priority_ts, booking_amount, status, invoiced_at, source,
                               description, oem_model_code, paint_alias, dms_colour, seating, sc_name, approved_by, approved_at, created_by, created_at, updated_at)
         SELECT ${jx("id")}, ?2, ${jx("outlet_id")}, ${jx("booking_no")}, ${jx("customer_name")}, '', 0, ${jx("variant_id")}, ${jx("model")}, ${jx("variant")}, ${jx("colour")}, ${jx("booking_date")}, ${jx("priority_ts")}, 0, ${jx("status")}, ${jx("invoiced_at")}, 'DMS_STOCK',
                ${jx("description")}, ${jx("oem_model_code")}, ${jx("paint_alias")}, ${jx("dms_colour")}, ${jx("seating")}, ${jx("sc_name")}, ?3, ?4, ?3, ?4, ?4 FROM json_each(?1) AS j WHERE true
         ON CONFLICT (tenant_id, booking_no) DO NOTHING`,
        JSON.stringify(part), ctx.tenantId, uctx.actor, at,
      ),
    );
  }
  for (const part of chunk(newAllocs, 150)) sync.push(allocInsert(part as unknown as Record<string, unknown>));
  for (const part of chunk(bookingStatus, 200)) sync.push(bookingStatusStmt(part));
  if (confirms.length) sync.push(stmt(ctx.db, `UPDATE allocations SET dms_confirmed_at = ?2 WHERE tenant_id = ?1 AND status = 'ACTIVE' AND dms_confirmed_at IS NULL AND id IN (SELECT value FROM json_each(?3))`, ctx.tenantId, at, JSON.stringify(confirms)));
  if (allocatedCars.length) sync.push(stmt(ctx.db, `UPDATE vehicles SET ever_allocated = 1 WHERE tenant_id = ?1 AND id IN (SELECT value FROM json_each(?2))`, ctx.tenantId, JSON.stringify(allocatedCars)));
  for (const part of chunk(audits, 300)) sync.push(stmt(ctx.db, `INSERT INTO audit_log (id, tenant_id, actor, action, entity_type, entity_id, detail_json, at) SELECT ${jx("id")}, ?2, ?3, ${jx("action")}, 'booking', ${jx("entity_id")}, ${jx("detail")}, ?4 FROM json_each(?1) AS j`, JSON.stringify(part), ctx.tenantId, uctx.actor, at));
  if (violations.length) {
    // Allotments made outside this system on a day it was the one in control. Each is recorded
    // against its booking, and the people who approve a car being taken back are told — they are the
    // ones who would have had to agree to it had it come through here.
    for (const part of chunk(violations.map((x) => ({ id: newId("aud"), entity_id: x.booking_id, detail: JSON.stringify({ ...x.detail, violation: x.kind }) })), 300)) {
      sync.push(stmt(ctx.db, `INSERT INTO audit_log (id, tenant_id, actor, action, entity_type, entity_id, detail_json, at) SELECT ${jx("id")}, ?2, ?3, 'ALLOTTED_OUTSIDE_SYSTEM', 'booking', ${jx("entity_id")}, ${jx("detail")}, ?4 FROM json_each(?1) AS j`, JSON.stringify(part), ctx.tenantId, uctx.actor, at));
    }
    sync.push(...refused);
    const by = (k: string) => violations.filter((x) => x.kind === k).length;
    const parts = [
      by("REFUSED") && `${by("REFUSED")} over a car this system is holding, which keeps it`,
      by("OVERTURNED") && `${by("OVERTURNED")} where a car this system had allocated was already sold elsewhere`,
      by("UNKNOWN_BOOKING") && `${by("UNKNOWN_BOOKING")} for a booking this system had never seen`,
      by("NOT_THROUGH_SYSTEM") && `${by("NOT_THROUGH_SYSTEM")} for a booking that was waiting in the queue here`,
    ].filter(Boolean);
    sync.push(
      ...ctx.settings.release_approver_roles.map((role) =>
        alertStmt(ctx, {
          targetRole: role,
          kind: "OUTSIDE_SYSTEM_ALLOTMENT",
          title: `${violations.length} car${violations.length === 1 ? "" : "s"} allotted outside the system`,
          body: `The stock report as on ${asOf} shows ${violations.length} allotment${violations.length === 1 ? "" : "s"} that did not come through this system: ${parts.join("; ")}. Allocation is this system's to decide, so a car it is holding keeps its customer and the DMS is put back in step from the DMS update sheet. One already invoiced or delivered stands, because that sale has happened. The day-end check lists each one.`,
          entityType: "recon",
          entityId: upload.id,
          isAlarm: true,
        }),
      ),
    );
  }
  if (reversedBookings.length) {
    // The retail invoice was cancelled in the DMS: the booking holds its car again and the payment window restarts.
    sync.push(
      stmt(ctx.db, `UPDATE bookings SET status = 'ALLOCATED', invoiced_at = NULL, updated_at = ?2 WHERE tenant_id = ?1 AND status = 'INVOICED' AND id IN (SELECT value FROM json_each(?3))`, ctx.tenantId, at, JSON.stringify(reversedBookings)),
      stmt(ctx.db, `UPDATE allocations SET clock_started_at = ?2, reminder_sent_at = NULL, escalated_at = NULL WHERE tenant_id = ?1 AND status = 'ACTIVE' AND booking_id IN (SELECT value FROM json_each(?3))`, ctx.tenantId, at, JSON.stringify(reversedBookings)),
      ...(await alarmStmts(ctx, { kind: "INVOICE_REVERSED", title: "Retail invoice cancelled in the DMS", body: `${reversedBookings.length} car(s) that the DMS showed as invoiced are no longer invoiced in the report as on ${asOf}. Their bookings hold the cars again.` })),
    );
  }
  if (outOfTurn.length) {
    sync.push(...(await alarmStmts(ctx, { kind: "OUT_OF_TURN", title: "Cars allotted in the DMS ahead of earlier bookings", body: `The stock report as on ${asOf} shows ${outOfTurn.length} car(s) allotted to a booking while an earlier booking for the same car was waiting: ${outOfTurn.slice(0, 5).join("; ")}${outOfTurn.length > 5 ? "; ..." : ""}. They are listed under Out-of-turn allocations for review.` })));
  }
  if (sync.length) {
    try {
      for (const part of chunk(sync, 20)) await ctx.db.batch(part);
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      // Someone reserved one of these cars or bookings while the file was being read. Nothing of this step was written; loading again settles it.
      throw conflict("Reservations changed while the report was being loaded. Load the same file again.");
    }
  }

  // ---- phase C: cars that are no longer in a complete report
  if (gone.length) {
    const delivered = gone.filter((v) => v.status === "INVOICED");
    const reserved = gone.filter((v) => v.status !== "INVOICED" && allocByVehicle.has(v.id));
    const free = gone.filter((v) => v.status !== "INVOICED" && !allocByVehicle.has(v.id));
    const leftAt = reportInstant(asOf, tz);
    const out: D1PreparedStatement[] = [];
    if (delivered.length) {
      // An invoiced car (IBND: invoiced, not delivered) that leaves the stock report has been delivered.
      const ids = JSON.stringify(delivered.map((v) => v.id));
      out.push(
        stmt(ctx.db, `UPDATE bookings SET status = 'DELIVERED', delivered_at = ?2, updated_at = ?3 WHERE tenant_id = ?1 AND status = 'INVOICED' AND id IN (SELECT booking_id FROM allocations WHERE tenant_id = ?1 AND status = 'ACTIVE' AND vehicle_id IN (SELECT value FROM json_each(?4)))`, ctx.tenantId, leftAt, at, ids),
        stmt(ctx.db, `UPDATE allocations SET status = 'FULFILLED', fulfilled_at = ?2 WHERE tenant_id = ?1 AND status = 'ACTIVE' AND vehicle_id IN (SELECT value FROM json_each(?3))`, ctx.tenantId, leftAt, ids),
        stmt(ctx.db, `UPDATE vehicles SET status = 'DELIVERED', delivered_at = ?2, left_stock_on = ?3, updated_at = ?4 WHERE tenant_id = ?1 AND id IN (SELECT value FROM json_each(?5))`, ctx.tenantId, leftAt, asOf, at, ids),
        stmt(ctx.db, `INSERT INTO vehicle_events (id, tenant_id, vehicle_id, type, from_status, to_status, detail_json, actor, at) SELECT ${jx("id")}, ?2, ${jx("vehicle_id")}, 'DELIVERED', 'INVOICED', 'DELIVERED', ?3, ?4, ?5 FROM json_each(?1) AS j`, JSON.stringify(delivered.map((v) => ({ id: newId("vev"), vehicle_id: v.id }))), ctx.tenantId, JSON.stringify({ reason: "Invoiced car no longer in the stock report", report_date: asOf }), uctx.actor, at),
      );
      s.left_stock.delivered += delivered.length;
    }
    if (free.length) {
      const ids = JSON.stringify(free.map((v) => v.id));
      out.push(
        stmt(ctx.db, `UPDATE vehicles SET status = 'REMOVED', left_stock_on = ?2, updated_at = ?3 WHERE tenant_id = ?1 AND id IN (SELECT value FROM json_each(?4))`, ctx.tenantId, asOf, at, ids),
        stmt(ctx.db, `INSERT INTO vehicle_events (id, tenant_id, vehicle_id, type, from_status, to_status, detail_json, actor, at) SELECT ${jx("id")}, ?2, ${jx("vehicle_id")}, 'REMOVED', ${jx("from")}, 'REMOVED', ?3, ?4, ?5 FROM json_each(?1) AS j`, JSON.stringify(free.map((v) => ({ id: newId("vev"), vehicle_id: v.id, from: v.status }))), ctx.tenantId, JSON.stringify({ reason: "Not in the stock report", report_date: asOf }), uctx.actor, at),
      );
      s.left_stock.removed += free.length;
    }
    for (const part of chunk(out, 20)) await ctx.db.batch(part);
    for (const v of reserved) {
      const alloc = allocByVehicle.get(v.id)!;
      await step(async () => {
        const invoiced = alloc.booking_status === "INVOICED";
        const carGone = [
          stmt(ctx.db, `UPDATE vehicles SET status = ?, delivered_at = ?, left_stock_on = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`, invoiced ? "DELIVERED" : "REMOVED", invoiced ? leftAt : null, asOf, at, v.id, ctx.tenantId),
          stmt(ctx.db, `INSERT INTO vehicle_events (id, tenant_id, vehicle_id, type, from_status, to_status, detail_json, actor, at) VALUES (?,?,?,?,?,?,?,?,?)`, newId("vev"), ctx.tenantId, v.id, invoiced ? "DELIVERED" : "REMOVED", v.status, invoiced ? "DELIVERED" : "REMOVED", JSON.stringify({ reason: "Not in the stock report", report_date: asOf, booking_no: alloc.booking_no }), uctx.actor, at),
        ];
        if (invoiced) {
          // The booking is invoiced and its car has left stock: delivered.
          await ctx.db.batch([
            ...carGone,
            stmt(ctx.db, `UPDATE bookings SET status = 'DELIVERED', delivered_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND status = 'INVOICED'`, leftAt, at, alloc.booking_id, ctx.tenantId),
            stmt(ctx.db, `UPDATE allocations SET status = 'FULFILLED', fulfilled_at = ? WHERE id = ? AND tenant_id = ? AND status = 'ACTIVE'`, leftAt, alloc.id, ctx.tenantId),
            auditStmt(uctx, "DELIVERED", "booking", alloc.booking_id, { vehicle_id: v.id, vin: v.vin, basis: "Car no longer in the stock report", report_date: asOf }),
          ]);
          s.left_stock.delivered++;
        } else {
          // The car left stock while reserved and its booking is not invoiced. The booking is held, not given another car, until a booking sheet or a person settles it.
          await releaseAllocation(uctx, alloc, "CAR_LEFT_STOCK", {
            reallocate: false,
            hold: { reason: "CAR_LEFT_STOCK", until: null },
            also: [...carGone, ...(await alarmStmts(ctx, { kind: "CAR_LEFT_STOCK", outletId: v.outlet_id, title: "A reserved car has left stock", body: `${vehicleLabel(v)} (${v.vin}) was reserved for booking ${alloc.booking_no} and is not in the stock report as on ${asOf}, and the booking is not invoiced. The booking is on hold: load the latest booking sheet, or check what happened to the car.`, entityType: "booking", entityId: alloc.booking_id }))],
          });
          s.left_stock.on_hold++;
        }
        allocByVehicle.delete(v.id);
      }, v.vin, 0);
    }
  }

  // ---- afterwards
  if (!result.more) {
    await refreshBookingColours(ctx);
    result.allocations = (await allocateAll(ctx, ALLOCATE_AFTER_LOAD)).length;
    await recordStockPositions(ctx, "STOCK_REPORT");

    // What was supposed to have been keyed into the DMS and has not been.
    //
    // A decision made since the last report has simply not had its turn yet, and saying so would be
    // noise every single day. One made *before* the last report and still absent from this one has
    // had a whole cycle of the DMS to appear in and has not: somebody was given the list and it did
    // not get done. That is the difference between "not yet" and "it did not happen", and only the
    // second is worth anybody's attention.
    //
    // Measured against the previous report rather than against a download, because a download says
    // the list left the building and nothing more.
    const previous = await first<{ report_date: string }>(
      ctx.db,
      `SELECT report_date FROM uploads WHERE tenant_id = ? AND kind = 'STOCK' AND status = 'DONE' AND id <> ? AND report_date IS NOT NULL ORDER BY report_date DESC LIMIT 1`,
      ctx.tenantId, upload.id,
    );
    if (previous?.report_date) {
      // The allocation has to pre-date the previous report's own day, not merely its noon: one made
      // on the morning of that day went in alongside the report and has had no cycle to appear in.
      const cut = localDayBounds(previous.report_date, tz).start;
      const stale = await all<{ allocated_at: string }>(
        ctx.db,
        `SELECT a.allocated_at FROM allocations a
           JOIN bookings b ON b.id = a.booking_id
           JOIN vehicles v ON v.id = a.vehicle_id
          WHERE a.tenant_id = ?1 AND a.status = 'ACTIVE' AND a.source <> 'DMS' AND a.allocated_at < ?2
            AND (v.dms_booking_no IS NULL OR v.dms_booking_no <> b.booking_no)`,
        ctx.tenantId, cut,
      );
      if (stale.length) {
        const oldest = stale.reduce((d, x) => (x.allocated_at < d ? x.allocated_at : d), stale[0].allocated_at);
        const days = Math.max(0, Math.round((Date.parse(reportInstant(asOf, tz)) - Date.parse(oldest)) / 86_400_000));
        s.not_keyed_in = { cars: stale.length, oldest_days: days };
        await ctx.db.batch([
          auditStmt(uctx, "DMS_UPDATES_NOT_KEYED_IN", "tenant", ctx.tenantId, { cars: stale.length, oldest_days: days, since: previous.report_date, report_date: asOf }),
          ...(await alarmStmts(ctx, {
            kind: "OUTSIDE_SYSTEM_ALLOTMENT",
            title: `${stale.length} allocation${stale.length === 1 ? "" : "s"} still not in the DMS`,
            body: `${stale.length} car${stale.length === 1 ? "" : "s"} allocated here before the stock report of ${previous.report_date} still do not show against those bookings in the report as on ${asOf}; the oldest has waited ${days} day${days === 1 ? "" : "s"}. They were on the DMS update sheet and have not been keyed in. Until they are, the DMS can give those cars to somebody else.`,
            entityType: "recon",
            entityId: upload.id,
          })),
        ]);
      }
    }
  }
  addInto(s, upload.prior, ["new_cars", "received", "invoiced", "returned", "left_stock.delivered", "left_stock.removed", "left_stock.on_hold", "orders.recorded", "orders.confirmed", "orders.bypassed", "orders.released_in_dms", "orders.out_of_turn", "variants_added"]);
  if (upload.continued) s.outlets_created = [...new Set([...(upload.prior.outlets_created ?? []), ...s.outlets_created])];
  await saveUpload(ctx, upload, result, mode, opts.filename, [...outletsInFile], upload.prior);
  ctx.cache.delete("data_status");
  return result;
}

export const STOCK_ISSUE_LABELS = STOCK_ISSUES;

// ---------------------------------------------------------------- booking sheet

interface BookingRow {
  id: string; booking_no: string; outlet_id: string; status: string; source: string; variant_id: string | null; model: string; variant: string; colour: string;
  customer_name: string; customer_mobile: string; booking_date: string; booking_amount: number; sales_exec_id: string | null; on_hold: number; hold_reason: string | null;
  description: string | null; oem_model_code: string | null; paint_alias: string; dms_colour: string | null; seating: string | null; dms_stage: string | null; dms_enquiry_stage: string | null;
  dms_ref: string | null; enquiry_no: string | null; sc_name: string | null; sc_code: string | null; sm_name: string | null; cancel_reason: string | null;
}

const B_FIELDS = ["outlet_id", "customer_name", "customer_mobile", "wa_opt_in", "variant_id", "model", "variant", "colour", "booking_date", "priority_ts", "booking_amount", "sales_exec_id", "source",
  "description", "oem_model_code", "paint_alias", "dms_colour", "seating", "dms_stage", "dms_enquiry_stage", "dms_ref", "enquiry_no", "sc_name", "sc_code", "sm_name"] as const;

export async function importBookingSheet(
  ctx: Ctx,
  bytes: Uint8Array,
  opts: { filename?: string; outletScope?: string[] | null; continueUpload?: string | null } = {},
): Promise<DmsUploadResult> {
  const tz = ctx.tenant.timezone;
  const scope = opts.outletScope ?? null;
  const sheetDate = today(ctx);
  const sheet = adapterFor(ctx).readBookingSheet(await readExport(bytes, opts.filename), { timeZone: tz });
  if (sheet.rows.length > MAX_ROWS) throw bad(`The sheet has more than ${MAX_ROWS} bookings; split it`);
  await checkDealer(ctx, sheet.dealer_name);
  const upload = await startUpload(ctx, "BOOKINGS", opts.continueUpload);
  const uctx: Ctx = { ...ctx, actor: `UPLOAD:${upload.id}` };
  const at = iso(ctx.now);
  const errors: RowError[] = [...sheet.errors];

  const { byCode: outletByCode, created: outletsCreated } = await outletsFor(ctx, new Map(sheet.rows.map((r) => [r.outlet_code, r.outlet_name])), scope, sheet.outlet_by);
  let rows = sheet.rows.filter((r) => {
    const id = outletByCode.get(r.outlet_code);
    if (!id) {
      // This export names its outlets and gives no codes, so one it names that the system does not
      // hold cannot be created from the file: it would be a second outlet for the same branch.
      errors.push({
        row: r.row,
        key: r.booking_no,
        message: sheet.outlet_by === "name"
          ? `There is no outlet called ${r.outlet_name}. Load the stock report, which names the outlets with their codes, or have the administrator add it.`
          : `Outlet ${r.outlet_code} (${r.outlet_name}) is not set up; ask the administrator to load this sheet once`,
      });
      return false;
    }
    if (scope && !scope.includes(id)) { errors.push({ row: r.row, key: r.booking_no, message: `Outlet ${r.outlet_code} is not one of your outlets` }); return false; }
    if (r.booking_date > new Date(ctx.now.getTime() + 86_400_000).toISOString()) { errors.push({ row: r.row, key: r.booking_no, message: "Created Date is in the future" }); return false; }
    return true;
  });

  const reg = await registerDmsCars(ctx, rows.map((r): DmsCarInput => ({ ...r, fuel_source: r.fuel ? "Booking sheet (Fuel Type)" : undefined })));
  let master = await loadMaster(ctx, true);
  await registerColours(ctx, rows.map((r) => ({ model: r.model, colour: bookingColour(master, r) })));
  master = await loadMaster(ctx, true);

  const numbers = JSON.stringify(rows.map((r) => r.booking_no));
  const existing = new Map((await all<BookingRow>(ctx.db, `SELECT * FROM bookings WHERE tenant_id = ? AND booking_no IN (SELECT value FROM json_each(?))`, ctx.tenantId, numbers)).map((b) => [b.booking_no, b]));
  const allocs = await all<{ id: string; booking_id: string; vehicle_id: string; vehicle_status: string; model: string; variant: string; colour: string }>(
    ctx.db,
    `SELECT a.id, a.booking_id, a.vehicle_id, v.status AS vehicle_status, v.model, v.variant, v.colour FROM allocations a JOIN vehicles v ON v.id = a.vehicle_id WHERE a.tenant_id = ? AND a.status = 'ACTIVE'`,
    ctx.tenantId,
  );
  const allocByBooking = new Map(allocs.map((a) => [a.booking_id, a]));
  const execByCode = new Map((await all<{ id: string; dms_code: string }>(ctx.db, `SELECT id, dms_code FROM users WHERE tenant_id = ? AND dms_code IS NOT NULL AND dms_code <> '' AND is_active = 1`, ctx.tenantId)).map((u) => [norm(u.dms_code), u.id]));

  const count = (st: BookingSheetRow["stage"]) => sheet.rows.filter((r) => r.stage === st).length;
  const s: BookingSummary = {
    dealer_name: sheet.dealer_name, sheet_date: sheetDate,
    bookings: sheet.rows.length, booked: count("BOOKED"), invoiced: count("INVOICED"), delivered: count("DELIVERED"), cancelled: count("CANCELLED"),
    new_bookings: 0, entered_queue: 0, cancelled_now: 0, cars_released: 0, invoiced_now: 0, delivered_now: 0, details_completed: 0,
    outlets_created: outletsCreated, variants_added: reg.added, not_recognised: sheet.rows.filter((r) => !r.parsed).length,
    consultants_not_linked: new Set(sheet.rows.filter((r) => r.sc_code && !execByCode.has(r.sc_code)).map((r) => r.sc_code)).size,
    master_conflicts: reg.conflicts,
  };
  const result: DmsUploadResult = { upload_id: upload.id, kind: "BOOKINGS", report_date: sheetDate, more: false, row_count: sheet.rows.length, created: 0, updated: 0, unchanged: 0, errors, allocations: 0, summary: s };

  const queueStatus = ctx.settings.import_bookings_as_approved ? "APPROVED" : "SUBMITTED";
  const inserts: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const audits: Record<string, unknown>[] = [];
  const cancels: { row: BookingSheetRow; b: BookingRow }[] = [];
  const kept: BookingSheetRow[] = [];
  for (const r of rows) {
    const variant = reg.byKey.get(keyOf(r.variant));
    if (!variant) { errors.push({ row: r.row, key: r.booking_no, message: `Variant ${r.variant} could not be registered in the vehicle master` }); continue; }
    const colour = bookingColour(master, r);
    if (!colour) { errors.push({ row: r.row, key: r.booking_no, message: "Colour is blank" }); continue; }
    const cur = existing.get(r.booking_no);
    if (cur && scope && !scope.includes(cur.outlet_id)) { errors.push({ row: r.row, key: r.booking_no, message: "This booking belongs to an outlet that is not one of yours" }); continue; }
    kept.push(r);
    const outletId = outletByCode.get(r.outlet_code)!;
    const execId = r.sc_code ? execByCode.get(r.sc_code) ?? null : null;
    const fields: Record<(typeof B_FIELDS)[number], unknown> = {
      outlet_id: outletId, customer_name: r.customer_name, customer_mobile: r.customer_mobile ?? cur?.customer_mobile ?? "", wa_opt_in: r.customer_mobile ? 1 : 0,
      variant_id: variant.id, model: variant.model, variant: variant.variant, colour,
      booking_date: r.booking_date, priority_ts: r.booking_date, booking_amount: r.booking_amount, sales_exec_id: execId ?? cur?.sales_exec_id ?? null, source: "DMS",
      description: r.description, oem_model_code: r.oem_model_code || null, paint_alias: r.paint_alias, dms_colour: r.dms_colour, seating: r.seater || null,
      dms_stage: r.dms_stage, dms_enquiry_stage: r.dms_enquiry_stage, dms_ref: r.dms_ref, enquiry_no: r.enquiry_no, sc_name: r.sc_name, sc_code: r.sc_code, sm_name: r.sm_name,
    };
    // Only worth saying where the export has a phone column and this row's is unusable. One of the
    // two booking exports carries no phone numbers at all, and saying so on every row of it would
    // bury the errors that are about this dealership's data rather than about the file's shape.
    if (!r.customer_mobile && !cur && sheet.has_mobile) errors.push({ row: r.row, key: r.booking_no, message: "Customer mobile number is not valid; the booking was loaded, but this customer will not receive WhatsApp messages" });

    if (!cur) {
      const status = r.stage === "BOOKED" ? queueStatus : r.stage;
      inserts.push({
        id: newId("bkg"), booking_no: r.booking_no, ...fields, status,
        submitted_at: at, approved_by: status === "SUBMITTED" ? null : uctx.actor, approved_at: status === "SUBMITTED" ? null : at,
        invoiced_at: r.stage === "INVOICED" || r.stage === "DELIVERED" ? at : null, delivered_at: r.stage === "DELIVERED" ? at : null,
        cancelled_at: r.stage === "CANCELLED" ? at : null, cancel_reason: r.stage === "CANCELLED" ? "Cancelled in DMS" : null,
      });
      s.new_bookings++;
      if (status === "APPROVED") s.entered_queue++;
      result.created++;
      continue;
    }

    const alloc = allocByBooking.get(cur.id);
    const fromStock = cur.source === "DMS_STOCK";
    // The car booked may change in the DMS while a booking waits. Once it holds a car, a different description is reported, not applied.
    const configChanged = cur.model !== variant.model || cur.variant !== variant.variant || cur.colour !== colour;
    if (configChanged && alloc) {
      Object.assign(fields, { variant_id: cur.variant_id, model: cur.model, variant: cur.variant, colour: cur.colour });
      if (alloc.model !== variant.model || alloc.variant !== variant.variant) errors.push({ row: r.row, key: r.booking_no, message: `The sheet has this booking for ${vehicleLabel({ model: variant.model, variant: variant.variant, colour })}, but it holds a ${vehicleLabel(alloc)}. The booking was not changed; check it.` });
    }
    // A booking created in the app keeps its own date and place in the queue; one first known from a stock report takes the sheet's.
    if (!fromStock && cur.source !== "DMS") Object.assign(fields, { booking_date: cur.booking_date, priority_ts: undefined, source: cur.source });
    if (cur.source === "DMS") fields.priority_ts = undefined; // an approved change of priority is not undone by a reload
    const changedFields = B_FIELDS.filter((f) => fields[f] !== undefined && (cur as unknown as Record<string, unknown>)[f] !== fields[f] && f !== "wa_opt_in");

    // Stage.
    let status = cur.status;
    let note: string | null = null;
    const open = ["DRAFT", "SUBMITTED", "APPROVED", "ALLOCATED", "REJECTED"].includes(cur.status);
    if (r.stage === "CANCELLED") {
      if (open) { cancels.push({ row: r, b: cur }); }
      else if (cur.status !== "CANCELLED") errors.push({ row: r.row, key: r.booking_no, message: `The sheet shows this booking as cancelled, but the system has it as ${cur.status.toLowerCase()} (from the stock report or an entry in the app). Nothing was changed; check it.` });
    } else if (r.stage === "INVOICED" || r.stage === "DELIVERED") {
      // While the booking's car is still in stock the booking is at most invoiced; it becomes delivered when the car leaves the stock report.
      const carInStock = alloc && ["IN_TRANSIT", "RECEIVED", "INVOICED"].includes(alloc.vehicle_status);
      const target = r.stage === "DELIVERED" && !carInStock ? "DELIVERED" : "INVOICED";
      if (open || (cur.status === "INVOICED" && target === "DELIVERED")) status = target;
      else if (cur.status === "CANCELLED") { status = target; note = "The system had this booking as cancelled; the sheet shows it invoiced, and the sheet was followed."; }
    } else if (r.stage === "BOOKED") {
      if (cur.status === "CANCELLED") errors.push({ row: r.row, key: r.booking_no, message: "The sheet shows this booking as Booked, but it is cancelled in the system. It was left cancelled; if the cancellation was withdrawn, enter the booking again." });
      else if (fromStock && cur.status === "APPROVED" && cur.on_hold && cur.hold_reason === "NOT_IN_BOOKING_SHEET") note = "Details completed from the booking sheet; the booking is waiting again.";
    }
    if (note && r.stage !== "BOOKED") errors.push({ row: r.row, key: r.booking_no, message: note });
    const statusChanged = status !== cur.status;
    const unhold = Boolean(note && r.stage === "BOOKED") || (statusChanged && cur.on_hold);
    if (r.stage === "CANCELLED" && open) {
      // Cancelled below, with the release of its car. What the sheet says about the booking (its stage, consultant, amount) is recorded now, so the same sheet loaded again finds nothing to change.
      if (changedFields.length) updates.push({ id: cur.id, ...Object.fromEntries(B_FIELDS.map((f) => [f, fields[f] === undefined ? (cur as unknown as Record<string, unknown>)[f] ?? null : fields[f]])), status: cur.status, unhold: 0, invoiced: 0, delivered: 0 });
      continue;
    }
    if (!changedFields.length && !statusChanged && !unhold) { result.unchanged++; continue; }
    result.updated++;
    if (fromStock) s.details_completed++;
    if (statusChanged && status === "INVOICED") s.invoiced_now++;
    if (statusChanged && status === "DELIVERED") s.delivered_now++;
    updates.push({ id: cur.id, ...Object.fromEntries(B_FIELDS.map((f) => [f, fields[f] === undefined ? (cur as unknown as Record<string, unknown>)[f === "priority_ts" ? "priority_ts" : f] ?? null : fields[f]])), status, unhold: unhold ? 1 : 0, invoiced: statusChanged && (status === "INVOICED" || status === "DELIVERED") ? 1 : 0, delivered: statusChanged && status === "DELIVERED" ? 1 : 0 });
    if (statusChanged) audits.push({ id: newId("aud"), entity_id: cur.id, action: status === "DELIVERED" ? "DELIVERED" : "INVOICED", detail: JSON.stringify({ source: "DMS booking sheet", dms_stage: r.dms_stage, dms_enquiry_stage: r.dms_enquiry_stage, previous: cur.status }) });
    else if (changedFields.some((f) => ["model", "variant", "colour", "outlet_id", "customer_mobile", "customer_name"].includes(f))) audits.push({ id: newId("aud"), entity_id: cur.id, action: "BOOKING_UPDATED_FROM_DMS", detail: JSON.stringify(Object.fromEntries(changedFields.map((f) => [f, fields[f]]))) });
  }
  rows = kept;

  const insertCols = ["id", "booking_no", ...B_FIELDS, "status", "submitted_at", "approved_by", "approved_at", "invoiced_at", "delivered_at", "cancelled_at", "cancel_reason"];
  const writes: D1PreparedStatement[] = [];
  for (const part of chunk(inserts, 120)) {
    writes.push(stmt(ctx.db, `INSERT INTO bookings (${insertCols.join(", ")}, tenant_id, sheet_date, created_by, created_at, updated_at) SELECT ${insertCols.map(jx).join(", ")}, ?2, ?3, ?4, ?5, ?5 FROM json_each(?1) AS j WHERE true ON CONFLICT (tenant_id, booking_no) DO NOTHING`, JSON.stringify(part), ctx.tenantId, sheetDate, uctx.actor, at));
  }
  for (const part of chunk(updates, 120)) {
    writes.push(
      stmt(
        ctx.db,
        `UPDATE bookings SET ${B_FIELDS.filter((f) => f !== "wa_opt_in").map((f) => `${f} = ${jx(f)}`).join(", ")}, status = ${jx("status")},
           invoiced_at = CASE WHEN ${jx("invoiced")} = 1 THEN COALESCE(invoiced_at, ?3) ELSE invoiced_at END,
           delivered_at = CASE WHEN ${jx("delivered")} = 1 THEN COALESCE(delivered_at, ?3) ELSE delivered_at END,
           cancelled_at = CASE WHEN ${jx("status")} = 'CANCELLED' THEN cancelled_at ELSE NULL END,
           on_hold = CASE WHEN ${jx("unhold")} = 1 THEN 0 ELSE on_hold END, hold_reason = CASE WHEN ${jx("unhold")} = 1 THEN NULL ELSE hold_reason END, hold_until = CASE WHEN ${jx("unhold")} = 1 THEN NULL ELSE hold_until END,
           updated_at = ?3
         FROM json_each(?1) AS j WHERE bookings.id = ${jx("id")} AND bookings.tenant_id = ?2`,
        JSON.stringify(part), ctx.tenantId, at,
      ),
    );
  }
  for (const part of chunk(audits, 300)) writes.push(stmt(ctx.db, `INSERT INTO audit_log (id, tenant_id, actor, action, entity_type, entity_id, detail_json, at) SELECT ${jx("id")}, ?2, ?3, ${jx("action")}, 'booking', ${jx("entity_id")}, ${jx("detail")}, ?4 FROM json_each(?1) AS j`, JSON.stringify(part), ctx.tenantId, uctx.actor, at));
  // Every booking in the sheet is marked as seen in it; a reservation whose booking changed outlet may now need a transfer.
  writes.push(stmt(ctx.db, `UPDATE bookings SET sheet_date = ?2 WHERE tenant_id = ?1 AND booking_no IN (SELECT value FROM json_each(?3)) AND (sheet_date IS NULL OR sheet_date <> ?2)`, ctx.tenantId, sheetDate, JSON.stringify(rows.map((r) => r.booking_no))));
  writes.push(stmt(ctx.db, `UPDATE allocations SET needs_transfer = (SELECT CASE WHEN b.outlet_id = v.outlet_id THEN 0 ELSE 1 END FROM bookings b, vehicles v WHERE b.id = allocations.booking_id AND v.id = allocations.vehicle_id) WHERE tenant_id = ?1 AND status = 'ACTIVE' AND booking_id IN (SELECT id FROM bookings WHERE tenant_id = ?1 AND booking_no IN (SELECT value FROM json_each(?2)))`, ctx.tenantId, JSON.stringify(updates.length ? rows.map((r) => r.booking_no) : [])));
  // An invoiced booking with no car left in stock is closed; a reservation for a car that has left stock is fulfilled with it.
  for (const part of chunk(writes, 20)) await ctx.db.batch(part);

  // ---- cancellations: the booking is cancelled and its car, if it holds one, is freed for the next customer
  let budget = STEP_BUDGET;
  const plain = cancels.filter((c) => !allocByBooking.has(c.b.id));
  if (plain.length) {
    const ids = JSON.stringify(plain.map((c) => c.b.id));
    await ctx.db.batch([
      stmt(ctx.db, `UPDATE bookings SET status = 'CANCELLED', cancelled_at = ?2, cancel_reason = 'Cancelled in DMS', on_hold = 0, hold_reason = NULL, hold_until = NULL, dms_stage = 'Cancellation Initiated', updated_at = ?2 WHERE tenant_id = ?1 AND status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED') AND id IN (SELECT value FROM json_each(?3))`, ctx.tenantId, at, ids),
      stmt(ctx.db, `UPDATE alerts SET read_at = ?2 WHERE tenant_id = ?1 AND kind = 'BOOKING_APPROVAL' AND read_at IS NULL AND entity_id IN (SELECT value FROM json_each(?3))`, ctx.tenantId, at, ids),
      stmt(ctx.db, `INSERT INTO audit_log (id, tenant_id, actor, action, entity_type, entity_id, detail_json, at) SELECT ${jx("id")}, ?2, ?3, 'BOOKING_CANCELLED', 'booking', ${jx("entity_id")}, ?4, ?5 FROM json_each(?1) AS j`, JSON.stringify(plain.map((c) => ({ id: newId("aud"), entity_id: c.b.id }))), ctx.tenantId, uctx.actor, JSON.stringify({ reason: "Cancelled in DMS" }), at),
    ]);
    s.cancelled_now += plain.length;
    result.updated += plain.length;
  }
  for (const c of cancels.filter((x) => allocByBooking.has(x.b.id))) {
    if (budget-- <= 0) { result.more = true; break; }
    try {
      // Cancelling and freeing the car are one step; the freed car is offered to the next booking in line straight away.
      const out = await cancelBooking(uctx, c.b.id, "Cancelled in DMS");
      s.cancelled_now++;
      s.cars_released++;
      result.updated++;
      result.allocations += out.allocations.length;
    } catch (e) {
      errors.push({ row: c.row.row, key: c.b.booking_no, message: (e as Error).message });
    }
  }

  if (!result.more) {
    await refreshBookingColours(ctx);
    result.allocations += (await allocateAll(ctx, ALLOCATE_AFTER_LOAD)).length;
    await recordStockPositions(ctx, "BOOKING_SHEET");
  }
  addInto(s, upload.prior, ["new_bookings", "entered_queue", "cancelled_now", "cars_released", "invoiced_now", "delivered_now", "details_completed", "variants_added"]);
  if (upload.continued) s.outlets_created = [...new Set([...(upload.prior.outlets_created ?? []), ...s.outlets_created])];
  await saveUpload(ctx, upload, result, "UPDATE", opts.filename, [...new Set(rows.map((r) => outletByCode.get(r.outlet_code)!))], upload.prior);
  ctx.cache.delete("data_status");
  return result;
}

// ---------------------------------------------------------------- retail invoice export

export interface RetailSummary {
  invoices: { total: number; new: number; changed: number; unchanged: number; withdrawn: number };
  money: { invoiced: number; selling: number; oem_discount: number; dealer_discount: number; unclaimed_discount: number };
  attached: { financed: number; dealer_arranged: number; insured: number; exchanged: number; delivered: number };
  issues: Record<string, number>;
  /** Claim columns the file leaves blank throughout, so nothing was read from their being empty. */
  claims_not_stated: string[];
  outlets_created: string[];
}

/**
 * Reads the retail invoice export.
 *
 * The file is the dealership's retail for a period, not a position, so nothing is inferred from a
 * row's absence except one thing: an invoice this system has seen before, in a period the new file
 * also covers, that the new file no longer lists. The DMS fills no cancellation column ever, so an
 * invoice disappearing is the only way a withdrawal is ever visible. The row is marked rather than
 * deleted, because an invoice that was withdrawn is a thing that happened.
 *
 * Nothing here allocates, releases or changes a booking. The stock report is what moves cars; this
 * file says what the dealership earned on them, and reading it must not be able to disturb the
 * allocation its own numbers describe.
 */
export async function importRetailExport(
  ctx: Ctx,
  bytes: Uint8Array,
  opts: { filename?: string; reportDate?: string | null; outletScope?: string[] | null; continueUpload?: string | null } = {},
): Promise<DmsUploadResult> {
  const tz = ctx.tenant.timezone;
  const asOf = opts.reportDate ?? dateInFilename(opts.filename) ?? today(ctx);
  const report = readRetailReport(await readExport(bytes, opts.filename), { timeZone: tz, asOf });
  await checkDealer(ctx, report.dealer_name);

  const upload = await startUpload(ctx, "RETAIL", opts.continueUpload);
  const at = iso(ctx.now);

  const seenOutlets = new Map<string, string>();
  for (const r of report.rows) if (!seenOutlets.has(r.outlet_code)) seenOutlets.set(r.outlet_code, r.outlet_name);
  const outlets = await outletsFor(ctx, seenOutlets, opts.outletScope ?? null);

  const s: RetailSummary = {
    invoices: { total: report.rows.length, new: 0, changed: 0, unchanged: 0, withdrawn: 0 },
    money: { invoiced: 0, selling: 0, oem_discount: 0, dealer_discount: 0, unclaimed_discount: 0 },
    attached: { financed: 0, dealer_arranged: 0, insured: 0, exchanged: 0, delivered: 0 },
    issues: {},
    claims_not_stated: report.claims_not_stated,
    outlets_created: outlets.created,
  };
  const errors: RowError[] = [...report.errors];

  // What the system already holds for the invoices in this file, and the vehicles and bookings they
  // name, so each row can be tied to the car and the order without a query of its own.
  const nos = report.rows.map((r) => r.invoice_no);
  const existing = new Map<string, Record<string, any>>();
  for (const part of chunk(nos, 200)) {
    for (const row of await all<Record<string, any>>(ctx.db, `SELECT * FROM retail_invoices WHERE tenant_id = ?1 AND invoice_no IN (SELECT value FROM json_each(?2))`, ctx.tenantId, JSON.stringify(part))) existing.set(String(row.invoice_no), row);
  }
  const vins = [...new Set(report.rows.map((r) => r.vin).filter(Boolean))];
  const vehicleByVin = new Map<string, string>();
  for (const part of chunk(vins, 200)) {
    for (const v of await all<{ id: string; vin: string }>(ctx.db, `SELECT id, vin FROM vehicles WHERE tenant_id = ?1 AND vin IN (SELECT value FROM json_each(?2))`, ctx.tenantId, JSON.stringify(part))) vehicleByVin.set(v.vin, v.id);
  }
  // The number the retail export calls "Booking No." is the dealer-side booking number, which the
  // booking sheet calls "Booking Number" and this system keeps as `dms_ref`. It is not the DMS order
  // number the booking is keyed by, so a lookup on `booking_no` alone matches nothing. Both are
  // tried, the dealer-side number first, because that is what this file actually carries.
  const bookingNos = [...new Set(report.rows.map((r) => r.booking_no).filter(Boolean))];
  const bookingByNo = new Map<string, string>();
  for (const part of chunk(bookingNos, 200)) {
    const found = await all<{ id: string; booking_no: string; dms_ref: string | null }>(
      ctx.db,
      `SELECT id, booking_no, dms_ref FROM bookings
        WHERE tenant_id = ?1 AND (dms_ref IN (SELECT value FROM json_each(?2)) OR booking_no IN (SELECT value FROM json_each(?2)))`,
      ctx.tenantId, JSON.stringify(part),
    );
    for (const b of found) if (b.booking_no) bookingByNo.set(b.booking_no, b.id);
    for (const b of found) if (b.dms_ref) bookingByNo.set(b.dms_ref, b.id);
  }

  const COLS = [
    "invoice_at", "invoice_date", "status", "outlet_id", "vin", "chassis_no", "vehicle_id", "booking_no", "booking_id", "allotment_id",
    "oem_model_code", "model", "variant", "colour", "customer_name", "customer_type", "customer_gstin", "sc_name",
    "invoice_amount", "selling_price", "gst_amount", "tcs_amount", "dealer_discount", "oem_scheme_discount", "loyalty_discount",
    "exchange_discount", "corporate_discount", "bndp_credit_note", "loyalty_credit_note", "exchange_credit_note",
    "financier", "finance_arranged_by", "finance_amount", "insurer", "insurance_amount", "exchange_indicator",
    "delivery_note_no", "delivery_note_date", "irn_at",
  ] as const;

  const inserts: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  let earliest = asOf;
  for (const r of report.rows) {
    const outletId = outlets.byCode.get(r.outlet_code);
    if (!outletId) { errors.push({ row: r.row, key: r.invoice_no, message: `Outlet ${r.outlet_code} is not one you may load` }); continue; }
    for (const i of r.issues) s.issues[i] = (s.issues[i] ?? 0) + 1;
    s.money.invoiced += r.invoice_amount ?? 0;
    s.money.selling += r.selling_price ?? 0;
    s.money.oem_discount += r.oem_scheme_discount ?? 0;
    s.money.dealer_discount += r.dealer_discount ?? 0;
    s.money.unclaimed_discount += r.unclaimed;
    if (r.financier && norm(r.financier) !== "CASH") s.attached.financed++;
    if (norm(r.finance_arranged_by ?? "") === "DEALER") s.attached.dealer_arranged++;
    if ((r.insurance_amount ?? 0) > 0) s.attached.insured++;
    if (norm(r.exchange_indicator ?? "") === "YES") s.attached.exchanged++;
    if (r.delivery_note_no) s.attached.delivered++;
    if (r.invoice_date && r.invoice_date < earliest) earliest = r.invoice_date;

    const want: Record<string, unknown> = {
      invoice_at: r.invoice_at, invoice_date: r.invoice_date, status: r.status, outlet_id: outletId,
      vin: r.vin || null, chassis_no: r.chassis_no || null, vehicle_id: vehicleByVin.get(r.vin) ?? null,
      booking_no: r.booking_no || null, booking_id: bookingByNo.get(r.booking_no) ?? null, allotment_id: r.allotment_id,
      oem_model_code: r.oem_model_code || null, model: r.model || null, variant: r.variant || null, colour: r.colour || null,
      customer_name: r.customer_name || null, customer_type: r.customer_type || null, customer_gstin: r.customer_gstin, sc_name: r.sc_name,
      invoice_amount: r.invoice_amount, selling_price: r.selling_price, gst_amount: r.gst_amount, tcs_amount: r.tcs_amount,
      dealer_discount: r.dealer_discount, oem_scheme_discount: r.oem_scheme_discount, loyalty_discount: r.loyalty_discount,
      exchange_discount: r.exchange_discount, corporate_discount: r.corporate_discount,
      bndp_credit_note: r.bndp_credit_note, loyalty_credit_note: r.loyalty_credit_note, exchange_credit_note: r.exchange_credit_note,
      financier: r.financier, finance_arranged_by: r.finance_arranged_by, finance_amount: r.finance_amount,
      insurer: r.insurer, insurance_amount: r.insurance_amount, exchange_indicator: r.exchange_indicator,
      delivery_note_no: r.delivery_note_no, delivery_note_date: r.delivery_note_date, irn_at: r.irn_at,
    };
    const cur = existing.get(r.invoice_no);
    if (!cur) {
      inserts.push({ id: newId("rti"), invoice_no: r.invoice_no, ...want });
      s.invoices.new++;
      // An invoice that was marked withdrawn and is listed again is a change even when every other
      // value matches: the withdrawal is what has to be undone, and the update is what undoes it.
    } else if (cur.withdrawn_on || COLS.some((c) => String(cur[c] ?? "") !== String(want[c] ?? ""))) {
      updates.push({ id: String(cur.id), ...want });
      s.invoices.changed++;
    } else {
      s.invoices.unchanged++;
    }
  }

  const writes: D1PreparedStatement[] = [];
  const set = COLS.map((c) => `${c} = ${jx(c)}`).join(", ");
  for (const part of chunk(inserts, 100)) {
    writes.push(
      stmt(
        ctx.db,
        `INSERT INTO retail_invoices (id, tenant_id, invoice_no, ${COLS.join(", ")}, report_date, last_upload_id, created_at, updated_at)
         SELECT ${jx("id")}, ?2, ${jx("invoice_no")}, ${COLS.map((c) => jx(c)).join(", ")}, ?3, ?4, ?5, ?5 FROM json_each(?1) AS j WHERE true
         ON CONFLICT (tenant_id, invoice_no) DO NOTHING`,
        JSON.stringify(part), ctx.tenantId, asOf, upload.id, at,
      ),
    );
  }
  for (const part of chunk(updates, 100)) {
    writes.push(
      stmt(
        ctx.db,
        `UPDATE retail_invoices SET ${set}, report_date = ?3, withdrawn_on = NULL, last_upload_id = ?4, updated_at = ?5
          FROM json_each(?1) AS j WHERE retail_invoices.tenant_id = ?2 AND retail_invoices.id = ${jx("id")}`,
        JSON.stringify(part), ctx.tenantId, asOf, upload.id, at,
      ),
    );
  }
  // The only thing read from a row's absence. Confined to the period this file covers, and to
  // outlets it names, so a file for one week never withdraws another week's invoices.
  const scope = opts.outletScope ?? null;
  const theseOutlets = [...outlets.byCode.values()];
  const gone = await all<{ id: string; invoice_no: string; vin: string | null }>(
    ctx.db,
    `SELECT id, invoice_no, vin FROM retail_invoices
      WHERE tenant_id = ?1 AND withdrawn_on IS NULL AND invoice_date >= ?2 AND invoice_date <= ?3
        AND outlet_id IN (SELECT value FROM json_each(?4))
        AND invoice_no NOT IN (SELECT value FROM json_each(?5))`,
    ctx.tenantId, earliest, asOf, JSON.stringify(theseOutlets), JSON.stringify(nos),
  );
  if (gone.length) {
    s.invoices.withdrawn = gone.length;
    writes.push(
      stmt(ctx.db, `UPDATE retail_invoices SET withdrawn_on = ?2, updated_at = ?3 WHERE tenant_id = ?1 AND id IN (SELECT value FROM json_each(?4))`, ctx.tenantId, asOf, at, JSON.stringify(gone.map((g) => g.id))),
      ...(await alarmStmts(ctx, {
        kind: "INVOICE_REVERSED",
        title: `${gone.length} retail invoice${gone.length === 1 ? "" : "s"} withdrawn`,
        body: `The retail export as on ${asOf} no longer lists ${gone.length} invoice${gone.length === 1 ? "" : "s"} it listed before: ${gone.slice(0, 5).map((g) => g.invoice_no).join(", ")}${gone.length > 5 ? " and others" : ""}. Nothing here changes a car or a booking; the stock report is what moves those.`,
      })),
    );
  }
  for (const part of chunk(writes, 20)) await ctx.db.batch(part);

  const result: DmsUploadResult = {
    upload_id: upload.id, kind: "RETAIL", report_date: asOf, more: false,
    row_count: report.rows.length, created: s.invoices.new, updated: s.invoices.changed, unchanged: s.invoices.unchanged,
    errors, allocations: 0, summary: addInto(s, upload.prior, ["invoices.new", "invoices.changed", "invoices.unchanged"]),
  };
  await saveUpload(ctx, upload, result, "UPDATE", opts.filename, [...seenOutlets.keys()], upload.prior);
  return result;
}
