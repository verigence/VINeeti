// What the deck promises each person: the sales executive's stock-and-date answer, and the Dealer
// Principal's view (customers waiting, cars not matched, out-of-turn allocations with who approved them,
// unsold stock by age), with measures only where the data supports them.
import { describe, expect, it } from "vitest";
import { CARS, loadBookings, loadStock, makeMahindraDealer, makeWorld, type BookingLine, type Dealer, type StockLine, type World } from "./harness";

const q = <T = any>(w: World, sql: string, ...p: unknown[]) => w.db.q<T>(sql, ...p);
const booking = (w: World, no: string) => q(w, `SELECT b.*, (SELECT v.vin FROM allocations a JOIN vehicles v ON v.id = a.vehicle_id WHERE a.booking_id = b.id AND a.status = 'ACTIVE') AS vin FROM bookings b WHERE b.booking_no = ?`, no)[0];

const STOCK: StockLine[] = [
  { vin: "MA1THAR0000000001", car: "THAR_WHITE", oemInvoiceDate: "2026-09-30" },
  { vin: "MA1THAR0000000002", car: "THAR_BLACK", oemInvoiceDate: "2026-09-10", price: 1200000 }, // 26 days old, nobody waiting for it
  { vin: "MA1MAXX0000000003", car: "MAXX_DIAMOND", status: "In Transit", oemInvoiceDate: "2026-08-20", price: 800000 }, // 47 days
  { vin: "MA1XUV00000000004", car: "XUV3XO_WHITE", oemInvoiceDate: "2026-07-01", price: 1100000 }, // 97 days
  { vin: "MA1MAXX0000000005", car: "MAXX_WHITE", demo: true, oemInvoiceDate: "2026-06-01" },
  { vin: "MA1SCN00000000006", car: "SCORPIO_N", status: "In Transit", oemInvoiceDate: "2026-10-01" },
];
const BOOKINGS: BookingLine[] = [
  { no: "OTF27A000001", car: "THAR_WHITE", created: "01-Sep-2026 10:00 AM", customer: "THAR ONE" },
  { no: "OTF27A000002", car: "THAR_WHITE", created: "02-Sep-2026 10:00 AM", customer: "THAR TWO" },
  { no: "OTF27A000003", car: "THAR_WHITE", created: "03-Sep-2026 10:00 AM", customer: "THAR THREE" },
  { no: "OTF27A000011", car: "SCORPIO_N", created: "05-Sep-2026 10:00 AM", customer: "SCORPIO ONE" },
  { no: "OTF27A000012", car: "SCORPIO_N", created: "06-Sep-2026 10:00 AM", customer: "SCORPIO TWO" },
];

async function start(): Promise<{ w: World; d: Dealer }> {
  const w = makeWorld("2026-10-06 10:00");
  const d = await makeMahindraDealer(w);
  await loadStock(w, d.users.stock.session, STOCK);
  await loadBookings(w, d.users.crm.session, BOOKINGS);
  expect(booking(w, "OTF27A000001").vin).toBe("MA1THAR0000000001");
  expect(booking(w, "OTF27A000011").vin).toBe("MA1SCN00000000006");
  return { w, d };
}
const answer = async (w: World, d: Dealer, car: { model: string; variant: string; colour: string }, who = "exec") =>
  (await w.api("GET", `/api/stock/availability?model=${encodeURIComponent(car.model)}&variant=${encodeURIComponent(car.variant)}&colour=${encodeURIComponent(car.colour)}`, undefined, d.users[who].session)).body;

