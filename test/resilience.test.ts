// What happens when things go wrong: a request cut off half way, two people acting at the same moment,
// a stale approval, someone using an upload to get round the rules, and heavy days. These came out of an
// independent review of the code; each test is the scenario that review used to show a defect.

import { describe, expect, it } from "vitest";
import { addCar, approvedBooking, booking, bookingFile, CARS, CRETA, failNextBatch, loadBookings, loadStock, makeDealer, makeWorld, meter, overlap, PASSWORD, stockFile, submittedBooking, VENUE, type BookingLine, type CarKey, type Dealer, type Session, type StockLine, type World } from "./harness";

const V = CRETA.variant;
const THAR = CARS.THAR_WHITE.is;
/** A line of the DMS stock report / booking sheet for a white Thar at Patia, unless said otherwise. */
const car = (vin: string, extra: Partial<StockLine> = {}): StockLine => ({ vin, car: "THAR_WHITE", loc: "PATIA", ...extra });
const order = (no: string, created: string, extra: Partial<BookingLine> = {}): BookingLine => ({ no, car: "THAR_WHITE", loc: "PATIA", created, ...extra });
/** The booking sheet of a day on which nothing changed in it: one booking delivered last month. */
const QUIET_SHEET: BookingLine[] = [order("OTF27A000900", "02-Sep-2026 11:00 AM", { car: "SCORPIO_N", stage: "Invoiced", enquiryStage: "Delivered" })];
const one = <T = any>(w: World, sql: string, ...p: unknown[]) => w.db.q<T>(sql, ...p)[0];
const allocatedVin = (w: World, no: string) => one(w, `SELECT v.vin FROM allocations a JOIN vehicles v ON v.id = a.vehicle_id JOIN bookings b ON b.id = a.booking_id WHERE b.booking_no = ? AND a.status = 'ACTIVE'`, no)?.vin ?? null;
const integrity = (w: World) => ({
  allocatedWithoutCar: w.db.q(`SELECT id FROM bookings b WHERE status = 'ALLOCATED' AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.booking_id = b.id AND a.status = 'ACTIVE')`).length,
  carHeldByClosedBooking: w.db.q(`SELECT a.id FROM allocations a JOIN bookings b ON b.id = a.booking_id WHERE a.status = 'ACTIVE' AND b.status NOT IN ('ALLOCATED','INVOICED')`).length,
  // An allocation the system made has its own record; one read from the DMS is recorded against its booking by the load that read it.
  allocationsWithoutRecord: w.db.q(`SELECT a.id FROM allocations a WHERE NOT EXISTS (SELECT 1 FROM audit_log l WHERE l.action = 'ALLOCATED' AND ((a.source <> 'DMS' AND l.detail_json LIKE '%' || a.id || '%') OR (a.source = 'DMS' AND l.entity_id = a.booking_id AND l.detail_json LIKE '%' || a.vehicle_id || '%')))`).length,
  // Every customer the system gave a car to was told. (An allotment made in the DMS is the DMS's news, not ours.)
  allocationsWithoutMessage: w.db.q(`SELECT a.id FROM allocations a WHERE a.source <> 'DMS' AND NOT EXISTS (SELECT 1 FROM wa_messages m WHERE m.booking_id = a.booking_id AND m.event_key LIKE 'ALLOC_%')`).length,
});
const CLEAN = { allocatedWithoutCar: 0, carHeldByClosedBooking: 0, allocationsWithoutRecord: 0, allocationsWithoutMessage: 0 };
/** A stock in-charge who works at Patia only. */
async function patiaOnly(w: World, d: Dealer): Promise<Session> {
  const id = (await w.api("POST", "/api/users", { name: "Patia Stock", mobile: "9000000060", email: "9000000060@test.example", role: "EDP_MANAGER", password: PASSWORD, all_outlets: false, outlet_ids: [d.outlets.PATIA] }, d.users.admin.session)).body.id;
  w.db.raw.exec(`UPDATE users SET must_change_password = 0 WHERE id = '${id}'`);
  return w.login(d.slug, "9000000060", PASSWORD);
}

