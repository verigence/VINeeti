// Analytics: three views worked out from the two DMS files by fixed rules, so the same files always give
// the same answer. Each answer states its rule (basis) and the files it came from.
//
//   ageing          unsold stock by model, by days since the manufacturer's (OEM) invoice date
//   not picked up   customers whose car has been waiting for them at the dealership for more than N days
//   sales           most and least sold model, and most sold car (model + variant + colour), in a period

import type { Ctx } from "../env";
import { all, stmt } from "../lib/db";
import { addDays, iso, localDayBounds, localParts } from "../lib/util";
import { dataStatus } from "./data-status";
import { releaseWords } from "./release-reasons";

const inList = (ids: string[] | null, col: string) => (ids ? `AND ${col} IN (${ids.map(() => "?").join(",") || "''"})` : "");
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
const AGE_BUCKETS: [string, number, number][] = [["0-15 days", 0, 15], ["16-30 days", 16, 30], ["31-60 days", 31, 60], ["Over 60 days", 61, 1e9]];

// ---------------------------------------------------------------- ageing inventory by model

export interface AgeingRow {
  model: string;
  cars: number;
  in_yard: number;
  in_transit: number;
  /** Cars per age bucket, in AGE_BUCKETS order; `unknown` are cars whose OEM invoice date the report does not give. */
  buckets: number[];
  unknown: number;
  oldest_days: number | null;
  average_days: number | null;
  /** Dealer value of the unsold cars, only for those allowed to see it. */
  value?: number;
  /** The oldest cars of this model, oldest first. */
  cars_detail: { vin: string; variant: string; colour: string; outlet: string; status: string; oem_invoice_date: string | null; age_days: number | null; value?: number }[];
}

/**
 * Unsold stock by model. A car is unsold when it is in the yard or in transit, is not blocked as a demo
 * car, and no booking holds it. Age is counted in days from the OEM invoice date in the stock report to
 * today. Models are listed by number of old cars (over 30 days), then by name.
 */
export async function ageingByModel(ctx: Ctx, outletIds: string[] | null, withValue: boolean, perModel = 10) {
  const today = localParts(ctx.now, ctx.tenant.timezone).date;
  const cars = await all<{ vin: string; model: string; variant: string; colour: string; outlet: string; status: string; wholesale_invoice_date: string | null; net_dealer_price: number | null }>(
    ctx.db,
    `SELECT v.vin, v.model, v.variant, v.colour, o.name AS outlet, v.status, v.wholesale_invoice_date, v.net_dealer_price FROM vehicles v JOIN outlets o ON o.id = v.outlet_id
     WHERE v.tenant_id = ? AND v.status IN ('RECEIVED','IN_TRANSIT') AND v.is_demo = 0 ${inList(outletIds, "v.outlet_id")}
       AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.vehicle_id = v.id AND a.status = 'ACTIVE')
     ORDER BY v.model, v.wholesale_invoice_date, v.vin`,
    ctx.tenantId, ...(outletIds ?? []),
  );
  const byModel = new Map<string, AgeingRow>();
  for (const c of cars) {
    const row = byModel.get(c.model) ?? { model: c.model, cars: 0, in_yard: 0, in_transit: 0, buckets: AGE_BUCKETS.map(() => 0), unknown: 0, oldest_days: null, average_days: null, cars_detail: [] };
    const age = c.wholesale_invoice_date ? Math.max(0, daysBetween(c.wholesale_invoice_date, today)) : null;
    row.cars++;
    c.status === "RECEIVED" ? row.in_yard++ : row.in_transit++;
    if (age === null) row.unknown++;
    else row.buckets[AGE_BUCKETS.findIndex(([, lo, hi]) => age >= lo && age <= hi)]++;
    if (withValue) row.value = (row.value ?? 0) + (c.net_dealer_price ?? 0);
    row.cars_detail.push({ vin: c.vin, variant: c.variant, colour: c.colour, outlet: c.outlet, status: c.status, oem_invoice_date: c.wholesale_invoice_date, age_days: age, ...(withValue ? { value: c.net_dealer_price ?? 0 } : {}) });
    byModel.set(c.model, row);
  }
  const rows = [...byModel.values()].map((r) => {
    const known = r.cars_detail.filter((c) => c.age_days !== null).map((c) => c.age_days!);
    r.oldest_days = known.length ? Math.max(...known) : null;
    r.average_days = known.length ? Math.round((known.reduce((a, b) => a + b, 0) / known.length) * 10) / 10 : null;
    r.cars_detail.sort((a, b) => (b.age_days ?? -1) - (a.age_days ?? -1) || a.vin.localeCompare(b.vin));
    r.cars_detail = r.cars_detail.slice(0, perModel);
    if (withValue) r.value = Math.round(r.value ?? 0);
    return r;
  });
  const over30 = (r: AgeingRow) => r.buckets[2] + r.buckets[3];
  rows.sort((a, b) => over30(b) - over30(a) || b.cars - a.cars || a.model.localeCompare(b.model));
  return {
    as_of: today,
    source: await dataStatus(ctx),
    buckets: AGE_BUCKETS.map(([label]) => label),
    totals: { cars: rows.reduce((n, r) => n + r.cars, 0), over_30_days: rows.reduce((n, r) => n + over30(r), 0), over_60_days: rows.reduce((n, r) => n + r.buckets[3], 0), ...(withValue ? { value: rows.reduce((n, r) => n + (r.value ?? 0), 0) } : {}) },
    rows,
    basis: "Unsold cars (in the yard or in transit, not demo, held by no booking) in the latest stock report, by days from the manufacturer's invoice date to today. Models with the most cars over 30 days first.",
  };
}

