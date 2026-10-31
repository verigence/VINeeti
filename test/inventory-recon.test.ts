// Dynamic inventory update (stock changing through the day from the screen and from repeated DMS files) and
// the day-end reconciliation that checks the books still agree.

import { describe, expect, it } from "vitest";
import { addCar, approvedBooking, booking, CARS, CRETA, loadBookings, loadStock, makeDealer, makeWorld, submittedBooking, VENUE, type BookingLine, type Dealer, type StockLine, type World } from "./harness";

const V = CRETA.variant;
const THAR = CARS.THAR_WHITE.is;
/** A line of the DMS stock report / booking sheet for the car most of these tests use: a white Thar at Patia. */
const car = (vin: string, extra: Partial<StockLine> = {}): StockLine => ({ vin, car: "THAR_WHITE", loc: "PATIA", ...extra });
const order = (no: string, created: string, extra: Partial<BookingLine> = {}): BookingLine => ({ no, car: "THAR_WHITE", loc: "PATIA", created, ...extra });
/** The booking sheet of a day on which nothing changed in it: one booking delivered last month. */
const QUIET_SHEET: BookingLine[] = [order("OTF27A000900", "02-Sep-2026 11:00 AM", { car: "SCORPIO_N", stage: "Invoiced", enquiryStage: "Delivered" })];
const bookingByNo = (w: World, no: string) => w.db.q<any>(`SELECT * FROM bookings WHERE booking_no = ?`, no)[0];
const carByVin = (w: World, vin: string) => w.db.q<any>(`SELECT * FROM vehicles WHERE vin = ?`, vin)[0];
const allocatedVin = (w: World, no: string) => w.db.q<any>(`SELECT v.vin FROM allocations a JOIN vehicles v ON v.id = a.vehicle_id JOIN bookings b ON b.id = a.booking_id WHERE b.booking_no = ? AND a.status = 'ACTIVE'`, no)[0]?.vin ?? null;
const recon = async (w: World, d: Dealer) => {
  const run = await w.api("POST", "/api/recon/run", {}, d.users.head.session);
  const detail = await w.api("GET", `/api/recon/runs/${run.body.run_id}`, undefined, d.users.head.session);
  return { summary: run.body.summary, items: detail.body.items as any[] };
};

