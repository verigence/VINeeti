import type { Ctx } from "../env";
import { all, first } from "../lib/db";
import { addDays, localDayBounds, localParts } from "../lib/util";
import { dataStatus } from "./data-status";
import { windowSchedule } from "./timers";

const inList = (ids: string[] | null, col: string) => (ids ? `AND ${col} IN (${ids.map(() => "?").join(",") || "''"})` : "");

/** Headline numbers for the home screen. */
export async function overview(ctx: Ctx, outletIds: string[] | null, onlyUserId: string | null = null) {
  const T = ctx.tenantId;
  const o = outletIds ?? [];
  const today = localParts(ctx.now, ctx.tenant.timezone).date;
  const n = async (sql: string, ...p: unknown[]) => (await first<{ n: number }>(ctx.db, sql, ...p))?.n ?? 0;
  const vScope = inList(outletIds, "v.outlet_id"), bScope = inList(outletIds, "b.outlet_id");
  // Someone who sees only their own bookings gets their own numbers, so each tile agrees with the list behind it.
  const mine = onlyUserId ? "AND (b.sales_exec_id = ? OR b.created_by = ?)" : "";
  const me = onlyUserId ? [onlyUserId, onlyUserId] : [];
  return {
    stock: {
      yard_free: await n(`SELECT COUNT(*) AS n FROM vehicles v WHERE v.tenant_id = ? AND v.status = 'RECEIVED' AND v.is_blocked = 0 ${vScope} AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.vehicle_id = v.id AND a.status = 'ACTIVE')`, T, ...o),
      yard_allocated: await n(`SELECT COUNT(*) AS n FROM vehicles v WHERE v.tenant_id = ? AND v.status = 'RECEIVED' ${vScope} AND EXISTS (SELECT 1 FROM allocations a WHERE a.vehicle_id = v.id AND a.status = 'ACTIVE')`, T, ...o),
      transit_free: await n(`SELECT COUNT(*) AS n FROM vehicles v WHERE v.tenant_id = ? AND v.status = 'IN_TRANSIT' AND v.is_blocked = 0 ${vScope} AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.vehicle_id = v.id AND a.status = 'ACTIVE')`, T, ...o),
      transit_allocated: await n(`SELECT COUNT(*) AS n FROM vehicles v WHERE v.tenant_id = ? AND v.status = 'IN_TRANSIT' ${vScope} AND EXISTS (SELECT 1 FROM allocations a WHERE a.vehicle_id = v.id AND a.status = 'ACTIVE')`, T, ...o),
      blocked: await n(`SELECT COUNT(*) AS n FROM vehicles v WHERE v.tenant_id = ? AND v.status IN ('RECEIVED','IN_TRANSIT') AND v.is_blocked = 1 ${vScope}`, T, ...o),
      transit_overdue: await n(`SELECT COUNT(*) AS n FROM vehicles v WHERE v.tenant_id = ? AND v.status = 'IN_TRANSIT' AND v.expected_arrival_date < ? ${vScope}`, T, today, ...o),
    },
    bookings: {
      draft: await n(`SELECT COUNT(*) AS n FROM bookings b WHERE b.tenant_id = ? AND b.status = 'DRAFT' ${bScope} ${mine}`, T, ...o, ...me),
      awaiting_approval: await n(`SELECT COUNT(*) AS n FROM bookings b WHERE b.tenant_id = ? AND b.status = 'SUBMITTED' ${bScope} ${mine}`, T, ...o, ...me),
      waiting: await n(`SELECT COUNT(*) AS n FROM bookings b WHERE b.tenant_id = ? AND b.status = 'APPROVED' AND b.on_hold = 0 ${bScope} ${mine}`, T, ...o, ...me),
      on_hold: await n(`SELECT COUNT(*) AS n FROM bookings b WHERE b.tenant_id = ? AND b.status = 'APPROVED' AND b.on_hold = 1 ${bScope} ${mine}`, T, ...o, ...me),
      allocated: await n(`SELECT COUNT(*) AS n FROM bookings b WHERE b.tenant_id = ? AND b.status = 'ALLOCATED' ${bScope} ${mine}`, T, ...o, ...me),
      invoiced: await n(`SELECT COUNT(*) AS n FROM bookings b WHERE b.tenant_id = ? AND b.status = 'INVOICED' ${bScope} ${mine}`, T, ...o, ...me),
      delivery_overdue: await n(`SELECT COUNT(*) AS n FROM bookings b WHERE b.tenant_id = ? AND b.status IN ('APPROVED','ALLOCATED','INVOICED') AND b.expected_delivery_date < ? ${bScope} ${mine}`, T, today, ...o, ...me),
    },
    approvals: {
      exceptions_pending: await n(`SELECT COUNT(*) AS n FROM exceptions e JOIN bookings b ON b.id = e.booking_id WHERE e.tenant_id = ? AND e.status = 'PENDING' ${bScope} ${mine}`, T, ...o, ...me),
    },
  };
}