describe("the sales executive's stock-and-date answer", () => {
  it("gives one of four answers, with free and reserved cars and the bookings already ahead", async () => {
    const { w, d } = await start();
    // 1. In the yard and free.
    expect(await answer(w, d, CARS.THAR_BLACK.is)).toMatchObject({ answer: "AVAILABLE_NOW", free_in_yard: 1, free_in_transit: 0, committed_in_yard: 0, waiting_bookings: 0, queue_position_for_new_booking: 1, car: { vin: "MA1THAR0000000002", status: "RECEIVED" } });
    // 4. Needs an order: the only car is reserved and two customers are already waiting.
    expect(await answer(w, d, CARS.THAR_WHITE.is)).toMatchObject({ answer: "NEEDS_ORDER", free_in_yard: 0, committed_in_yard: 1, waiting_bookings: 2, queue_position_for_new_booking: 3, car: null });
    // The one in transit is reserved; one more customer waits behind it.
    expect(await answer(w, d, CARS.SCORPIO_N.is)).toMatchObject({ answer: "NEEDS_ORDER", committed_in_transit: 1, waiting_bookings: 1, queue_position_for_new_booking: 2 });
    // 3. In transit, date not firm: the stock report has no dispatch or arrival date.
    const notFirm = await answer(w, d, CARS.MAXX_DIAMOND.is);
    expect(notFirm).toMatchObject({ answer: "INVOICED_NOT_DISPATCHED", free_in_transit: 1, car: { vin: "MA1MAXX0000000003", expected_arrival_date: null, indicative_arrival_date: null, oem_invoice_date: "2026-08-20" } });
    // Every answer says which files it was worked out from.
    expect(notFirm.source).toEqual({ stock_as_on: "2026-10-06", bookings_as_on: "2026-10-06", stale: false });
    // The dealership sets its usual transit time: an indicative date appears, and the answer is still "not firm".
    expect((await w.api("PUT", "/api/settings", { transit_days: 60 }, d.users.head.session)).status).toBe(200);
    expect(await answer(w, d, CARS.MAXX_DIAMOND.is)).toMatchObject({ answer: "INVOICED_NOT_DISPATCHED", car: { expected_arrival_date: null, indicative_arrival_date: "2026-10-19" } });
    // 2. In transit with a date: the stock in-charge has entered the expected arrival.
    const car = q(w, `SELECT id FROM vehicles WHERE vin = 'MA1MAXX0000000003'`)[0];
    expect((await w.api("PATCH", `/api/vehicles/${car.id}`, { expected_arrival_date: "2026-10-15" }, d.users.stock.session)).status).toBe(200);
    expect(await answer(w, d, CARS.MAXX_DIAMOND.is)).toMatchObject({ answer: "IN_TRANSIT", car: { expected_arrival_date: "2026-10-15" } });
    // The date entered is kept when the next stock report (which has none) is loaded.
    w.at("2026-10-07 10:00");
    await loadStock(w, d.users.stock.session, STOCK);
    expect(await answer(w, d, CARS.MAXX_DIAMOND.is)).toMatchObject({ answer: "IN_TRANSIT", car: { expected_arrival_date: "2026-10-15" } });
  });

  it("says so when the files it rests on are out of date", async () => {
    const { w, d } = await start();
    w.at("2026-10-12 10:00");
    expect((await answer(w, d, CARS.THAR_BLACK.is)).source).toEqual({ stock_as_on: "2026-10-06", bookings_as_on: "2026-10-06", stale: true });
  });
});

