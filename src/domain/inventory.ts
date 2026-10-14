// Stock: every change to a car made in the app goes through here so that the movement history, the
// allocation rules and the customer messages stay in step. This is the "dynamic inventory update":
// between two DMS stock reports (dms-import.ts) the stock in-charge can receive a car the moment it
// arrives, move it between outlets or block it, and the next report then confirms what the DMS shows.

import type { Ctx } from "../env";
import { all, alertStmt, auditStmt, first, isGuardFailure, run, stmt, type Guard } from "../lib/db";
import { bad, conflict, iso, localParts, newId, norm, notFound, parseDate } from "../lib/util";
import { messageStmt } from "../whatsapp/outbox";
import { resolveConfig, type ConfigInput, type ResolvedConfig } from "./master";
import {
  activeAllocationForVehicle,
  allocateConfig,
  dealershipLabel,
  releaseAllocation,
  vehicleLabel,
  type AllocationOutcome,
  type BookingRow,
} from "./allocation";

export type VehicleStatus = "IN_TRANSIT" | "RECEIVED" | "INVOICED" | "DELIVERED" | "REMOVED";
const RANK: Record<string, number> = { IN_TRANSIT: 0, RECEIVED: 1, INVOICED: 2, DELIVERED: 3 };

export interface Vehicle {
  id: string;
  tenant_id: string;
  outlet_id: string;
  vin: string;
  engine_no: string | null;
  variant_id: string | null;
  model: string;
  variant: string;
  colour: string;
  status: VehicleStatus;
  is_blocked: number;
  block_reason: string | null;
  wholesale_invoice_no: string | null;
  wholesale_invoice_date: string | null;
  dispatch_date: string | null;
  expected_arrival_date: string | null;
  received_at: string | null;
  invoiced_at: string | null;
  delivered_at: string | null;
  dms_booking_no: string | null;
  ever_allocated: number;
}

/** One line of a car's movement history. With a guard, the batch it is part of only goes through while the guard holds. */
export function eventStmt(ctx: Ctx, vehicleId: string, type: string, from: string | null, to: string | null, detail: unknown = {}, guard?: Guard) {
  return stmt(
    ctx.db,
    guard
      ? `INSERT INTO vehicle_events (id, tenant_id, vehicle_id, type, from_status, to_status, detail_json, actor, at) SELECT ?, CASE WHEN EXISTS (${guard.sql}) THEN ? ELSE NULL END, ?,?,?,?,?,?,?`
      : `INSERT INTO vehicle_events (id, tenant_id, vehicle_id, type, from_status, to_status, detail_json, actor, at) VALUES (?,?,?,?,?,?,?,?,?)`,
    newId("vev"), ...(guard?.params ?? []), ctx.tenantId, vehicleId, type, from, to, JSON.stringify(detail ?? {}), ctx.actor, iso(ctx.now),
  );
}

export async function getVehicle(ctx: Ctx, id: string): Promise<Vehicle> {
  const v = await first<Vehicle>(ctx.db, `SELECT * FROM vehicles WHERE id = ? AND tenant_id = ?`, id, ctx.tenantId);
  if (!v) throw notFound("Vehicle");
  return v;
}

export interface VehicleInput extends ConfigInput {
  vin: string;
  outlet_id: string;
  status: "IN_TRANSIT" | "RECEIVED";
  engine_no?: string | null;
  wholesale_invoice_no?: string | null;
  wholesale_invoice_date?: string | null;
  dispatch_date?: string | null;
  expected_arrival_date?: string | null;
}

type NewVehicle = Omit<VehicleInput, keyof ConfigInput> & ResolvedConfig;