// ---------------------------------------------------------------- customers who have not picked up their car

export interface NotPickedUpRow {
  booking_id: string;
  booking_no: string;
  customer_name: string;
  customer_mobile: string;
  sales_exec: string | null;
  outlet: string;
  model: string;
  variant: string;
  colour: string;
  vin: string;
  /** WAITING_FOR_PAYMENT: car in the yard, not invoiced. INVOICED_NOT_TAKEN: retail-invoiced in the DMS, still in the stock report. */
  stage: "WAITING_FOR_PAYMENT" | "INVOICED_NOT_TAKEN";
  /** The day the car became available to this customer: its arrival in the yard, or the day the booking got a car already in the yard. */
  since: string;
  days: number;
  payment_reported_at: string | null;
  payment_received_at: string | null;
  invoiced_on: string | null;
}

/**
 * Customers whose car has been at the dealership for them for more than `days` days without being taken:
 * either payment and invoicing are still pending (the car is reserved and in the yard), or the car is
 * invoiced in the DMS but still appears in the stock report. Counted in calendar days at the dealership
 * from the later of the car's arrival and the allocation, to today. Longest waiting first.
 */
export async function notPickedUp(ctx: Ctx, outletIds: string[] | null, days = 10) {
  const tz = ctx.tenant.timezone;
  const today = localParts(ctx.now, tz).date;
  const rows = await all<any>(
    ctx.db,
    `SELECT b.id AS booking_id, b.booking_no, b.customer_name, b.customer_mobile, se.name AS sales_exec, o.name AS outlet, b.model, b.variant, b.colour, b.status AS booking_status,
            b.payment_reported_at, b.payment_received_at, v.vin, v.status AS vehicle_status, v.received_at, v.invoiced_at, v.dms_invoice_date, a.allocated_at, a.clock_started_at
     FROM allocations a JOIN bookings b ON b.id = a.booking_id JOIN vehicles v ON v.id = a.vehicle_id JOIN outlets o ON o.id = b.outlet_id LEFT JOIN users se ON se.id = b.sales_exec_id
     WHERE a.tenant_id = ? AND a.status = 'ACTIVE' AND v.status IN ('RECEIVED','INVOICED') AND b.status IN ('ALLOCATED','INVOICED') ${inList(outletIds, "b.outlet_id")}`,
    ctx.tenantId, ...(outletIds ?? []),
  );
  const out: NotPickedUpRow[] = [];
  for (const r of rows) {
    // The car was available to this customer from its arrival, or from the allocation if the car was already here.
    const candidates = [r.clock_started_at, r.received_at, r.allocated_at].filter(Boolean) as string[];
    if (!candidates.length) continue;
    const since = localParts(new Date(r.clock_started_at ?? (r.received_at > r.allocated_at ? r.received_at : r.allocated_at)), tz).date;
    const waited = daysBetween(since, today);
    if (waited <= days) continue;
    const invoiced = r.vehicle_status === "INVOICED" || r.booking_status === "INVOICED";
    out.push({
      booking_id: r.booking_id, booking_no: r.booking_no, customer_name: r.customer_name, customer_mobile: r.customer_mobile, sales_exec: r.sales_exec, outlet: r.outlet,
      model: r.model, variant: r.variant, colour: r.colour, vin: r.vin,
      stage: invoiced ? "INVOICED_NOT_TAKEN" : "WAITING_FOR_PAYMENT", since, days: waited,
      payment_reported_at: r.payment_reported_at, payment_received_at: r.payment_received_at,
      invoiced_on: r.dms_invoice_date ?? (r.invoiced_at ? localParts(new Date(r.invoiced_at), tz).date : null),
    });
  }
  out.sort((a, b) => b.days - a.days || a.booking_no.localeCompare(b.booking_no));
  return {
    as_of: today,
    days,
    source: await dataStatus(ctx),
    counts: { total: out.length, waiting_for_payment: out.filter((r) => r.stage === "WAITING_FOR_PAYMENT").length, invoiced_not_taken: out.filter((r) => r.stage === "INVOICED_NOT_TAKEN").length },
    rows: out,
    basis: `Bookings whose reserved car has been at the dealership for more than ${days} calendar days, counted from the car's arrival (or from the allocation, if the car was already in the yard): payment or invoicing pending, or invoiced in the DMS but still in the stock report.`,
  };
}

