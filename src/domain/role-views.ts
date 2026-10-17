// What each person is answerable for, worked out once and read by whichever screen needs it.
//
// Four pictures, deliberately few. The earlier screens showed the same stock four ways and still could
// not answer "which model is piling up while we keep ordering it" — so these are organised by the
// question, not by the table they come from, and every screen that asks a question reads the one
// dataset that answers it.
//
//   modelPicture   what each model is doing: standing, moving, selling, on order, and what it ties up
//   holdingCars    cars a booking is holding: how long, paid or not, invoiced or not
//   waitingLine    customers with no car yet, and how long they have waited
//   dailyMovement  what happened each day: allocated, released, invoiced, delivered
//
// Everything is from the DMS files and what the app recorded. Nothing is estimated.

import type { Ctx } from "../env";
import { atLeastMinimum, belowMinimum, inQueue, queueMinimum } from "./queue";
import { all, first } from "../lib/db";
import { addDays, localDayBounds, localParts } from "../lib/util";
import { dataStatus } from "./data-status";

const inList = (ids: string[] | null, col: string) => (ids?.length ? ` AND ${col} IN (${ids.map(() => "?").join(",")})` : "");
const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) / 86_400_000);

export interface ModelRow {
  model: string;
  /** Free to offer a new customer. */
  yard_free: number;
  transit_free: number;
  /** Held by a booking. */
  yard_held: number;
  transit_held: number;
  blocked: number;
  /** Cars free to offer that have been here longer than 60 days. */
  old_free: number;
  oldest_days: number | null;
  /** Dealer price of the free cars, and of the old ones among them. Only where the role may see value. */
  value: number | null;
  old_value: number | null;
  /** Retail invoices raised for this model in the last 30 and 90 days. */
  sold_30: number;
  sold_90: number;
  /** Months of cover: free stock divided by the monthly rate of the last 90 days. Null when nothing sold. */
  months_of_cover: number | null;
  /** Customers waiting for this model with no car yet. */
  waiting: number;
  /** Quantity on order with the manufacturer that has not arrived. */
  on_order: number;
}

/**
 * What each model is doing. One row per model, and enough in it to answer the questions that used to
 * need four screens: what is standing, what is moving, what is selling, what is still being ordered,
 * and what it is all tying up.
 *
 * "Months of cover" is the one derived figure, and it is the honest version: free stock divided by what
 * actually sold over the last ninety days. Where nothing sold it is null rather than infinity, because
 * "we will never sell these" is a judgement and this is arithmetic.
 */
