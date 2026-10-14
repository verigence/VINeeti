// Analytics by fixed rules over the two DMS files: ageing stock by model, customers who have not picked
// up their car, and the most and least selling model and car.
import { describe, expect, it } from "vitest";
import { loadBookings, loadStock, makeMahindraDealer, makeWorld, type BookingLine, type Dealer, type StockLine, type World } from "./harness";

const STOCK: StockLine[] = [
  { vin: "MA1THAR0000000001", car: "THAR_WHITE", oemInvoiceDate: "2026-09-30", grnDate: "2026-10-06" },
  { vin: "MA1THAR0000000002", car: "THAR_BLACK", oemInvoiceDate: "2026-09-10", price: 1200000 },
  { vin: "MA1MAXX0000000003", car: "MAXX_DIAMOND", status: "In Transit", oemInvoiceDate: "2026-08-20", price: 800000 },
  { vin: "MA1XUV00000000004", car: "XUV3XO_WHITE", oemInvoiceDate: "2026-07-01", price: 1100000 },
  { vin: "MA1MAXX0000000005", car: "MAXX_WHITE", demo: true, oemInvoiceDate: "2026-06-01" },
  { vin: "MA1SCN00000000006", car: "SCORPIO_N", status: "In Transit", oemInvoiceDate: "2026-10-01" },
];
const BOOKINGS: BookingLine[] = [
  { no: "OTF27A000001", car: "THAR_WHITE", created: "01-Sep-2026 10:00 AM", customer: "THAR ONE" },
  { no: "OTF27A000002", car: "THAR_WHITE", created: "02-Sep-2026 10:00 AM", customer: "THAR TWO" },
  { no: "OTF27A000011", car: "SCORPIO_N", created: "05-Sep-2026 10:00 AM", customer: "SCORPIO ONE" },
];
async function start(): Promise<{ w: World; d: Dealer }> {
  const w = makeWorld("2026-10-06 10:00");
  const d = await makeMahindraDealer(w);
  await loadStock(w, d.users.stock.session, STOCK);
  await loadBookings(w, d.users.crm.session, BOOKINGS);
  return { w, d };
}
const get = (w: World, d: Dealer, path: string, who = "head") => w.api("GET", path, undefined, d.users[who].session);

describe("ageing inventory by model", () => {
  it("counts unsold cars by days since the manufacturer's invoice, model by model, with the same answer every time", async () => {
    const { w, d } = await start();
    const res = await get(w, d, "/api/analytics/ageing");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ as_of: "2026-10-06", buckets: ["0-15 days", "16-30 days", "31-60 days", "Over 60 days"], totals: { cars: 3, over_30_days: 2, over_60_days: 1, value: 3100000 } });
    expect(res.body.source).toMatchObject({ stale: false, stock: { report_date: "2026-10-06" } });
    // Reserved cars and the demo car are not unsold stock. Models with the most old cars first; equal ones by name.
    expect(res.body.rows.map((r: any) => [r.model, r.cars, r.buckets, r.oldest_days, r.value])).toEqual([
      ["BOL MAXX PUP HD", 1, [0, 0, 1, 0], 47, 800000],
      ["XUV 3XO", 1, [0, 0, 0, 1], 97, 1100000],
      ["THAR", 1, [0, 1, 0, 0], 26, 1200000],
    ]);
    expect(res.body.rows[0].cars_detail).toEqual([{ vin: "MA1MAXX0000000003", variant: "1.7 LX (M0246)", colour: "DIAMOND WHITE", outlet: "CUTTACK", status: "IN_TRANSIT", oem_invoice_date: "2026-08-20", age_days: 47, value: 800000 }]);
    expect((await get(w, d, "/api/analytics/ageing")).body).toEqual(res.body);
    // Without the right to see stock value, the same counts and no money.
    const exec = (await get(w, d, "/api/analytics/ageing", "exec")).body;
    expect(exec.totals).toEqual({ cars: 3, over_30_days: 2, over_60_days: 1 });
    expect(exec.rows[0].value).toBeUndefined();
    expect(exec.rows[0].cars_detail[0].value).toBeUndefined();
  });
});