describe("the Dealer Principal's view", () => {
  it("shows customers waiting, cars not matched, unsold stock by age and payments, for the files loaded", async () => {
    const { w, d } = await start();
    const v = (await w.api("GET", "/api/dashboards/owner", undefined, d.users.dp.session)).body;
    expect(v).toMatchObject({ customers_waiting: 3, customers_on_hold: 0, cars_not_matched: 3, cars_reserved: 2, invoiced_not_delivered: 0 });
    expect(v.source).toMatchObject({ stale: false, stock: { report_date: "2026-10-06", loaded_by: "Gopal Stock" }, bookings: { report_date: "2026-10-06", loaded_by: "Charu CRM" } });
    // Unsold stock by days since the manufacturer's invoice. The reserved cars and the demo car are not counted.
    expect(v.unsold_by_age.buckets).toEqual([
      { label: "0-15 days", cars: 0, in_yard: 0, in_transit: 0, value: 0 },
      { label: "16-30 days", cars: 1, in_yard: 1, in_transit: 0, value: 1200000 },
      { label: "31-60 days", cars: 1, in_yard: 0, in_transit: 1, value: 800000 },
      { label: "Over 60 days", cars: 1, in_yard: 1, in_transit: 0, value: 1100000 },
    ]);
    expect(v.unsold_by_age).toMatchObject({ total: 3, demo_excluded: 1 });
    // Two THAR customers and one SCORPIO-N customer have nothing in the yard, in transit or on order.
    expect(v.bookings_with_no_car_coming).toEqual({ bookings: 3, configurations: 2 });
    expect(v.payments).toEqual({ awaiting_payment: 2, to_verify: 0, verified_not_invoiced: 0 });
    expect(v.outlets).toEqual([expect.objectContaining({ code: "SM01", waiting: 3, holding_a_car: 2, cars: 6, cars_free: 3 })]);
    expect(v.delivery_dates_at_risk).toMatchObject({ count: 0 });
    expect(v.out_of_turn).toMatchObject({ this_month: 0, under_review: 0 });
  });

  it("lists every out-of-turn allocation: who got the car, who was passed over, and who approved it or that nobody did", async () => {
    const { w, d } = await start();
    const u = d.users;
    // Approved beforehand: THAR THREE is moved ahead of THAR TWO by a request the Sales Lead raises and the Dealer Principal approves.
    const three = booking(w, "OTF27A000003"), two = booking(w, "OTF27A000002");
    const req = await w.api("POST", "/api/exceptions", { type: "PRIORITY_CHANGE", booking_id: three.id, reason: "Customer's daughter's wedding on 20 October", payload: { before_booking_id: two.id } }, u.lead.session);
    expect(req.status).toBe(201);
    expect((await w.api("POST", `/api/exceptions/${req.body.id}/approve`, { remarks: "Seen the invitation" }, u.dp.session)).status).toBe(200);
    // Not approved by anyone: in the DMS, the SCORPIO-N reserved for SCORPIO ONE is allotted to SCORPIO TWO.
    w.at("2026-10-07 10:00");
    await loadStock(w, u.stock.session, [
      ...STOCK.slice(0, 5),
      { vin: "MA1SCN00000000006", car: "SCORPIO_N", status: "In Transit", oemInvoiceDate: "2026-10-01", order: "OTF27A000012", customer: "SCORPIO TWO" },
      { vin: "MA1THAR0000000007", car: "THAR_WHITE", oemInvoiceDate: "2026-10-05" }, // a new THAR arrives: it goes to THAR THREE
    ]);
    expect(booking(w, "OTF27A000003").vin).toBe("MA1THAR0000000007");
    expect(booking(w, "OTF27A000002").vin).toBeNull();
    expect(booking(w, "OTF27A000012").vin).toBe("MA1SCN00000000006");

    const list = (await w.api("GET", "/api/dashboards/out-of-turn", undefined, u.dp.session)).body as any[];
    const row = (no: string) => list.find((r) => r.given_to === no);
    expect(list).toHaveLength(2);
    expect(row("OTF27A000003")).toMatchObject({ customer_name: "THAR THREE", vin: "MA1THAR0000000007", bypassed: "OTF27A000002", state: "APPROVED", how: "Priority changed, by approved request", approved_by_name: "Dinesh Principal", approved_by_role: "DEALER_PRINCIPAL", exception_reason: "Customer's daughter's wedding on 20 October", decision_remarks: "Seen the invitation" });
    expect(row("OTF27A000012")).toMatchObject({ customer_name: "SCORPIO TWO", vin: "MA1SCN00000000006", bypassed: "OTF27A000011", state: "UNDER_REVIEW", how: "Allotted in the DMS", approved_by_name: null });
    const owner = (await w.api("GET", "/api/dashboards/owner", undefined, u.dp.session)).body;
    expect(owner.out_of_turn).toMatchObject({ this_month: 2, under_review: 1 });

    // The approved one has nothing to review. The other stays open until the Dealer Principal or Business Head records what was found.
    expect((await w.api("POST", `/api/out-of-turn/${row("OTF27A000003").allocation_id}/review`, { note: "ok" }, u.dp.session)).status).toBe(409);
    expect((await w.api("POST", `/api/out-of-turn/${row("OTF27A000012").allocation_id}/review`, { note: "" }, u.head.session)).status).toBe(400);
    expect((await w.api("POST", `/api/out-of-turn/${row("OTF27A000012").allocation_id}/review`, { note: "Sales Lead allotted it in the DMS for a walk-in exchange customer. Warned; SCORPIO ONE called and given the next car." }, u.head.session)).status).toBe(200);
    const after = (await w.api("GET", "/api/dashboards/out-of-turn", undefined, u.auditor.session)).body as any[];
    expect(after.find((r) => r.given_to === "OTF27A000012")).toMatchObject({ state: "REVIEWED", reviewed_by_name: "Bikram Head" });
    expect((await w.api("GET", "/api/dashboards/owner", undefined, u.dp.session)).body.out_of_turn).toMatchObject({ this_month: 2, under_review: 0 });
    expect((await w.api("POST", `/api/out-of-turn/${row("OTF27A000012").allocation_id}/review`, { note: "again" }, u.dp.session)).status).toBe(409);
  });

  it("gives the agreed measures, and says plainly which ones the data cannot support", async () => {
    const { w, d } = await start();
    const res = await w.api("GET", "/api/dashboards/measures", undefined, d.users.dp.session);
    expect(res.status).toBe(200);
    expect(res.body.period).toEqual({ from: "2026-10-01", to: "2026-10-06" });
    expect(res.body.previous).toEqual({ from: "2026-09-25", to: "2026-09-30" });
    const m = Object.fromEntries((res.body.measures as any[]).map((x) => [x.key, x]));
    expect(Object.keys(m)).toEqual(["on_promised_date", "cancelled_waiting", "complaints", "yard_to_invoice", "yard_to_delivery", "stock_over_30", "funding_interest", "out_of_turn", "no_car_coming", "time_to_answer"]);
    expect(m.stock_over_30).toMatchObject({ value: 2, unit: "cars" });
    expect(m.no_car_coming).toMatchObject({ value: 3, unit: "bookings" });
    expect(m.out_of_turn).toMatchObject({ value: 0 });
    expect(m.cancelled_waiting).toMatchObject({ value: 0 });
    // Not in either file and not recorded here: shown as not measured, never as a number.
    expect(m.complaints).toMatchObject({ value: null, basis: "Not measured" });
    expect(m.time_to_answer).toMatchObject({ value: null, basis: "Not measured" });
    // Measured only once the dealership gives its funding rate; no promised date in the booking sheet.
    expect(m.funding_interest).toMatchObject({ value: null, note: "Set the annual funding rate in Settings to measure this." });
    expect(m.on_promised_date.value).toBeNull();
    expect(m.on_promised_date.note).toContain("The DMS booking sheet carries no promised date");
    // A period that ends in the future, or runs backwards, is refused.
    expect((await w.api("GET", "/api/dashboards/measures?from=2026-10-01&to=2026-10-20", undefined, d.users.dp.session)).status).toBe(400);
    expect((await w.api("GET", "/api/dashboards/measures?from=2026-10-05&to=2026-10-01", undefined, d.users.dp.session)).status).toBe(400);
  });

  it("counts a delivery from the files: invoiced when the stock report shows the invoice, delivered when the car leaves the report", async () => {
    const { w, d } = await start();
    const u = d.users;
    // 8 October: the THAR is retail-invoiced to THAR ONE in the DMS.
    w.at("2026-10-08 10:00");
    const invoiced = STOCK.map((l) => (l.vin === "MA1THAR0000000001" ? { ...l, order: "OTF27A000001", customer: "THAR ONE", invoiceId: "INV0001", invoiceDate: "2026-10-08", grnDate: "2026-10-02" } : l));
    await loadStock(w, u.stock.session, invoiced);
    expect(booking(w, "OTF27A000001")).toMatchObject({ status: "INVOICED" });
    expect((await w.api("GET", "/api/dashboards/owner", undefined, u.dp.session)).body).toMatchObject({ invoiced_not_delivered: 1 });
    // 10 October: the car is no longer in the stock report.
    w.at("2026-10-10 10:00");
    await loadStock(w, u.stock.session, STOCK.filter((l) => l.vin !== "MA1THAR0000000001"));
    expect(booking(w, "OTF27A000001")).toMatchObject({ status: "DELIVERED" });
    const m = Object.fromEntries(((await w.api("GET", "/api/dashboards/measures", undefined, u.finance.session)).body.measures as any[]).map((x) => [x.key, x]));
    expect(m.yard_to_invoice).toMatchObject({ value: 6, unit: "days" }); // GRN 2 October, invoice 8 October
    expect(m.yard_to_delivery).toMatchObject({ value: 8, unit: "days" }); // GRN 2 October, gone from the report of 10 October
  });
});