describe("uploads cannot be used to get round outlet access or approval", () => {
  it("a user limited to one outlet cannot change another outlet's bookings or cars through a file", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    await loadStock(w, d.users.stock.session, [car("VINCUTTACK0000001", { loc: "CUTTACK" })]);
    const victim = await approvedBooking(w, d, "se3", THAR, "CUTTACK", "Cuttack Customer", "9811100001");
    const no = victim.booking_no;
    expect(allocatedVin(w, no)).toBe("VINCUTTACK0000001");
    const s = await patiaOnly(w, d);

    // Booking sheet: cancel the Cuttack booking, change its mobile, and add an old-dated Cuttack booking.
    const cancel = order(no, "13-Oct-2026 10:00 AM", { loc: "CUTTACK", stage: "Cancellation Initiated", customer: "CUTTACK CUSTOMER", mobile: "9999999999" });
    const bookings = await loadBookings(w, s, [cancel, order("OTF20A000001", "01-Jan-2020 10:00 AM", { loc: "CUTTACK", customer: "QUEUE JUMPER", mobile: "9811100002" })]);
    expect(bookings.body).toMatchObject({ created: 0, updated: 0 });
    expect(bookings.body.errors.map((e: any) => e.message)).toEqual(["Outlet CUTTACK is not one of your outlets", "Outlet CUTTACK is not one of your outlets"]);
    // The same cancellation with the booking passed off as one of Patia's.
    const disguised = await loadBookings(w, s, [{ ...cancel, loc: "PATIA" }]);
    expect(disguised.body).toMatchObject({ created: 0, updated: 0 });
    expect(disguised.body.errors.map((e: any) => e.message)).toEqual(["This booking belongs to an outlet that is not one of yours"]);
    // Stock report: invoice the Cuttack car to somebody else, add a Cuttack car, and pull the Cuttack car into Patia.
    const stock = await loadStock(w, s, [car("VINCUTTACK0000001", { loc: "CUTTACK", order: "OTF27A000666", invoiceId: "INV-666" }), car("VINCUTTACK0000002", { loc: "CUTTACK" })]);
    expect(stock.body).toMatchObject({ created: 0, updated: 0 });
    expect(stock.body.errors.map((e: any) => e.message)).toEqual(["Outlet CUTTACK is not one of your outlets", "Outlet CUTTACK is not one of your outlets"]);
    const pull = await loadStock(w, s, [car("VINCUTTACK0000001")]);
    expect(pull.body).toMatchObject({ created: 0, updated: 0 });
    expect(pull.body.errors[0].message).toBe("This car is held at an outlet that is not one of yours");
    // Their own outlet's complete report is theirs to load, and does not make Cuttack's car "missing from stock".
    const own = await loadStock(w, s, [car("VINPATIA000000001")]);
    expect(own.body).toMatchObject({ created: 1, errors: [] });
    expect(own.body.summary.left_stock).toEqual({ delivered: 0, removed: 0, on_hold: 0 });

    expect((await booking(w, d, victim.id)).booking).toMatchObject({ status: "ALLOCATED", customer_mobile: "919811100001", outlet_id: d.outlets.CUTTACK });
    expect(allocatedVin(w, no)).toBe("VINCUTTACK0000001");
    expect(one(w, `SELECT status, outlet_id, dms_booking_no FROM vehicles WHERE vin = 'VINCUTTACK0000001'`)).toEqual({ status: "RECEIVED", outlet_id: d.outlets.CUTTACK, dms_booking_no: null });
    expect(w.db.q(`SELECT vin FROM vehicles ORDER BY vin`).map((v: any) => v.vin)).toEqual(["VINCUTTACK0000001", "VINPATIA000000001"]);
    expect(w.db.q(`SELECT booking_no FROM bookings`).map((b: any) => b.booking_no)).toEqual([no]);
  });

  // BACKEND? importStockReport checks the outlet of each car (the row's, and the one the system holds it at) but not
  // the outlet of the booking the row's Order ID names. So a user limited to Patia can load a "stock report" in which
  // a Patia car is allotted, or invoiced, to a Cuttack booking, and the system follows it: the Cuttack booking that
  // was waiting is given the Patia car past its queue, and the Cuttack booking that held a Cuttack car loses it
  // (release reason ALLOTTED_ANOTHER_CAR_IN_DMS) and is marked invoiced. No alarm of any kind is raised for either.
  // Expected: a row whose Order ID is a booking of an outlet the uploader has no access to is reported and not applied
  // (as the booking sheet does: "This booking belongs to an outlet that is not one of yours"). Remove `.fails` when fixed.
  it("a user limited to one outlet cannot change another outlet's bookings by naming them as the Order ID of their own cars", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    await loadStock(w, d.users.stock.session, [car("VINCUTTACK0000001", { loc: "CUTTACK" })]);
    const holder = await approvedBooking(w, d, "se3", THAR, "CUTTACK", "Cuttack Holder", "9811100001");
    w.at("2026-10-13 11:00");
    const waiting = await approvedBooking(w, d, "se3", THAR, "CUTTACK", "Cuttack Waiting", "9811100002");
    const s = await patiaOnly(w, d);
    const res = await loadStock(w, s, [
      car("VINPATIA000000001", { order: waiting.booking_no }),
      car("VINPATIA000000002", { order: holder.booking_no, invoiceId: "INV-0001" }),
    ]);
    expect((await booking(w, d, holder.id)).booking.status).toBe("ALLOCATED");
    expect(allocatedVin(w, holder.booking_no)).toBe("VINCUTTACK0000001");
    // The Patia car came in free, so the queue (own outlet first, then any) gave it to the Cuttack customer who was waiting: the system's own allocation, not the DMS's.
    expect((await booking(w, d, waiting.id)).booking.status).toBe("ALLOCATED");
    expect(one(w, `SELECT source, out_of_turn FROM allocations WHERE booking_id = ? AND status = 'ACTIVE'`, waiting.id)).toEqual({ source: "SYSTEM", out_of_turn: 0 });
    expect(res.body.errors).toHaveLength(2);
    expect(res.body.errors.map((e: any) => e.message)).toEqual([
      `This car is shown allotted to booking ${waiting.booking_no}, which belongs to an outlet that is not one of yours. The allotment was not applied.`,
      `This car is shown allotted to booking ${holder.booking_no}, which belongs to an outlet that is not one of yours. The allotment was not applied.`,
    ]);
  });

  // BACKEND? An upload is recorded as the dealership's latest stock report / booking sheet even when not one row of it
  // was applied (here: every row is for an outlet the uploader has no access to). GET /api/data-status then says the
  // data is as on today, the "DMS files out of date" guard is lifted, and the scheduled job takes back a car it was
  // holding for exactly that reason. The real report of the day before is afterwards refused as OLDER_REPORT. More
  // generally the "as on" date is kept per dealership, so a file for one outlet (or a PARTIAL file) vouches for all.
  // Expected: a file from which nothing was loaded does not move the "as on" date. Remove `.fails` when fixed.
  it("a file from which nothing was loaded does not make the dealership's DMS data count as fresh", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    await loadStock(w, d.users.stock.session, [car("VINCUTTACK0000001", { loc: "CUTTACK" })]);
    await loadBookings(w, d.users.stock.session, [order("OTF27A000001", "01-Oct-2026 10:00 AM", { loc: "CUTTACK" })]);
    expect(allocatedVin(w, "OTF27A000001")).toBe("VINCUTTACK0000001");
    const s = await patiaOnly(w, d);
    // Day 6 of the payment window, and no file since the 13th: the car is held, not taken back.
    w.at("2026-10-19 10:00");
    expect((await w.tick())[0]).toMatchObject({ released: 0, held: 1 });
    const stock = await loadStock(w, s, [car("VINCUTTACK0000001", { loc: "CUTTACK" })]);
    const sheet = await loadBookings(w, s, [order("OTF27A000001", "01-Oct-2026 10:00 AM", { loc: "CUTTACK" })]);
    expect([stock.body.errors.length, sheet.body.errors.length, stock.body.unchanged, sheet.body.unchanged]).toEqual([1, 1, 0, 0]); // nothing was loaded
    expect((await w.api("GET", "/api/data-status", undefined, d.users.head.session)).body).toMatchObject({ stale: true, stock: { report_date: "2026-10-13" }, bookings: { report_date: "2026-10-13" } });
    w.at("2026-10-19 10:15");
    expect((await w.tick())[0]).toMatchObject({ released: 0, held: 1 });
    expect(allocatedVin(w, "OTF27A000001")).toBe("VINCUTTACK0000001");
  });

  it("only the people who load the DMS files can load them, and whoever loads a booking cannot approve it", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    await w.api("PUT", "/api/settings", { import_bookings_as_approved: false, booking_approver_roles: ["SALES_LEAD", "CEO_VP", "ADMIN"] }, d.users.admin.session);
    const sheet = bookingFile([order("OTF27A000001", "12-Oct-2026 10:00 AM", { customer: "LOADED CUSTOMER", mobile: "9811100001" })]);
    const report = stockFile([car("VINLOAD0000000001")]);
    // Not the sales team, whose bookings they are; not the GM, the AGM, Finance or the auditor either.
    for (const who of ["sm", "se1", "gm", "agm", "accounts", "auditor"]) {
      expect((await w.send("/api/uploads/bookings?filename=sheet.csv", sheet, d.users[who].session)).status, who).toBe(403);
      expect((await w.send("/api/uploads/stock?filename=stock.csv", report, d.users[who].session)).status, who).toBe(403);
    }
    expect(w.db.q(`SELECT id FROM uploads`)).toHaveLength(0);
    expect((await w.send("/api/uploads/bookings?filename=sheet.csv", sheet, d.users.admin.session)).body.created).toBe(1);
    const id = one(w, `SELECT id FROM bookings WHERE booking_no = 'OTF27A000001'`).id;
    expect(one(w, `SELECT status FROM bookings WHERE id = ?`, id).status).toBe("SUBMITTED");
    const own = await w.api("POST", `/api/bookings/${id}/approve`, {}, d.users.admin.session);
    expect(own.status).toBe(403);
    expect(own.body.error.message).toBe("The person who loaded a booking cannot approve it");
    expect((await w.api("POST", `/api/bookings/${id}/approve`, {}, d.users.sm.session)).status).toBe(200);
  });

  it("naming a booking in the stock report passes without comment only at go-live; afterwards it is recorded as out of turn and raised for review", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    const s = d.users.stock.session;
    await loadBookings(w, s, [order("OTF27A000001", "01-Oct-2026 10:00 AM", { customer: "SENIOR" }), order("OTF27A000002", "02-Oct-2026 10:00 AM", { customer: "JUNIOR" })]);
    await loadStock(w, s, [car("VINLIVE0000000001", { car: "SCORPIO_N" })]); // go-live: the dealership's first stock report
    w.at("2026-10-14 10:00");
    // A new car, and the report says it is allotted to the junior booking. The DMS is the dealership's book of record,
    // so the car is the junior's. What the system will not do is let it pass as if the queue had been followed.
    const res = await loadStock(w, s, [car("VINLIVE0000000001", { car: "SCORPIO_N" }), car("VINNEW00000000001", { order: "OTF27A000002", customer: "JUNIOR" })]);
    expect(res.body).toMatchObject({ created: 1, errors: [] });
    expect(res.body.summary.orders).toMatchObject({ total: 1, recorded: 1, out_of_turn: 1, bypassed: 0 });
    expect(allocatedVin(w, "OTF27A000002")).toBe("VINNEW00000000001");
    const senior = one(w, `SELECT id, status, on_hold, priority_ts, booking_date FROM bookings WHERE booking_no = 'OTF27A000001'`);
    expect(senior).toMatchObject({ status: "APPROVED", on_hold: 0, priority_ts: senior.booking_date }); // still first in line for the next car
    expect((await booking(w, d, senior.id)).queue).toEqual({ position: 1, waiting: 1 });
    const alloc = one(w, `SELECT id, source, allocated_by, out_of_turn, bypassed_booking_id, bypassed_count, exception_id FROM allocations WHERE status = 'ACTIVE'`);
    expect(alloc).toMatchObject({ source: "DMS", allocated_by: "DMS", out_of_turn: 1, bypassed_booking_id: senior.id, bypassed_count: 1, exception_id: null });
    // The junior customer is not sent a message as if the system had allocated the car.
    expect(w.db.q(`SELECT id FROM wa_messages WHERE event_key LIKE 'ALLOC_%'`)).toHaveLength(0);
    // Management is told at once, and it stays on the day-end list and the owner's list until one of them has looked at it.
    expect(w.db.q(`SELECT target_role FROM alerts WHERE kind = 'OUT_OF_TURN' AND is_alarm = 1 ORDER BY target_role`).map((a: any) => a.target_role)).toEqual(["CEO_VP", "DEALER_PRINCIPAL"]);
    expect(one(w, `SELECT body FROM alerts WHERE kind = 'OUT_OF_TURN' LIMIT 1`).body).toContain("OTF27A000002 (ahead of OTF27A000001)");
    expect(w.db.q(`SELECT to_name FROM wa_messages WHERE event_key = 'MANAGEMENT_ALARM'`)).toEqual([{ to_name: "Bikram Head" }]);
    const run = await w.api("POST", "/api/recon/run", {}, d.users.head.session);
    expect(run.body.summary.items.by_category.OUT_OF_TURN).toBe(1);
    const row = (await w.api("GET", "/api/dashboards/out-of-turn", undefined, d.users.head.session)).body[0];
    expect(row).toMatchObject({ allocation_id: alloc.id, given_to: "OTF27A000002", bypassed: "OTF27A000001", state: "UNDER_REVIEW" });
    // The person who loaded the file cannot close the question; the Business Head can, with what was found.
    expect((await w.api("POST", `/api/out-of-turn/${alloc.id}/review`, { note: "fine" }, s)).status).toBe(403);
    expect((await w.api("POST", `/api/out-of-turn/${alloc.id}/review`, { note: "Corporate order, agreed with the Dealer Principal on 12 Oct" }, d.users.head.session)).status).toBe(200);
    expect((await w.api("POST", "/api/recon/run", {}, d.users.head.session)).body.summary.items.by_category.OUT_OF_TURN).toBeUndefined();
    // The same report again raises nothing a second time.
    await loadStock(w, s, [car("VINLIVE0000000001", { car: "SCORPIO_N" }), car("VINNEW00000000001", { order: "OTF27A000002", customer: "JUNIOR" })]);
    expect(w.db.q(`SELECT id FROM alerts WHERE kind = 'OUT_OF_TURN'`)).toHaveLength(2);
  });

  it("a go-live report with over a hundred commitments is taken whole in one request, exactly as named", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    const n = 104;
    await loadBookings(w, d.users.admin.session, Array.from({ length: n }, (_, i) => order(`OTF27A${String(i).padStart(6, "0")}`, `0${(i % 9) + 1}-Oct-2026 10:00 AM`, { customer: `CUST ${i}`, mobile: `98111${String(i).padStart(5, "0")}` })));
    // Every car is already promised, and not in booking order.
    const rows = Array.from({ length: n }, (_, i) => car(`VINLIVE${String(i).padStart(10, "0")}`, { order: `OTF27A${String(n - 1 - i).padStart(6, "0")}` }));
    const { m, restore } = meter(w);
    m.limit = 1000;
    let res;
    try {
      res = await w.send("/api/uploads/stock?filename=stock.csv&report_date=2026-10-13", stockFile(rows), d.users.admin.session);
    } finally {
      restore();
    }
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: n, more: false, errors: [] }); // one request, not a file to be split by hand
    expect(m.calls).toBeLessThan(60); // measured: 34. The commitments are written in bulk, not one by one.
    expect(res.body.summary.orders).toMatchObject({ total: n, recorded: n, in_booking_data: n, out_of_turn: 0 });
    const wrong = w.db.q(`SELECT b.booking_no, v.vin FROM allocations a JOIN bookings b ON b.id = a.booking_id JOIN vehicles v ON v.id = a.vehicle_id WHERE a.status = 'ACTIVE'`).filter((r: any) => Number(r.vin.slice(7)) !== n - 1 - Number(r.booking_no.slice(6)));
    expect(wrong).toEqual([]);
    expect(w.db.q(`SELECT id FROM allocations WHERE status = 'ACTIVE'`)).toHaveLength(n);
    expect(w.db.q(`SELECT id FROM bookings WHERE status = 'ALLOCATED'`)).toHaveLength(n);
    // No customer is messaged about a commitment they already had.
    expect(w.db.q(`SELECT id FROM wa_messages`)).toHaveLength(0);
    expect(integrity(w)).toEqual(CLEAN);
  });

  it("a load that needs more steps than one request may take stops cleanly and is finished by sending the same file again", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    const s = d.users.stock.session;
    const n = 104;
    const vins = Array.from({ length: n }, (_, i) => `VINSTEP${String(i).padStart(10, "0")}`);
    await loadBookings(w, s, vins.map((_, i) => order(`OTF27A${String(i).padStart(6, "0")}`, `2026-10-0${(i % 9) + 1}T10:${String(i % 60).padStart(2, "0")}:00+05:30`)));
    await loadStock(w, s, vins.map((vin) => car(vin, { status: "In Transit" })));
    for (let i = 0; i < 2; i++) await w.api("POST", "/api/allocations/run", {}, d.users.head.session);
    expect(w.db.q(`SELECT id FROM allocations WHERE status = 'ACTIVE' AND clock_started_at IS NULL`)).toHaveLength(n);
    // The whole carrier convoy arrives: each arrival tells a customer and starts a payment window, which is a step of its own.
    w.at("2026-10-14 18:00");
    const evening = stockFile(vins.map((vin) => car(vin, { grnDate: "2026-10-14" })));
    const told = () => one(w, `SELECT COUNT(*) AS n, COUNT(DISTINCT booking_id) AS customers FROM wa_messages WHERE event_key = 'STOCK_RECEIVED'`);
    const first = await w.send("/api/uploads/stock?filename=stock.csv&report_date=2026-10-14", evening, s);
    expect(first.body).toMatchObject({ more: true, errors: [] });
    // Stopped part way, nothing is half done: a car is either received, with its customer told and the window running, or untouched.
    expect(told()).toEqual({ n: 50, customers: 50 });
    expect(one(w, `SELECT COUNT(*) AS n FROM vehicles v JOIN allocations a ON a.vehicle_id = v.id AND a.status = 'ACTIVE' WHERE (v.status = 'RECEIVED') <> (a.clock_started_at IS NOT NULL)`).n).toBe(0);
    expect(one(w, `SELECT COUNT(*) AS n FROM vehicles WHERE status = 'RECEIVED'`).n).toBe(50);
    expect(one(w, `SELECT status FROM uploads WHERE id = ?`, first.body.upload_id).status).toBe("RUNNING");
    let res = first, rounds = 1;
    while (res.body.more) {
      res = await w.send(`/api/uploads/stock?filename=stock.csv&report_date=2026-10-14&continue=${first.body.upload_id}`, evening, s);
      expect(res.status).toBe(200);
      if (++rounds > 5) throw new Error("the load did not finish");
    }
    expect(rounds).toBe(3); // 50 + 50 + 4
    expect(res.body).toMatchObject({ upload_id: first.body.upload_id, more: false, errors: [] });
    expect(res.body.summary.received).toBe(n);
    expect(told()).toEqual({ n, customers: n }); // each customer told exactly once
    expect(one(w, `SELECT COUNT(*) AS n FROM vehicles WHERE status = 'RECEIVED'`).n).toBe(n);
    expect(one(w, `SELECT COUNT(*) AS n FROM allocations WHERE status = 'ACTIVE' AND clock_started_at IS NOT NULL`).n).toBe(n);
    expect(w.db.q(`SELECT status, row_count FROM uploads WHERE kind = 'STOCK' ORDER BY at`)).toEqual([{ status: "DONE", row_count: n }, { status: "DONE", row_count: n }]); // the evening file is one load in the history, not three
    // And once more for good measure: nothing left to do, nobody told again.
    const again = await loadStock(w, s, vins.map((vin) => car(vin, { grnDate: "2026-10-14" })), { asOn: "2026-10-14" });
    expect(again.body).toMatchObject({ created: 0, updated: 0, unchanged: n, more: false });
    expect(told()).toEqual({ n, customers: n });
    expect(integrity(w)).toEqual(CLEAN);
  });
});