export async function modelPicture(ctx: Ctx, outletIds: string[] | null, withValue: boolean): Promise<{ as_of: string; rows: ModelRow[]; totals: { models: number; free: number; held: number; value: number | null; old_value: number | null }; source: Awaited<ReturnType<typeof dataStatus>>; basis: string }> {
  const tz = ctx.tenant.timezone;
  const today = localParts(ctx.now, tz).date;
  const T = ctx.tenantId;
  const vScope = inList(outletIds, "v.outlet_id");
  const o = outletIds ?? [];

  const stock = await all<{ model: string; status: string; held: number; blocked: number; price: number | null; age: number | null }>(
    ctx.db,
    `SELECT v.model, v.status, CASE WHEN a.id IS NULL THEN 0 ELSE 1 END AS held, v.is_blocked AS blocked, v.net_dealer_price AS price,
            CASE WHEN v.wholesale_invoice_date IS NULL THEN NULL ELSE CAST(julianday(?) - julianday(v.wholesale_invoice_date) AS INTEGER) END AS age
       FROM vehicles v LEFT JOIN allocations a ON a.vehicle_id = v.id AND a.status = 'ACTIVE'
      WHERE v.tenant_id = ? AND v.status IN ('RECEIVED','IN_TRANSIT') AND v.is_demo = 0${vScope}`,
    today, T, ...o,
  );

  const since30 = localDayBounds(addDays(today, -29), tz).start;
  const since90 = localDayBounds(addDays(today, -89), tz).start;
  const sold = await all<{ model: string; sold_30: number; sold_90: number }>(
    ctx.db,
    `SELECT v.model, SUM(CASE WHEN v.invoiced_at >= ? THEN 1 ELSE 0 END) AS sold_30, COUNT(*) AS sold_90
       FROM vehicles v WHERE v.tenant_id = ? AND v.status IN ('INVOICED','DELIVERED') AND v.invoiced_at >= ?${vScope} GROUP BY v.model`,
    since30, T, since90, ...o,
  );

  const waiting = await all<{ model: string; n: number }>(
    ctx.db,
    `SELECT b.model, COUNT(*) AS n FROM bookings b
      WHERE b.tenant_id = ? AND ${inQueue(ctx.settings, "b.")}
        AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.booking_id = b.id AND a.status = 'ACTIVE')${inList(outletIds, "b.outlet_id")}
      GROUP BY b.model`,
    T, ...o,
  );

  const ordered = await all<{ model: string; n: number }>(
    ctx.db,
    `SELECT model, SUM(quantity) AS n FROM order_requests WHERE tenant_id = ? AND status IN ('PLACED','CONFIRMED') GROUP BY model`,
    T,
  );

  const by = new Map<string, ModelRow>();
  const row = (model: string) =>
    by.get(model) ??
    (by.set(model, { model, yard_free: 0, transit_free: 0, yard_held: 0, transit_held: 0, blocked: 0, old_free: 0, oldest_days: null, value: withValue ? 0 : null, old_value: withValue ? 0 : null, sold_30: 0, sold_90: 0, months_of_cover: null, waiting: 0, on_order: 0 }),
    by.get(model)!);

  for (const c of stock) {
    const r = row(c.model);
    const free = !c.held && !c.blocked;
    if (c.blocked) r.blocked += 1;
    else if (c.status === "RECEIVED") (c.held ? (r.yard_held += 1) : (r.yard_free += 1));
    else (c.held ? (r.transit_held += 1) : (r.transit_free += 1));
    if (free) {
      if (c.age !== null && (r.oldest_days === null || c.age > r.oldest_days)) r.oldest_days = c.age;
      if (withValue && c.price) r.value = (r.value ?? 0) + c.price;
      if (c.age !== null && c.age > 60) {
        r.old_free += 1;
        if (withValue && c.price) r.old_value = (r.old_value ?? 0) + c.price;
      }
    }
  }
  for (const s of sold) {
    const r = row(s.model);
    r.sold_30 = s.sold_30;
    r.sold_90 = s.sold_90;
  }
  for (const w of waiting) row(w.model).waiting = w.n;
  for (const x of ordered) row(x.model).on_order = x.n;

  for (const r of by.values()) {
    const perMonth = r.sold_90 / 3;
    const free = r.yard_free + r.transit_free;
    r.months_of_cover = perMonth > 0 ? Math.round((free / perMonth) * 10) / 10 : null;
    if (withValue) {
      r.value = Math.round(r.value ?? 0);
      r.old_value = Math.round(r.old_value ?? 0);
    }
  }

  const rows = [...by.values()].sort((a, b) => b.yard_free + b.transit_free - (a.yard_free + a.transit_free) || a.model.localeCompare(b.model));
  return {
    as_of: today,
    rows,
    totals: {
      models: rows.length,
      free: rows.reduce((n, r) => n + r.yard_free + r.transit_free, 0),
      held: rows.reduce((n, r) => n + r.yard_held + r.transit_held, 0),
      value: withValue ? rows.reduce((n, r) => n + (r.value ?? 0), 0) : null,
      old_value: withValue ? rows.reduce((n, r) => n + (r.old_value ?? 0), 0) : null,
    },
    source: await dataStatus(ctx),
    basis:
      "Cars in the latest stock report, in the yard or on the way, demo cars excluded. Free means no booking holds the car and it is not blocked. " +
      "Age is days since the manufacturer's invoice date. Sold is retail invoices raised in the last 30 and 90 days. " +
      "Months of cover is free stock divided by the last 90 days' sales a month; where nothing sold in 90 days it is left blank rather than called infinite.",
  };
}

export interface HoldingRow {
  booking_id: string;
  booking_no: string;
  customer_name: string;
  model: string;
  variant: string;
  colour: string;
  vin: string;
  outlet: string;
  sales_exec: string | null;
  /** Days since the car was allocated to this booking. */
  held_days: number;
  /** Days since the car was at the dealership, which is when the payment window starts. Null while in transit. */
  window_days: number | null;
  at_dealership: boolean;
  payment: "NONE" | "REPORTED" | "RECEIVED";
  invoiced: boolean;
  /** Days since the retail invoice; null when not invoiced. */
  invoiced_days: number | null;
}

/**
 * Cars a booking is holding, with the two clocks that matter: how long the car has been held, and how
 * long since the money was due. A car held for a week against a booking nobody has paid for is stock
 * nobody can sell and a customer nobody has chased.
 */
export async function holdingCars(ctx: Ctx, outletIds: string[] | null): Promise<{ as_of: string; rows: HoldingRow[]; source: Awaited<ReturnType<typeof dataStatus>>; basis: string }> {
  const tz = ctx.tenant.timezone;
  const today = localParts(ctx.now, tz).date;
  const rows = await all<{
    booking_id: string; booking_no: string; customer_name: string; model: string; variant: string; colour: string; vin: string; outlet: string; sales_exec: string | null;
    allocated_at: string; alloc_source: string; dms_allotment_date: string | null; clock_started_at: string | null; vehicle_status: string; payment_reported_at: string | null; payment_received_at: string | null; invoiced_at: string | null;
  }>(
    ctx.db,
    `SELECT b.id AS booking_id, b.booking_no, b.customer_name, b.model, b.variant, b.colour, v.vin, o.name AS outlet, u.name AS sales_exec,
            a.allocated_at, a.source AS alloc_source, v.dms_allotment_date, a.clock_started_at, v.status AS vehicle_status, b.payment_reported_at, b.payment_received_at, b.invoiced_at
       FROM allocations a
       JOIN bookings b ON b.id = a.booking_id
       JOIN vehicles v ON v.id = a.vehicle_id
       JOIN outlets o ON o.id = v.outlet_id
       LEFT JOIN users u ON u.id = b.sales_exec_id
      WHERE a.tenant_id = ? AND a.status = 'ACTIVE' AND b.status IN ('ALLOCATED','INVOICED')${inList(outletIds, "b.outlet_id")}
      ORDER BY a.allocated_at`,
    ctx.tenantId, ...(outletIds ?? []),
  );
  const asDate = (s: string) => localParts(new Date(s), tz).date;
  return {
    as_of: today,
    rows: rows.map((r) => ({
      booking_id: r.booking_id,
      booking_no: r.booking_no,
      customer_name: r.customer_name,
      model: r.model,
      variant: r.variant,
      colour: r.colour,
      vin: r.vin,
      outlet: r.outlet,
      sales_exec: r.sales_exec,
      // How long this customer has had this car, which for an allotment the DMS made is counted from the
      // DMS's own allotment date — not from the day the file that disclosed it happened to be loaded.
      held_days: Math.max(0, days(r.alloc_source === "DMS" && r.dms_allotment_date ? r.dms_allotment_date : asDate(r.allocated_at), today)),
      window_days: r.clock_started_at ? Math.max(0, days(asDate(r.clock_started_at), today)) : null,
      at_dealership: r.vehicle_status !== "IN_TRANSIT",
      payment: r.payment_received_at ? "RECEIVED" : r.payment_reported_at ? "REPORTED" : "NONE",
      invoiced: Boolean(r.invoiced_at),
      invoiced_days: r.invoiced_at ? Math.max(0, days(asDate(r.invoiced_at), today)) : null,
    })),
    source: await dataStatus(ctx),
    basis:
      "Every car a booking is holding now. Held is days since the car was allotted — for an allotment the DMS made, from the allotment date in the stock report rather than the day that file was loaded. " +
      "The payment window counts from the day the car was at the dealership, so a car still in transit has no window yet. " +
      "Payment is what the system holds: reported by sales, or received once Finance has checked it against the bank.",
  };
}