function insertVehicleStmts(ctx: Ctx, id: string, v: NewVehicle, source: string, uploadId: string | null) {
  const at = iso(ctx.now);
  return [
    stmt(
      ctx.db,
      `INSERT INTO vehicles (id, tenant_id, outlet_id, vin, engine_no, variant_id, model, variant, colour, status, wholesale_invoice_no, wholesale_invoice_date, dispatch_date, expected_arrival_date, received_at, source, last_upload_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, ctx.tenantId, v.outlet_id, v.vin, v.engine_no ?? null, v.variant_id, v.model, v.variant, v.colour, v.status, v.wholesale_invoice_no ?? null,
      v.wholesale_invoice_date ?? null, v.dispatch_date ?? null, v.expected_arrival_date ?? null, v.status === "RECEIVED" ? at : null, source, uploadId, at, at,
    ),
    eventStmt(ctx, id, "CREATED", null, v.status, { source, outlet_id: v.outlet_id }),
  ];
}

export async function addVehicle(ctx: Ctx, input: VehicleInput): Promise<{ id: string; allocations: AllocationOutcome[] }> {
  const vin = norm(input.vin);
  if (!vin) throw bad("Chassis number is required");
  // A car of a discontinued variant can still arrive in stock; only new bookings are refused for it.
  const cfg = await resolveConfig(ctx, input, { allowInactive: true });
  const dates: Record<string, string | null> = {};
  for (const k of ["wholesale_invoice_date", "dispatch_date", "expected_arrival_date"] as const) {
    dates[k] = input[k] ? parseDate(input[k]) : null;
    if (input[k] && !dates[k]) throw bad("A date is not valid");
  }
  const v: NewVehicle = { vin, outlet_id: input.outlet_id, status: input.status, engine_no: input.engine_no ? String(input.engine_no).trim() : null, wholesale_invoice_no: input.wholesale_invoice_no ? String(input.wholesale_invoice_no).trim() : null, ...dates, ...cfg };
  if (!["IN_TRANSIT", "RECEIVED"].includes(v.status)) throw bad("A new vehicle must be in transit or received");
  if (!(await first(ctx.db, `SELECT id FROM outlets WHERE id = ? AND tenant_id = ?`, v.outlet_id, ctx.tenantId))) throw bad("Outlet not found");
  if (await first(ctx.db, `SELECT id FROM vehicles WHERE tenant_id = ? AND vin = ?`, ctx.tenantId, v.vin)) throw conflict(`Chassis number ${v.vin} is already in stock records`);
  const id = newId("veh");
  await ctx.db.batch(insertVehicleStmts(ctx, id, v, "MANUAL", null));
  return { id, allocations: await allocateConfig(ctx, v) };
}

/** What is written when a reserved car reaches the dealership: the record, the alert to the sales executive, the message to the customer. */
async function arrivalNotices(ctx: Ctx, v: Vehicle, b: BookingRow, allocationId: string, guard?: Guard): Promise<D1PreparedStatement[]> {
  return [
    auditStmt(ctx, "STOCK_RECEIVED", "booking", b.id, { vehicle_id: v.id, vin: v.vin, allocation_id: allocationId }, guard),
    ...(b.sales_exec_id ? [alertStmt(ctx, { targetUser: b.sales_exec_id, outletId: b.outlet_id, kind: "STOCK_RECEIVED", title: "Your customer's car has arrived", body: `${vehicleLabel(v)} (${v.vin}) for booking ${b.booking_no}, ${b.customer_name}, is at the dealership. Payment and invoicing are due within ${ctx.settings.reminder_days} days; the car is re-allocated on day ${ctx.settings.reallocate_days}.`, entityType: "booking", entityId: b.id })] : []),
    await messageStmt(ctx, {
      eventKey: "STOCK_RECEIVED",
      toMobile: b.customer_mobile,
      toName: b.customer_name,
      bookingId: b.id,
      optIn: Boolean(b.wa_opt_in),
      params: { customer_name: b.customer_name, vehicle: vehicleLabel(v), dealership: await dealershipLabel(ctx, b.outlet_id), days: String(ctx.settings.reminder_days) },
    }),
  ];
}

/**
 * A reserved car is at the dealership but its arrival was never announced: the stock report marked it
 * received at the very moment it was being allocated, or the report tied it to another order. Starts the
 * payment window and tells the customer and the sales executive, once. Returns false when there was
 * nothing to do (someone else did it, or the allocation is gone).
 */
export async function announceArrival(ctx: Ctx, allocationId: string): Promise<boolean> {
  const a = await first<{ id: string; booking_id: string; vehicle_id: string }>(ctx.db, `SELECT id, booking_id, vehicle_id FROM allocations WHERE id = ? AND tenant_id = ? AND status = 'ACTIVE' AND clock_started_at IS NULL`, allocationId, ctx.tenantId);
  if (!a) return false;
  const v = await getVehicle(ctx, a.vehicle_id);
  const b = await first<BookingRow>(ctx.db, `SELECT * FROM bookings WHERE id = ? AND tenant_id = ?`, a.booking_id, ctx.tenantId);
  if (v.status !== "RECEIVED" || !b || b.status !== "ALLOCATED") return false;
  const stillDue = { sql: `SELECT 1 FROM allocations WHERE id = ? AND tenant_id = ? AND status = 'ACTIVE' AND clock_started_at IS NULL`, params: [a.id, ctx.tenantId] };
  try {
    await ctx.db.batch([
      ...(await arrivalNotices(ctx, v, b, a.id, stillDue)),
      stmt(ctx.db, `UPDATE allocations SET clock_started_at = ? WHERE id = ? AND tenant_id = ? AND status = 'ACTIVE' AND clock_started_at IS NULL`, iso(ctx.now), a.id, ctx.tenantId),
    ]);
  } catch (e) {
    if (isGuardFailure(e)) return false;
    throw e;
  }
  return true;
}

/** A car in transit reaches the dealership. Starts the payment window if the car is already allocated. */
export async function receiveVehicle(ctx: Ctx, vehicleId: string): Promise<{ allocations: AllocationOutcome[] }> {
  const v = await getVehicle(ctx, vehicleId);
  if (v.status !== "IN_TRANSIT") throw conflict(`${v.vin} is not in transit (current status: ${v.status})`);
  const at = iso(ctx.now);
  const alloc = await activeAllocationForVehicle(ctx, v.id);
  const stmts = [
    // Guarded: if the car was received by another request a moment ago, nothing here is repeated.
    eventStmt(ctx, v.id, "RECEIVED", "IN_TRANSIT", "RECEIVED", { allocation_id: alloc?.id ?? null }, { sql: `SELECT 1 FROM vehicles WHERE id = ? AND tenant_id = ? AND status = 'IN_TRANSIT'`, params: [v.id, ctx.tenantId] }),
    stmt(ctx.db, `UPDATE vehicles SET status = 'RECEIVED', received_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND status = 'IN_TRANSIT'`, at, at, v.id, ctx.tenantId),
    // The payment window starts for whichever booking holds the car at this moment.
    stmt(ctx.db, `UPDATE allocations SET clock_started_at = COALESCE(clock_started_at, ?) WHERE tenant_id = ? AND vehicle_id = ? AND status = 'ACTIVE'`, at, ctx.tenantId, v.id),
  ];
  if (alloc) {
    const b = (await first<BookingRow>(ctx.db, `SELECT * FROM bookings WHERE id = ? AND tenant_id = ?`, alloc.booking_id, ctx.tenantId))!;
    stmts.push(...(await arrivalNotices(ctx, v, b, alloc.id)));
  }
  try {
    await ctx.db.batch(stmts);
  } catch (e) {
    if (isGuardFailure(e)) throw conflict(`${v.vin} has already been received`);
    throw e;
  }
  return { allocations: alloc ? [] : await allocateConfig(ctx, v) };
}

export async function transferVehicle(ctx: Ctx, vehicleId: string, toOutletId: string): Promise<{ allocations: AllocationOutcome[] }> {
  const v = await getVehicle(ctx, vehicleId);
  if (!["IN_TRANSIT", "RECEIVED"].includes(v.status)) throw conflict("Only a car in transit or in stock can be transferred");
  if (v.outlet_id === toOutletId) throw bad("The car is already at this outlet");
  if (!(await first(ctx.db, `SELECT id FROM outlets WHERE id = ? AND tenant_id = ? AND is_active = 1`, toOutletId, ctx.tenantId))) throw bad("Outlet not found");
  const at = iso(ctx.now);
  const alloc = await activeAllocationForVehicle(ctx, v.id);
  const stmts = [
    stmt(ctx.db, `UPDATE vehicles SET outlet_id = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`, toOutletId, at, v.id, ctx.tenantId),
    eventStmt(ctx, v.id, "TRANSFERRED", v.status, v.status, { from_outlet_id: v.outlet_id, to_outlet_id: toOutletId }),
  ];
  if (alloc) {
    stmts.push(
      stmt(ctx.db, `UPDATE allocations SET needs_transfer = (SELECT CASE WHEN b.outlet_id = ? THEN 0 ELSE 1 END FROM bookings b WHERE b.id = allocations.booking_id) WHERE id = ?`, toOutletId, alloc.id),
    );
  }
  await ctx.db.batch(stmts);
  return { allocations: alloc ? [] : await allocateConfig(ctx, v) };
}

/** Damage or an inspection hold: the car cannot be allocated. A booking holding it goes back to the queue. */
export async function blockVehicle(ctx: Ctx, vehicleId: string, reason: string): Promise<{ allocations: AllocationOutcome[] }> {
  const v = await getVehicle(ctx, vehicleId);
  if (!reason.trim()) throw bad("A reason is required");
  if (!["IN_TRANSIT", "RECEIVED"].includes(v.status)) throw conflict("Only a car in transit or in stock can be blocked");
  await ctx.db.batch([
    stmt(ctx.db, `UPDATE vehicles SET is_blocked = 1, block_reason = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`, reason.trim(), iso(ctx.now), v.id, ctx.tenantId),
    eventStmt(ctx, v.id, "BLOCKED", v.status, v.status, { reason: reason.trim() }),
  ]);
  const alloc = await activeAllocationForVehicle(ctx, v.id);
  return { allocations: alloc ? await releaseAllocation(ctx, alloc, "VEHICLE_BLOCKED") : [] };
}

export async function unblockVehicle(ctx: Ctx, vehicleId: string): Promise<{ allocations: AllocationOutcome[] }> {
  const v = await getVehicle(ctx, vehicleId);
  if (!v.is_blocked) throw bad("The car is not blocked");
  await ctx.db.batch([
    stmt(ctx.db, `UPDATE vehicles SET is_blocked = 0, block_reason = NULL, updated_at = ? WHERE id = ? AND tenant_id = ?`, iso(ctx.now), v.id, ctx.tenantId),
    eventStmt(ctx, v.id, "UNBLOCKED", v.status, v.status, {}),
  ]);
  return { allocations: await allocateConfig(ctx, v) };
}

/** Takes a car out of stock (returned to the manufacturer, sold to another dealer, entered by mistake). */
export async function removeVehicle(ctx: Ctx, vehicleId: string, reason: string): Promise<{ allocations: AllocationOutcome[] }> {
  const v = await getVehicle(ctx, vehicleId);
  if (!reason.trim()) throw bad("A reason is required");
  if (!["IN_TRANSIT", "RECEIVED"].includes(v.status)) throw conflict("Only a car in transit or in stock can be removed");
  await ctx.db.batch([
    stmt(ctx.db, `UPDATE vehicles SET status = 'REMOVED', updated_at = ? WHERE id = ? AND tenant_id = ?`, iso(ctx.now), v.id, ctx.tenantId),
    eventStmt(ctx, v.id, "REMOVED", v.status, "REMOVED", { reason: reason.trim() }),
  ]);
  const alloc = await activeAllocationForVehicle(ctx, v.id);
  return { allocations: alloc ? await releaseAllocation(ctx, alloc, "VEHICLE_REMOVED") : [] };
}

export async function updateVehicleDetails(
  ctx: Ctx,
  vehicleId: string,
  patch: { expected_arrival_date?: string | null; dispatch_date?: string | null; wholesale_invoice_no?: string | null; wholesale_invoice_date?: string | null; engine_no?: string | null },
) {
  const v = await getVehicle(ctx, vehicleId);
  const changes: Record<string, [unknown, unknown]> = {};
  const next: Record<string, string | null> = {};
  for (const k of ["expected_arrival_date", "dispatch_date", "wholesale_invoice_date"] as const) {
    if (patch[k] === undefined) continue;
    const val = patch[k] ? parseDate(patch[k]) : null;
    if (patch[k] && !val) throw bad(`${k} is not a valid date`);
    if (val !== v[k]) (changes[k] = [v[k], val]), (next[k] = val);
  }
  for (const k of ["wholesale_invoice_no", "engine_no"] as const) {
    if (patch[k] === undefined) continue;
    const val = patch[k] ? String(patch[k]).trim() : null;
    if (val !== v[k]) (changes[k] = [v[k], val]), (next[k] = val);
  }
  const keys = Object.keys(next);
  if (!keys.length) return { changed: false };
  await ctx.db.batch([
    stmt(ctx.db, `UPDATE vehicles SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ? AND tenant_id = ?`, ...keys.map((k) => next[k]), iso(ctx.now), v.id, ctx.tenantId),
    eventStmt(ctx, v.id, changes.expected_arrival_date ? "ETA_CHANGED" : "UPDATED", v.status, v.status, changes),
  ]);
  return { changed: true };
}

/** Free and committed stock by model / variant / colour, with the earliest arrival of a free in-transit car. */
export async function stockSummary(ctx: Ctx, outletIds: string[] | null, filter: { category?: string; model?: string; fuel?: string; transmission?: string } = {}) {
  const scope = outletIds ? `AND v.outlet_id IN (${outletIds.map(() => "?").join(",") || "''"})` : "";
  const today = localParts(ctx.now, ctx.tenant.timezone).date;
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.model) (where.push("AND v.model = ?"), params.push(norm(filter.model)));
  for (const k of ["category", "fuel", "transmission"] as const) if (filter[k]) (where.push(`AND vm.${k} = ?`), params.push(filter[k]));
  return all(
    ctx.db,
    `SELECT v.model, v.variant, v.colour, MAX(v.variant_id) AS variant_id, MAX(vm.category) AS category, MAX(vm.trim_level) AS trim, MAX(vm.transmission) AS transmission, MAX(vm.fuel) AS fuel, MAX(vm.drive) AS drive, MAX(vm.seater) AS seater,
       SUM(CASE WHEN v.status = 'RECEIVED' AND a.id IS NULL AND v.is_blocked = 0 THEN 1 ELSE 0 END) AS yard_free,
       SUM(CASE WHEN v.status = 'RECEIVED' AND a.id IS NOT NULL THEN 1 ELSE 0 END) AS yard_allocated,
       SUM(CASE WHEN v.status = 'IN_TRANSIT' AND a.id IS NULL AND v.is_blocked = 0 THEN 1 ELSE 0 END) AS transit_free,
       SUM(CASE WHEN v.status = 'IN_TRANSIT' AND a.id IS NOT NULL THEN 1 ELSE 0 END) AS transit_allocated,
       SUM(v.is_blocked) AS blocked,
       MIN(CASE WHEN v.status = 'IN_TRANSIT' AND a.id IS NULL AND v.is_blocked = 0 THEN v.expected_arrival_date END) AS earliest_free_arrival,
       SUM(CASE WHEN v.status = 'IN_TRANSIT' AND v.expected_arrival_date < ? THEN 1 ELSE 0 END) AS transit_overdue
     FROM vehicles v LEFT JOIN allocations a ON a.vehicle_id = v.id AND a.status = 'ACTIVE' LEFT JOIN vehicle_variants vm ON vm.id = v.variant_id
     WHERE v.tenant_id = ? AND v.status IN ('RECEIVED','IN_TRANSIT') ${scope} ${where.join(" ")}
     GROUP BY v.model, v.variant, v.colour ORDER BY v.model, v.variant, v.colour`,
    today,
    ctx.tenantId,
    ...(outletIds ?? []),
    ...params,
  );
}