// ---------------------------------------------------------------- most and least selling

export interface SalesRow {
  key: string;
  model: string;
  variant?: string;
  colour?: string;
  sold: number;
  /** Sold cars delivered (no longer in the stock report) and still at the dealership after invoicing. */
  delivered: number;
  /** Unsold cars of this model in the latest stock report, and customers still waiting for one. */
  unsold_in_stock: number;
  waiting_bookings: number;
}

/**
 * Sales in a period, counted as retail invoices: a booking is sold on the day the DMS files first show it
 * invoiced (or the day it was invoiced in the app). Models with no sale but cars in stock are listed
 * with zero, so the least selling is visible. Ties are broken by name, so the order never changes between
 * two runs on the same data.
 */
export async function salesRanking(ctx: Ctx, outletIds: string[] | null, period: { from: string; to: string }) {
  const tz = ctx.tenant.timezone;
  const [a, b] = [localDayBounds(period.from, tz).start, localDayBounds(period.to, tz).end];
  const sold = await all<{ model: string; variant: string; colour: string; n: number; delivered: number }>(
    ctx.db,
    `SELECT b.model, b.variant, b.colour, COUNT(*) AS n, SUM(CASE WHEN b.status = 'DELIVERED' THEN 1 ELSE 0 END) AS delivered FROM bookings b
     WHERE b.tenant_id = ? AND b.status IN ('INVOICED','DELIVERED') AND b.invoiced_at >= ? AND b.invoiced_at < ? ${inList(outletIds, "b.outlet_id")}
     GROUP BY b.model, b.variant, b.colour`,
    ctx.tenantId, a, b, ...(outletIds ?? []),
  );
  const stock = await all<{ model: string; variant: string; colour: string; n: number }>(
    ctx.db,
    `SELECT v.model, v.variant, v.colour, COUNT(*) AS n FROM vehicles v WHERE v.tenant_id = ? AND v.status IN ('RECEIVED','IN_TRANSIT') AND v.is_demo = 0 ${inList(outletIds, "v.outlet_id")}
       AND NOT EXISTS (SELECT 1 FROM allocations x WHERE x.vehicle_id = v.id AND x.status = 'ACTIVE') GROUP BY v.model, v.variant, v.colour`,
    ctx.tenantId, ...(outletIds ?? []),
  );
  const waiting = await all<{ model: string; variant: string; colour: string; n: number }>(
    ctx.db,
    `SELECT model, variant, colour, COUNT(*) AS n FROM bookings WHERE tenant_id = ? AND status = 'APPROVED' ${inList(outletIds, "outlet_id")} GROUP BY model, variant, colour`,
    ctx.tenantId, ...(outletIds ?? []),
  );
  const models = new Map<string, SalesRow>();
  const cars = new Map<string, SalesRow>();
  const at = (map: Map<string, SalesRow>, key: string, r: { model: string; variant?: string; colour?: string }) => {
    const row = map.get(key) ?? { key, model: r.model, ...(r.variant ? { variant: r.variant, colour: r.colour } : {}), sold: 0, delivered: 0, unsold_in_stock: 0, waiting_bookings: 0 };
    map.set(key, row);
    return row;
  };
  const carKey = (r: { model: string; variant: string; colour: string }) => `${r.model} | ${r.variant} | ${r.colour}`;
  for (const r of sold) {
    const m = at(models, r.model, r); m.sold += r.n; m.delivered += r.delivered;
    const c = at(cars, carKey(r), r); c.sold += r.n; c.delivered += r.delivered;
  }
  for (const r of stock) { at(models, r.model, r).unsold_in_stock += r.n; at(cars, carKey(r), r).unsold_in_stock += r.n; }
  for (const r of waiting) { at(models, r.model, r).waiting_bookings += r.n; at(cars, carKey(r), r).waiting_bookings += r.n; }
  const byMost = (x: SalesRow, y: SalesRow) => y.sold - x.sold || x.key.localeCompare(y.key);
  const modelRows = [...models.values()].sort(byMost);
  const carRows = [...cars.values()].sort(byMost);
  const total = modelRows.reduce((n, r) => n + r.sold, 0);
  const withShare = modelRows.map((r) => ({ ...r, share_pct: total ? Math.round((r.sold / total) * 1000) / 10 : null }));
  // Least selling: among models the dealership stocks (cars in the latest report) or sold in the period, the fewest sales; names break ties.
  const least = [...modelRows].filter((r) => r.unsold_in_stock > 0 || r.sold > 0).sort((x, y) => x.sold - y.sold || y.unsold_in_stock - x.unsold_in_stock || x.key.localeCompare(y.key));
  return {
    period,
    source: await dataStatus(ctx),
    total_sold: total,
    most_selling_model: withShare[0]?.sold ? withShare[0] : null,
    least_selling_model: least[0] ?? null,
    most_selling_car: carRows[0]?.sold ? carRows[0] : null,
    models: withShare,
    cars: carRows.slice(0, 50),
    basis: "A sale is a retail invoice: a booking counts on the day the DMS files first showed it invoiced (or it was invoiced in the app), by the car it was booked for. Unsold stock and waiting customers are as in the latest files. Equal counts are ordered by name.",
  };
}