describe("daily data upload from the DMS", () => {
  it("loads active bookings and allocates by booking date, not by the order of the file", async () => {
    const w = makeWorld("2026-10-13 09:30");
    const d = await makeDealer(w);
    await loadStock(w, d.users.stock.session, [car("VIN0000000000001", { oemInvoiceDate: "2026-10-01" })]);
    const res = await loadBookings(w, d.users.stock.session, [
      order("OTF27A000200", "05-Oct-2026 04:00 PM", { customer: "LATER CUSTOMER", mobile: "9876511111" }),
      order("OTF27A000100", "01-Oct-2026 11:00 AM", { customer: "EARLIER CUSTOMER", mobile: "9876522222", raw: { "Booking Amount": "25,000" } }),
      order("OTF27A000300", "06-Oct-2026 09:00 AM", { customer: "THIRD CUSTOMER", mobile: "12345" }),
    ]);
    expect(res.body).toMatchObject({ created: 3, updated: 0, allocations: 1 });
    expect(res.body.summary).toMatchObject({ bookings: 3, booked: 3, new_bookings: 3, entered_queue: 3 });
    // A booking whose mobile number cannot be used is still loaded (the customer keeps their place); the row is pointed out.
    expect(res.body.errors).toEqual([{ row: 4, key: "OTF27A000300", message: "Customer mobile number is not valid; the booking was loaded, but this customer will not receive WhatsApp messages" }]);
    expect(allocatedVin(w, "OTF27A000100")).toBe("VIN0000000000001");
    expect(bookingByNo(w, "OTF27A000100")).toMatchObject({ status: "ALLOCATED", booking_amount: 25000, booking_date: "2026-10-01T05:30:00.000Z", priority_ts: "2026-10-01T05:30:00.000Z", source: "DMS", ...THAR });
    expect(bookingByNo(w, "OTF27A000200").status).toBe("APPROVED");
    expect(bookingByNo(w, "OTF27A000300")).toMatchObject({ status: "APPROVED", wa_opt_in: 0 });
    const list = (await w.api("GET", "/api/bookings?view=waiting", undefined, d.users.sm.session)).body;
    expect(list.map((b: any) => [b.booking_no, b.queue_position])).toEqual([["OTF27A000200", 1], ["OTF27A000300", 2]]); // the waiting list reads in queue order
  });

  it("reports bad rows by row number and still loads the good ones", async () => {
    const w = makeWorld("2026-10-13 09:30");
    const d = await makeDealer(w);
    const res = await loadBookings(w, d.users.stock.session, [
      order("OTF27A000001", "01-Oct-2026 10:00 AM", { customer: "GOOD ROW" }),
      order("OTF27A000002", "01-Oct-2026 10:00 AM", { customer: "BAD OUTLET", loc: "PURI" }),
      order("OTF27A000003", "32-Oct-2026 10:00 AM", { customer: "BAD DATE" }),
      order("OTF27A000004", "01-Oct-2026 10:00 AM", { customer: "BAD STAGE", raw: { "Booking Stage": "On Hold" } }),
      order("OTF27A000001", "01-Oct-2026 10:00 AM", { customer: "DUPLICATE" }),
      order("OTF27A000006", "20-Oct-2026 10:00 AM", { customer: "DATED NEXT WEEK" }),
    ]);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 1, updated: 0 });
    // First what the sheet itself has wrong, then what this dealership cannot take from it.
    expect(res.body.errors).toEqual([
      { row: 4, key: "OTF27A000003", message: 'Booking date "32-Oct-2026 10:00 AM" is not a date' },
      { row: 5, key: "OTF27A000004", message: 'Booking status "On Hold" is not recognised (expected Booked, Allotted, Invoiced or Cancellation Initiated)' },
      { row: 6, key: "OTF27A000001", message: "DMS Booking Number appears more than once in the sheet; only the first row was used" },
      { row: 3, key: "OTF27A000002", message: "Outlet PURI (PURI) is not set up; ask the administrator to load this sheet once" },
      { row: 7, key: "OTF27A000006", message: "Created Date is in the future" },
    ]);
    expect(w.db.q(`SELECT booking_no, customer_name FROM bookings`)).toEqual([{ booking_no: "OTF27A000001", customer_name: "GOOD ROW" }]);
    expect(w.db.q(`SELECT code FROM outlets ORDER BY code`).map((o: any) => o.code)).toEqual(["CUTTACK", "PATIA"]); // someone limited to certain outlets does not create new ones
    const history = await w.api("GET", "/api/uploads", undefined, d.users.stock.session);
    expect(history.body.uploads[0]).toMatchObject({ kind: "BOOKINGS", status: "DONE", filename: "Booking-Sept26.xlsx", created_count: 1, error_count: 5, uploaded_by_name: "Gopal Stock" });
    expect(history.body.uploads[0].errors).toHaveLength(5);
    // A file that is not the booking sheet is refused whole.
    const notIt = await w.send("/api/uploads/bookings?filename=x.csv", new TextEncoder().encode("booking_no,customer_name\nBK-9,X\n"), d.users.stock.session);
    expect(notIt.status).toBe(400);
    // The dealership has two booking exports with different headings, so the refusal names both.
    expect(notIt.body.error.message).toContain("This is not a DMS booking export");
    expect(notIt.body.error.message).toContain("DMS Booking Number");
    expect(notIt.body.error.message).toContain("OTF Number");
  });

  it("a booking cancelled in the DMS leaves the queue and its car goes to the next customer", async () => {
    const w = makeWorld("2026-10-13 09:30");
    const d = await makeDealer(w);
    const s = d.users.stock.session;
    await loadStock(w, s, [car("VIN0000000000001")]);
    const rows = [order("OTF27A000001", "01-Oct-2026 10:00 AM", { customer: "FIRST" }), order("OTF27A000002", "02-Oct-2026 10:00 AM", { customer: "SECOND" }), order("OTF27A000003", "03-Oct-2026 10:00 AM", { customer: "THIRD" })];
    await loadBookings(w, s, [rows[2], rows[1], rows[0]]);
    expect(allocatedVin(w, "OTF27A000001")).toBe("VIN0000000000001");
    w.at("2026-10-13 15:00");
    const sheet = [rows[2], rows[1], { ...rows[0], stage: "Cancellation Initiated" as const }];
    const res = await loadBookings(w, s, sheet);
    expect(res.body.summary).toMatchObject({ cancelled: 1, cancelled_now: 1, cars_released: 1 });
    expect(res.body).toMatchObject({ allocations: 1, errors: [] });
    expect(bookingByNo(w, "OTF27A000001")).toMatchObject({ status: "CANCELLED", cancel_reason: "Cancelled in DMS" });
    // The car goes to the next booking in the queue, not the next row of the sheet.
    expect(allocatedVin(w, "OTF27A000002")).toBe("VIN0000000000001");
    expect(bookingByNo(w, "OTF27A000003").status).toBe("APPROVED");
    const told = () => w.db.q<any>(`SELECT b.booking_no, m.event_key FROM wa_messages m JOIN bookings b ON b.id = m.booking_id ORDER BY m.created_at, m.rowid`).map((x) => `${x.booking_no} ${x.event_key}`);
    expect(told()).toEqual(["OTF27A000001 ALLOC_FREE_STOCK", "OTF27A000002 ALLOC_REALLOCATED"]);
    // The same sheet loaded again cancels nothing twice, moves no car and messages nobody.
    const before = { audit: w.db.q(`SELECT id FROM audit_log`).length, allocations: w.db.q(`SELECT id, status FROM allocations ORDER BY id`) };
    const again = await loadBookings(w, s, sheet);
    expect(again.body).toMatchObject({ created: 0, allocations: 0, errors: [] });
    expect(again.body.summary).toMatchObject({ cancelled_now: 0, cars_released: 0 });
    expect(told()).toHaveLength(2);
    expect(w.db.q(`SELECT id FROM audit_log`)).toHaveLength(before.audit);
    expect(w.db.q(`SELECT id, status FROM allocations ORDER BY id`)).toEqual(before.allocations);
  });

  // BACKEND? "Loading the same file again changes nothing" does not hold for the sheet's own columns of a booking that
  // the first load cancelled. importBookingSheet leaves the row before its field update when it is about to cancel the
  // booking, so Booking Stage / Enquiry Stage stay as they were (a cancelled booking that held a car still reads
  // "Booked"), and the second load of the same sheet writes those rows and counts them as updated; only the third load
  // is unchanged. Nothing a customer or a queue sees is affected (the test above). Remove `.fails` once the load that
  // cancels a booking also records what the sheet says about it.
  it("the sheet that cancelled bookings, loaded again, is reported as unchanged", async () => {
    const w = makeWorld("2026-10-13 09:30");
    const d = await makeDealer(w);
    const s = d.users.stock.session;
    await loadStock(w, s, [car("VIN0000000000001")]);
    const rows = [order("OTF27A000001", "01-Oct-2026 10:00 AM"), order("OTF27A000002", "02-Oct-2026 10:00 AM"), order("OTF27A000003", "03-Oct-2026 10:00 AM")];
    await loadBookings(w, s, rows);
    // The first booking holds the car and the third is waiting; the DMS cancels both.
    const sheet = [{ ...rows[0], stage: "Cancellation Initiated" as const }, rows[1], { ...rows[2], stage: "Cancellation Initiated" as const }];
    expect((await loadBookings(w, s, sheet)).body.summary).toMatchObject({ cancelled_now: 2, cars_released: 1 });
    for (const no of ["OTF27A000001", "OTF27A000003"]) expect(bookingByNo(w, no), no).toMatchObject({ status: "CANCELLED", dms_stage: "Cancellation Initiated", dms_enquiry_stage: "Dropped" });
    expect((await loadBookings(w, s, sheet)).body).toMatchObject({ created: 0, updated: 0, unchanged: 3 });
  });

  it("the car a cancelled booking gives back follows the dealership's own queue order", async () => {
    const w = makeWorld("2026-10-13 09:30");
    const d = await makeDealer(w);
    const s = d.users.stock.session;
    expect((await w.api("PUT", "/api/settings", { queue_order: ["BOOKING_AMOUNT", "BOOKING_DATE"] }, d.users.admin.session)).status).toBe(200);
    await loadStock(w, s, [car("VIN0000000000001")]);
    const rows = [order("OTF27A000001", "01-Oct-2026 10:00 AM", { amount: 21000 }), order("OTF27A000002", "02-Oct-2026 10:00 AM", { amount: 51000 }), order("OTF27A000003", "03-Oct-2026 10:00 AM", { amount: 100000 })];
    await loadBookings(w, s, rows);
    expect(allocatedVin(w, "OTF27A000003")).toBe("VIN0000000000001"); // highest booking amount first, as this dealership has set
    await loadBookings(w, s, [rows[0], rows[1], { ...rows[2], stage: "Cancellation Initiated" }]);
    expect(allocatedVin(w, "OTF27A000002")).toBe("VIN0000000000001");
    expect(bookingByNo(w, "OTF27A000001").status).toBe("APPROVED"); // booked first, but third under this rule
  });

  it("when the dealership wants DMS bookings approved in the app first, they arrive awaiting approval", async () => {
    const w = makeWorld("2026-10-13 09:30");
    const d = await makeDealer(w);
    await w.api("PUT", "/api/settings", { import_bookings_as_approved: false }, d.users.admin.session);
    await loadStock(w, d.users.stock.session, [car("VIN0000000000001")]);
    const res = await loadBookings(w, d.users.stock.session, [order("OTF27A000001", "01-Oct-2026 10:00 AM")]);
    expect(res.body).toMatchObject({ created: 1, allocations: 0 });
    expect(res.body.summary.entered_queue).toBe(0);
    expect(bookingByNo(w, "OTF27A000001").status).toBe("SUBMITTED");
    expect(allocatedVin(w, "OTF27A000001")).toBeNull();
    const approved = await w.api("POST", `/api/bookings/${bookingByNo(w, "OTF27A000001").id}/approve`, {}, d.users.sm.session);
    expect(approved.body.allocations).toHaveLength(1);
  });
});

