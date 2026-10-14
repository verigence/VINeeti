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
      WHERE b.tenant_id = ? AND b.status = 'APPROVED' AND b.on_hold = 0
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
    allocated_at: string; clock_started_at: string | null; vehicle_status: string; payment_reported_at: string | null; payment_received_at: string | null; invoiced_at: string | null;
  }>(
    ctx.db,
    `SELECT b.id AS booking_id, b.booking_no, b.customer_name, b.model, b.variant, b.colour, v.vin, o.name AS outlet, u.name AS sales_exec,
            a.allocated_at, a.clock_started_at, v.status AS vehicle_status, b.payment_reported_at, b.payment_received_at, b.invoiced_at
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
      held_days: Math.max(0, days(asDate(r.allocated_at), today)),
      window_days: r.clock_started_at ? Math.max(0, days(asDate(r.clock_started_at), today)) : null,
      at_dealership: r.vehicle_status !== "IN_TRANSIT",
      payment: r.payment_received_at ? "RECEIVED" : r.payment_reported_at ? "REPORTED" : "NONE",
      invoiced: Boolean(r.invoiced_at),
      invoiced_days: r.invoiced_at ? Math.max(0, days(asDate(r.invoiced_at), today)) : null,
    })),
    source: await dataStatus(ctx),
    basis:
      "Every car a booking is holding now. Held is days since the car was allocated. The payment window counts from the day the car was at the dealership, so a car still in transit has no window yet. " +
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

/** Customers with no car yet, oldest first: who is waiting, for what, and whether anything is coming. */
export async function waitingLine(ctx: Ctx, outletIds: string[] | null): Promise<{ as_of: string; rows: WaitingRow[]; buckets: { label: string; bookings: number }[]; source: Awaited<ReturnType<typeof dataStatus>>; basis: string }> {
  const tz = ctx.tenant.timezone;
  const today = localParts(ctx.now, tz).date;
  const rows = await all<{ booking_id: string; booking_no: string; customer_name: string; model: string; variant: string; colour: string; outlet: string; sales_exec: string | null; booked_on: string; on_hold: number }>(
    ctx.db,
    `SELECT b.id AS booking_id, b.booking_no, b.customer_name, b.model, b.variant, b.colour, o.name AS outlet, u.name AS sales_exec, b.priority_ts AS booked_on, b.on_hold
       FROM bookings b JOIN outlets o ON o.id = b.outlet_id LEFT JOIN users u ON u.id = b.sales_exec_id
      WHERE b.tenant_id = ? AND b.status = 'APPROVED'
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
  const bands: [string, number, number][] = [["0-7 days", 0, 7], ["8-15 days", 8, 15], ["16-30 days", 16, 30], ["31-60 days", 31, 60], ["Over 60 days", 61, 1e9]];
  return {
    as_of: today,
    rows: out,
    buckets: bands.map(([label, lo, hi]) => ({ label, bookings: out.filter((r) => r.waiting_days >= lo && r.waiting_days <= hi).length })),
    source: await dataStatus(ctx),
    basis: "Approved bookings with no car allocated to them. Waiting is days since the booking's place in the queue was set. Free now counts cars of exactly that model, variant and colour that no booking holds — the queue ahead of this customer is not deducted.",
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

  const allocated = await pick(
    `SELECT date(al.allocated_at) AS d, COUNT(*) AS n FROM allocations al JOIN bookings b ON b.id = al.booking_id
      WHERE al.tenant_id = ? AND al.allocated_at >= ? AND al.allocated_at < ?${bScope} GROUP BY d`, T, a, b, ...o);
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
      "Counted by the day each thing happened: the day a car was allocated, the day an allocation was released and the car went back to free stock, the day the retail invoice was raised, and the day the car was handed over. " +
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
      WHERE ${mine} AND b.status = 'APPROVED' AND b.on_hold = 0
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