/** Default period for the sales ranking: the last 90 days to today. */
export function defaultSalesPeriod(ctx: Ctx) {
  const today = localParts(ctx.now, ctx.tenant.timezone).date;
  return { from: addDays(today, -89), to: today };
}

// ---------------------------------------------------------------- day-wise stock position per outlet

/** Records the position of every outlet, as the system holds it now, under today's business date. Replaces an earlier record for the same day. */
export async function recordStockPositions(ctx: Ctx, source: "STOCK_REPORT" | "BOOKING_SHEET" | "DAY_END"): Promise<number> {
  const date = localParts(ctx.now, ctx.tenant.timezone).date;
  const rows = await all<{ outlet_id: string; in_transit_free: number; in_transit_reserved: number; in_yard_free: number; in_yard_reserved: number; invoiced_in_stock: number; blocked: number; value_unsold: number | null }>(
    ctx.db,
    `SELECT o.id AS outlet_id,
       SUM(CASE WHEN v.status = 'IN_TRANSIT' AND v.is_blocked = 0 AND a.id IS NULL THEN 1 ELSE 0 END) AS in_transit_free,
       SUM(CASE WHEN v.status = 'IN_TRANSIT' AND a.id IS NOT NULL THEN 1 ELSE 0 END) AS in_transit_reserved,
       SUM(CASE WHEN v.status = 'RECEIVED' AND v.is_blocked = 0 AND a.id IS NULL THEN 1 ELSE 0 END) AS in_yard_free,
       SUM(CASE WHEN v.status = 'RECEIVED' AND a.id IS NOT NULL THEN 1 ELSE 0 END) AS in_yard_reserved,
       SUM(CASE WHEN v.status = 'INVOICED' THEN 1 ELSE 0 END) AS invoiced_in_stock,
       SUM(CASE WHEN v.status IN ('IN_TRANSIT','RECEIVED') AND v.is_blocked = 1 AND a.id IS NULL THEN 1 ELSE 0 END) AS blocked,
       SUM(CASE WHEN v.status IN ('IN_TRANSIT','RECEIVED') AND v.is_blocked = 0 AND a.id IS NULL THEN v.net_dealer_price ELSE NULL END) AS value_unsold
     FROM outlets o LEFT JOIN vehicles v ON v.outlet_id = o.id AND v.tenant_id = o.tenant_id AND v.status IN ('IN_TRANSIT','RECEIVED','INVOICED')
       LEFT JOIN allocations a ON a.vehicle_id = v.id AND a.status = 'ACTIVE'
     WHERE o.tenant_id = ? GROUP BY o.id`,
    ctx.tenantId,
  );
  if (!rows.length) return 0;
  await ctx.db.batch(
    rows.map((r) =>
      stmt(
        ctx.db,
        `INSERT INTO stock_positions (tenant_id, date, outlet_id, in_transit_free, in_transit_reserved, in_yard_free, in_yard_reserved, invoiced_in_stock, blocked, value_unsold, source, recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (tenant_id, date, outlet_id) DO UPDATE SET in_transit_free = excluded.in_transit_free, in_transit_reserved = excluded.in_transit_reserved, in_yard_free = excluded.in_yard_free, in_yard_reserved = excluded.in_yard_reserved,
           invoiced_in_stock = excluded.invoiced_in_stock, blocked = excluded.blocked, value_unsold = excluded.value_unsold, source = excluded.source, recorded_at = excluded.recorded_at`,
        ctx.tenantId, date, r.outlet_id, r.in_transit_free ?? 0, r.in_transit_reserved ?? 0, r.in_yard_free ?? 0, r.in_yard_reserved ?? 0, r.invoiced_in_stock ?? 0, r.blocked ?? 0, r.value_unsold, source, iso(ctx.now),
      ),
    ),
  );
  return rows.length;
}