describe("approvals are checked again at the moment they are given", () => {
  it("a deferral approved after the booking was invoiced is refused and changes nothing", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    await addCar(w, d, "VINSTALE000000001", CRETA, "PATIA", "RECEIVED");
    const b = await approvedBooking(w, d, "se1", CRETA, "PATIA", "Cust", "9811100001");
    const ex = await w.api("POST", "/api/exceptions", { type: "DEFER_DELIVERY", booking_id: b.id, payload: { until: "2026-12-01" }, reason: "asked for December" }, d.users.agm.session);
    await w.api("POST", `/api/bookings/${b.id}/invoice`, undefined, d.users.accounts.session);
    const res = await w.api("POST", `/api/exceptions/${ex.body.id}/approve`, {}, d.users.head.session);
    expect(res.status).toBe(409);
    expect(one(w, `SELECT status FROM exceptions WHERE id = ?`, ex.body.id).status).toBe("PENDING");
    expect(one(w, `SELECT status FROM allocations WHERE booking_id = ?`, b.id).status).toBe("ACTIVE");
    expect((await w.api("POST", `/api/bookings/${b.id}/deliver`, undefined, d.users.accounts.session)).body.status).toBe("DELIVERED");
    expect(one(w, `SELECT status FROM vehicles WHERE vin = 'VINSTALE000000001'`).status).toBe("DELIVERED");
    // The approver can still close the request by rejecting it.
    expect((await w.api("POST", `/api/exceptions/${ex.body.id}/reject`, { remarks: "Already delivered" }, d.users.head.session)).status).toBe(200);
  });

  // Allocation by hand is closed: pairing a free car with a booking of someone's choosing is what the
  // queue is for. What can still be asked for is taking a car off the customer holding it, which names
  // a loser as well as a winner and so goes through approval.
  it("nobody can ask for a car to be allocated by hand any more", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    const b = await approvedBooking(w, d, "se1", CRETA, "PATIA", "Cust", "9811100001");
    const wanted = await addCar(w, d, "VINMANUAL00000002", CRETA, "PATIA", "RECEIVED");
    const res = await w.api("POST", "/api/exceptions", { type: "MANUAL_ALLOCATION", booking_id: b.id, vehicle_id: wanted.id, reason: "Customer wants the car in the yard" }, d.users.agm.session);
    expect(res.status).toBe(400);
  });

  it("a car promised to another booking stays where it is while the request cannot be applied", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    const held = await addCar(w, d, "VINMANUAL00000001", CRETA, "PATIA", "RECEIVED");
    const first = await approvedBooking(w, d, "se1", CRETA, "PATIA", "First", "9811100001");
    const second = await approvedBooking(w, d, "se1", CRETA, "PATIA", "Second", "9811100002");
    expect((await booking(w, d, first.id)).allocation.vin).toBe("VINMANUAL00000001");
    const ex = await w.api("POST", "/api/exceptions", { type: "RELEASE_ALLOCATION", booking_id: first.id, payload: { release_reason: "REALLOCATED_TO_BOOKING", to_booking_id: second.id }, reason: "Second customer is paying cash today" }, d.users.agm.session);
    expect(ex.status).toBe(201);
    // Before the approver gets to it, the second booking is given a car of its own by the queue.
    const other = await addCar(w, d, "VINMANUAL00000003", CRETA, "PATIA", "RECEIVED");
    expect((await booking(w, d, second.id)).allocation.vin).toBe("VINMANUAL00000003");
    expect((await w.api("POST", `/api/exceptions/${ex.body.id}/approve`, {}, d.users.head.session)).status).toBe(409);
    expect((await booking(w, d, first.id)).allocation.vin).toBe("VINMANUAL00000001");
    expect(one(w, `SELECT status FROM exceptions WHERE id = ?`, ex.body.id).status).toBe("PENDING");

    // That car is damaged, so the second booking is waiting again and the request can go through:
    // the first customer's car is released and allocated to the second in one step.
    await w.api("POST", `/api/vehicles/${other.id}/block`, { reason: "Hail damage" }, d.users.stock.session);
    expect((await w.api("POST", `/api/exceptions/${ex.body.id}/approve`, {}, d.users.head.session)).status).toBe(200);
    expect((await booking(w, d, second.id)).allocation).toMatchObject({ vin: "VINMANUAL00000001", exception_id: ex.body.id, allocated_by: d.users.head.id });
    const released = one(w, `SELECT release_reason, release_request_id, released_to_booking_id FROM allocations WHERE booking_id = ? AND vehicle_id = ? AND status = 'RELEASED'`, first.id, held.id);
    expect(released).toMatchObject({ release_reason: "REALLOCATED_TO_BOOKING", release_request_id: ex.body.id, released_to_booking_id: second.id });
    // The customer who lost the car keeps their place in the queue rather than going to the back.
    expect(one(w, `SELECT status, on_hold FROM bookings WHERE id = ?`, first.id)).toMatchObject({ status: "APPROVED", on_hold: 0 });
    expect(integrity(w)).toEqual(CLEAN);
  });

  it("an extension granted after the reminder went out does not remind the customer a second time", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    await addCar(w, d, "VINEXT00000000001", CRETA, "PATIA", "RECEIVED");
    const b = await approvedBooking(w, d, "se1", CRETA, "PATIA", "Cust", "9811100001");
    w.at("2026-10-17 10:00"); // day 4: reminded on day 3 would be the 16th
    await w.tick();
    const reminders = () => w.db.q(`SELECT id FROM wa_messages WHERE event_key = 'PAYMENT_REMINDER'`).length;
    expect(reminders()).toBe(1);
    const ex = await w.api("POST", "/api/exceptions", { type: "WINDOW_EXTENSION", booking_id: b.id, payload: { days: 1 }, reason: "one more day" }, d.users.agm.session);
    await w.api("POST", `/api/exceptions/${ex.body.id}/approve`, {}, d.users.head.session);
    await w.tick();
    expect(reminders()).toBe(1); // the new reminder date (the 17th) has already come; the customer was reminded
    expect((await booking(w, d, b.id)).allocation.window).toMatchObject({ escalation_on: "2026-10-19", release_on: "2026-10-20", stage: "REMINDED" });
  });
});