describe("stock changes through the day", () => {
  it("morning, afternoon and evening files move cars along and allocation follows each time", async () => {
    const w = makeWorld("2026-10-13 09:00");
    const d = await makeDealer(w);
    const s = d.users.stock.session;
    await loadBookings(w, s, [order("OTF27A000001", "01-Oct-2026 10:00 AM"), order("OTF27A000002", "02-Oct-2026 10:00 AM")]);
    // Morning: one car dispatched from the plant.
    let res = await loadStock(w, s, [car("VIN0000000000001", { status: "In Transit", oemInvoiceDate: "2026-10-05" })]);
    expect(res.body).toMatchObject({ created: 1, allocations: 1 });
    expect(allocatedVin(w, "OTF27A000001")).toBe("VIN0000000000001");
    // The carrier gives an arrival date; the stock report has no column for it, so it is entered on the screen.
    w.at("2026-10-13 11:00");
    const id = carByVin(w, "VIN0000000000001").id;
    await w.api("PATCH", `/api/vehicles/${id}`, { expected_arrival_date: "2026-10-17" }, s);
    // Afternoon: a second car is dispatched.
    w.at("2026-10-13 14:00");
    res = await loadStock(w, s, [car("VIN0000000000001", { status: "In Transit", oemInvoiceDate: "2026-10-05" }), car("VIN0000000000002", { status: "In Transit", oemInvoiceDate: "2026-10-09" })]);
    expect(res.body).toMatchObject({ created: 1, updated: 0, unchanged: 1, allocations: 1 });
    expect(carByVin(w, "VIN0000000000001").expected_arrival_date).toBe("2026-10-17"); // the report does not wipe what was entered
    expect(allocatedVin(w, "OTF27A000002")).toBe("VIN0000000000002");
    // Evening: the first car has arrived. The customer is told and the payment window starts.
    w.at("2026-10-13 18:00");
    res = await loadStock(w, s, [car("VIN0000000000001", { oemInvoiceDate: "2026-10-05", grnDate: "2026-10-13" }), car("VIN0000000000002", { status: "In Transit", oemInvoiceDate: "2026-10-09" })]);
    expect(res.body).toMatchObject({ created: 0, updated: 1, unchanged: 1, errors: [] });
    expect(res.body.summary.received).toBe(1);
    expect(carByVin(w, "VIN0000000000001").status).toBe("RECEIVED");
    const b1 = bookingByNo(w, "OTF27A000001");
    expect(w.db.q<any>(`SELECT event_key FROM wa_messages WHERE booking_id = ? ORDER BY created_at`, b1.id).map((m) => m.event_key)).toEqual(["ALLOC_IN_TRANSIT", "STOCK_RECEIVED"]);
    expect((await booking(w, d, b1.id)).allocation.window.release_on).toBe("2026-10-19");
    // Every movement is on the car's history.
    const hist = await w.api("GET", `/api/vehicles/${id}`, undefined, d.users.se1.session);
    expect(hist.body.events.map((e: any) => e.type).reverse()).toEqual(["CREATED", "ETA_CHANGED", "RECEIVED"]);
    expect(hist.body.events.map((e: any) => e.actor_name).reverse()).toEqual(["DMS file", "Gopal Stock", "DMS file"]);
  });

  it("a report that contradicts what the system knows is pointed out, not applied blindly", async () => {
    const w = makeWorld("2026-10-13 09:00");
    const d = await makeDealer(w);
    const s = d.users.stock.session;
    await loadStock(w, s, [car("VIN0000000000001", { status: "In Transit" }), car("VIN0000000000003")]);
    await loadBookings(w, s, [order("OTF27A000001", "01-Oct-2026 10:00 AM")]);
    expect(allocatedVin(w, "OTF27A000001")).toBe("VIN0000000000003"); // the car in the yard first
    // The car in transit arrives and is received on the screen at 11:00.
    w.at("2026-10-13 11:00");
    await w.api("POST", `/api/vehicles/${carByVin(w, "VIN0000000000001").id}/receive`, undefined, s);
    const receivedAt = carByVin(w, "VIN0000000000001").received_at;
    // A report exported before that still says In Transit: the car does not go back on the road.
    w.at("2026-10-13 12:00");
    let res = await loadStock(w, s, [car("VIN0000000000001", { status: "In Transit" }), car("VIN0000000000003")]);
    expect(res.body).toMatchObject({ updated: 0, unchanged: 2, errors: [] });
    expect(carByVin(w, "VIN0000000000001")).toMatchObject({ status: "RECEIVED", received_at: receivedAt });
    // Rows the report itself has wrong are refused one by one, by row number; the rest of the report is used.
    res = await loadStock(w, s, [
      car("VIN0000000000001"),
      car("VIN0000000000001", { status: "In Transit" }),
      car("VIN0000000000003"),
      car("VIN0000000000009", { raw: { " Vehicle Status": "Parked" } }),
      car("VIN0000000000010", { raw: { "Stock Type": "Reserved" } }),
    ]);
    expect(res.body.errors).toEqual([
      { row: 3, key: "VIN0000000000001", message: "VIN appears more than once in the report; only the first row was used" },
      { row: 5, key: "VIN0000000000009", message: 'Vehicle Status "Parked" is not recognised (expected Received or In Transit)' },
      { row: 6, key: "VIN0000000000010", message: 'Stock Type "Reserved" is not recognised (expected Unalloted, Alloted or IBND)' },
    ]);
    expect(w.db.q(`SELECT vin FROM vehicles ORDER BY vin`).map((v: any) => v.vin)).toEqual(["VIN0000000000001", "VIN0000000000003"]);
    // A report that describes a reserved car as a different car does not change it under the customer: the row is reported.
    res = await loadStock(w, s, [car("VIN0000000000001"), { vin: "VIN0000000000003", car: "THAR_BLACK", loc: "PATIA" }]);
    expect(res.body.errors).toEqual([{ row: 3, key: "VIN0000000000003", message: "The report describes this car as THAR LXT D MT 2WD 4S HT (M0877) STEALTH BLACK; the system has it as THAR LXT D MT 2WD 4S HT (M0877) EVEREST WHITE and it is reserved for booking OTF27A000001. Its description was not changed; check the reservation." }]);
    expect(carByVin(w, "VIN0000000000003")).toMatchObject({ status: "RECEIVED", colour: "EVEREST WHITE" });
    expect(allocatedVin(w, "OTF27A000001")).toBe("VIN0000000000003");
  });

  it("takes over existing commitments at go-live from the stock report", async () => {
    const w = makeWorld("2026-10-13 09:00");
    const d = await makeDealer(w);
    const s = d.users.stock.session;
    await loadBookings(w, s, [order("OTF27A000001", "01-Oct-2026 10:00 AM", { customer: "FIRST" }), order("OTF27A000002", "02-Oct-2026 10:00 AM", { customer: "SECOND" })]);
    // The dealership had already promised this car to the second customer before the system came in:
    // its first stock report shows the car allotted to that order. A second car is allotted to an order from before the sheets.
    const res = await loadStock(w, s, [
      car("VIN0000000000001", { order: "OTF27A000002", customer: "SECOND" }),
      car("VIN0000000000002", { order: "OTF26A000777", customer: "LAST YEAR'S ORDER" }),
    ]);
    expect(res.body.errors).toEqual([]);
    expect(res.body.summary.orders).toMatchObject({ total: 2, in_booking_data: 1, known_only_from_stock: 1, recorded: 2, bypassed: 0, out_of_turn: 0 });
    expect(allocatedVin(w, "OTF27A000002")).toBe("VIN0000000000001");
    expect(w.db.q(`SELECT source, allocated_by, out_of_turn, json_extract(rule_trace_json, '$.rule') AS rule FROM allocations ORDER BY allocated_by`)).toEqual([
      { source: "DMS", allocated_by: "DMS", out_of_turn: 0, rule: "OPENING_FROM_DMS" },
      { source: "DMS", allocated_by: "DMS", out_of_turn: 0, rule: "OPENING_FROM_DMS" },
    ]);
    expect(bookingByNo(w, "OTF27A000001").status).toBe("APPROVED");
    expect(bookingByNo(w, "OTF26A000777")).toMatchObject({ status: "ALLOCATED", source: "DMS_STOCK", customer_name: "LAST YEAR'S ORDER" });
    // An opening commitment is not announced to the customer as a new allocation, and is nobody's alarm.
    expect(w.db.q(`SELECT id FROM wa_messages`)).toHaveLength(0);
    expect(w.db.q(`SELECT id FROM alerts WHERE is_alarm = 1`)).toHaveLength(0);
  });

  // BACKEND? importStockReport frees a reserved car when its booking is invoiced and a stock report at least as recent
  // still lists the car as unallotted ("the customer was billed with a different car"). That holds for a booking the
  // booking sheet shows invoiced. It is also applied to a booking Finance invoiced in the app with this very car
  // (POST /api/bookings/:id/invoice, which marks the car itself invoiced): the next report that still shows the car
  // unallotted releases it (reason BILLED_WITH_ANOTHER_CAR). The booking is then invoiced, and can be delivered, with
  // no car; the car stays "invoiced" and belongs to nobody; and the day-end reconciliation lists nothing about either.
  // Expected: a car the system itself invoiced to a booking stays with it (a report that disagrees is a finding for a
  // person, not a release). Remove `.fails` when fixed.
  it("a car invoiced to its customer in the app stays with that booking when the stock report still lists it as unallotted", async () => {
    const w = makeWorld("2026-10-13 09:30");
    const d = await makeDealer(w);
    const s = d.users.stock.session;
    await loadStock(w, s, [car("VIN0000000000001")]);
    await loadBookings(w, s, [order("OTF27A000001", "01-Oct-2026 10:00 AM")]);
    const id = bookingByNo(w, "OTF27A000001").id;
    w.at("2026-10-14 11:00");
    await w.api("POST", `/api/bookings/${id}/payment-reported`, { reference: "UTR2610140001" }, d.users.sm.session);
    await w.api("POST", `/api/bookings/${id}/payment-received`, {}, d.users.accounts.session);
    expect((await w.api("POST", `/api/bookings/${id}/invoice`, undefined, d.users.accounts.session)).body.status).toBe("INVOICED");
    expect(carByVin(w, "VIN0000000000001").status).toBe("INVOICED");
    // The evening's report was exported before the DMS had the invoice: there the car is still Received and Unalloted.
    w.at("2026-10-14 18:00");
    expect((await loadStock(w, s, [car("VIN0000000000001")])).body.errors).toEqual([]);
    expect(allocatedVin(w, "OTF27A000001")).toBe("VIN0000000000001");
    expect((await w.api("POST", `/api/bookings/${id}/deliver`, undefined, d.users.accounts.session)).body.status).toBe("DELIVERED");
    expect(carByVin(w, "VIN0000000000001").status).toBe("DELIVERED");
  });

  it("blocking a damaged car returns its customer to the queue; unblocking makes it available again", async () => {
    const w = makeWorld("2026-10-13 09:00");
    const d = await makeDealer(w);
    const car = await addCar(w, d, "VIN0000000000001", CRETA, "PATIA", "RECEIVED");
    const b1 = await approvedBooking(w, d, "se1", CRETA, "PATIA", "First", "9876511111");
    expect(b1.approval.allocations).toHaveLength(1);
    expect((await w.api("POST", `/api/vehicles/${car.id}/block`, { reason: "" }, d.users.stock.session)).status).toBe(400);
    await w.api("POST", `/api/vehicles/${car.id}/block`, { reason: "Transit damage, bumper" }, d.users.stock.session);
    expect((await booking(w, d, b1.id)).booking).toMatchObject({ status: "APPROVED", on_hold: 0 });
    const summary = (await w.api("GET", "/api/stock/summary", undefined, d.users.se1.session)).body[0];
    expect(summary).toMatchObject({ yard_free: 0, blocked: 1 });
    const res = await w.api("POST", `/api/vehicles/${car.id}/unblock`, undefined, d.users.stock.session);
    expect(res.body.allocations[0]).toMatchObject({ bookingId: b1.id, type: "FREE_STOCK" }); // the same customer, so not "re-allocated"
  });

  it("a deferred customer rejoins automatically on the agreed date", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    await addCar(w, d, "VIN0000000000001", CRETA, "PATIA", "RECEIVED");
    const b1 = await approvedBooking(w, d, "se1", CRETA, "PATIA", "Deferring", "9876511111");
    const ex = await w.api("POST", "/api/exceptions", { type: "DEFER_DELIVERY", booking_id: b1.id, payload: { until: "2026-11-01" }, reason: "Customer wants delivery after Diwali" }, d.users.agm.session);
    await w.api("POST", `/api/exceptions/${ex.body.id}/approve`, {}, d.users.head.session);
    expect((await booking(w, d, b1.id)).booking).toMatchObject({ status: "APPROVED", on_hold: 1, hold_reason: "CUSTOMER_DEFERRED", hold_until: "2026-11-01", expected_delivery_date: "2026-11-01" });
    w.at("2026-10-31 10:00");
    expect((await w.tick())[0].holds_lifted).toBe(0);
    w.at("2026-11-01 08:00"); // before business hours: holds still lift, only customer reminders wait
    expect((await w.tick())[0].holds_lifted).toBe(1);
    expect((await booking(w, d, b1.id)).allocation.vin).toBe("VIN0000000000001");
  });

  it("with 'rejoin the queue' chosen, a timed-out customer goes to the back and the car to the next", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    await w.api("PUT", "/api/settings", { hold_after_timeout: false }, d.users.admin.session);
    await addCar(w, d, "VIN0000000000001", CRETA, "PATIA", "RECEIVED");
    const b1 = await approvedBooking(w, d, "se1", CRETA, "PATIA", "Slow Payer", "9876511111");
    w.at("2026-10-14 10:00");
    const b2 = await approvedBooking(w, d, "se1", CRETA, "PATIA", "Next", "9876511112");
    w.at("2026-10-19 10:00");
    expect((await w.tick())[0].released).toBe(1);
    expect((await booking(w, d, b2.id)).allocation).toMatchObject({ vin: "VIN0000000000001", type: "REALLOCATED" });
    const first = await booking(w, d, b1.id);
    expect(first.booking).toMatchObject({ status: "APPROVED", on_hold: 0 });
    expect(first.queue).toEqual({ position: 1, waiting: 1 });
  });
});