/** Dashboard A: bookings that hold a car, with where each stands in the payment window. */
export async function allocationDashboard(ctx: Ctx, outletIds: string[] | null) {
  const rows = await all<any>(
    ctx.db,
    `SELECT a.id AS allocation_id, a.type, a.allocated_at, a.allocated_by, a.needs_transfer, a.clock_started_at, a.window_extension_days, a.reminder_sent_at, a.escalated_at, a.exception_id,
            b.id AS booking_id, b.booking_no, b.booking_date, b.customer_name, b.model, b.variant, b.colour, b.status AS booking_status, b.expected_delivery_date, b.payment_received_at, b.outlet_id,
            o.name AS outlet, v.id AS vehicle_id, v.vin, v.status AS vehicle_status, v.expected_arrival_date, v.outlet_id AS vehicle_outlet_id, vo.name AS vehicle_outlet
     FROM allocations a JOIN bookings b ON b.id = a.booking_id JOIN vehicles v ON v.id = a.vehicle_id JOIN outlets o ON o.id = b.outlet_id JOIN outlets vo ON vo.id = v.outlet_id
     WHERE a.tenant_id = ? AND a.status = 'ACTIVE' ${inList(outletIds, "b.outlet_id")} ORDER BY a.allocated_at DESC LIMIT 500`,
    ctx.tenantId,
    ...(outletIds ?? []),
  );
  return rows.map((r) => {
    let window = null;
    if (r.clock_started_at && r.booking_status === "ALLOCATED" && !r.payment_received_at) {
      const s = windowSchedule(ctx, r.clock_started_at, r.window_extension_days);
      window = { ...s, stage: r.escalated_at ? "ESCALATED" : r.reminder_sent_at ? "REMINDED" : "OPEN" };
    }
    return { ...r, window };
  });
}

/** Dashboard B: what has to be ordered. Waiting bookings with no car in sight, less orders already placed. */
export async function orderQueueDashboard(ctx: Ctx) {
  const waiting = await all<{ model: string; variant: string; colour: string; waiting: number; on_hold: number; earliest_booking: string; earliest_commitment: string | null }>(
    ctx.db,
    `SELECT b.model, b.variant, b.colour, SUM(CASE WHEN b.on_hold = 0 THEN 1 ELSE 0 END) AS waiting, SUM(b.on_hold) AS on_hold,
            MIN(b.priority_ts) AS earliest_booking, MIN(b.expected_delivery_date) AS earliest_commitment
     FROM bookings b WHERE b.tenant_id = ? AND b.status = 'APPROVED' GROUP BY b.model, b.variant, b.colour`,
    ctx.tenantId,
  );
  const orders = await all<{ model: string; variant: string; colour: string; quantity: number; expected_date: string | null }>(
    ctx.db,
    `SELECT model, variant, colour, SUM(quantity) AS quantity, MIN(expected_date) AS expected_date FROM order_requests WHERE tenant_id = ? AND status IN ('PLACED','CONFIRMED') GROUP BY model, variant, colour`,
    ctx.tenantId,
  );
  const key = (r: { model: string; variant: string; colour: string }) => `${r.model}|${r.variant}|${r.colour}`;
  const onOrder = new Map(orders.map((o) => [key(o), o]));
  return waiting
    .filter((w) => w.waiting > 0)
    .map((w) => {
      const o = onOrder.get(key(w));
      const ordered = o?.quantity ?? 0;
      return { ...w, on_order: ordered, to_order: Math.max(0, w.waiting - ordered), expected_date: o?.expected_date ?? null, status: w.waiting - ordered > 0 ? "PENDING" : "ORDERED" };
    })
    .sort((a, b) => (a.earliest_booking < b.earliest_booking ? -1 : 1));
}

/** Dashboard C: bookings past their committed delivery date, with the reason. */
export async function delayedDashboard(ctx: Ctx, outletIds: string[] | null) {
  const today = localParts(ctx.now, ctx.tenant.timezone).date;
  const rows = await all<any>(
    ctx.db,
    `SELECT b.id AS booking_id, b.booking_no, b.booking_date, b.customer_name, b.model, b.variant, b.colour, b.status, b.on_hold, b.hold_reason, b.expected_delivery_date, b.delivered_at,
            b.payment_received_at, o.name AS outlet, v.vin, v.status AS vehicle_status, v.expected_arrival_date, a.needs_transfer
     FROM bookings b JOIN outlets o ON o.id = b.outlet_id
     LEFT JOIN allocations a ON a.booking_id = b.id AND a.status IN ('ACTIVE','FULFILLED') LEFT JOIN vehicles v ON v.id = a.vehicle_id
     WHERE b.tenant_id = ? AND b.expected_delivery_date IS NOT NULL ${inList(outletIds, "b.outlet_id")}
       AND ((b.status IN ('APPROVED','ALLOCATED','INVOICED') AND b.expected_delivery_date < ?)
         OR (b.status = 'DELIVERED' AND substr(b.delivered_at, 1, 10) > b.expected_delivery_date AND b.delivered_at >= ?))
     ORDER BY b.expected_delivery_date LIMIT 500`,
    ctx.tenantId,
    ...(outletIds ?? []),
    today,
    new Date(ctx.now.getTime() - 45 * 86_400_000).toISOString(),
  );
  const days = (from: string, to: string) => Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000);
  return rows.map((r) => {
    const end = r.status === "DELIVERED" ? localParts(new Date(r.delivered_at), ctx.tenant.timezone).date : today;
    let reason = "Waiting for stock";
    if (r.status === "DELIVERED") reason = "Delivered late";
    else if (r.on_hold) reason = r.hold_reason === "CUSTOMER_DEFERRED" ? "Customer asked for a later date" : r.hold_reason === "PAYMENT_TIMEOUT" ? "Payment not received in time" : "On hold";
    else if (r.status === "INVOICED") reason = "Invoiced, delivery pending";
    else if (r.vin && r.vehicle_status === "IN_TRANSIT") reason = r.expected_arrival_date && r.expected_arrival_date < today ? "Transit delay" : "Car in transit";
    else if (r.vin && r.needs_transfer) reason = "Transfer between outlets pending";
    else if (r.vin) reason = r.payment_received_at ? "Invoicing pending" : "Payment pending";
    return { ...r, delay_days: days(r.expected_delivery_date, end), reason };
  });
}