export interface StockDayRow { date: string; outlet_id: string; outlet: string; in_transit_free: number; in_transit_reserved: number; in_yard_free: number; in_yard_reserved: number; invoiced_in_stock: number; blocked: number; total: number; value_unsold?: number | null; source: string }

/** The stock position of each outlet, day by day, for a period: one row per day and outlet, plus the dealership's total per day. */
export async function stockByDay(ctx: Ctx, outletIds: string[] | null, period: { from: string; to: string }, withValue: boolean) {
  const rows = await all<StockDayRow & { value_unsold: number | null }>(
    ctx.db,
    `SELECT p.date, p.outlet_id, o.name AS outlet, p.in_transit_free, p.in_transit_reserved, p.in_yard_free, p.in_yard_reserved, p.invoiced_in_stock, p.blocked, p.value_unsold, p.source,
            p.in_transit_free + p.in_transit_reserved + p.in_yard_free + p.in_yard_reserved + p.invoiced_in_stock + p.blocked AS total
     FROM stock_positions p JOIN outlets o ON o.id = p.outlet_id WHERE p.tenant_id = ? AND p.date >= ? AND p.date <= ? ${inList(outletIds, "p.outlet_id")} ORDER BY p.date, o.name`,
    ctx.tenantId, period.from, period.to, ...(outletIds ?? []),
  );
  const days = new Map<string, { date: string; outlets: StockDayRow[]; total: Omit<StockDayRow, "outlet_id" | "outlet" | "source"> }>();
  for (const r of rows) {
    const row: StockDayRow = { ...r, ...(withValue ? {} : { value_unsold: undefined }) };
    const d = days.get(r.date) ?? { date: r.date, outlets: [], total: { date: r.date, in_transit_free: 0, in_transit_reserved: 0, in_yard_free: 0, in_yard_reserved: 0, invoiced_in_stock: 0, blocked: 0, total: 0, ...(withValue ? { value_unsold: 0 } : {}) } };
    d.outlets.push(row);
    for (const k of ["in_transit_free", "in_transit_reserved", "in_yard_free", "in_yard_reserved", "invoiced_in_stock", "blocked", "total"] as const) d.total[k] += r[k];
    if (withValue) d.total.value_unsold = (d.total.value_unsold ?? 0) + (r.value_unsold ?? 0);
    days.set(r.date, d);
  }
  return {
    period,
    source: await dataStatus(ctx),
    days: [...days.values()],
    basis: "The position the system held at the end of each day on which a DMS file was loaded or the day-end reconciliation ran. Free: no booking holds the car. Reserved: allocated to a booking. A day with neither has no row.",
  };
}

// ---------------------------------------------------------------- allocations and releases by day and outlet

export interface AllocationDayRow {
  at: string;
  kind: "ALLOCATED" | "RELEASED";
  outlet: string;
  outlet_id: string;
  booking_id: string;
  booking_no: string;
  customer_name: string;
  model: string;
  variant: string;
  colour: string;
  vin: string;
  /** For an allocation: how it came about. For a release: why. */
  how: string;
  by: string;
}