describe("day-end reconciliation", () => {
  it("carries the stock count from one day to the next and explains every movement", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    await addCar(w, d, "VIN0000000000001", CRETA, "PATIA", "RECEIVED");
    await addCar(w, d, "VIN0000000000002", CRETA, "PATIA", "IN_TRANSIT", { expected_arrival_date: "2026-10-20" });
    await addCar(w, d, "VIN0000000000003", VENUE, "CUTTACK", "RECEIVED");
    const day1 = await recon(w, d);
    expect(day1.summary.stock.find((s: any) => s.outlet === "Patia")).toMatchObject({ opening: 0, added: 2, left: 0, closing: 2, expected_closing: 2, in_transit: 1, in_yard_free: 1 });
    expect(day1.items).toEqual([]);

    // Day 2: one car arrives new, one is transferred between outlets, one is sold and delivered.
    w.at("2026-10-14 11:00");
    await addCar(w, d, "VIN0000000000004", CRETA, "PATIA", "IN_TRANSIT", { expected_arrival_date: "2026-10-30" });
    await w.api("POST", `/api/vehicles/${carByVin(w, "VIN0000000000003").id}/transfer`, { outlet_id: d.outlets.PATIA }, d.users.stock.session);
    const bk = await approvedBooking(w, d, "se1", CRETA, "PATIA", "Buyer", "9876511111", { expected_delivery_date: "2026-10-20" });
    await w.api("POST", `/api/bookings/${bk.id}/invoice`, undefined, d.users.accounts.session);
    await w.api("POST", `/api/bookings/${bk.id}/deliver`, undefined, d.users.accounts.session);
    const day2 = await recon(w, d);
    expect(day2.summary.stock.find((s: any) => s.outlet === "Patia")).toMatchObject({ opening: 2, added: 2, left: 1, closing: 3, expected_closing: 3 });
    expect(day2.summary.stock.find((s: any) => s.outlet === "Cuttack")).toMatchObject({ opening: 1, added: 0, left: 1, closing: 0 });
    expect(day2.summary.bookings).toMatchObject({ invoiced_today: 1, delivered_today: 1 });
    expect(day2.summary.day).toMatchObject({ allocations: 1, uploads: 0 });
    expect(day2.items.filter((i) => i.severity === "HIGH")).toEqual([]);
  });

  it("explains every movement that comes from the stock report too: cars arriving, invoiced, moved between outlets and gone", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    const s = d.users.stock.session;
    // Day 1. Patia: one car in the yard, one on the road, and one the DMS has already invoiced (it never was stock here). Cuttack: one in the yard.
    await loadStock(w, s, [
      car("VIN0000000000001"),
      car("VIN0000000000002", { status: "In Transit" }),
      car("VIN0000000000003", { order: "OTF27A000903", customer: "BILLED LAST WEEK", invoiceId: "INV-0903", invoiceDate: "2026-10-09" }),
      car("VIN0000000000004", { loc: "CUTTACK" }),
    ]);
    await loadBookings(w, s, [...QUIET_SHEET, order("OTF27A000903", "20-Sep-2026 10:00 AM", { stage: "Invoiced", customer: "BILLED LAST WEEK" })]);
    const day1 = await recon(w, d);
    expect(day1.summary.stock.find((x: any) => x.outlet === "Patia")).toMatchObject({ opening: 0, added: 2, left: 0, closing: 2, expected_closing: 2, in_transit: 1, in_yard_free: 1 });
    expect(day1.summary.stock.find((x: any) => x.outlet === "Cuttack")).toMatchObject({ opening: 0, added: 1, left: 0, closing: 1 });
    expect(day1.items).toEqual([]);

    // Day 2's report: the yard car is invoiced to a customer, the car on the road has been diverted to Cuttack,
    // a new car is dispatched to Patia, the invoiced car has been delivered (it is no longer listed) and neither is Cuttack's car.
    w.at("2026-10-14 11:00");
    const res = await loadStock(w, s, [
      car("VIN0000000000001", { order: "OTF27A000904", customer: "BILLED TODAY", invoiceId: "INV-0904", invoiceDate: "2026-10-14" }),
      car("VIN0000000000002", { status: "In Transit", loc: "CUTTACK" }),
      car("VIN0000000000005", { status: "In Transit" }),
    ]);
    expect(res.body).toMatchObject({ created: 1, updated: 2, errors: [] });
    expect(res.body.summary).toMatchObject({ new_cars: 1, invoiced: 1, left_stock: { delivered: 1, removed: 1, on_hold: 0 } });
    await loadBookings(w, s, [...QUIET_SHEET, order("OTF27A000903", "20-Sep-2026 10:00 AM", { stage: "Invoiced", enquiryStage: "Delivered", customer: "BILLED LAST WEEK" }), order("OTF27A000904", "25-Sep-2026 10:00 AM", { stage: "Invoiced", customer: "BILLED TODAY" })]);
    expect(w.db.q(`SELECT vin, status FROM vehicles ORDER BY vin`).map((v: any) => `${v.vin.slice(-1)} ${v.status}`)).toEqual(["1 INVOICED", "2 IN_TRANSIT", "3 DELIVERED", "4 REMOVED", "5 IN_TRANSIT"]);
    const day2 = await recon(w, d);
    expect(day2.summary.stock.find((x: any) => x.outlet === "Patia")).toMatchObject({ opening: 2, added: 1, left: 2, closing: 1, expected_closing: 1, in_transit: 1, in_yard_free: 0 });
    expect(day2.summary.stock.find((x: any) => x.outlet === "Cuttack")).toMatchObject({ opening: 1, added: 1, left: 1, closing: 1, expected_closing: 1, in_transit: 1 });
    expect(day2.summary.bookings).toMatchObject({ invoiced_today: 1, delivered_today: 1 });
    expect(day2.summary.day.uploads).toBe(2);
    expect(day2.items).toEqual([]);
  });

  it("flags a stock count that does not follow from the recorded movements", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    await addCar(w, d, "VIN0000000000001", CRETA, "PATIA", "RECEIVED");
    await addCar(w, d, "VIN0000000000002", CRETA, "PATIA", "RECEIVED");
    await recon(w, d);
    w.at("2026-10-14 10:00");
    // A car disappears from the records without any movement being recorded (data changed behind the system's back).
    w.db.raw.exec(`UPDATE vehicles SET status = 'REMOVED' WHERE vin = 'VIN0000000000002'`);
    const day2 = await recon(w, d);
    const item = day2.items.find((i) => i.category === "STOCK_MOVEMENT");
    expect(item).toMatchObject({ severity: "HIGH", outlet: "Patia" });
    expect(item.message).toBe("Patia: opening 2 + 0 added - 0 left should give 2, but the system holds 1.");
  });

  it("flags cars missing from the full stock list, late arrivals, late deliveries, stale data and slow approvals", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    const s = d.users.stock.session;
    await loadStock(w, s, [car("VIN0000000000001"), car("VIN0000000000002", { status: "In Transit" }), { vin: "VIN0000000000003", car: "XUV3XO_WHITE", loc: "CUTTACK" }]);
    await loadBookings(w, s, QUIET_SHEET);
    await w.api("PATCH", `/api/vehicles/${carByVin(w, "VIN0000000000002").id}`, { expected_arrival_date: "2026-10-15" }, s);
    const late = await approvedBooking(w, d, "se1", THAR, "PATIA", "Late Delivery", "9876511111", { expected_delivery_date: "2026-10-16" });
    expect(late.approval.allocations[0]).toMatchObject({ vin: "VIN0000000000001" });
    const slow = await submittedBooking(w, d, "se1", CARS.XUV3XO_WHITE.is, "PATIA", "Slow Approval", "9876511112");

    // 17 Oct: no DMS file has been loaded since the 13th, which is longer than the three days this dealership allows.
    w.at("2026-10-17 20:30");
    let r = await recon(w, d);
    const cats = (items: any[]) => items.map((i) => i.category).sort();
    expect(cats(r.items)).toEqual(["APPROVAL_PENDING", "DELIVERY_OVERDUE", "STALE_DATA", "TRANSIT_OVERDUE"]);
    expect(r.items.find((i) => i.category === "TRANSIT_OVERDUE").message).toContain("VIN0000000000002");
    expect(r.items.find((i) => i.category === "DELIVERY_OVERDUE").entity_id).toBe(late.id);
    expect(r.items.find((i) => i.category === "APPROVAL_PENDING").entity_id).toBe(slow.id);
    expect(r.items.find((i) => i.category === "STALE_DATA")).toMatchObject({ severity: "HIGH" });
    expect(r.items.find((i) => i.category === "STALE_DATA").message).toBe(
      "The stock report is as on 13 Oct 2026 (4 day(s) old); the booking sheet is as on 13 Oct 2026 (4 day(s) old). The files are expected every 3 day(s). Availability and queue positions may be out of date, and no car is re-allocated automatically until they are loaded.",
    );

    // 18 Oct: the complete stock report of Patia. A new car is on it; the reserved car and the car in transit are not.
    w.at("2026-10-18 10:00");
    const snap = await loadStock(w, s, [car("VIN0000000000009")]);
    expect(snap.status).toBe(200);
    expect(snap.body.summary.left_stock).toEqual({ delivered: 0, removed: 1, on_hold: 1 });
    // The free car has left stock. Cuttack was not in the file, so its car is untouched.
    expect(carByVin(w, "VIN0000000000002")).toMatchObject({ status: "REMOVED", left_stock_on: "2026-10-18" });
    expect(carByVin(w, "VIN0000000000003").status).toBe("RECEIVED");
    // The reserved car has left stock too, and its booking is not invoiced: nobody knows yet what became of the car, so the
    // booking is held (not quietly given the new car) and management is told.
    expect(carByVin(w, "VIN0000000000001")).toMatchObject({ status: "REMOVED", left_stock_on: "2026-10-18" });
    expect((await booking(w, d, late.id)).booking).toMatchObject({ status: "APPROVED", on_hold: 1, hold_reason: "CAR_LEFT_STOCK" });
    expect((await booking(w, d, late.id)).allocation).toBeNull();
    expect(snap.body.allocations).toBe(0);
    expect(w.db.q(`SELECT target_role FROM alerts WHERE kind = 'CAR_LEFT_STOCK' AND is_alarm = 1 ORDER BY target_role`).map((a: any) => a.target_role)).toEqual(["CEO_VP", "DEALER_PRINCIPAL"]);
    // On WhatsApp the Business Head has had two alarms by now: yesterday's reconciliation with its high-severity finding
    // (the stale files), and this car. (This dealership has no Dealer Principal user to send them to.)
    expect(w.db.q<any>(`SELECT to_name, json_extract(params_json, '$.title') AS title FROM wa_messages WHERE event_key = 'MANAGEMENT_ALARM' ORDER BY created_at, rowid`)).toEqual([
      { to_name: "Bikram Head", title: "Day-end reconciliation found high-severity differences" },
      { to_name: "Bikram Head", title: "A reserved car has left stock" },
    ]);
    r = await recon(w, d);
    const missing = r.items.find((i) => i.category === "CAR_LEFT_STOCK");
    expect(missing).toMatchObject({ severity: "HIGH", outlet: "Patia", entity_id: late.id });
    // The stock report is fresh now; the booking sheet is still the one of the 13th, and the finding says exactly that.
    expect(r.items.find((i) => i.category === "STALE_DATA").message).toMatch(/^The booking sheet is as on 13 Oct 2026 \(5 day\(s\) old\)\. The files are expected/);
    await loadBookings(w, s, QUIET_SHEET);
    r = await recon(w, d);
    expect(r.items.some((i) => i.category === "STALE_DATA")).toBe(false);
    expect(r.items.some((i) => i.category === "CAR_LEFT_STOCK")).toBe(true); // stays until someone settles the booking
  });

  it("flags free cars and waiting bookings that were left unmatched, and the sweep then matches them", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    const b1 = await approvedBooking(w, d, "se1", CRETA, "PATIA", "Waiting", "9876511111");
    // A car is inserted without going through allocation (for example a failed request midway).
    w.db.raw.exec(`INSERT INTO vehicles (id, tenant_id, outlet_id, vin, model, variant, colour, status, source, created_at, updated_at) VALUES ('veh_manual', '${d.tenantId}', '${d.outlets.PATIA}', 'VIN0000000000077', 'CRETA', '${V}', 'ABYSS BLACK', 'RECEIVED', 'MANUAL', '2026-10-13T04:30:00.000Z', '2026-10-13T04:30:00.000Z')`);
    const r = await recon(w, d);
    expect(r.items.find((i) => i.category === "UNMATCHED_STOCK").message).toContain("1 free car(s) and 1 waiting booking(s)");
    await w.tick(); // the 15-minute sweep
    expect((await booking(w, d, b1.id)).allocation.vin).toBe("VIN0000000000077");
    expect((await recon(w, d)).items.some((i) => i.category === "UNMATCHED_STOCK")).toBe(false);
  });

  it("the database itself refuses a second active allocation for a car or a booking", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    const car = await addCar(w, d, "VIN0000000000001", CRETA, "PATIA", "RECEIVED");
    const b1 = await approvedBooking(w, d, "se1", CRETA, "PATIA", "Holder", "9876511111");
    const b2 = await approvedBooking(w, d, "se1", CRETA, "PATIA", "Other", "9876511112");
    const car2 = (await addCar(w, d, "VIN0000000000002", VENUE, "PATIA", "RECEIVED")).id; // free, different model
    const insert = (booking: string, vehicle: string) => () => w.db.raw.exec(`INSERT INTO allocations (id, tenant_id, booking_id, vehicle_id, type, status, allocated_at, allocated_by) VALUES ('alc_${Math.random()}', '${d.tenantId}', '${booking}', '${vehicle}', 'FREE_STOCK', 'ACTIVE', '2026-10-13T05:00:00.000Z', 'SYSTEM')`);
    expect(insert(b2.id, car.id)).toThrow(/UNIQUE/);
    expect(insert(b1.id, car2)).toThrow(/UNIQUE/);
  });
});