describe("a request cut off half way leaves nothing half done", () => {
  it("an approval whose database write fails takes effect once, when it is tried again", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    await addCar(w, d, "VINTWICE000000001", CRETA, "PATIA", "RECEIVED");
    const b = await approvedBooking(w, d, "se1", CRETA, "PATIA", "Cust", "9811100001");
    const ex = await w.api("POST", "/api/exceptions", { type: "WINDOW_EXTENSION", booking_id: b.id, payload: { days: 3 }, reason: "loan" }, d.users.agm.session);
    const f = failNextBatch(w, /UPDATE exceptions SET status/);
    expect((await w.api("POST", `/api/exceptions/${ex.body.id}/approve`, {}, d.users.head.session)).status).toBe(500);
    f.restore();
    expect(one(w, `SELECT window_extension_days AS n FROM allocations WHERE booking_id = ?`, b.id).n).toBe(0); // nothing applied
    expect((await w.api("POST", `/api/exceptions/${ex.body.id}/approve`, {}, d.users.head.session)).status).toBe(200);
    expect((await w.api("POST", `/api/exceptions/${ex.body.id}/approve`, {}, d.users.head.session)).status).toBe(409);
    expect(one(w, `SELECT window_extension_days AS n FROM allocations WHERE booking_id = ?`, b.id).n).toBe(3);
  });

  it("a cancellation either frees the car and cancels the booking, or does neither", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    await addCar(w, d, "VINCANCEL00000001", CRETA, "PATIA", "RECEIVED");
    const b = await approvedBooking(w, d, "se1", CRETA, "PATIA", "Cust", "9811100001");
    const next = await approvedBooking(w, d, "se2", CRETA, "PATIA", "Next", "9811100002");
    const f = failNextBatch(w, /SET status = 'RELEASED'/);
    expect((await w.api("POST", `/api/bookings/${b.id}/cancel`, { reason: "customer withdrew" }, d.users.sm.session)).status).toBe(500);
    f.restore();
    expect((await booking(w, d, b.id)).booking.status).toBe("ALLOCATED"); // untouched, so the user can simply try again
    expect((await w.api("POST", `/api/bookings/${b.id}/cancel`, { reason: "customer withdrew" }, d.users.sm.session)).status).toBe(200);
    expect((await booking(w, d, b.id)).booking.status).toBe("CANCELLED");
    expect((await booking(w, d, next.id)).allocation.vin).toBe("VINCANCEL00000001");
    expect(integrity(w)).toEqual(CLEAN);
  });

  it("the same holds when the cancellation comes in the booking sheet: the load names the row, and the next load finishes it", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    const s = d.users.stock.session;
    await loadStock(w, s, [car("VINCANCEL00000002")]);
    const rows = [order("OTF27A000001", "01-Oct-2026 10:00 AM"), order("OTF27A000002", "02-Oct-2026 10:00 AM")];
    await loadBookings(w, s, rows);
    const sheet = [{ ...rows[0], stage: "Cancellation Initiated" as const }, rows[1]];
    const f = failNextBatch(w, /SET status = 'RELEASED'/);
    const cut = await loadBookings(w, s, sheet);
    f.restore();
    expect(f.state.fired).toBe(true);
    expect(cut.status).toBe(200); // one row that could not be finished does not lose the rest of the sheet
    expect(cut.body.errors).toMatchObject([{ row: 2, key: "OTF27A000001" }]);
    expect(cut.body.summary).toMatchObject({ cancelled_now: 0, cars_released: 0 });
    expect(one(w, `SELECT status FROM bookings WHERE booking_no = 'OTF27A000001'`).status).toBe("ALLOCATED"); // untouched
    expect(allocatedVin(w, "OTF27A000001")).toBe("VINCANCEL00000002");
    const again = await loadBookings(w, s, sheet);
    expect(again.body).toMatchObject({ errors: [], allocations: 1 });
    expect(again.body.summary).toMatchObject({ cancelled_now: 1, cars_released: 1 });
    expect(one(w, `SELECT status FROM bookings WHERE booking_no = 'OTF27A000001'`).status).toBe("CANCELLED");
    expect(allocatedVin(w, "OTF27A000002")).toBe("VINCANCEL00000002");
    expect(w.db.q(`SELECT id FROM audit_log WHERE action = 'BOOKING_CANCELLED'`)).toHaveLength(1);
    expect(integrity(w)).toEqual(CLEAN);
  });

  it("a stock report cut off while it undoes a bypass leaves the reservation whole, and undoes it once when loaded again", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    const s = d.users.stock.session;
    await loadBookings(w, s, [order("OTF27A000001", "01-Oct-2026 10:00 AM"), order("OTF27A000002", "02-Oct-2026 10:00 AM")]);
    await loadStock(w, s, [car("VINBYPASS00000001")]);
    expect(allocatedVin(w, "OTF27A000001")).toBe("VINBYPASS00000001");
    // Next day the DMS shows the car invoiced to the second booking.
    w.at("2026-10-14 10:00");
    const report = [car("VINBYPASS00000001", { order: "OTF27A000002", invoiceId: "INV-0001", invoiceDate: "2026-10-13" })];
    const told = () => ({
      released: w.db.q(`SELECT id FROM audit_log WHERE action = 'ALLOCATION_RELEASED'`).length,
      bypass: w.db.q(`SELECT id FROM audit_log WHERE action = 'BYPASS_DETECTED'`).length,
      alarms: w.db.q(`SELECT id FROM alerts WHERE is_alarm = 1 AND kind = 'BYPASS'`).length,
      whatsapp: w.db.q(`SELECT id FROM wa_messages WHERE event_key = 'MANAGEMENT_ALARM'`).length,
    });
    const f = failNextBatch(w, /SET status = 'RELEASED'/);
    const cut = await loadStock(w, s, report);
    f.restore();
    expect(f.state.fired).toBe(true);
    expect(cut.status).toBe(200);
    expect(cut.body.errors).toMatchObject([{ row: 2, key: "VINBYPASS00000001" }]);
    expect(cut.body.summary.orders).toMatchObject({ bypassed: 0, recorded: 0 });
    // No part of it happened: the first customer still holds the car, the second is still waiting, nobody was alarmed.
    expect(allocatedVin(w, "OTF27A000001")).toBe("VINBYPASS00000001");
    expect(one(w, `SELECT status FROM bookings WHERE booking_no = 'OTF27A000002'`).status).toBe("APPROVED");
    expect(told()).toEqual({ released: 0, bypass: 0, alarms: 0, whatsapp: 0 });
    const again = await loadStock(w, s, report);
    expect(again.body.errors).toEqual([]);
    expect(again.body.summary.orders).toMatchObject({ bypassed: 1, recorded: 1 });
    expect(one(w, `SELECT status, on_hold FROM bookings WHERE booking_no = 'OTF27A000001'`)).toEqual({ status: "APPROVED", on_hold: 0 });
    expect(one(w, `SELECT status FROM bookings WHERE booking_no = 'OTF27A000002'`).status).toBe("INVOICED");
    expect(allocatedVin(w, "OTF27A000002")).toBe("VINBYPASS00000001");
    expect(told()).toEqual({ released: 1, bypass: 1, alarms: 2, whatsapp: 1 });
    await loadStock(w, s, report);
    expect(told()).toEqual({ released: 1, bypass: 1, alarms: 2, whatsapp: 1 });
    expect(integrity(w)).toEqual(CLEAN);
  });

  it("an allocation is never written without its record and its customer message", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    await addCar(w, d, "VINATOMIC00000001", CRETA, "PATIA", "RECEIVED");
    const b = await submittedBooking(w, d, "se1", CRETA, "PATIA", "Cust", "9811100001");
    const f = failNextBatch(w, /INSERT INTO allocations/);
    const res = await w.api("POST", `/api/bookings/${b.id}/approve`, {}, d.users.sm.session);
    f.restore();
    expect(res.status).toBe(500);
    // The approval itself was recorded; the allocation was not, in any part.
    expect(w.db.q(`SELECT id FROM allocations`)).toHaveLength(0);
    expect(w.db.q(`SELECT id FROM wa_messages`)).toHaveLength(0);
    expect((await booking(w, d, b.id)).booking.status).toBe("APPROVED");
    // The 15-minute sweep finishes the job.
    expect((await w.tick())[0].allocated).toBe(1);
    expect(integrity(w)).toEqual(CLEAN);
    expect(w.db.q(`SELECT id FROM wa_messages WHERE event_key = 'ALLOC_FREE_STOCK' AND status = 'SENT'`)).toHaveLength(1);
  });

  it("a message whose send was interrupted is sent on a later run, not lost", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    await addCar(w, d, "VINLEASE000000001", CRETA, "PATIA", "RECEIVED");
    await approvedBooking(w, d, "se1", CRETA, "PATIA", "Cust", "9811100001");
    // Put the message back as it would be if the Worker had stopped right after claiming it.
    w.db.raw.exec(`UPDATE wa_messages SET status = 'QUEUED', attempts = 1, sent_at = NULL, provider_message_id = NULL, next_attempt_at = '2026-10-13T04:35:00.000Z'`);
    w.at("2026-10-13 10:03");
    await w.tick();
    expect(one(w, `SELECT status FROM wa_messages`).status).toBe("QUEUED"); // still within the five-minute hold
    w.at("2026-10-13 10:06");
    await w.tick();
    expect(one(w, `SELECT status, attempts FROM wa_messages`)).toMatchObject({ status: "SENT", attempts: 2 });
  });

  /** The evening stock report shows a car received; an approval gives that car to a customer after the report has read it as free and before it is written. */
  async function arrivesWhileBeingAllocated() {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    const s = d.users.stock.session;
    await loadStock(w, s, [car("VINCLOCK000000001", { status: "In Transit" })]);
    await loadBookings(w, s, QUIET_SHEET);
    const b = await submittedBooking(w, d, "se1", THAR, "PATIA", "Cust", "9811100001");
    w.at("2026-10-13 18:00");
    const o = overlap(w, /UPDATE vehicles SET outlet_id = json_extract/, async () => {
      expect((await w.api("POST", `/api/bookings/${b.id}/approve`, {}, d.users.sm.session)).body.allocations).toHaveLength(1);
    });
    const res = await loadStock(w, s, [car("VINCLOCK000000001", { grnDate: "2026-10-13" })]);
    o.restore();
    expect(o.state.fired).toBe(true);
    expect(res.body).toMatchObject({ updated: 1, errors: [] });
    expect(one(w, `SELECT v.status FROM vehicles v JOIN allocations a ON a.vehicle_id = v.id AND a.status = 'ACTIVE' WHERE a.booking_id = ?`, b.id).status).toBe("RECEIVED");
    return { w, d, b };
  }

  it("a car that arrives at the very moment it is being allocated still gets its payment window", async () => {
    const { w, b } = await arrivesWhileBeingAllocated();
    // The report was written from what it had read, so the allocation made in between has no clock yet. The sweep,
    // a few minutes later, starts it: the window is never left open-ended.
    w.at("2026-10-13 18:15");
    expect((await w.tick())[0].repaired).toBe(1);
    expect(one(w, `SELECT clock_started_at FROM allocations WHERE booking_id = ?`, b.id).clock_started_at).toBe("2026-10-13T12:45:00.000Z");
    w.at("2026-10-16 10:00");
    expect((await w.tick())[0].reminders).toBe(1);
  });

  // BACKEND? In the same overlap the customer is never told the car has arrived. The stock report writes the car as
  // received in bulk (it read the car as free, so it does not take the "arrival of a reserved car" step that sends
  // STOCK_RECEIVED), the sweep's repair only starts the clock, and loading the report again finds the car already
  // received. The customer's first news of the arrival is the day-3 reminder ("it has been 3 days since your allocated
  // car reached ..."). Expected: whichever of the report, the sweep or the next load starts the window also sends the
  // arrival message and tells the sales executive. Remove `.fails` when fixed.
  it("a car that arrives at the very moment it is being allocated: the customer is still told it has arrived", async () => {
    const { w, d, b } = await arrivesWhileBeingAllocated();
    w.at("2026-10-13 18:15");
    await w.tick();
    await loadStock(w, d.users.stock.session, [car("VINCLOCK000000001", { grnDate: "2026-10-13" })]);
    expect(w.db.q(`SELECT event_key FROM wa_messages WHERE booking_id = ? AND audience = 'CUSTOMER' ORDER BY created_at, rowid`, b.id).map((m: any) => m.event_key)).toEqual(["ALLOC_IN_TRANSIT", "STOCK_RECEIVED"]);
  });

  it("the sweep starts a payment clock that was missed and frees a car held by a cancelled booking", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    await addCar(w, d, "VINREPAIR00000001", CRETA, "PATIA", "RECEIVED");
    await addCar(w, d, "VINREPAIR00000002", VENUE, "PATIA", "RECEIVED");
    const b1 = await approvedBooking(w, d, "se1", CRETA, "PATIA", "Clock", "9811100001");
    const b2 = await approvedBooking(w, d, "se1", VENUE, "PATIA", "Cancelled", "9811100002");
    const b3 = await approvedBooking(w, d, "se2", VENUE, "PATIA", "Next", "9811100003");
    // The two states an older version, or a failure in the wrong place, could leave behind.
    w.db.raw.exec(`UPDATE allocations SET clock_started_at = NULL WHERE booking_id = '${b1.id}'`);
    w.db.raw.exec(`UPDATE bookings SET status = 'CANCELLED' WHERE id = '${b2.id}'`);
    w.at("2026-10-13 10:15");
    expect((await w.tick())[0].repaired).toBe(2);
    expect((await booking(w, d, b1.id)).allocation.window.release_on).toBe("2026-10-19");
    expect((await booking(w, d, b3.id)).allocation.vin).toBe("VINREPAIR00000002");
    expect(integrity(w)).toEqual(CLEAN);
  });
});