/** Allocations made and releases (de-allocations) in a period, by day and outlet, with every one listed. */
export async function allocationsByDay(ctx: Ctx, outletIds: string[] | null, period: { from: string; to: string }) {
  const tz = ctx.tenant.timezone;
  const [a, b] = [localDayBounds(period.from, tz).start, localDayBounds(period.to, tz).end];
  const base = `FROM allocations x JOIN bookings bk ON bk.id = x.booking_id JOIN outlets o ON o.id = bk.outlet_id JOIN vehicles v ON v.id = x.vehicle_id LEFT JOIN users u ON u.id = x.allocated_by`;
  const made = await all<any>(ctx.db, `SELECT x.allocated_at AS at, o.name AS outlet, o.id AS outlet_id, bk.id AS booking_id, bk.booking_no, bk.customer_name, bk.model, bk.variant, bk.colour, v.vin, x.type, x.source, x.out_of_turn, x.exception_id, u.name AS by_name, x.allocated_by ${base} WHERE x.tenant_id = ? AND x.allocated_at >= ? AND x.allocated_at < ? ${inList(outletIds, "bk.outlet_id")} ORDER BY x.allocated_at`, ctx.tenantId, a, b, ...(outletIds ?? []));
  const released = await all<any>(ctx.db, `SELECT x.released_at AS at, o.name AS outlet, o.id AS outlet_id, bk.id AS booking_id, bk.booking_no, bk.customer_name, bk.model, bk.variant, bk.colour, v.vin, x.release_reason ${base} WHERE x.tenant_id = ? AND x.status = 'RELEASED' AND x.released_at >= ? AND x.released_at < ? ${inList(outletIds, "bk.outlet_id")} ORDER BY x.released_at`, ctx.tenantId, a, b, ...(outletIds ?? []));
  const who = (r: any) => (r.allocated_by === "SYSTEM" ? "System (queue)" : r.allocated_by === "DMS" || r.source === "DMS" ? "DMS allotment" : r.by_name ?? r.allocated_by);
  const rows: AllocationDayRow[] = [
    ...made.map((r) => ({ at: r.at, kind: "ALLOCATED" as const, outlet: r.outlet, outlet_id: r.outlet_id, booking_id: r.booking_id, booking_no: r.booking_no, customer_name: r.customer_name, model: r.model, variant: r.variant, colour: r.colour, vin: r.vin, how: `${r.type === "IN_TRANSIT" ? "Car in transit" : r.type === "REALLOCATED" ? "Re-allocated car" : "Free stock"}${r.source === "EXCEPTION" ? ", by approved request" : r.source === "DMS" ? ", allotted in the DMS" : ""}${r.out_of_turn ? " (out of turn)" : ""}`, by: who(r) })),
    ...released.map((r) => ({ at: r.at, kind: "RELEASED" as const, outlet: r.outlet, outlet_id: r.outlet_id, booking_id: r.booking_id, booking_no: r.booking_no, customer_name: r.customer_name, model: r.model, variant: r.variant, colour: r.colour, vin: r.vin, how: releaseWords(r.release_reason), by: "" })),
  ].sort((x, y) => x.at.localeCompare(y.at) || x.booking_no.localeCompare(y.booking_no));
  const days = new Map<string, { date: string; allocated: number; released: number; outlets: Record<string, { outlet: string; allocated: number; released: number }>; reasons: Record<string, number> }>();
  for (const r of rows) {
    const date = localParts(new Date(r.at), tz).date;
    const d = days.get(date) ?? { date, allocated: 0, released: 0, outlets: {}, reasons: {} };
    const o = (d.outlets[r.outlet_id] ??= { outlet: r.outlet, allocated: 0, released: 0 });
    if (r.kind === "ALLOCATED") { d.allocated++; o.allocated++; } else { d.released++; o.released++; d.reasons[r.how] = (d.reasons[r.how] ?? 0) + 1; }
    days.set(date, d);
  }
  return {
    period,
    source: await dataStatus(ctx),
    totals: { allocated: made.length, released: released.length },
    days: [...days.values()].map((d) => ({ ...d, outlets: Object.values(d.outlets).sort((x, y) => x.outlet.localeCompare(y.outlet)) })),
    rows,
    basis: "Every allocation made and every release in the period, dated by the dealership's calendar, under the outlet of the booking. A car moved from one customer to another appears as a release and an allocation.",
  };
}