/** What a sales executive can tell a customer about a model, variant and colour right now. */
export async function availabilityAnswer(ctx: Ctx, cfg: { model: string; variant: string; colour: string }, outletId: string | null) {
  const sameOnly = ctx.settings.outlet_scope === "SAME_OUTLET_ONLY" && outletId;
  const vScope = sameOnly ? "AND v.outlet_id = ?" : "";
  const p: unknown[] = [ctx.tenantId, cfg.model, cfg.variant, cfg.colour, ...(sameOnly ? [outletId] : [])];
  const free = await all<{ id: string; vin: string; status: string; outlet_id: string; outlet: string; expected_arrival_date: string | null; dispatch_date: string | null; wholesale_invoice_date: string | null }>(
    ctx.db,
    `SELECT v.id, v.vin, v.status, v.outlet_id, o.name AS outlet, v.expected_arrival_date, v.dispatch_date, v.wholesale_invoice_date FROM vehicles v JOIN outlets o ON o.id = v.outlet_id
     WHERE v.tenant_id = ? AND v.model = ? AND v.variant = ? AND v.colour = ? AND v.status IN ('RECEIVED','IN_TRANSIT') AND v.is_blocked = 0 ${vScope}
       AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.vehicle_id = v.id AND a.status = 'ACTIVE')
     ORDER BY CASE v.status WHEN 'RECEIVED' THEN 0 ELSE 1 END, v.expected_arrival_date`,
    ...p,
  );
  const committed = await first<{ yard: number; transit: number }>(
    ctx.db,
    `SELECT SUM(CASE WHEN v.status = 'RECEIVED' THEN 1 ELSE 0 END) AS yard, SUM(CASE WHEN v.status = 'IN_TRANSIT' THEN 1 ELSE 0 END) AS transit
     FROM vehicles v JOIN allocations a ON a.vehicle_id = v.id AND a.status = 'ACTIVE' WHERE v.tenant_id = ? AND v.model = ? AND v.variant = ? AND v.colour = ? AND v.status IN ('RECEIVED','IN_TRANSIT') ${vScope}`,
    ...p,
  );
  const waiting = (await first<{ n: number }>(ctx.db, `SELECT COUNT(*) AS n FROM bookings b WHERE b.tenant_id = ? AND b.model = ? AND b.variant = ? AND b.colour = ? AND b.status = 'APPROVED' AND b.on_hold = 0 ${sameOnly ? "AND b.outlet_id = ?" : ""}`, ...p))?.n ?? 0;
  const onOrder = await first<{ quantity: number; expected_date: string | null }>(ctx.db, `SELECT SUM(quantity) AS quantity, MIN(expected_date) AS expected_date FROM order_requests WHERE tenant_id = ? AND model = ? AND variant = ? AND colour = ? AND status IN ('PLACED','CONFIRMED')`, ctx.tenantId, cfg.model, cfg.variant, cfg.colour);

  // Cars left for a new customer after everyone already waiting is served. As in allocation, a car in the
  // yard comes before one in transit, and at the same readiness a car at the customer's own outlet comes first.
  const today = localParts(ctx.now, ctx.tenant.timezone).date;
  const spare = free.slice(waiting);
  if (outletId) spare.sort((a, b) => (a.status === b.status ? Number(b.outlet_id === outletId) - Number(a.outlet_id === outletId) : 0));
  const next = spare[0];
  // The four answers. A car in transit has a date only if the dealership entered one; the DMS stock report gives
  // none. Without it the answer is "date not firm", with an indicative date when the dealership has set its usual
  // transit time (OEM invoice date + that many days), always shown as indicative.
  let answer: "AVAILABLE_NOW" | "IN_TRANSIT" | "INVOICED_NOT_DISPATCHED" | "NEEDS_ORDER";
  if (next?.status === "RECEIVED") answer = "AVAILABLE_NOW";
  else if (next) answer = next.expected_arrival_date ? "IN_TRANSIT" : "INVOICED_NOT_DISPATCHED";
  else answer = "NEEDS_ORDER";
  const indicative = (v: { status: string; expected_arrival_date: string | null; wholesale_invoice_date: string | null }) =>
    v.status === "IN_TRANSIT" && !v.expected_arrival_date && v.wholesale_invoice_date && ctx.settings.transit_days ? addDays(v.wholesale_invoice_date, ctx.settings.transit_days) : null;
  const source = await dataStatus(ctx);
  return {
    answer,
    queue_position_for_new_booking: waiting + 1,
    waiting_bookings: waiting,
    free_in_yard: free.filter((v) => v.status === "RECEIVED").length,
    free_in_transit: free.filter((v) => v.status === "IN_TRANSIT").length,
    committed_in_yard: committed?.yard ?? 0,
    committed_in_transit: committed?.transit ?? 0,
    on_order: onOrder?.quantity ?? 0,
    order_expected_date: onOrder?.expected_date ?? null,
    car: next ? { vin: next.vin, status: next.status, outlet: next.outlet, same_outlet: outletId ? next.outlet_id === outletId : null, expected_arrival_date: next.expected_arrival_date, indicative_arrival_date: indicative(next), oem_invoice_date: next.wholesale_invoice_date, arrival_overdue: next.status === "IN_TRANSIT" && Boolean(next.expected_arrival_date) && next.expected_arrival_date! < today } : null,
    free_cars: free.map((v) => ({ vin: v.vin, status: v.status, outlet: v.outlet, expected_arrival_date: v.expected_arrival_date, indicative_arrival_date: indicative(v) })),
    // Where this answer comes from: the stock report and booking sheet it was worked out from.
    source: { stock_as_on: source.stock?.report_date ?? null, bookings_as_on: source.bookings?.report_date ?? null, stale: source.stale },
  };
}