describe("customers who have not picked up their car", () => {
  it("lists a customer once the car has waited more than the given days, payment pending or invoiced and not taken", async () => {
    const { w, d } = await start();
    // The THAR arrived on 6 October and is reserved for THAR ONE. Ten days later nobody is listed; on the eleventh day, THAR ONE is.
    w.at("2026-10-16 10:00");
    expect((await get(w, d, "/api/analytics/not-picked-up")).body).toMatchObject({ days: 10, counts: { total: 0 }, rows: [] });
    w.at("2026-10-17 10:00");
    const res = await get(w, d, "/api/analytics/not-picked-up");
    expect(res.body.counts).toEqual({ total: 1, waiting_for_payment: 1, invoiced_not_taken: 0 });
    expect(res.body.rows[0]).toMatchObject({ booking_no: "OTF27A000001", customer_name: "THAR ONE", vin: "MA1THAR0000000001", stage: "WAITING_FOR_PAYMENT", since: "2026-10-06", days: 11, payment_received_at: null, invoiced_on: null });
    expect(res.body.basis).toContain("more than 10 calendar days");
    // A shorter limit shows the same customer sooner; the car in transit for SCORPIO ONE never counts.
    expect((await get(w, d, "/api/analytics/not-picked-up?days=3")).body.rows.map((r: any) => r.booking_no)).toEqual(["OTF27A000001"]);
    // The DMS invoices the car and the customer still has not taken it: same list, different stage.
    await loadStock(w, d.users.stock.session, STOCK.map((l) => (l.vin === "MA1THAR0000000001" ? { ...l, order: "OTF27A000001", customer: "THAR ONE", invoiceId: "INV0001", invoiceDate: "2026-10-15" } : l)));
    const after = (await get(w, d, "/api/analytics/not-picked-up")).body;
    expect(after.counts).toEqual({ total: 1, waiting_for_payment: 0, invoiced_not_taken: 1 });
    expect(after.rows[0]).toMatchObject({ booking_no: "OTF27A000001", stage: "INVOICED_NOT_TAKEN", days: 11, invoiced_on: "2026-10-15" });
    // Once the car leaves the stock report it has been taken.
    w.at("2026-10-18 10:00");
    await loadStock(w, d.users.stock.session, STOCK.filter((l) => l.vin !== "MA1THAR0000000001"));
    expect((await get(w, d, "/api/analytics/not-picked-up")).body.counts.total).toBe(0);
    expect((await get(w, d, "/api/analytics/not-picked-up?days=400")).status).toBe(400);
    expect((await get(w, d, "/api/analytics/not-picked-up", "exec")).status).toBe(403); // the team's customers are the Sales Lead's and management's to chase
  });
});

describe("most and least selling", () => {
  it("counts retail invoices in the period and ranks models and cars, ties by name", async () => {
    const { w, d } = await start();
    const empty = (await get(w, d, "/api/analytics/sales")).body;
    expect(empty).toMatchObject({ period: { from: "2026-07-09", to: "2026-10-06" }, total_sold: 0, most_selling_model: null, most_selling_car: null });
    // Nothing sold yet: the least selling is the stocked model with no sale that comes first by name.
    expect(empty.least_selling_model).toMatchObject({ model: "BOL MAXX PUP HD", sold: 0, unsold_in_stock: 1 });
    // The THAR is invoiced to THAR ONE on 15 October.
    w.at("2026-10-17 10:00");
    await loadStock(w, d.users.stock.session, STOCK.map((l) => (l.vin === "MA1THAR0000000001" ? { ...l, order: "OTF27A000001", customer: "THAR ONE", invoiceId: "INV0001", invoiceDate: "2026-10-15" } : l)));
    const res = await get(w, d, "/api/analytics/sales");
    expect(res.body).toMatchObject({ period: { from: "2026-07-20", to: "2026-10-17" }, total_sold: 1 });
    expect(res.body.most_selling_model).toMatchObject({ model: "THAR", sold: 1, delivered: 0, unsold_in_stock: 1, waiting_bookings: 1, share_pct: 100 });
    expect(res.body.most_selling_car).toMatchObject({ model: "THAR", variant: "LXT D MT 2WD 4S HT (M0877)", colour: "EVEREST WHITE", sold: 1 });
    expect(res.body.least_selling_model).toMatchObject({ model: "BOL MAXX PUP HD", sold: 0 });
    expect(res.body.models.map((m: any) => [m.model, m.sold])).toEqual([["THAR", 1], ["BOL MAXX PUP HD", 0], ["XUV 3XO", 0]]);
    // A period before the invoice has no sale; the same question asked twice gives the same answer.
    expect((await get(w, d, "/api/analytics/sales?from=2026-09-01&to=2026-10-14")).body.total_sold).toBe(0);
    expect((await get(w, d, "/api/analytics/sales?from=2026-10-15&to=2026-10-15")).body.total_sold).toBe(1);
    expect((await get(w, d, "/api/analytics/sales")).body).toEqual(res.body);
    expect((await get(w, d, "/api/analytics/sales?from=2026-10-01&to=2026-12-01")).status).toBe(400);
  });
});