describe("two people acting at the same moment", () => {
  // Each test forces the worst overlap: the second request runs in full at the instant the first is about to write.
  it("two approvals of the same request apply it once", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    await addCar(w, d, "VINDOUBLE00000001", CRETA, "PATIA", "RECEIVED");
    const b = await approvedBooking(w, d, "se1", CRETA, "PATIA", "Cust", "9811100001");
    const ex = await w.api("POST", "/api/exceptions", { type: "WINDOW_EXTENSION", booking_id: b.id, payload: { days: 3 }, reason: "loan" }, d.users.agm.session);
    let second: { status: number } | undefined;
    const o = overlap(w, /UPDATE exceptions SET status/, async () => void (second = await w.api("POST", `/api/exceptions/${ex.body.id}/approve`, {}, d.users.admin.session)));
    await w.api("PUT", "/api/settings", { exception_approver_roles: ["CEO_VP", "ADMIN"] }, d.users.admin.session);
    const first = await w.api("POST", `/api/exceptions/${ex.body.id}/approve`, {}, d.users.head.session);
    o.restore();
    expect(o.state.fired).toBe(true);
    expect([first.status, second!.status].sort()).toEqual([200, 409]);
    expect(one(w, `SELECT window_extension_days AS n FROM allocations WHERE booking_id = ?`, b.id).n).toBe(3);
    expect(w.db.q(`SELECT id FROM audit_log WHERE action = 'EXCEPTION_APPROVED'`)).toHaveLength(1);
    expect(w.db.q(`SELECT id FROM alerts WHERE kind = 'EXCEPTION_DECIDED'`)).toHaveLength(1);
  });

  it("two clicks on Receive record one arrival and send one message", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    const car = await addCar(w, d, "VINDOUBLE00000002", CRETA, "PATIA", "IN_TRANSIT");
    await approvedBooking(w, d, "se1", CRETA, "PATIA", "Cust", "9811100001");
    let second: { status: number } | undefined;
    const o = overlap(w, /UPDATE vehicles SET status = 'RECEIVED'/, async () => void (second = await w.api("POST", `/api/vehicles/${car.id}/receive`, undefined, d.users.stock.session)));
    const first = await w.api("POST", `/api/vehicles/${car.id}/receive`, undefined, d.users.stock.session);
    o.restore();
    expect([first.status, second!.status].sort()).toEqual([200, 409]);
    expect(w.db.q(`SELECT id FROM vehicle_events WHERE type = 'RECEIVED'`)).toHaveLength(1);
    expect(w.db.q(`SELECT id FROM wa_messages WHERE event_key = 'STOCK_RECEIVED'`)).toHaveLength(1);
    expect(w.db.q(`SELECT id FROM alerts WHERE kind = 'STOCK_RECEIVED'`)).toHaveLength(1);
  });

  it("two approvals of the same booking allocate one car and send one message", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    await addCar(w, d, "VINDOUBLE00000003", CRETA, "PATIA", "RECEIVED");
    await addCar(w, d, "VINDOUBLE00000004", CRETA, "PATIA", "RECEIVED");
    const b = await submittedBooking(w, d, "se1", CRETA, "PATIA", "Cust", "9811100001");
    let second: { status: number } | undefined;
    const o = overlap(w, /UPDATE bookings SET status = 'APPROVED'/, async () => void (second = await w.api("POST", `/api/bookings/${b.id}/approve`, {}, d.users.head.session)));
    const first = await w.api("POST", `/api/bookings/${b.id}/approve`, {}, d.users.sm.session);
    o.restore();
    expect([first.status, second!.status].sort()).toEqual([200, 409]);
    expect(w.db.q(`SELECT id FROM allocations WHERE status = 'ACTIVE'`)).toHaveLength(1);
    expect(w.db.q(`SELECT id FROM wa_messages WHERE audience = 'CUSTOMER'`)).toHaveLength(1);
    expect(w.db.q(`SELECT id FROM wa_messages WHERE event_key = 'SALES_EXEC_UPDATE'`)).toHaveLength(1); // and the sales executive once
    expect(w.db.q(`SELECT id FROM audit_log WHERE action = 'BOOKING_APPROVED'`)).toHaveLength(1);
  });

  it("two allocation runs at once give each car to one booking and message each customer once", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    const b1 = await approvedBooking(w, d, "se1", CRETA, "PATIA", "First", "9811100001");
    const b2 = await approvedBooking(w, d, "se2", CRETA, "PATIA", "Second", "9811100002");
    for (const vin of ["VINDOUBLE00000010", "VINDOUBLE00000011"]) w.db.raw.exec(`INSERT INTO vehicles (id, tenant_id, outlet_id, vin, model, variant, colour, status, source, created_at, updated_at) VALUES ('veh_${vin}', '${d.tenantId}', '${d.outlets.PATIA}', '${vin}', 'CRETA', '${V}', 'ABYSS BLACK', 'RECEIVED', 'MANUAL', '2026-10-13T04:30:00.000Z', '2026-10-13T04:30:00.000Z')`);
    const o = overlap(w, /INSERT INTO allocations/, () => w.api("POST", "/api/allocations/run", {}, d.users.head.session));
    await w.api("POST", "/api/allocations/run", {}, d.users.gm.session);
    o.restore();
    expect(o.state.fired).toBe(true);
    expect(w.db.q(`SELECT id FROM allocations WHERE status = 'ACTIVE'`)).toHaveLength(2);
    expect(w.db.q(`SELECT id FROM allocations`)).toHaveLength(2);
    expect(w.db.q(`SELECT id FROM wa_messages WHERE audience = 'CUSTOMER'`)).toHaveLength(2);
    expect(w.db.q(`SELECT id FROM wa_messages WHERE event_key = 'SALES_EXEC_UPDATE'`)).toHaveLength(2);
    expect((await booking(w, d, b1.id)).allocation.vin).not.toBe((await booking(w, d, b2.id)).allocation.vin);
    expect(integrity(w)).toEqual(CLEAN);
  });

  it("a car blocked for damage at the very moment it is being allocated is not given to the customer", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    const car = await addCar(w, d, "VINDOUBLE00000007", CRETA, "PATIA", "RECEIVED");
    const b = await submittedBooking(w, d, "se1", CRETA, "PATIA", "Cust", "9811100001");
    const o = overlap(w, /INSERT INTO allocations/, () => w.api("POST", `/api/vehicles/${car.id}/block`, { reason: "Dent found at inspection" }, d.users.stock.session));
    const res = await w.api("POST", `/api/bookings/${b.id}/approve`, {}, d.users.sm.session);
    o.restore();
    expect(o.state.fired).toBe(true);
    expect(res.body.allocations).toHaveLength(0);
    expect(w.db.q(`SELECT id FROM allocations`)).toHaveLength(0);
    expect(w.db.q(`SELECT id FROM wa_messages`)).toHaveLength(0);
    expect((await booking(w, d, b.id)).booking.status).toBe("APPROVED");
  });

  it("two scheduled runs overlapping send one reminder and one escalation", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    await addCar(w, d, "VINDOUBLE00000006", CRETA, "PATIA", "RECEIVED");
    await approvedBooking(w, d, "se1", CRETA, "PATIA", "Slow", "9811100001");
    w.at("2026-10-16 10:00");
    let o = overlap(w, /UPDATE allocations SET reminder_sent_at/, () => w.tick());
    await w.tick();
    o.restore();
    expect(o.state.fired).toBe(true);
    expect(w.db.q(`SELECT id FROM wa_messages WHERE event_key = 'PAYMENT_REMINDER'`)).toHaveLength(1);
    expect(w.db.q(`SELECT id FROM alerts WHERE kind = 'PAYMENT_PENDING'`)).toHaveLength(1);
    w.at("2026-10-18 10:00");
    o = overlap(w, /UPDATE allocations SET escalated_at/, () => w.tick());
    await w.tick();
    o.restore();
    expect(o.state.fired).toBe(true);
    // One escalation: recorded once, one message to the one person who receives alarms here (the Business Head; this
    // dealership has no Dealer Principal user), and one alarm in the app for each of the two alarm roles.
    expect(w.db.q(`SELECT id FROM audit_log WHERE action = 'PAYMENT_ESCALATED'`)).toHaveLength(1);
    expect(w.db.q(`SELECT to_name FROM wa_messages WHERE event_key = 'PAYMENT_ESCALATION'`)).toEqual([{ to_name: "Bikram Head" }]);
    expect(w.db.q(`SELECT target_role, is_alarm FROM alerts WHERE kind = 'ESCALATION' ORDER BY target_role`)).toEqual([{ target_role: "CEO_VP", is_alarm: 1 }, { target_role: "DEALER_PRINCIPAL", is_alarm: 1 }]);
    expect(w.db.q(`SELECT id FROM wa_messages WHERE event_key = 'MANAGEMENT_ALARM'`)).toHaveLength(0); // the escalation message is the WhatsApp for this alarm
  });

  it("a booking cancelled at the very moment a car is being allocated to it does not get the car", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    const b1 = await approvedBooking(w, d, "se1", CRETA, "PATIA", "Cancels", "9811100001");
    w.at("2026-10-13 10:05");
    const b2 = await approvedBooking(w, d, "se2", CRETA, "PATIA", "Next", "9811100002");
    // The cancellation lands after allocation has read the queue and before it writes the allocation.
    const dbProto = Object.getPrototypeOf(w.db);
    const orig = dbProto.batch;
    let fired = false;
    dbProto.batch = async function (this: unknown, stmts: { sql: string }[]) {
      if (!fired && stmts.some((s) => /INSERT INTO allocations/.test(s.sql))) {
        fired = true;
        dbProto.batch = orig;
        expect((await w.api("POST", `/api/bookings/${b1.id}/cancel`, { reason: "changed mind" }, d.users.sm.session)).status).toBe(200);
      }
      return orig.call(this, stmts);
    };
    const car = await addCar(w, d, "VINRACE0000000001", CRETA, "PATIA", "RECEIVED");
    dbProto.batch = orig;
    expect(fired).toBe(true);
    expect(car.allocations).toHaveLength(0); // the write was refused as a whole: no allocation, no message to a cancelled customer
    expect(w.db.q(`SELECT id FROM wa_messages`)).toHaveLength(0);
    expect((await booking(w, d, b1.id)).booking.status).toBe("CANCELLED");
    await w.tick(); // the sweep gives the car to the customer who is still waiting
    expect((await booking(w, d, b2.id)).allocation.vin).toBe("VINRACE0000000001");
    expect(integrity(w)).toEqual(CLEAN);
  });

  it("two scheduled runs overlapping on release day release once", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    await addCar(w, d, "VINDOUBLE00000005", CRETA, "PATIA", "RECEIVED");
    const b1 = await approvedBooking(w, d, "se1", CRETA, "PATIA", "Slow", "9811100001");
    const b2 = await approvedBooking(w, d, "se2", CRETA, "PATIA", "Next", "9811100002");
    w.at("2026-10-19 10:00");
    const o = overlap(w, /SET status = 'RELEASED'/, () => w.tick());
    await w.tick();
    o.restore();
    expect(o.state.fired).toBe(true);
    expect(w.db.q(`SELECT id FROM audit_log WHERE action = 'ALLOCATION_RELEASED'`)).toHaveLength(1);
    expect(w.db.q(`SELECT id FROM alerts WHERE kind = 'REALLOCATED' AND target_role = 'CEO_VP'`)).toHaveLength(1);
    expect(w.db.q(`SELECT target_role FROM alerts WHERE kind = 'REALLOCATED' AND is_alarm = 1 ORDER BY target_role`).map((a: any) => a.target_role)).toEqual(["CEO_VP", "DEALER_PRINCIPAL"]);
    expect(w.db.q(`SELECT to_name FROM wa_messages WHERE event_key = 'MANAGEMENT_ALARM'`)).toEqual([{ to_name: "Bikram Head" }]);
    expect((await booking(w, d, b2.id)).allocation.type).toBe("REALLOCATED");
    expect((await booking(w, d, b1.id)).booking.on_hold).toBe(1);
    expect(w.db.q(`SELECT id FROM wa_messages WHERE event_key = 'ALLOC_REALLOCATED'`)).toHaveLength(1);
    expect(integrity(w)).toEqual(CLEAN);
  });
});