export interface WaitingRow {
  booking_id: string;
  booking_no: string;
  customer_name: string;
  model: string;
  variant: string;
  colour: string;
  outlet: string;
  sales_exec: string | null;
  booked_on: string;
  waiting_days: number;
  on_hold: boolean;
  /** Free cars of exactly this model, variant and colour, before the queue ahead of this booking. */
  free_now: number;
  /** Quantity on order with the manufacturer for this configuration. */
  on_order: number;
}

export interface BelowMinimumRow {
  booking_id: string; booking_no: string; customer_name: string;
  model: string; variant: string; colour: string; outlet: string; sales_exec: string | null;
  booked_on: string; waiting_days: number;
  booking_amount: number;
  /** How much more the customer has to pay before they take a place in the queue. */
  short_by: number;
}

/** Customers with no car yet, oldest first: who is waiting, for what, and whether anything is coming. */
export async function waitingLine(ctx: Ctx, outletIds: string[] | null): Promise<{ as_of: string; rows: WaitingRow[]; below_minimum: { minimum: number; bookings: BelowMinimumRow[] }; buckets: { label: string; bookings: number }[]; source: Awaited<ReturnType<typeof dataStatus>>; basis: string }> {
  const tz = ctx.tenant.timezone;
  const today = localParts(ctx.now, tz).date;
  const rows = await all<{ booking_id: string; booking_no: string; customer_name: string; model: string; variant: string; colour: string; outlet: string; sales_exec: string | null; booked_on: string; on_hold: number }>(
    ctx.db,
    `SELECT b.id AS booking_id, b.booking_no, b.customer_name, b.model, b.variant, b.colour, o.name AS outlet, u.name AS sales_exec, b.priority_ts AS booked_on, b.on_hold
       FROM bookings b JOIN outlets o ON o.id = b.outlet_id LEFT JOIN users u ON u.id = b.sales_exec_id
      WHERE b.tenant_id = ? AND b.status = 'APPROVED' AND ${atLeastMinimum(ctx.settings, "b.")}
        AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.booking_id = b.id AND a.status = 'ACTIVE')${inList(outletIds, "b.outlet_id")}
      ORDER BY b.priority_ts`,
    ctx.tenantId, ...(outletIds ?? []),
  );
  const free = await all<{ model: string; variant: string; colour: string; n: number }>(
    ctx.db,
    `SELECT v.model, v.variant, v.colour, COUNT(*) AS n FROM vehicles v
      WHERE v.tenant_id = ? AND v.status IN ('RECEIVED','IN_TRANSIT') AND v.is_blocked = 0 AND v.is_demo = 0
        AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.vehicle_id = v.id AND a.status = 'ACTIVE')
      GROUP BY 1, 2, 3`,
    ctx.tenantId,
  );
  const orders = await all<{ model: string; variant: string; colour: string; n: number }>(
    ctx.db,
    `SELECT model, variant, colour, SUM(quantity) AS n FROM order_requests WHERE tenant_id = ? AND status IN ('PLACED','CONFIRMED') GROUP BY 1, 2, 3`,
    ctx.tenantId,
  );
  const k = (r: { model: string; variant: string; colour: string }) => `${r.model}|${r.variant}|${r.colour}`;
  const freeBy = new Map(free.map((f) => [k(f), f.n]));
  const orderBy = new Map(orders.map((f) => [k(f), f.n]));
  const out = rows.map((r) => ({
    booking_id: r.booking_id,
    booking_no: r.booking_no,
    customer_name: r.customer_name,
    model: r.model,
    variant: r.variant,
    colour: r.colour,
    outlet: r.outlet,
    sales_exec: r.sales_exec,
    booked_on: r.booked_on.slice(0, 10),
    waiting_days: Math.max(0, days(r.booked_on, today)),
    on_hold: Boolean(r.on_hold),
    free_now: freeBy.get(k(r)) ?? 0,
    on_order: orderBy.get(k(r)) ?? 0,
  }));
  // Customers who have booked but not paid the dealership's minimum are not in the queue — that is the
  // rule — but they must not disappear with it. Somebody has to collect that money, and a customer who
  // silently stopped counting is a customer nobody rings.
  const short = await all<{ booking_id: string; booking_no: string; customer_name: string; model: string; variant: string; colour: string; outlet: string; sales_exec: string | null; booked_on: string; booking_amount: number }>(
    ctx.db,
    `SELECT b.id AS booking_id, b.booking_no, b.customer_name, b.model, b.variant, b.colour, o.name AS outlet, u.name AS sales_exec, b.priority_ts AS booked_on, b.booking_amount
       FROM bookings b JOIN outlets o ON o.id = b.outlet_id LEFT JOIN users u ON u.id = b.sales_exec_id
      WHERE b.tenant_id = ? AND ${belowMinimum(ctx.settings, "b.")}
        AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.booking_id = b.id AND a.status = 'ACTIVE')${inList(outletIds, "b.outlet_id")}
      ORDER BY b.priority_ts`,
    ctx.tenantId, ...(outletIds ?? []),
  );

  const bands: [string, number, number][] = [["0-7 days", 0, 7], ["8-15 days", 8, 15], ["16-30 days", 16, 30], ["31-60 days", 31, 60], ["Over 60 days", 61, 1e9]];
  return {
    as_of: today,
    rows: out,
    below_minimum: {
      minimum: queueMinimum(ctx.settings),
      bookings: short.map((r) => ({ ...r, booked_on: r.booked_on.slice(0, 10), waiting_days: Math.max(0, days(r.booked_on, today)), short_by: Math.max(0, queueMinimum(ctx.settings) - (r.booking_amount ?? 0)) })),
    },
    buckets: bands.map(([label, lo, hi]) => ({ label, bookings: out.filter((r) => r.waiting_days >= lo && r.waiting_days <= hi).length })),
    source: await dataStatus(ctx),
    basis: `Approved bookings with no car allocated to them, that have paid the dealership's minimum booking amount of ${queueMinimum(ctx.settings)} — below it a booking takes no place in the queue, and those customers are listed apart so the money can still be collected. Waiting is days since the booking's place in the queue was set. Free now counts cars of exactly that model, variant and colour that no booking holds — the queue ahead of this customer is not deducted.`,
  };
}