// ---------------------------------------------------------------- the owner's view

const AGE_BUCKETS: [string, number, number][] = [["0-15 days", 0, 15], ["16-30 days", 16, 30], ["31-60 days", 31, 60], ["Over 60 days", 61, 1e9]];
const daysFrom = (date: string, today: string) => Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date.slice(0, 10)}T00:00:00Z`)) / 86_400_000);

/** Out-of-turn allocations: who got the car, who was passed over, and who approved it (or that nobody did). */
export async function outOfTurn(ctx: Ctx, outletIds: string[] | null, since: string, limit = 200) {
  const rows = await all<any>(
    ctx.db,
    `SELECT a.id AS allocation_id, a.allocated_at, a.source, a.status AS allocation_status, a.bypassed_count, a.reviewed_at, a.review_note, rb.name AS reviewed_by_name,
            b.id AS booking_id, b.booking_no AS given_to, b.customer_name, b.booking_date, b.model, b.variant, b.colour, o.name AS outlet, v.vin,
            x.id AS bypassed_booking_id, x.booking_no AS bypassed, x.booking_date AS bypassed_booking_date, x.status AS bypassed_status,
            e.id AS exception_id, e.type AS exception_type, e.reason AS exception_reason, e.decision_remarks, e.decided_at, du.name AS approved_by_name, du.role AS approved_by_role
     FROM allocations a JOIN bookings b ON b.id = a.booking_id JOIN vehicles v ON v.id = a.vehicle_id JOIN outlets o ON o.id = b.outlet_id
     LEFT JOIN bookings x ON x.id = a.bypassed_booking_id
     LEFT JOIN exceptions e ON e.id = COALESCE(a.exception_id, json_extract(a.rule_trace_json, '$.priority_exception_id')) AND e.status = 'APPROVED'
     LEFT JOIN users du ON du.id = e.decided_by LEFT JOIN users rb ON rb.id = a.reviewed_by
     WHERE a.tenant_id = ? AND a.out_of_turn = 1 AND a.allocated_at >= ? ${inList(outletIds, "b.outlet_id")} ORDER BY a.allocated_at DESC LIMIT ?`,
    ctx.tenantId, since, ...(outletIds ?? []), limit,
  );
  return rows.map((r) => ({
    ...r,
    // APPROVED: an exception request was approved beforehand. REVIEWED: nobody approved it beforehand; it has since been looked at. UNDER_REVIEW: not yet.
    state: r.exception_id ? "APPROVED" : r.reviewed_at ? "REVIEWED" : "UNDER_REVIEW",
    how: r.source === "DMS" ? "Allotted in the DMS" : r.exception_type === "MANUAL_ALLOCATION" ? "Named car, by approved request" : r.exception_type === "PRIORITY_CHANGE" ? "Priority changed, by approved request" : "By approved request",
  }));
}

/** Unsold stock (cars no booking holds) by days since the manufacturer's invoice. Value only for those who may see it. */
export async function unsoldByAge(ctx: Ctx, outletIds: string[] | null, withValue: boolean) {
  const today = localParts(ctx.now, ctx.tenant.timezone).date;
  const cars = await all<{ wholesale_invoice_date: string | null; net_dealer_price: number | null; status: string; is_demo: number }>(
    ctx.db,
    `SELECT v.wholesale_invoice_date, v.net_dealer_price, v.status, v.is_demo FROM vehicles v
     WHERE v.tenant_id = ? AND v.status IN ('RECEIVED','IN_TRANSIT') ${inList(outletIds, "v.outlet_id")} AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.vehicle_id = v.id AND a.status = 'ACTIVE')`,
    ctx.tenantId, ...(outletIds ?? []),
  );
  const buckets = AGE_BUCKETS.map(([label]) => ({ label, cars: 0, in_yard: 0, in_transit: 0, value: 0 }));
  const unknown = { label: "Invoice date not known", cars: 0, in_yard: 0, in_transit: 0, value: 0 };
  let demo = 0;
  for (const c of cars) {
    if (c.is_demo) { demo++; continue; }
    const age = c.wholesale_invoice_date ? daysFrom(c.wholesale_invoice_date, today) : null;
    const b = age === null ? unknown : buckets[AGE_BUCKETS.findIndex(([, lo, hi]) => age >= lo && age <= hi)] ?? buckets[0];
    b.cars++;
    c.status === "RECEIVED" ? b.in_yard++ : b.in_transit++;
    b.value += c.net_dealer_price ?? 0;
  }
  const out = [...buckets, ...(unknown.cars ? [unknown] : [])];
  return { buckets: out.map((b) => ({ ...b, value: withValue ? Math.round(b.value) : undefined })), total: out.reduce((n, b) => n + b.cars, 0), demo_excluded: demo, basis: "Days since the manufacturer's (OEM) invoice date in the stock report. Cars held for a booking and demo cars are not counted." };
}

/** Waiting bookings for which nothing is in the yard, in transit or on order, after everyone ahead of them is served. */
export async function noCarComing(ctx: Ctx): Promise<{ bookings: number; configurations: number }> {
  const waiting = await all<{ model: string; variant: string; colour: string; n: number }>(ctx.db, `SELECT model, variant, colour, COUNT(*) AS n FROM bookings WHERE tenant_id = ? AND status = 'APPROVED' AND on_hold = 0 GROUP BY 1, 2, 3`, ctx.tenantId);
  const free = await all<{ model: string; variant: string; colour: string; n: number }>(
    ctx.db,
    `SELECT v.model, v.variant, v.colour, COUNT(*) AS n FROM vehicles v WHERE v.tenant_id = ? AND v.status IN ('RECEIVED','IN_TRANSIT') AND v.is_blocked = 0 AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.vehicle_id = v.id AND a.status = 'ACTIVE') GROUP BY 1, 2, 3`,
    ctx.tenantId,
  );
  const orders = await all<{ model: string; variant: string; colour: string; n: number }>(ctx.db, `SELECT model, variant, colour, SUM(quantity) AS n FROM order_requests WHERE tenant_id = ? AND status IN ('PLACED','CONFIRMED') GROUP BY 1, 2, 3`, ctx.tenantId);
  const key = (r: { model: string; variant: string; colour: string }) => `${r.model}|${r.variant}|${r.colour}`;
  const supply = new Map<string, number>();
  for (const r of [...free, ...orders]) supply.set(key(r), (supply.get(key(r)) ?? 0) + r.n);
  let bookings = 0, configurations = 0;
  for (const w of waiting) {
    const short = w.n - (supply.get(key(w)) ?? 0);
    if (short > 0) (bookings += short), configurations++;
  }
  return { bookings, configurations };
}

/** Bookings whose committed delivery date is past or within the next 7 days while the car is not yet invoiced. */
export async function deliveryAtRisk(ctx: Ctx, outletIds: string[] | null) {
  const today = localParts(ctx.now, ctx.tenant.timezone).date;
  const rows = await all<any>(
    ctx.db,
    `SELECT b.id AS booking_id, b.booking_no, b.customer_name, b.model, b.variant, b.colour, b.status, b.on_hold, b.expected_delivery_date, o.name AS outlet, v.vin, v.status AS vehicle_status, v.expected_arrival_date
     FROM bookings b JOIN outlets o ON o.id = b.outlet_id LEFT JOIN allocations a ON a.booking_id = b.id AND a.status = 'ACTIVE' LEFT JOIN vehicles v ON v.id = a.vehicle_id
     WHERE b.tenant_id = ? AND b.status IN ('APPROVED','ALLOCATED') AND b.expected_delivery_date IS NOT NULL AND b.expected_delivery_date <= ? ${inList(outletIds, "b.outlet_id")}
     ORDER BY b.expected_delivery_date LIMIT 300`,
    ctx.tenantId, addDays(today, 7), ...(outletIds ?? []),
  );
  return rows.map((r) => ({ ...r, overdue: r.expected_delivery_date < today, why: r.on_hold ? "On hold" : !r.vin ? "No car reserved yet" : r.vehicle_status === "IN_TRANSIT" ? "Car still in transit" : "Car at the dealership, payment or invoicing pending" }));
}

/** What the Dealer Principal and the Business Head / CEO see first: fairness, ageing, and what is at risk, across the outlets they cover. */
export async function ownerView(ctx: Ctx, outletIds: string[] | null, withValue: boolean) {
  const T = ctx.tenantId;
  const o = outletIds ?? [];
  const n = async (sql: string, ...p: unknown[]) => (await first<{ n: number }>(ctx.db, sql, ...p))?.n ?? 0;
  const bScope = inList(outletIds, "b.outlet_id"), vScope = inList(outletIds, "v.outlet_id");
  const today = localParts(ctx.now, ctx.tenant.timezone).date;
  const monthStart = localDayBounds(`${today.slice(0, 7)}-01`, ctx.tenant.timezone).start;
  const turn = await outOfTurn(ctx, outletIds, monthStart);
  const risk = await deliveryAtRisk(ctx, outletIds);
  const perOutlet = await all<any>(
    ctx.db,
    `SELECT o.id AS outlet_id, o.code, o.name,
       (SELECT COUNT(*) FROM bookings b WHERE b.tenant_id = o.tenant_id AND b.outlet_id = o.id AND b.status = 'APPROVED' AND b.on_hold = 0) AS waiting,
       (SELECT COUNT(*) FROM bookings b WHERE b.tenant_id = o.tenant_id AND b.outlet_id = o.id AND b.status = 'ALLOCATED') AS holding_a_car,
       (SELECT COUNT(*) FROM vehicles v WHERE v.tenant_id = o.tenant_id AND v.outlet_id = o.id AND v.status IN ('RECEIVED','IN_TRANSIT')) AS cars,
       (SELECT COUNT(*) FROM vehicles v WHERE v.tenant_id = o.tenant_id AND v.outlet_id = o.id AND v.status IN ('RECEIVED','IN_TRANSIT') AND v.is_blocked = 0 AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.vehicle_id = v.id AND a.status = 'ACTIVE')) AS cars_free
     FROM outlets o WHERE o.tenant_id = ? AND o.is_active = 1 ${outletIds ? `AND o.id IN (${outletIds.map(() => "?").join(",") || "''"})` : ""} ORDER BY o.name`,
    T, ...o,
  );
  return {
    source: await dataStatus(ctx),
    customers_waiting: await n(`SELECT COUNT(*) AS n FROM bookings b WHERE b.tenant_id = ? AND b.status = 'APPROVED' AND b.on_hold = 0 ${bScope}`, T, ...o),
    customers_on_hold: await n(`SELECT COUNT(*) AS n FROM bookings b WHERE b.tenant_id = ? AND b.status = 'APPROVED' AND b.on_hold = 1 ${bScope}`, T, ...o),
    cars_not_matched: await n(`SELECT COUNT(*) AS n FROM vehicles v WHERE v.tenant_id = ? AND v.status IN ('RECEIVED','IN_TRANSIT') AND v.is_blocked = 0 ${vScope} AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.vehicle_id = v.id AND a.status = 'ACTIVE')`, T, ...o),
    cars_reserved: await n(`SELECT COUNT(*) AS n FROM vehicles v WHERE v.tenant_id = ? AND v.status IN ('RECEIVED','IN_TRANSIT') ${vScope} AND EXISTS (SELECT 1 FROM allocations a WHERE a.vehicle_id = v.id AND a.status = 'ACTIVE')`, T, ...o),
    invoiced_not_delivered: await n(`SELECT COUNT(*) AS n FROM vehicles v WHERE v.tenant_id = ? AND v.status = 'INVOICED' ${vScope}`, T, ...o),
    delivery_dates_at_risk: { count: risk.length, overdue: risk.filter((r) => r.overdue).length, rows: risk.slice(0, 25), basis: "Bookings with a committed delivery date that is past or within 7 days, whose car is not yet invoiced. A booking with no committed date recorded is not counted." },
    out_of_turn: { this_month: turn.length, under_review: turn.filter((t) => t.state === "UNDER_REVIEW").length, rows: turn.slice(0, 25) },
    unsold_by_age: await unsoldByAge(ctx, outletIds, withValue),
    bookings_with_no_car_coming: await noCarComing(ctx),
    payments: {
      awaiting_payment: await n(`SELECT COUNT(*) AS n FROM bookings b WHERE b.tenant_id = ? AND b.status = 'ALLOCATED' AND b.payment_received_at IS NULL AND b.payment_reported_at IS NULL ${bScope}`, T, ...o),
      to_verify: await n(`SELECT COUNT(*) AS n FROM bookings b WHERE b.tenant_id = ? AND b.status = 'ALLOCATED' AND b.payment_received_at IS NULL AND b.payment_reported_at IS NOT NULL ${bScope}`, T, ...o),
      verified_not_invoiced: await n(`SELECT COUNT(*) AS n FROM bookings b WHERE b.tenant_id = ? AND b.status = 'ALLOCATED' AND b.payment_received_at IS NOT NULL ${bScope}`, T, ...o),
    },
    outlets: perOutlet,
  };
}

// ---------------------------------------------------------------- measures (how success is measured)

export interface Measure {
  key: string;
  group: "Customer and revenue" | "Stock and cash" | "Fairness and team";
  label: string;
  /** Which way it should move. */
  should: "rise" | "fall";
  /** Null when the system has nothing to measure it from; `note` says why. */
  value: number | null;
  unit: "%" | "days" | "cars" | "bookings" | "INR" | "count";
  previous: number | null;
  /** What the figure is counted from, in this period. */
  basis: string;
  note?: string;
}

/**
 * The measures agreed with the dealership, for a period and the period before it, worked out only from
 * what the system holds: the DMS files and what was done in the app. Where the data cannot support a
 * measure, the value is null and the note says what is missing; nothing is estimated.
 */
export async function measures(ctx: Ctx, period: { from: string; to: string }, withValue: boolean): Promise<{ period: { from: string; to: string }; previous: { from: string; to: string }; measures: Measure[] }> {
  const tz = ctx.tenant.timezone;
  const T = ctx.tenantId;
  const len = daysFrom(period.from, period.to) + 1;
  const previous = { from: addDays(period.from, -len), to: addDays(period.from, -1) };
  const span = (p: { from: string; to: string }) => [localDayBounds(p.from, tz).start, localDayBounds(p.to, tz).end] as const;
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
  const rate = ctx.settings.funding_rate_pct;

  const forPeriod = async (p: { from: string; to: string }) => {
    const [a, b] = span(p);
    const delivered = await all<{ delivered_at: string; expected_delivery_date: string | null }>(ctx.db, `SELECT delivered_at, expected_delivery_date FROM bookings WHERE tenant_id = ? AND status = 'DELIVERED' AND delivered_at >= ? AND delivered_at < ?`, T, a, b);
    const promised = delivered.filter((d) => d.expected_delivery_date);
    const onTime = promised.filter((d) => localParts(new Date(d.delivered_at), tz).date <= d.expected_delivery_date!).length;
    const cancelled = await all<{ booking_date: string; cancelled_at: string; had_car: number }>(
      ctx.db,
      `SELECT b.booking_date, b.cancelled_at, EXISTS (SELECT 1 FROM allocations a WHERE a.booking_id = b.id) AS had_car FROM bookings b WHERE b.tenant_id = ? AND b.status = 'CANCELLED' AND b.cancelled_at >= ? AND b.cancelled_at < ?`,
      T, a, b,
    );
    const waitingCancelled = cancelled.filter((c) => !c.had_car);
    const invoicedCars = await all<{ received_at: string | null; invoiced_at: string; wholesale_invoice_date: string | null; net_dealer_price: number | null }>(
      ctx.db,
      `SELECT received_at, invoiced_at, wholesale_invoice_date, net_dealer_price FROM vehicles WHERE tenant_id = ? AND invoiced_at >= ? AND invoiced_at < ? AND status IN ('INVOICED','DELIVERED')`,
      T, a, b,
    );
    const deliveredCars = await all<{ received_at: string | null; delivered_at: string }>(ctx.db, `SELECT received_at, delivered_at FROM vehicles WHERE tenant_id = ? AND status = 'DELIVERED' AND delivered_at >= ? AND delivered_at < ?`, T, a, b);
    // Whole calendar days at the dealership: received on the 2nd and invoiced on the 8th is 6 days, whatever the times of day.
    const dayGap = (from: string, to: string) => Math.max(0, daysFrom(localParts(new Date(from), tz).date, localParts(new Date(to), tz).date));
    const interest = invoicedCars.filter((c) => c.net_dealer_price && c.wholesale_invoice_date).map((c) => (c.net_dealer_price! * (rate ?? 0) * Math.max(0, daysFrom(c.wholesale_invoice_date!, localParts(new Date(c.invoiced_at), tz).date))) / 36_500);
    const turn = await first<{ n: number; open: number }>(ctx.db, `SELECT COUNT(*) AS n, SUM(CASE WHEN exception_id IS NULL AND json_extract(rule_trace_json,'$.priority_exception_id') IS NULL AND reviewed_at IS NULL THEN 1 ELSE 0 END) AS open FROM allocations WHERE tenant_id = ? AND out_of_turn = 1 AND allocated_at >= ? AND allocated_at < ?`, T, a, b);
    return {
      delivered: delivered.length, promised: promised.length, onTimePct: promised.length ? Math.round((onTime / promised.length) * 1000) / 10 : null,
      cancelled: cancelled.length, waitingCancelled: waitingCancelled.length, waitDays: avg(waitingCancelled.map((c) => dayGap(c.booking_date, c.cancelled_at))),
      yardToInvoice: avg(invoicedCars.filter((c) => c.received_at).map((c) => dayGap(c.received_at!, c.invoiced_at))), invoicedCars: invoicedCars.length,
      yardToDelivery: avg(deliveredCars.filter((c) => c.received_at).map((c) => dayGap(c.received_at!, c.delivered_at))), deliveredCars: deliveredCars.length,
      interestPerCar: rate && interest.length ? Math.round(interest.reduce((x, y) => x + y, 0) / interest.length) : null, interestCars: interest.length,
      outOfTurn: turn?.n ?? 0, outOfTurnOpen: turn?.open ?? 0,
    };
  };
  const cur = await forPeriod(period), prev = await forPeriod(previous);
  const age = await unsoldByAge(ctx, null, withValue);
  const over30 = age.buckets.filter((b) => b.label === "31-60 days" || b.label === "Over 60 days");
  const none = await noCarComing(ctx);
  const m: Measure[] = [
    { key: "on_promised_date", group: "Customer and revenue", label: "Delivery on promised date", should: "rise", value: cur.onTimePct, unit: "%", previous: prev.onTimePct, basis: `${cur.promised} of ${cur.delivered} deliveries in the period had a committed delivery date recorded`, note: cur.promised ? undefined : "No delivery in this period had a committed date recorded. The DMS booking sheet carries no promised date; it is counted for bookings where the date is entered in this system." },
    { key: "cancelled_waiting", group: "Customer and revenue", label: "Cancellations while waiting for a car", should: "fall", value: cur.waitingCancelled, unit: "bookings", previous: prev.waitingCancelled, basis: `${cur.cancelled} bookings cancelled in the period; ${cur.waitingCancelled} of them had never been given a car${cur.waitDays !== null ? `, after ${cur.waitDays} days on average` : ""}`, note: "The DMS does not record why a booking was cancelled; this counts cancellations of customers who were still waiting." },
    { key: "complaints", group: "Customer and revenue", label: "Delivery complaints", should: "fall", value: null, unit: "count", previous: null, basis: "Not measured", note: "Neither DMS file carries complaints, and they are not recorded in this system." },
    { key: "yard_to_invoice", group: "Stock and cash", label: "Yard-to-invoice days", should: "fall", value: cur.yardToInvoice, unit: "days", previous: prev.yardToInvoice, basis: `${cur.invoicedCars} cars retail-invoiced in the period; from the GRN date to the retail invoice date in the stock report` },
    { key: "yard_to_delivery", group: "Stock and cash", label: "Yard-to-delivery days", should: "fall", value: cur.yardToDelivery, unit: "days", previous: prev.yardToDelivery, basis: `${cur.deliveredCars} cars delivered in the period`, note: "A delivery is dated by the first stock report that no longer lists the invoiced car, so this is at most as exact as the gap between two reports." },
    { key: "stock_over_30", group: "Stock and cash", label: "Stock older than 30 days", should: "fall", value: over30.reduce((n, b) => n + b.cars, 0), unit: "cars", previous: null, basis: `Unsold cars more than 30 days from the manufacturer's invoice, as of the latest stock report${withValue ? `; dealer value ${Math.round(over30.reduce((n, b) => n + (b.value ?? 0), 0)).toLocaleString("en-IN")}` : ""}`, note: "A position today, not a figure for the period." },
    { key: "funding_interest", group: "Stock and cash", label: "Funding interest per car sold", should: "fall", value: withValue ? cur.interestPerCar : null, unit: "INR", previous: withValue ? prev.interestPerCar : null, basis: rate ? `${cur.interestCars} cars retail-invoiced in the period: net dealer price x ${rate}% a year x days from the manufacturer's invoice to the retail invoice` : "Not measured", note: !withValue ? "Shown to roles that may see stock value." : rate ? undefined : "Set the annual funding rate in Settings to measure this." },
    { key: "out_of_turn", group: "Fairness and team", label: "Out-of-turn allocations", should: "fall", value: cur.outOfTurn, unit: "count", previous: prev.outOfTurn, basis: `Cars given ahead of an earlier waiting booking in the period; ${cur.outOfTurnOpen} without prior approval and not yet reviewed` },
    { key: "no_car_coming", group: "Fairness and team", label: "Bookings with no car coming", should: "fall", value: none.bookings, unit: "bookings", previous: null, basis: `Waiting customers for whom nothing is in the yard, in transit or on order, across ${none.configurations} model / variant / colour combinations`, note: "A position today, not a figure for the period." },
    { key: "time_to_answer", group: "Fairness and team", label: "Time to answer an enquiry", should: "fall", value: null, unit: "count", previous: null, basis: "Not measured", note: "The stock-and-date answer is on the sales executive's phone at once; how long a customer waited for an answer before is not recorded anywhere." },
  ];
  return { period, previous, measures: m };
}