describe("heavy days stay inside the platform's allowance of 1,000 database calls per request", () => {
  // Five different cars, so the queues and the stock are spread the way a dealership's are.
  const KINDS: CarKey[] = ["THAR_WHITE", "THAR_BLACK", "XUV3XO_WHITE", "SCORPIO_N", "MAXX_WHITE"];
  const vin = (i: number) => `VIN${String(i).padStart(5, "0")}000000000`;
  const stockLines = (n: number, received: (i: number) => boolean): StockLine[] => Array.from({ length: n }, (_, i) => car(vin(i), { car: KINDS[i % KINDS.length], ...(received(i) ? { grnDate: "2026-10-13" } : { status: "In Transit" as const }) }));
  const bookingLines = (n: number, cancelled: (i: number) => boolean = () => false): BookingLine[] =>
    Array.from({ length: n }, (_, i) => order(`OTF27A${String(i).padStart(6, "0")}`, `2026-09-01T${String(Math.floor(i / 60) % 24).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00+05:30`, { car: KINDS[i % KINDS.length], customer: `CUST ${i}`, mobile: `9${String(700000000 + i)}`, ...(cancelled(i) ? { stage: "Cancellation Initiated" as const } : {}) }));

  it("a dealership with 600 cars and 1,000 bookings: the two DMS files, allocation runs, bulk receive and mass cancellation", async () => {
    const w = makeWorld("2026-10-13 09:30");
    const d: Dealer = await makeDealer(w);
    const s = d.users.stock.session;
    const { m, reset, restore } = meter(w);
    const worst: Record<string, number> = {};
    const measured = async (label: string, fn: () => Promise<{ status: number; body: any }>) => {
      reset();
      m.limit = 1000; // what the platform allows one request; past it the request dies
      const r = await fn();
      worst[label] = Math.max(worst[label] ?? 0, m.calls);
      expect(r.status, `${label}: ${JSON.stringify(r.body).slice(0, 200)}`).toBeLessThan(300);
      return r;
    };
    /** Sends a file as the Uploads screen does: again with `continue` while the answer says there is more to do. Every request is measured. */
    const load = async (label: string, kind: "stock" | "bookings", bytes: Uint8Array) => {
      const url = `/api/uploads/${kind}?filename=${kind}.csv${kind === "stock" ? "&report_date=2026-10-13" : ""}`;
      let res = await measured(label, () => w.send(url, bytes, s));
      let requests = 1;
      while (res.body.more) {
        if (++requests > 20) throw new Error(`${label}: the load did not finish`);
        const id = res.body.upload_id;
        res = await measured(label, () => w.send(`${url}&continue=${id}`, bytes, s));
      }
      return { ...res, requests };
    };
    const count = (sql: string) => one(w, sql).n as number;
    try {
      const first = await load("stock report, 600 new cars", "stock", stockFile(stockLines(600, () => false)));
      expect(first).toMatchObject({ requests: 1, body: { created: 600, errors: [] } });
      const up = await load("booking sheet, 1,000 new bookings", "bookings", bookingFile(bookingLines(1000)));
      expect(up).toMatchObject({ requests: 1, body: { created: 1000, errors: [], allocations: 40 } }); // a first batch of cars is given straight away
      // Allocation proceeds in bounded steps: by request, and by the sweep every 15 minutes.
      let active = 0;
      for (let i = 0; i < 40 && active < 600; i++) {
        const r = await measured("allocation run", () => w.api("POST", "/api/allocations/run", {}, d.users.head.session));
        expect(r.body.allocated).toBeLessThanOrEqual(100);
        active = count(`SELECT COUNT(*) AS n FROM allocations WHERE status = 'ACTIVE'`);
      }
      expect(active).toBe(600);
      expect(integrity(w)).toEqual(CLEAN);
      // A carrier load of 60 allocated cars arrives and is received on the screen.
      const vins = Array.from({ length: 60 }, (_, i) => vin(i));
      const rec = await measured("receive 60 allocated cars at once", () => w.api("POST", "/api/vehicles/receive-bulk", { vins }, s));
      expect(rec.body.received).toHaveLength(60);
      // The evening stock report: those 60 and the next 200 are in the yard. Each of the 200 arrivals tells a customer.
      const evening = await load("stock report with 200 reserved cars arriving", "stock", stockFile(stockLines(600, (i) => i < 260)));
      expect(evening.requests).toBe(4); // 50 arrivals a request
      expect(evening.body).toMatchObject({ created: 0, errors: [], more: false });
      expect(evening.body.summary.received).toBe(200);
      expect(count(`SELECT COUNT(*) AS n FROM vehicles WHERE status = 'RECEIVED'`)).toBe(260);
      expect(one(w, `SELECT COUNT(*) AS n, COUNT(DISTINCT booking_id) AS customers FROM wa_messages WHERE event_key = 'STOCK_RECEIVED'`)).toEqual({ n: 260, customers: 260 });
      // The DMS cancels 300 bookings that hold cars, in one sheet. Each car goes to the next customer waiting for it.
      const cancel = await load("booking sheet cancelling 300 allocated bookings", "bookings", bookingFile(bookingLines(1000, (i) => i < 300)));
      expect(cancel.requests).toBe(6); // 50 cancellations a request
      expect(cancel.body).toMatchObject({ created: 0, errors: [], more: false });
      expect(cancel.body.summary).toMatchObject({ cancelled_now: 300, cars_released: 300 });
      expect(count(`SELECT COUNT(*) AS n FROM bookings WHERE status = 'CANCELLED'`)).toBe(300);
      expect(count(`SELECT COUNT(*) AS n FROM allocations WHERE status = 'ACTIVE'`)).toBe(600); // every freed car was given on
      expect(count(`SELECT COUNT(*) AS n FROM allocations WHERE status = 'ACTIVE' AND type = 'REALLOCATED'`)).toBe(300);
      expect(integrity(w)).toEqual(CLEAN);
    } finally {
      restore();
    }
    console.log("database calls per request (the most any one request of each kind made):", worst);
    // Measured on this scenario: 35, 129, 162, 358, 336 and 433 calls. The limits leave room to grow, but would catch
    // a load that went back to writing row by row, or a step budget that let one request do too much.
    expect(worst["stock report, 600 new cars"]).toBeLessThan(60);
    expect(worst["booking sheet, 1,000 new bookings"]).toBeLessThan(200); // includes giving the first 40 cars
    expect(worst["allocation run"]).toBeLessThan(250); // 100 cars
    expect(worst["receive 60 allocated cars at once"]).toBeLessThan(500);
    expect(worst["stock report with 200 reserved cars arriving"]).toBeLessThan(500); // 50 arrivals
    expect(worst["booking sheet cancelling 300 allocated bookings"]).toBeLessThan(600); // 50 cancellations, each car given on
  }, 180_000);

  // BACKEND? allocateAll caps the matches it makes but not the configurations it looks at: for every model / variant /
  // colour that has both a waiting booking and a free car it makes two database calls, whether or not the outlet rule
  // lets the two meet. Under "own outlet only" (or "nearby outlets") a configuration whose car is at one outlet and
  // whose customer is at another costs two calls on every run and never counts against the cap. With 600 of them:
  // measured 1,232 calls for the booking sheet load, 1,203 for "Run allocation" and 1,209 for one firing of the
  // scheduled job, each over the platform's 1,000. On the platform the booking sheet then fails after its bookings
  // are written (and fails the same way every time it is sent again), and the scheduled job fails for every
  // dealership sharing that firing. Under the default rule ("own outlet first") every such configuration can be
  // matched, so the cap on matches bounds the work. Expected: a bound on configurations examined per request, the
  // rest left to the next sweep. Remove `.fails` when fixed.
  it("allocation stays inside the allowance when hundreds of cars and bookings cannot meet under the outlet rule", async () => {
    const w = makeWorld("2026-10-13 09:30");
    const d = await makeDealer(w);
    const s = d.users.stock.session;
    await w.api("PUT", "/api/settings", { outlet_scope: "SAME_OUTLET_ONLY" }, d.users.admin.session);
    const n = 600;
    // 600 pick-ups in 600 paint names at Cuttack; 600 customers at Patia, one waiting for each paint.
    const report = stockFile(Array.from({ length: n }, (_, i) => car(vin(i), { car: "MAXX_WHITE", loc: "CUTTACK", raw: { Color: `SHADE ${i}` } })));
    const sheet = bookingFile(Array.from({ length: n }, (_, i) => order(`OTF27A${String(i).padStart(6, "0")}`, "01-Oct-2026 10:00 AM", { car: "MAXX_WHITE", colour: `SHADE ${i}` })));
    const { m, reset, restore } = meter(w);
    const calls: Record<string, number> = {};
    try {
      for (const [label, fn] of [
        ["stock report", () => w.send("/api/uploads/stock?filename=stock.csv&report_date=2026-10-13", report, s)],
        ["booking sheet", () => w.send("/api/uploads/bookings?filename=sheet.csv", sheet, s)],
        ["allocation run", () => w.api("POST", "/api/allocations/run", {}, d.users.head.session)],
      ] as const) {
        reset();
        m.limit = 1000;
        const r = await fn();
        calls[label] = m.calls;
        expect(r.status, `${label}: ${JSON.stringify(r.body).slice(0, 200)}`).toBe(200);
      }
      reset();
      m.limit = 1000;
      const reports = await w.tick();
      calls["scheduled job"] = m.calls;
      expect(reports.every((r) => !r.error), JSON.stringify(reports)).toBe(true);
    } finally {
      restore();
    }
    for (const [label, n] of Object.entries(calls)) expect(n, label).toBeLessThan(700);
  });

  it("the scheduled job stays within its allowance on a day with 150 releases across three dealerships", async () => {
    const w = makeWorld("2026-10-13 09:30");
    const dealers = [await makeDealer(w, "dealer-a"), await makeDealer(w, "dealer-b"), await makeDealer(w, "dealer-c")];
    const count = (sql: string) => one(w, sql).n as number;
    for (const d of dealers) {
      await loadStock(w, d.users.stock.session, stockLines(50, () => true));
      await loadBookings(w, d.users.stock.session, bookingLines(100));
      for (let i = 0; i < 3; i++) await w.api("POST", "/api/allocations/run", {}, d.users.head.session);
    }
    expect(count(`SELECT COUNT(*) AS n FROM allocations WHERE status = 'ACTIVE'`)).toBe(150);
    const { m, reset, restore } = meter(w);
    let firings = 0, worst = 0;
    const fire = async (at: string) => {
      w.at(at);
      reset();
      m.limit = 1000;
      const reports = await w.tick();
      expect(reports.every((r) => !r.error), JSON.stringify(reports)).toBe(true);
      worst = Math.max(worst, m.calls);
      firings++;
      return reports;
    };
    try {
      // Day 6 for every one of them, and nobody has loaded a DMS file since the 13th: every car is held, none taken back.
      const held = await fire("2026-10-19 09:45");
      expect(held.map((r) => [r.released, r.held])).toEqual([[0, 50], [0, 50], [0, 50]]);
      expect(count(`SELECT COUNT(*) AS n FROM allocations WHERE status = 'RELEASED'`)).toBe(0);
      // The day's files come in: nothing has been paid for or invoiced in the DMS either.
      restore();
      for (const d of dealers) {
        expect((await loadStock(w, d.users.stock.session, stockLines(50, () => true))).body).toMatchObject({ unchanged: 50, errors: [] });
        expect((await loadBookings(w, d.users.stock.session, bookingLines(100))).body).toMatchObject({ unchanged: 100, errors: [] });
      }
      // Each firing does a bounded share; the day's work completes over a few firings.
      const again = meter(w);
      try {
        for (let minute = 0; minute < 8 * 60 && count(`SELECT COUNT(*) AS n FROM allocations WHERE status = 'RELEASED'`) < 150; minute += 15) {
          w.at(`2026-10-19 ${String(10 + Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`);
          again.reset();
          again.m.limit = 1000;
          const reports = await w.tick();
          expect(reports.every((r) => !r.error), JSON.stringify(reports)).toBe(true);
          worst = Math.max(worst, again.m.calls);
          firings++;
        }
      } finally {
        again.restore();
      }
    } finally {
      restore();
    }
    console.log(`scheduled job: ${firings} firings, at most ${worst} database calls in one`);
    expect(worst).toBeLessThan(700); // measured: 475, on the firing that releases the most
    expect(firings).toBeLessThanOrEqual(6); // measured: 4. One firing that holds everything, then the day's 150 releases over three
    expect(count(`SELECT COUNT(*) AS n FROM allocations WHERE status = 'RELEASED' AND release_reason = 'PAYMENT_TIMEOUT'`)).toBe(150);
    expect(count(`SELECT COUNT(*) AS n FROM allocations WHERE status = 'ACTIVE' AND type = 'REALLOCATED'`)).toBe(150);
    expect(new Set(w.db.q<any>(`SELECT tenant_id FROM allocations WHERE status = 'ACTIVE'`).map((r) => r.tenant_id)).size).toBe(3); // no dealership starved
    // Management of each dealership is told of each car taken back: in the app for both alarm roles, on WhatsApp to its Business Head.
    expect(count(`SELECT COUNT(*) AS n FROM alerts WHERE kind = 'REALLOCATED' AND is_alarm = 1`)).toBe(300);
    expect(count(`SELECT COUNT(*) AS n FROM wa_messages WHERE event_key = 'MANAGEMENT_ALARM' AND rendered_text LIKE '%Car released after payment timeout%'`)).toBe(150);
    expect(integrity(w)).toEqual(CLEAN);
  }, 180_000);
});