export interface DayRow {
  date: string;
  allocated: number;
  released: number;
  invoiced: number;
  delivered: number;
}

/** What moved each day: cars given to customers, cars that came back, invoices raised and cars handed over. */
export async function dailyMovement(ctx: Ctx, from: string, to: string, outletIds: string[] | null): Promise<{ period: { from: string; to: string }; days: DayRow[]; totals: DayRow; source: Awaited<ReturnType<typeof dataStatus>>; basis: string }> {
  const tz = ctx.tenant.timezone;
  const T = ctx.tenantId;
  const [a, b] = [localDayBounds(from, tz).start, localDayBounds(to, tz).end];
  const bScope = inList(outletIds, "b.outlet_id");
  const o = outletIds ?? [];
  const pick = async (sql: string, ...p: unknown[]) => all<{ d: string; n: number }>(ctx.db, sql, ...p);

  // The day an allotment happened, not the day this system heard about it. An allotment made in the DMS
  // arrives in a file, often weeks later and in a batch with hundreds of others; counting those on the
  // day of the load would put a dealership's whole history on one spike and say nothing about how it
  // trades. The stock report carries its own allotment date, so that is the day used wherever there is
  // one; the system's own allocations are counted on the day it made them.
  const allocDay = `date(COALESCE(CASE WHEN al.source = 'DMS' THEN v.dms_allotment_date END, al.allocated_at))`;
  const allocated = await pick(
    `SELECT ${allocDay} AS d, COUNT(*) AS n FROM allocations al JOIN bookings b ON b.id = al.booking_id JOIN vehicles v ON v.id = al.vehicle_id
      WHERE al.tenant_id = ? AND ${allocDay} >= date(?) AND ${allocDay} <= date(?)${bScope} GROUP BY d`, T, from, to, ...o);
  const released = await pick(
    `SELECT date(al.released_at) AS d, COUNT(*) AS n FROM allocations al JOIN bookings b ON b.id = al.booking_id
      WHERE al.tenant_id = ? AND al.released_at IS NOT NULL AND al.released_at >= ? AND al.released_at < ?${bScope} GROUP BY d`, T, a, b, ...o);
  const invoiced = await pick(
    `SELECT date(b.invoiced_at) AS d, COUNT(*) AS n FROM bookings b
      WHERE b.tenant_id = ? AND b.invoiced_at IS NOT NULL AND b.invoiced_at >= ? AND b.invoiced_at < ?${bScope} GROUP BY d`, T, a, b, ...o);
  const delivered = await pick(
    `SELECT date(b.delivered_at) AS d, COUNT(*) AS n FROM bookings b
      WHERE b.tenant_id = ? AND b.delivered_at IS NOT NULL AND b.delivered_at >= ? AND b.delivered_at < ?${bScope} GROUP BY d`, T, a, b, ...o);

  const at = (xs: { d: string; n: number }[], d: string) => xs.find((x) => x.d === d)?.n ?? 0;
  const out: DayRow[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push({ date: d, allocated: at(allocated, d), released: at(released, d), invoiced: at(invoiced, d), delivered: at(delivered, d) });
  const sum = (f: (r: DayRow) => number) => out.reduce((n, r) => n + f(r), 0);
  return {
    period: { from, to },
    days: out,
    totals: { date: `${from}..${to}`, allocated: sum((r) => r.allocated), released: sum((r) => r.released), invoiced: sum((r) => r.invoiced), delivered: sum((r) => r.delivered) },
    source: await dataStatus(ctx),
    basis:
      "Counted by the day each thing happened: the day a car was allotted, the day an allotment was released and the car went back to free stock, the day the retail invoice was raised, and the day the car was handed over. " +
      "An allotment the DMS made is counted on the allotment date in the stock report, not the day the file was loaded; one this system made is counted on the day it made it. " +
      "A day with no activity is shown as zero rather than left out.",
  };
}

/** One sales executive's own picture: their bookings, and what is holding a car for them. */
export async function myWork(ctx: Ctx, userId: string): Promise<{ as_of: string; counts: { waiting: number; allocated: number; invoiced: number; delivered_30: number; no_car_coming: number }; basis: string }> {
  const tz = ctx.tenant.timezone;
  const today = localParts(ctx.now, tz).date;
  const since30 = localDayBounds(addDays(today, -29), tz).start;
  const n = async (sql: string, ...p: unknown[]) => (await first<{ n: number }>(ctx.db, sql, ...p))?.n ?? 0;
  const mine = `b.tenant_id = ? AND (b.sales_exec_id = ? OR b.created_by = ?)`;
  const counts = {
    waiting: await n(`SELECT COUNT(*) AS n FROM bookings b WHERE ${mine} AND b.status = 'APPROVED' AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.booking_id = b.id AND a.status = 'ACTIVE')`, ctx.tenantId, userId, userId),
    allocated: await n(`SELECT COUNT(*) AS n FROM bookings b WHERE ${mine} AND b.status = 'ALLOCATED'`, ctx.tenantId, userId, userId),
    invoiced: await n(`SELECT COUNT(*) AS n FROM bookings b WHERE ${mine} AND b.status = 'INVOICED'`, ctx.tenantId, userId, userId),
    delivered_30: await n(`SELECT COUNT(*) AS n FROM bookings b WHERE ${mine} AND b.status = 'DELIVERED' AND b.delivered_at >= ?`, ctx.tenantId, userId, userId, since30),
    no_car_coming: 0,
  };
  counts.no_car_coming = await n(
    `SELECT COUNT(*) AS n FROM bookings b
      WHERE ${mine} AND ${inQueue(ctx.settings, "b.")}
        AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.booking_id = b.id AND a.status = 'ACTIVE')
        AND NOT EXISTS (SELECT 1 FROM vehicles v WHERE v.tenant_id = b.tenant_id AND v.model = b.model AND v.variant = b.variant AND v.colour = b.colour AND v.status IN ('RECEIVED','IN_TRANSIT') AND v.is_blocked = 0 AND v.is_demo = 0
                          AND NOT EXISTS (SELECT 1 FROM allocations a2 WHERE a2.vehicle_id = v.id AND a2.status = 'ACTIVE'))
        AND NOT EXISTS (SELECT 1 FROM order_requests r WHERE r.tenant_id = b.tenant_id AND r.model = b.model AND r.variant = b.variant AND r.colour = b.colour AND r.status IN ('PLACED','CONFIRMED'))`,
    ctx.tenantId, userId, userId,
  );
  return {
    as_of: today,
    counts,
    basis: "Bookings you created or that are assigned to you. Delivered counts the last 30 days. No car coming means nothing of that model, variant and colour is free in the yard, on the way, or on order.",
  };
}

export interface DemandRow {
  model: string;
  variant: string;
  colour: string;
  /** Customers in the queue for exactly this car, and the longest any of them has waited. */
  queue: number;
  on_hold: number;
  longest_wait_days: number;
  /** Free to give out now, before the queue is served. */
  free_now: number;
  on_order: number;
  /** Queue minus what is free and on order: how many of these still have nothing coming. */
  short_by: number;
}

/**
 * The order bank: who is queued for what. In this market the queue is the demand signal — a model with
 * forty people waiting and nothing coming is a different problem from one with forty in the yard and
 * nobody waiting, and both are invisible in a stock report read on its own.
 *
 * Sorted by the longest queue, so the most-wanted car is the first row. Reading from the bottom gives
 * the configurations nobody is asking for.
 */
export async function demandQueue(ctx: Ctx, outletIds: string[] | null): Promise<{ as_of: string; rows: DemandRow[]; totals: { waiting: number; configurations: number; short: number }; source: Awaited<ReturnType<typeof dataStatus>>; basis: string }> {
  const tz = ctx.tenant.timezone;
  const today = localParts(ctx.now, tz).date;
  const queue = await all<{ model: string; variant: string; colour: string; queue: number; on_hold: number; earliest: string }>(
    ctx.db,
    `SELECT b.model, b.variant, b.colour, SUM(CASE WHEN b.on_hold = 0 THEN 1 ELSE 0 END) AS queue, SUM(b.on_hold) AS on_hold, MIN(b.priority_ts) AS earliest
       FROM bookings b
      WHERE b.tenant_id = ? AND b.status = 'APPROVED' AND ${atLeastMinimum(ctx.settings, "b.")}
        AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.booking_id = b.id AND a.status = 'ACTIVE')${inList(outletIds, "b.outlet_id")}
      GROUP BY 1, 2, 3`,
    ctx.tenantId, ...(outletIds ?? []),
  );
  const free = await all<{ model: string; variant: string; colour: string; n: number }>(
    ctx.db,
    `SELECT v.model, v.variant, v.colour, COUNT(*) AS n FROM vehicles v
      WHERE v.tenant_id = ? AND v.status IN ('RECEIVED','IN_TRANSIT') AND v.is_blocked = 0 AND v.is_demo = 0
        AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.vehicle_id = v.id AND a.status = 'ACTIVE')
      GROUP BY 1, 2, 3`,
    ctx.tenantId,
  );
  const orders = await all<{ model: string; variant: string; colour: string; n: number }>(
    ctx.db,
    `SELECT model, variant, colour, SUM(quantity) AS n FROM order_requests WHERE tenant_id = ? AND status IN ('PLACED','CONFIRMED') GROUP BY 1, 2, 3`,
    ctx.tenantId,
  );
  const k = (r: { model: string; variant: string; colour: string }) => `${r.model}|${r.variant}|${r.colour}`;
  const freeBy = new Map(free.map((f) => [k(f), f.n]));
  const orderBy = new Map(orders.map((f) => [k(f), f.n]));
  const rows = queue
    .map((q) => {
      const freeNow = freeBy.get(k(q)) ?? 0;
      const onOrder = orderBy.get(k(q)) ?? 0;
      return {
        model: q.model,
        variant: q.variant,
        colour: q.colour,
        queue: q.queue,
        on_hold: q.on_hold,
        longest_wait_days: Math.max(0, days(q.earliest, today)),
        free_now: freeNow,
        on_order: onOrder,
        short_by: Math.max(0, q.queue - freeNow - onOrder),
      };
    })
    .sort((a, b) => b.queue - a.queue || b.longest_wait_days - a.longest_wait_days || a.model.localeCompare(b.model));
  return {
    as_of: today,
    rows,
    totals: { waiting: rows.reduce((n, r) => n + r.queue, 0), configurations: rows.length, short: rows.reduce((n, r) => n + r.short_by, 0) },
    source: await dataStatus(ctx),
    basis:
      "Approved bookings with no car allocated, grouped by the exact model, variant and colour asked for. Free now is cars no booking holds; on order is what has been placed with the manufacturer and not arrived. " +
      "Short by is the queue less both of those — customers for whom nothing exists anywhere yet. Bookings on hold are counted apart and are not in the queue figure.",
  };
}

export interface DueRow {
  booking_id: string;
  booking_no: string;
  customer_name: string;
  model: string;
  variant: string;
  colour: string;
  vin: string;
  outlet: string;
  sales_exec: string | null;
  /** Days the payment window has run. The window starts when the car is at the dealership. */
  window_days: number;
  /** Days left before the dealership's own re-allocation rule applies; negative once it has passed. */
  days_left: number;
  state: "AWAITING" | "REPORTED";
  booking_amount: number;
  reported_amount: number | null;
  reported_on: string | null;
}

/**
 * Money owed on cars that are already held. A car standing against a booking nobody has paid for is
 * stock that cannot be sold and a customer nobody has chased, and it is the single most common way a
 * dealership's yard silently fills up.
 *
 * What this cannot do: tell you the balance due. Neither DMS file carries the deal value — the on-road
 * price, the exchange, the finance — so the amount a customer still owes is not in this system. What is
 * here is what the dealership recorded: the booking amount, anything sales has reported, and how long
 * the window has run. It is deliberately not dressed up as a balance.
 */
export async function paymentsDue(ctx: Ctx, outletIds: string[] | null): Promise<{ as_of: string; rows: DueRow[]; buckets: { label: string; bookings: number }[]; totals: { awaiting: number; reported: number; past_window: number; booking_amount: number }; window_days: number; source: Awaited<ReturnType<typeof dataStatus>>; basis: string }> {
  const tz = ctx.tenant.timezone;
  const today = localParts(ctx.now, tz).date;
  const limit = ctx.settings.reallocate_days;
  const rows = await all<{
    booking_id: string; booking_no: string; customer_name: string; model: string; variant: string; colour: string; vin: string; outlet: string; sales_exec: string | null;
    clock_started_at: string | null; booking_amount: number; payment_reported_at: string | null; payment_amount: number | null;
  }>(
    ctx.db,
    `SELECT b.id AS booking_id, b.booking_no, b.customer_name, b.model, b.variant, b.colour, v.vin, o.name AS outlet, u.name AS sales_exec,
            a.clock_started_at, b.booking_amount, b.payment_reported_at, b.payment_amount
       FROM allocations a
       JOIN bookings b ON b.id = a.booking_id
       JOIN vehicles v ON v.id = a.vehicle_id
       JOIN outlets o ON o.id = v.outlet_id
       LEFT JOIN users u ON u.id = b.sales_exec_id
      WHERE a.tenant_id = ? AND a.status = 'ACTIVE' AND b.status = 'ALLOCATED' AND b.payment_received_at IS NULL
        AND a.clock_started_at IS NOT NULL${inList(outletIds, "b.outlet_id")}
      ORDER BY a.clock_started_at`,
    ctx.tenantId, ...(outletIds ?? []),
  );
  const out: DueRow[] = rows.map((r) => {
    const window = Math.max(0, days(localParts(new Date(r.clock_started_at!), tz).date, today));
    return {
      booking_id: r.booking_id,
      booking_no: r.booking_no,
      customer_name: r.customer_name,
      model: r.model,
      variant: r.variant,
      colour: r.colour,
      vin: r.vin,
      outlet: r.outlet,
      sales_exec: r.sales_exec,
      window_days: window,
      days_left: limit - window,
      state: r.payment_reported_at ? "REPORTED" : "AWAITING",
      booking_amount: r.booking_amount,
      reported_amount: r.payment_amount,
      reported_on: r.payment_reported_at ? localParts(new Date(r.payment_reported_at), tz).date : null,
    };
  });
  const bands: [string, number, number][] = [["Due today or tomorrow", 0, 1], ["2-5 days in", 2, 5], ["6-10 days in", 6, 10], ["Over 10 days in", 11, 1e9]];
  return {
    as_of: today,
    rows: out,
    buckets: bands.map(([label, lo, hi]) => ({ label, bookings: out.filter((r) => r.window_days >= lo && r.window_days <= hi).length })),
    totals: {
      awaiting: out.filter((r) => r.state === "AWAITING").length,
      reported: out.filter((r) => r.state === "REPORTED").length,
      past_window: out.filter((r) => r.days_left < 0).length,
      booking_amount: Math.round(out.reduce((n, r) => n + (r.booking_amount ?? 0), 0)),
    },
    window_days: limit,
    source: await dataStatus(ctx),
    basis:
      `Cars held against a booking whose payment Finance has not confirmed. The window counts from the day the car was at the dealership; this dealership re-allocates after ${limit} days. ` +
      "Neither DMS file carries the deal value, so the balance a customer still owes is not in this system: what is shown is the booking amount and anything sales has reported.",
  };
}

/**
 * The two money questions a Dealer Principal asks: what is stuck, and what moved.
 *
 * Blocked is the dealer price of cars nobody has booked, by how long they have stood — the dealership's
 * own money, sitting. Churned is the dealer price of cars retail-invoiced in the period: the same money
 * turning back over. Both come from the net dealer price in the stock report, and cars the file carries
 * no price for are counted separately rather than quietly left out of a total.
 */
export async function moneyFlow(ctx: Ctx, from: string, to: string, outletIds: string[] | null): Promise<{ period: { from: string; to: string }; blocked: { label: string; cars: number; value: number }[]; blocked_total: { cars: number; value: number; unpriced: number }; churned: { cars: number; value: number; unpriced: number }; source: Awaited<ReturnType<typeof dataStatus>>; basis: string }> {
  const tz = ctx.tenant.timezone;
  const today = localParts(ctx.now, tz).date;
  const T = ctx.tenantId;
  const o = outletIds ?? [];
  const held = await all<{ price: number | null; age: number | null }>(
    ctx.db,
    `SELECT v.net_dealer_price AS price,
            CASE WHEN v.wholesale_invoice_date IS NULL THEN NULL ELSE CAST(julianday(?) - julianday(v.wholesale_invoice_date) AS INTEGER) END AS age
       FROM vehicles v
      WHERE v.tenant_id = ? AND v.status IN ('RECEIVED','IN_TRANSIT') AND v.is_demo = 0
        AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.vehicle_id = v.id AND a.status = 'ACTIVE')${inList(outletIds, "v.outlet_id")}`,
    today, T, ...o,
  );
  const bands: [string, number, number][] = [["0-30 days", 0, 30], ["31-60 days", 31, 60], ["61-90 days", 61, 90], ["Over 90 days", 91, 1e9]];
  const blocked = bands.map(([label, lo, hi]) => {
    const cars = held.filter((c) => c.age !== null && c.age >= lo && c.age <= hi);
    return { label, cars: cars.length, value: Math.round(cars.reduce((n, c) => n + (c.price ?? 0), 0)) };
  });
  const sold = await all<{ price: number | null }>(
    ctx.db,
    `SELECT v.net_dealer_price AS price FROM vehicles v
      WHERE v.tenant_id = ? AND v.status IN ('INVOICED','DELIVERED') AND v.invoiced_at >= ? AND v.invoiced_at < ?${inList(outletIds, "v.outlet_id")}`,
    T, localDayBounds(from, tz).start, localDayBounds(to, tz).end, ...o,
  );
  return {
    period: { from, to },
    blocked,
    blocked_total: { cars: held.length, value: Math.round(held.reduce((n, c) => n + (c.price ?? 0), 0)), unpriced: held.filter((c) => c.price === null).length },
    churned: { cars: sold.length, value: Math.round(sold.reduce((n, c) => n + (c.price ?? 0), 0)), unpriced: sold.filter((c) => c.price === null).length },
    source: await dataStatus(ctx),
    basis:
      "Blocked is the net dealer price in the stock report of cars no booking holds, banded by days since the manufacturer's invoice. Churned is the same price for cars retail-invoiced in the period. " +
      "Cars the file carries no price for are counted and reported apart, never folded into a total as zero. Demo cars are not stock to sell and are excluded.",
  };
}

export interface ControlViolation {
  kind: "OVERTURNED" | "UNKNOWN_BOOKING" | "NOT_THROUGH_SYSTEM";
  booking_id: string;
  booking_no: string;
  customer_name: string;
  vin: string;
  /** For an overturned allocation: the booking the car was taken from, or the car it replaced. */
  taken_from_booking_no: string | null;
  instead_of_vin: string | null;
  at: string;
}

/**
 * Who allocated what today, and what got round the system.
 *
 * The question this answers is the one asked after the evening's files are loaded: how many cars
 * did this system give out, how many of those has the DMS caught up with, and what was allotted
 * somewhere else. The DMS is the record, so the last of those is a report rather than a block —
 * but from the day the dealership puts allocation through this system, it is a violation and the
 * people who approve a car being taken back are told.
 *
 * `confirmed` is not a formality. An allocation this system made is confirmed when a later stock
 * report shows the DMS agreeing; one that stays unconfirmed is either not yet keyed in or was keyed
 * in and did not take, and both are the back office's to chase.
 */
export async function allocationControl(ctx: Ctx, outletIds: string[] | null, date?: string) {
  const day = date ?? localParts(ctx.now, ctx.tenant.timezone).date;
  const { start, end } = localDayBounds(day, ctx.tenant.timezone);
  const scope = outletIds ? `AND b.outlet_id IN (${outletIds.map(() => "?").join(",") || "''"})` : "";
  const ids = outletIds ?? [];

  const made = await all<{ source: string; allocated_by: string; confirmed: number; n: number }>(
    ctx.db,
    `SELECT a.source, a.allocated_by, CASE WHEN a.dms_confirmed_at IS NULL THEN 0 ELSE 1 END AS confirmed, COUNT(*) AS n
     FROM allocations a JOIN bookings b ON b.id = a.booking_id AND b.tenant_id = a.tenant_id
     WHERE a.tenant_id = ? AND a.allocated_at >= ? AND a.allocated_at < ? ${scope}
     GROUP BY a.source, a.allocated_by, confirmed`,
    ctx.tenantId, start, end, ...ids,
  );
  // "By this system" means the queue decided it. An approved request is this system too, but it is a
  // person's decision carried out here, and the two are worth counting apart.
  const sum = (p: (r: (typeof made)[number]) => boolean) => made.filter(p).reduce((n, r) => n + r.n, 0);
  const bySystem = sum((r) => r.source === "SYSTEM");
  const byRequest = sum((r) => r.source === "EXCEPTION");
  const fromDms = sum((r) => r.source === "DMS");

  const rows = await all<ControlViolation & { detail_json: string }>(
    ctx.db,
    `SELECT l.at, l.entity_id AS booking_id, l.detail_json
     FROM audit_log l JOIN bookings b ON b.id = l.entity_id AND b.tenant_id = l.tenant_id
     WHERE l.tenant_id = ? AND l.action = 'ALLOTTED_OUTSIDE_SYSTEM' AND l.at >= ? AND l.at < ? ${scope}
     ORDER BY l.at`,
    ctx.tenantId, start, end, ...ids,
  );
  const violations: ControlViolation[] = rows.map((r) => {
    const d = JSON.parse(r.detail_json) as Record<string, string>;
    return {
      kind: (d.violation ?? "NOT_THROUGH_SYSTEM") as ControlViolation["kind"],
      booking_id: r.booking_id,
      booking_no: d.booking_no,
      customer_name: d.customer_name,
      vin: d.vin,
      taken_from_booking_no: d.taken_from_booking_no ?? null,
      instead_of_vin: d.instead_of_vin ?? null,
      at: r.at,
    };
  });

  return {
    date: day,
    /** The day this dealership put allocation through the system; null while it has not. */
    controls_from: ctx.settings.allocation_control_from,
    in_control: Boolean(ctx.settings.allocation_control_from && day >= ctx.settings.allocation_control_from),
    allocated: {
      by_system: bySystem,
      by_approved_request: byRequest,
      adopted_from_dms: fromDms,
      total: bySystem + byRequest + fromDms,
    },
    /** Of what this system decided, how much the DMS has caught up with. */
    confirmed_in_dms: sum((r) => r.source !== "DMS" && r.confirmed === 1),
    awaiting_entry_in_dms: sum((r) => r.source !== "DMS" && r.confirmed === 0),
    violations: {
      total: violations.length,
      overturned: violations.filter((v) => v.kind === "OVERTURNED").length,
      unknown_booking: violations.filter((v) => v.kind === "UNKNOWN_BOOKING").length,
      not_through_system: violations.filter((v) => v.kind === "NOT_THROUGH_SYSTEM").length,
      rows: violations,
    },
    source: await dataStatus(ctx),
    basis:
      "Allocations are counted by the day they were made, under the outlet of the booking. 'By this system' is the queue's own decision; 'by approved request' is a car moved on a request somebody approved. A violation is an allotment that appears in the DMS without having come through here, counted only from the day the dealership put allocation through this system.",
  };
}