describe("allocations by day and stock by day", () => {
  it("lists every allocation and release by day and outlet, and keeps each day's stock position per outlet", async () => {
    const { w, d } = await start();
    // Day 1 (6 Oct): two allocations on load. Day 2: THAR ONE is cancelled in the DMS, the THAR goes to THAR TWO.
    w.at("2026-10-07 10:00");
    await loadBookings(w, d.users.crm.session, [{ ...BOOKINGS[0], stage: "Cancellation Initiated" }, BOOKINGS[1], BOOKINGS[2]]);
    await loadStock(w, d.users.stock.session, [...STOCK, { vin: "MA1THAR0000000007", car: "THAR_WHITE", loc: "SM02", oemInvoiceDate: "2026-10-05" }]);
    const res = await get(w, d, "/api/analytics/allocations?from=2026-10-06&to=2026-10-07");
    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual({ allocated: 3, released: 1 });
    expect(res.body.days.map((x: any) => [x.date, x.allocated, x.released, x.reasons])).toEqual([["2026-10-06", 2, 0, {}], ["2026-10-07", 1, 1, { "Booking cancelled": 1 }]]);
    expect(res.body.days[1].outlets).toEqual([{ outlet: "CUTTACK", allocated: 1, released: 1 }]);
    const day2 = res.body.rows.filter((r: any) => r.at.startsWith("2026-10-07"));
    expect(day2.map((r: any) => [r.kind, r.booking_no, r.vin, r.how, r.by])).toEqual([
      ["RELEASED", "OTF27A000001", "MA1THAR0000000001", "Booking cancelled", ""],
      ["ALLOCATED", "OTF27A000002", "MA1THAR0000000001", "Re-allocated car", "System (queue)"],
    ]);
    // A Sales Lead limited to one outlet sees that outlet's days only (none here: everything is at Cuttack).
    expect((await get(w, d, "/api/analytics/allocations?from=2026-10-06&to=2026-10-07", "exec")).status).toBe(200);

    // Stock by day: the position at the end of each day's loads, per outlet, with the dealership's total. The seventh brought a free THAR at Jajpur.
    const stock = (await get(w, d, "/api/analytics/stock-days?from=2026-10-06&to=2026-10-07")).body;
    expect(stock.days.map((x: any) => [x.date, x.total.in_yard_free, x.total.in_yard_reserved, x.total.in_transit_free, x.total.in_transit_reserved, x.total.blocked, x.total.total])).toEqual([
      ["2026-10-06", 2, 1, 1, 1, 1, 6],
      ["2026-10-07", 3, 1, 1, 1, 1, 7],
    ]);
    expect(stock.days[1].outlets.map((o: any) => [o.outlet, o.in_yard_free, o.in_yard_reserved, o.total, o.source])).toEqual([["CUTTACK", 2, 1, 6, "STOCK_REPORT"], ["JAJPUR", 1, 0, 1, "STOCK_REPORT"]]);
    // The day-end reconciliation records the position for the business day as well.
    w.at("2026-10-08 21:05");
    await w.tick();
    const later = (await get(w, d, "/api/analytics/stock-days?from=2026-10-06&to=2026-10-08")).body;
    expect(later.days.map((x: any) => [x.date, x.outlets[0].source])).toEqual([["2026-10-06", "BOOKING_SHEET"], ["2026-10-07", "STOCK_REPORT"], ["2026-10-08", "DAY_END"]]);
    expect((await get(w, d, "/api/analytics/stock-days?from=2026-10-06&to=2026-10-08", "exec")).body.days[0].total.value_unsold).toBeUndefined();
  });
});