describe("the booking date decides the queue, so backdating is made visible", () => {
  it("tells the approver, records it, and lists it at day end", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    const honest = await approvedBooking(w, d, "se1", CRETA, "PATIA", "Honest", "9811100001");
    const s = d.users.se2.session;
    const back = await submittedBooking(w, d, "se2", CRETA, "PATIA", "Backdated", "9811100002", { booking_date: "2026-10-01 11:00" });
    void s;
    const alert = (await w.api("GET", "/api/alerts", undefined, d.users.sm.session)).body.find((a: any) => a.entity_id === back.id);
    expect(alert.body).toContain("Booking date is 12 day(s) before it was entered");
    expect((await booking(w, d, back.id, "sm")).booking.backdated_days).toBe(12);
    expect((await booking(w, d, honest.id, "sm")).booking.backdated_days).toBe(0);
    await w.api("POST", `/api/bookings/${back.id}/approve`, { remarks: "Docket dated 1 Oct seen" }, d.users.sm.session);
    expect(JSON.parse(one(w, `SELECT detail_json FROM audit_log WHERE action = 'BOOKING_APPROVED' AND entity_id = ?`, back.id).detail_json).backdated_days).toBe(12);
    const run = await w.api("POST", "/api/recon/run", {}, d.users.head.session);
    const detail = await w.api("GET", `/api/recon/runs/${run.body.run_id}`, undefined, d.users.head.session);
    const item = detail.body.items.find((i: any) => i.category === "BACKDATED_BOOKING");
    expect(item).toMatchObject({ severity: "MEDIUM", entity_id: back.id });
    expect(item.message).toContain("12 days earlier");
  });
});