// ---------------------------------------------------------------- matches a waiting customer could be offered

/**
 * Waiting bookings that have no car of their own colour free, but for which a car of the same model and
 * variant in another colour is. An offer the sales team can make; nothing is allocated unless the customer
 * changes the booking. `onlyUserId` limits it to one sales executive's bookings.
 */
export async function nearMatches(ctx: Ctx, outletIds: string[] | null, onlyUserId: string | null) {
  const rows = await all<any>(
    ctx.db,
    `SELECT b.id AS booking_id, b.booking_no, b.customer_name, b.booking_date, b.model, b.variant, b.colour, b.outlet_id, o.name AS outlet, COALESCE(se.name, b.sc_name) AS sales_exec,
            v.colour AS car_colour, SUM(CASE WHEN v.status = 'RECEIVED' THEN 1 ELSE 0 END) AS in_yard, SUM(CASE WHEN v.status = 'IN_TRANSIT' THEN 1 ELSE 0 END) AS in_transit,
            SUM(CASE WHEN v.outlet_id = b.outlet_id THEN 1 ELSE 0 END) AS at_own_outlet, MIN(v.wholesale_invoice_date) AS oldest_invoice
     FROM bookings b JOIN outlets o ON o.id = b.outlet_id LEFT JOIN users se ON se.id = b.sales_exec_id
     JOIN vehicles v ON v.tenant_id = b.tenant_id AND v.model = b.model AND v.variant = b.variant AND v.colour <> b.colour AND v.status IN ('RECEIVED','IN_TRANSIT') AND v.is_blocked = 0
       AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.vehicle_id = v.id AND a.status = 'ACTIVE')
     WHERE b.tenant_id = ? AND b.status = 'APPROVED' AND b.on_hold = 0 ${inList(outletIds, "b.outlet_id")} ${onlyUserId ? "AND (b.sales_exec_id = ? OR b.created_by = ?)" : ""}
       AND NOT EXISTS (SELECT 1 FROM vehicles w WHERE w.tenant_id = b.tenant_id AND w.model = b.model AND w.variant = b.variant AND w.colour = b.colour AND w.status IN ('RECEIVED','IN_TRANSIT') AND w.is_blocked = 0
                         AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.vehicle_id = w.id AND a.status = 'ACTIVE'))
     GROUP BY b.id, v.colour ORDER BY b.priority_ts LIMIT 1500`,
    ctx.tenantId, ...(outletIds ?? []), ...(onlyUserId ? [onlyUserId, onlyUserId] : []),
  );
  const byBooking = new Map<string, any>();
  for (const r of rows) {
    if (!byBooking.has(r.booking_id)) byBooking.set(r.booking_id, { booking_id: r.booking_id, booking_no: r.booking_no, customer_name: r.customer_name, booking_date: r.booking_date, model: r.model, variant: r.variant, colour: r.colour, outlet: r.outlet, sales_exec: r.sales_exec, options: [] });
    byBooking.get(r.booking_id).options.push({ colour: r.car_colour, in_yard: r.in_yard, in_transit: r.in_transit, at_own_outlet: r.at_own_outlet, oldest_invoice: r.oldest_invoice });
  }
  return [...byBooking.values()];
}