describe("day-end findings", () => {
  it("a car added after the evening run is part of the next day's movements, not a mismatch", async () => {
    const w = makeWorld("2026-10-13 21:00");
    const d = await makeDealer(w);
    await addCar(w, d, "VINLATE00000000001".slice(0, 17), CRETA, "PATIA", "RECEIVED");
    expect((await w.tick())[0].reconciliation).toBeTruthy();
    w.at("2026-10-13 21:30");
    await addCar(w, d, "VINLATE0000000002", CRETA, "PATIA", "RECEIVED");
    w.at("2026-10-14 21:00");
    const [r] = await w.tick();
    const run = await w.api("GET", `/api/recon/runs/${r.reconciliation}`, undefined, d.users.head.session);
    expect(run.body.summary.stock.find((x: any) => x.outlet === "Patia")).toMatchObject({ opening: 1, added: 1, left: 0, closing: 2, expected_closing: 2 });
    expect(run.body.items.some((i: any) => i.category === "STOCK_MOVEMENT")).toBe(false);
  });

  it("a serious finding is closed by the Business Head, not by the people whose work it questions", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    await addCar(w, d, "VINFIND0000000001", CRETA, "PATIA", "RECEIVED");
    await w.api("POST", "/api/recon/run", {}, d.users.head.session);
    w.at("2026-10-14 10:00");
    w.db.raw.exec(`UPDATE vehicles SET status = 'REMOVED' WHERE vin = 'VINFIND0000000001'`);
    const run = await w.api("POST", "/api/recon/run", {}, d.users.head.session);
    const item = (await w.api("GET", `/api/recon/runs/${run.body.run_id}`, undefined, d.users.head.session)).body.items.find((i: any) => i.severity === "HIGH");
    const byStock = await w.api("POST", `/api/recon/items/${item.id}/resolve`, { note: "all fine" }, d.users.stock.session);
    expect(byStock.status).toBe(403);
    expect((await w.api("POST", `/api/recon/items/${item.id}/resolve`, { note: "Car returned to manufacturer; record corrected" }, d.users.head.session)).status).toBe(200);
  });

  it("the export cannot carry a spreadsheet formula", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    await addCar(w, d, "VINCSV00000000001", CRETA, "PATIA", "IN_TRANSIT", { expected_arrival_date: "2026-10-01" });
    const run = await w.api("POST", "/api/recon/run", {}, d.users.head.session);
    const item = (await w.api("GET", `/api/recon/runs/${run.body.run_id}`, undefined, d.users.head.session)).body.items[0];
    await w.api("POST", `/api/recon/items/${item.id}/resolve`, { note: '=HYPERLINK("http://evil.example","click")' }, d.users.head.session);
    const csv = (await w.api("GET", `/api/recon/runs/${run.body.run_id}?format=csv`, undefined, d.users.head.session)).body as string;
    expect(csv).toContain(`"'=HYPERLINK`);
    expect(csv).not.toMatch(/,=HYPERLINK|,"=HYPERLINK/);
  });
});

describe("customer data stays within the outlet", () => {
  it("the WhatsApp log, customer replies and audit trail are limited for users of one outlet", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    await addCar(w, d, "VINSCOPE000000001", CRETA, "PATIA", "RECEIVED");
    await addCar(w, d, "VINSCOPE000000002", CRETA, "CUTTACK", "RECEIVED");
    const p = await approvedBooking(w, d, "se1", CRETA, "PATIA", "Patia Customer", "9811100001");
    const c = await approvedBooking(w, d, "se3", CRETA, "CUTTACK", "Cuttack Customer", "9811100002");
    w.db.raw.exec(`INSERT INTO wa_inbound (id, tenant_id, from_mobile, from_name, message_type, text, provider_message_id, received_at) VALUES ('wai_1', '${d.tenantId}', '919811100001', 'Patia Customer', 'text', 'ok', 'in1', '2026-10-13T05:00:00.000Z'), ('wai_2', '${d.tenantId}', '919811100002', 'Cuttack Customer', 'text', 'ok', 'in2', '2026-10-13T05:00:00.000Z')`);
    const log = (await w.api("GET", "/api/wa/messages", undefined, d.users.sm.session)).body; // Patia's manager
    expect([...new Set(log.messages.map((m: any) => m.booking_id))]).toEqual([p.id]);
    expect(log.counts).toEqual([{ status: "SENT", n: 2 }]); // the customer and the sales executive
    expect((await w.api("GET", "/api/wa/inbound", undefined, d.users.sm.session)).body.map((i: any) => i.from_name)).toEqual(["Patia Customer"]);
    expect((await w.api("GET", "/api/wa/messages", undefined, d.users.auditor.session)).body.messages.map((m: any) => m.booking_id).sort()).toEqual([p.id, p.id, c.id, c.id].sort());
    // An auditor restricted to one outlet does not get the dealership-wide audit trail.
    await w.api("PATCH", `/api/users/${d.users.auditor.id}`, { all_outlets: false, outlet_ids: [d.outlets.PATIA] }, d.users.admin.session);
    expect((await w.api("GET", "/api/audit", undefined, d.users.auditor.session)).status).toBe(403);
  });
});

describe("a car the DMS itself allotted is not taken back by the payment window", () => {
  // The DMS is the dealership's record of who has which car. Releasing one against it would put the two
  // systems in conflict, and the very next file load would assert the allotment again. The system's own
  // allocations are still taken back on time: only the DMS's are left alone.
  const STOCK = [car("VINDMSHELD0000001", { order: "OTF27A000001", customer: "DMS CUSTOMER" }), car("VINSYSHELD0000001")];
  const SHEET = [order("OTF27A000001", "01-Oct-2026 10:00 AM", { customer: "DMS CUSTOMER", mobile: "9811100011" }), order("OTF27A000002", "02-Oct-2026 10:00 AM", { customer: "QUEUE CUSTOMER", mobile: "9811100012" })];

  it("holds the DMS's allotment past the re-allocation day and releases the system's own", async () => {
    const w = makeWorld("2026-10-05 10:00");
    const d = await makeDealer(w);
    await loadBookings(w, d.users.stock.session, SHEET);
    await loadStock(w, d.users.stock.session, STOCK);
    // One car came with the customer's order on it; the other was free, so the queue gave it to the next customer.
    expect(allocatedVin(w, "OTF27A000001")).toBe("VINDMSHELD0000001");
    expect(allocatedVin(w, "OTF27A000002")).toBe("VINSYSHELD0000001");
    expect(w.db.q(`SELECT b.booking_no, a.source, a.dms_confirmed_at IS NOT NULL AS from_dms FROM allocations a JOIN bookings b ON b.id = a.booking_id WHERE a.status = 'ACTIVE' ORDER BY b.booking_no`)).toEqual([
      { booking_no: "OTF27A000001", source: "DMS", from_dms: 1 },
      { booking_no: "OTF27A000002", source: "SYSTEM", from_dms: 0 },
    ]);

    // Day 6, nobody has paid, and today's files are loaded so the "DMS data is out of date" guard does not apply.
    w.at("2026-10-11 10:00");
    await loadStock(w, d.users.stock.session, STOCK);
    await loadBookings(w, d.users.stock.session, SHEET);
    expect((await w.tick())[0]).toMatchObject({ released: 1, held: 1 });
    expect(allocatedVin(w, "OTF27A000001")).toBe("VINDMSHELD0000001");
    expect(allocatedVin(w, "OTF27A000002")).toBeNull();
    expect((await booking(w, d, one(w, `SELECT id FROM bookings WHERE booking_no = 'OTF27A000002'`).id)).booking).toMatchObject({ status: "APPROVED", on_hold: 1, hold_reason: "PAYMENT_TIMEOUT" });
    // Somebody still has to chase the unpaid DMS booking: the payment is escalated, the car is not freed.
    expect(one(w, `SELECT escalated_at IS NOT NULL AS escalated, released_at FROM allocations WHERE booking_id = (SELECT id FROM bookings WHERE booking_no = 'OTF27A000001')`)).toMatchObject({ escalated: 1, released_at: null });
    // Management hears of it in the alarm wording, not the payment-escalation wording, which promises a
    // re-allocation that is not going to happen to this car.
    const dmsBooking = one(w, `SELECT id FROM bookings WHERE booking_no = 'OTF27A000001'`).id;
    expect(w.db.q(`SELECT event_key FROM wa_messages WHERE booking_id = ? AND event_key = 'PAYMENT_ESCALATION'`, dmsBooking)).toEqual([]);
    expect(w.db.q<{ body: string }>(`SELECT body FROM alerts WHERE is_alarm = 1 AND kind = 'ESCALATION' AND entity_id = ?`, dmsBooking)[0].body).toContain("either collect the payment or free the car in the DMS");

    // It stays held however long it goes on: the decision to free it belongs in the DMS.
    w.at("2026-10-25 10:00");
    await loadStock(w, d.users.stock.session, STOCK);
    await loadBookings(w, d.users.stock.session, SHEET);
    expect((await w.tick())[0]).toMatchObject({ released: 0, held: 1 });
    expect(allocatedVin(w, "OTF27A000001")).toBe("VINDMSHELD0000001");
    expect(integrity(w)).toEqual(CLEAN);
  });
});
