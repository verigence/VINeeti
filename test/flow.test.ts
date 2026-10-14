// The customer's "Booking to Delivery Allocation" process, steps 1-10, exercised end to end through the
// HTTP API with each persona doing its own part. Stock comes from the DMS stock report, as it does at the
// dealership; bookings are entered, checked and approved in the app.

import { beforeAll, describe, expect, it } from "vitest";
import { addCar, approvedBooking, booking, CARS, CRETA, loadBookings, loadStock, makeDealer, makeWorld, stockFile, submittedBooking, type BookingLine, type Dealer, type StockLine, type World } from "./harness";

let w: World;
let d: Dealer;
const ids: Record<string, string> = {};
const nos: Record<string, string> = {};
const cars: Record<string, string> = {};

// The two cars of this story, as the system names them once the stock report has been read.
const THAR = CARS.THAR_WHITE.is; // sold at Patia
const XUV = CARS.XUV3XO_WHITE.is; // sold at Cuttack
const THAR_LABEL = "THAR LXT D MT 2WD 4S HT (M0877) EVEREST WHITE";
const V1 = "MALC841CLRM100001", V2 = "MALC841CLRM100002", V3 = "MALC841CLRM100003", V5 = "MALC841CLRM100005";

const messages = (event: string, bookingId?: string) =>
  w.db.q<{ status: string; to_mobile: string; rendered_text: string; provider: string }>(
    `SELECT status, to_mobile, rendered_text, provider FROM wa_messages WHERE event_key = ? ${bookingId ? "AND booking_id = ?" : ""} ORDER BY created_at`,
    ...(bookingId ? [event, bookingId] : [event]),
  );
const carId = (vin: string) => w.db.q<{ id: string }>(`SELECT id FROM vehicles WHERE vin = ?`, vin)[0].id;
const carRow = (vin: string) => w.db.q<any>(`SELECT * FROM vehicles WHERE vin = ?`, vin)[0];
const count = (sql: string, ...p: unknown[]) => w.db.q<{ n: number }>(sql, ...p)[0].n;
/** The stock report of the day, loaded by the stock in-charge. */
const stockReport = (lines: StockLine[]) => loadStock(w, d.users.stock.session, lines);
/** This dealership enters its bookings in the app, so the DMS booking sheet of the day only carries a car delivered last month. */
const SHEET: BookingLine[] = [{ no: "OTF27A000001", car: "SCORPIO_N", loc: "PATIA", stage: "Invoiced", enquiryStage: "Delivered", created: "02-Sep-2026 11:00 AM", customer: "DELIVERED IN SEPTEMBER" }];
const bookingSheet = () => loadBookings(w, d.users.stock.session, SHEET);

beforeAll(async () => {
  w = makeWorld("2026-10-13 10:00");
  d = await makeDealer(w);
});

describe("steps 1-2: stock in the system and visible to sales", () => {
  const morning: StockLine[] = [
    { vin: V1, car: "THAR_WHITE", loc: "PATIA", oemInvoiceDate: "2026-10-01", grnDate: "2026-10-05" },
    { vin: V2, car: "THAR_WHITE", loc: "PATIA", status: "In Transit", oemInvoiceDate: "2026-10-08" },
    { vin: V3, car: "XUV3XO_WHITE", loc: "CUTTACK", status: "In Transit", oemInvoiceDate: "2026-10-08" },
  ];

  it("loads free and in-transit stock from the DMS stock report", async () => {
    const res = await stockReport(morning);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 3, updated: 0, errors: [], more: false, report_date: "2026-10-13", allocations: 0 });
    expect(res.body.summary).toMatchObject({ cars: 3, unallocated: 3, unallocated_received: 1, unallocated_in_transit: 2, allocated: 0, not_recognised: 0, outlets_created: [] });
    // Each car is named by what its Model Description says, and stands where the report says it is.
    expect(w.db.q(`SELECT v.vin, v.model, v.variant, v.colour, v.status, o.code AS outlet FROM vehicles v JOIN outlets o ON o.id = v.outlet_id ORDER BY v.vin`)).toEqual([
      { vin: V1, ...THAR, status: "RECEIVED", outlet: "PATIA" },
      { vin: V2, ...THAR, status: "IN_TRANSIT", outlet: "PATIA" },
      { vin: V3, ...XUV, status: "IN_TRANSIT", outlet: "CUTTACK" },
    ]);
    expect((await bookingSheet()).body).toMatchObject({ created: 1, errors: [] });
    cars.V1 = carId(V1);
    cars.V2 = carId(V2);
    cars.V3 = carId(V3);
    // The stock report carries no arrival date for a car in transit; the stock in-charge enters what the carrier says.
    for (const [id, eta] of [[cars.V2, "2026-10-22"], [cars.V3, "2026-10-20"]]) {
      expect((await w.api("PATCH", `/api/vehicles/${id}`, { expected_arrival_date: eta }, d.users.stock.session)).body).toEqual({ changed: true });
    }
  });

  it("loading the same report again changes nothing", async () => {
    const before = { events: count(`SELECT COUNT(*) AS n FROM vehicle_events`), audit: count(`SELECT COUNT(*) AS n FROM audit_log`) };
    const res = await stockReport(morning);
    expect(res.body).toMatchObject({ created: 0, updated: 0, unchanged: 3, errors: [], allocations: 0 });
    expect(count(`SELECT COUNT(*) AS n FROM vehicle_events`)).toBe(before.events);
    expect(count(`SELECT COUNT(*) AS n FROM audit_log`)).toBe(before.audit);
    expect(carRow(V2).expected_arrival_date).toBe("2026-10-22"); // what was entered on the screen stays
  });

  it("shows every salesperson the free, in-transit and allocated position", async () => {
    const res = await w.api("GET", "/api/stock/summary", undefined, d.users.se1.session);
    const thar = res.body.find((r: any) => r.model === "THAR");
    expect(thar).toMatchObject({ yard_free: 1, yard_allocated: 0, transit_free: 1, transit_allocated: 0, earliest_free_arrival: "2026-10-22" });
    const avail = await w.api("GET", `/api/stock/availability?model=thar&variant=${encodeURIComponent(THAR.variant.toLowerCase())}&colour=everest%20white&outlet_id=${d.outlets.PATIA}`, undefined, d.users.se1.session);
    expect(avail.body).toMatchObject({ answer: "AVAILABLE_NOW", free_in_yard: 1, free_in_transit: 1, queue_position_for_new_booking: 1 });
    // The answer says which stock report it was worked out from.
    expect(avail.body.source).toMatchObject({ stock_as_on: "2026-10-13", stale: false });
  });

  it("does not let a sales executive change stock", async () => {
    expect((await w.send("/api/uploads/stock?filename=stock.csv", stockFile(morning), d.users.se1.session)).status).toBe(403);
    expect((await w.api("POST", `/api/vehicles/${cars.V2}/receive`, undefined, d.users.se1.session)).status).toBe(403);
    expect(carRow(V2).status).toBe("IN_TRANSIT");
  });
});

describe("steps 3-5: booking submission, approval and automatic allocation", () => {
  it("refuses submission until every item on the booking checklist is confirmed", async () => {
    const s = d.users.se1.session;
    const created = await w.api("POST", "/api/bookings", { outlet_id: d.outlets.PATIA, customer_name: "Rahul Sharma", customer_mobile: "98765 00001", booking_amount: 25000, ...THAR }, s);
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("DRAFT");
    const id = created.body.id;
    const tick = (items: Record<string, boolean>, who = "se1") => w.api("PUT", `/api/bookings/${id}/checklist`, items, d.users[who].session);
    const sub = await w.api("POST", `/api/bookings/${id}/submit`, undefined, s);
    expect(sub.status).toBe(400);
    expect(sub.body.error.code).toBe("CHECKLIST_INCOMPLETE");
    expect(sub.body.error.message).toContain("PAN");
    expect((await booking(w, d, id, "se1")).checklist_missing).toEqual(["DOCKET", "KYC", "PAN_AADHAAR", "PAYMENT_PROOF"]);
    // Three of the four are not enough, and the refusal names the one that is missing.
    expect((await tick({ DOCKET: true, KYC: true, PAYMENT_PROOF: true })).body).toEqual({ checklist_missing: ["PAN_AADHAAR"] });
    const again = await w.api("POST", `/api/bookings/${id}/submit`, undefined, s);
    expect(again.body.error.code).toBe("CHECKLIST_INCOMPLETE");
    expect(again.body.error.message).toBe("Confirm these are on file before submitting: PAN card and Aadhaar card");
    // A tick can be taken back while the booking is a draft, and only the items of the checklist exist.
    expect((await tick({ KYC: false })).body).toEqual({ checklist_missing: ["KYC", "PAN_AADHAAR"] });
    expect((await tick({ SELFIE: true })).status).toBe(400);
    // The checklist is confirmed by the people who handle the booking: not another executive, not someone who only reads.
    expect((await tick({ KYC: true }, "se2")).status).toBe(403);
    expect((await tick({ KYC: true }, "auditor")).status).toBe(403);
    expect((await tick({ KYC: true }, "se3")).status).toBe(403); // another outlet's executive
    expect((await booking(w, d, id, "se1")).checklist_missing).toEqual(["KYC", "PAN_AADHAAR"]);
    expect((await tick({ KYC: true, PAN_AADHAAR: true })).body).toEqual({ checklist_missing: [] });
    expect((await w.api("POST", `/api/bookings/${id}/submit`, undefined, s)).body.status).toBe("SUBMITTED");
    // Once submitted, what was confirmed (and by whom) stands: the approver decides on exactly that.
    expect((await tick({ DOCKET: false })).status).toBe(409);
    const detail = await booking(w, d, id, "sm");
    expect(detail.checklist.map((c: any) => [c.key, c.ticked, c.by])).toEqual([["DOCKET", true, "Ravi Exec"], ["KYC", true, "Ravi Exec"], ["PAN_AADHAAR", true, "Ravi Exec"], ["PAYMENT_PROOF", true, "Ravi Exec"]]);
    expect(detail.checklist_missing).toEqual([]);
    // Every change to the checklist is on the booking's record.
    expect(w.db.q<{ detail_json: string }>(`SELECT detail_json FROM audit_log WHERE action = 'BOOKING_CHECKLIST' AND entity_id = ? ORDER BY rowid`, id).map((r) => JSON.parse(r.detail_json))).toEqual([{ DOCKET: true, KYC: true, PAYMENT_PROOF: true }, { KYC: false }, { KYC: true, PAN_AADHAAR: true }]);
    await w.api("POST", `/api/bookings/${id}/cancel`, { reason: "Test booking" }, s);
  });

  it("B: allocates free stock on approval and messages the customer", async () => {
    const b = await submittedBooking(w, d, "se1", THAR, "PATIA", "Rahul Sharma", "9876500001");
    ids.B1 = b.id;
    nos.B1 = b.booking_no;
    // The sales executive cannot approve; only the configured approver roles can.
    expect((await w.api("POST", `/api/bookings/${b.id}/approve`, {}, d.users.se1.session)).status).toBe(403);
    const res = await w.api("POST", `/api/bookings/${b.id}/approve`, { remarks: "ok" }, d.users.sm.session);
    expect(res.status).toBe(200);
    expect(res.body.allocations).toHaveLength(1);
    expect(res.body.allocations[0]).toMatchObject({ type: "FREE_STOCK", vin: V1, needsTransfer: false });
    expect(res.body.booking.status).toBe("ALLOCATED");
    const [m] = messages("ALLOC_FREE_STOCK", b.id);
    expect(m).toMatchObject({ status: "SENT", provider: "TEST", to_mobile: "919876500001" });
    expect(m.rendered_text).toBe(
      `Dear Rahul Sharma, your ${THAR_LABEL} has been allocated against booking ${b.booking_no}. The car is available at Northstar Motors, Patia. Kindly arrange your funds for the next process. Thank you.`,
    );
  });

  it("A: allocates in-transit stock to the next booking, with the expected arrival in the message", async () => {
    w.at("2026-10-13 11:00");
    const b = await approvedBooking(w, d, "se2", THAR, "PATIA", "Meera Das", "9876500002");
    ids.B2 = b.id;
    nos.B2 = b.booking_no;
    expect(b.approval.allocations[0]).toMatchObject({ type: "IN_TRANSIT", vin: V2 });
    const [m] = messages("ALLOC_IN_TRANSIT", b.id);
    expect(m.status).toBe("SENT");
    expect(m.rendered_text).toContain("in transit from the plant. It is expected by 22 Oct 2026 at Northstar Motors, Patia.");
  });

  it("5B: with no stock the booking waits in the queue and appears on the order queue", async () => {
    w.at("2026-10-13 12:00");
    const b = await approvedBooking(w, d, "se1", THAR, "PATIA", "Sanjay Rout", "9876500003");
    ids.B3 = b.id;
    nos.B3 = b.booking_no;
    expect(b.approval.allocations).toHaveLength(0);
    expect(b.approval.booking.status).toBe("APPROVED");
    const detail = await booking(w, d, b.id);
    expect(detail.queue).toEqual({ position: 1, waiting: 1 });
    const queue = await w.api("GET", "/api/dashboards/order-queue", undefined, d.users.ordering.session);
    expect(queue.body.find((r: any) => r.model === "THAR")).toMatchObject({ waiting: 1, on_order: 0, to_order: 1, status: "PENDING" });
    const avail = await w.api("GET", `/api/stock/availability?model=THAR&variant=${encodeURIComponent(THAR.variant)}&colour=EVEREST%20WHITE`, undefined, d.users.se2.session);
    expect(avail.body).toMatchObject({ answer: "NEEDS_ORDER", queue_position_for_new_booking: 2, committed_in_yard: 1, committed_in_transit: 1 });
  });

  it("the person who created a booking cannot approve it", async () => {
    const b = await submittedBooking(w, d, "sm", XUV, "PATIA", "Own Booking", "9876500099");
    const res = await w.api("POST", `/api/bookings/${b.id}/approve`, {}, d.users.sm.session);
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain("cannot approve");
    await w.api("POST", `/api/bookings/${b.id}/cancel`, { reason: "test" }, d.users.sm.session);
  });

  it("free stock moves on: sales reports the payment, Finance verifies it, then invoice and delivery", async () => {
    const acc = d.users.accounts.session;
    const pay = (path: string, body: unknown, who: string) => w.api("POST", `/api/bookings/${ids.B1}/${path}`, body, d.users[who].session);
    // Verifying is Finance's work, and Finance verifies against a reference it can find in the bank statement.
    expect((await pay("payment-received", { reference: "UTR2610130001" }, "se1")).status).toBe(403);
    expect((await pay("payment-received", undefined, "accounts")).status).toBe(400);
    // Reporting is the sales team's work, and a report without a reference gives Finance nothing to check.
    expect((await pay("payment-reported", { reference: "UTR2610130001" }, "accounts")).status).toBe(403);
    expect((await pay("payment-reported", { amount: 1650000 }, "se1")).status).toBe(400);
    const reported = await pay("payment-reported", { amount: 1650000, reference: "UTR2610130001", note: "NEFT from the customer's own account" }, "se1");
    expect(reported.status).toBe(200);
    expect(reported.body).toMatchObject({ status: "ALLOCATED", payment_ref: "UTR2610130001", payment_amount: 1650000, payment_reported_by: d.users.se1.id, payment_received_at: null });
    expect((await pay("payment-reported", { reference: "UTR2610130001" }, "se1")).status).toBe(409);
    // A reported payment is not yet a received one: the payment window stays open, and Finance is asked to verify.
    expect((await booking(w, d, ids.B1)).allocation.window).toMatchObject({ stage: "OPEN", held_for_finance: true });
    expect((await w.api("GET", "/api/alerts", undefined, acc)).body.some((a: any) => a.kind === "PAYMENT_TO_VERIFY" && a.entity_id === ids.B1 && !a.read_at)).toBe(true);
    expect((await w.api("GET", "/api/payments", undefined, acc)).body.find((p: any) => p.booking_id === ids.B1)).toMatchObject({ state: "TO_VERIFY", payment_ref: "UTR2610130001", payment_reported_by_name: "Ravi Exec" });
    const verified = await pay("payment-received", undefined, "accounts");
    expect(verified.status).toBe(200);
    expect(verified.body).toMatchObject({ payment_ref: "UTR2610130001", payment_amount: 1650000, payment_verified_by: d.users.accounts.id });
    expect(verified.body.payment_received_at).toBeTruthy();
    expect((await booking(w, d, ids.B1)).allocation.window).toBeNull(); // verification is what closes the payment window
    expect((await pay("payment-received", undefined, "accounts")).status).toBe(409);
    expect((await w.api("POST", `/api/bookings/${ids.B1}/invoice`, undefined, acc)).body.status).toBe("INVOICED");
    expect((await w.api("POST", `/api/bookings/${ids.B1}/deliver`, undefined, d.users.stock.session)).body.status).toBe("DELIVERED");
    expect(w.db.q(`SELECT status FROM vehicles WHERE id = ?`, cars.V1)[0].status).toBe("DELIVERED");
    expect(w.db.q(`SELECT status FROM allocations WHERE vehicle_id = ?`, cars.V1)[0].status).toBe("FULFILLED");
  });

  it("an in-transit car cannot be invoiced before it is received", async () => {
    const res = await w.api("POST", `/api/bookings/${ids.B2}/invoice`, undefined, d.users.accounts.session);
    expect(res.status).toBe(409);
  });
});

describe("steps 6-9: stock received, day 3 reminder, day 5 escalation, day 6 re-allocation", () => {
  it("6: receiving the car starts the payment window and messages the customer", async () => {
    w.at("2026-10-15 11:00");
    const res = await w.api("POST", `/api/vehicles/${cars.V2}/receive`, undefined, d.users.stock.session);
    expect(res.status).toBe(200);
    const [m] = messages("STOCK_RECEIVED", ids.B2);
    expect(m.rendered_text).toContain("has now reached Northstar Motors, Patia");
    expect(m.rendered_text).toContain("within 3 days");
    const detail = await booking(w, d, ids.B2);
    expect(detail.allocation.window).toMatchObject({ day: 0, reminder_on: "2026-10-18", escalation_on: "2026-10-20", release_on: "2026-10-21", stage: "OPEN" });
  });

  it("nothing happens before day 3", async () => {
    w.at("2026-10-17 12:00");
    const [r] = await w.tick();
    expect(r).toMatchObject({ reminders: 0, escalations: 0, released: 0 });
  });

  it("7: no customer is messaged outside business hours", async () => {
    w.at("2026-10-18 03:00");
    const [r] = await w.tick();
    expect(r.reminders).toBeUndefined();
    expect(messages("PAYMENT_REMINDER")).toHaveLength(0);
  });

  it("7: the day 3 reminder goes once", async () => {
    w.at("2026-10-18 09:15");
    expect((await w.tick())[0].reminders).toBe(1);
    w.at("2026-10-18 09:30");
    expect((await w.tick())[0].reminders).toBe(0);
    w.at("2026-10-19 10:00");
    expect((await w.tick())[0].reminders).toBe(0);
    const sent = messages("PAYMENT_REMINDER");
    expect(sent).toHaveLength(1);
    expect(sent[0].to_mobile).toBe("919876500002");
    expect(sent[0].rendered_text).toContain("it has been 3 days");
    expect((await booking(w, d, ids.B2)).allocation.window.stage).toBe("REMINDED");
  });

  it("8: on day 5 the Business Head is alerted, once", async () => {
    w.at("2026-10-20 10:00");
    expect((await w.tick())[0].escalations).toBe(1);
    w.at("2026-10-20 10:15");
    expect((await w.tick())[0].escalations).toBe(0);
    // The escalation goes on WhatsApp to the people who receive alarms: here the Business Head (this dealership has no Dealer Principal user).
    const sent = messages("PAYMENT_ESCALATION");
    expect(sent).toHaveLength(1);
    expect(sent[0].to_mobile).toBe("91" + d.users.head.mobile);
    expect(sent[0].rendered_text).toContain("allocated to Meera Das");
    expect(sent[0].rendered_text).toContain("for 5 days");
    expect(sent[0].rendered_text).toContain("re-allocated to a new customer on 21 Oct 2026");
    const alerts = await w.api("GET", "/api/alerts", undefined, d.users.head.session);
    expect(alerts.body.filter((a: any) => a.kind === "ESCALATION" && a.entity_id === ids.B2)).toMatchObject([{ is_alarm: true, target_role: "BUSINESS_HEAD" }]);
    // The escalation is management's; a sales executive does not see it.
    const seAlerts = await w.api("GET", "/api/alerts", undefined, d.users.se2.session);
    expect(seAlerts.body.some((a: any) => a.kind === "ESCALATION")).toBe(false);
  });

  it("9: on day 6 a car is not taken back on DMS files that are out of date", async () => {
    // The last stock report and booking sheet are those of 13 Oct. The customer may have paid and been
    // invoiced in the DMS since, so the car stays where it is until today's files are in.
    w.at("2026-10-21 09:15");
    expect((await w.api("GET", "/api/data-status", undefined, d.users.sm.session)).body).toMatchObject({ stale: true, stale_files: ["STOCK", "BOOKINGS"] });
    const [r] = await w.tick();
    expect(r).toMatchObject({ released: 0, held: 1 });
    expect((await booking(w, d, ids.B2)).booking.status).toBe("ALLOCATED");
    // Today's files: the car received on the 15th is in the yard, still unallotted in the DMS.
    const stock = await stockReport([
      { vin: V2, car: "THAR_WHITE", loc: "PATIA", oemInvoiceDate: "2026-10-08", grnDate: "2026-10-15" },
      { vin: V3, car: "XUV3XO_WHITE", loc: "CUTTACK", status: "In Transit", oemInvoiceDate: "2026-10-08" },
    ]);
    expect(stock.body).toMatchObject({ created: 0, errors: [], allocations: 0 });
    expect(stock.body.summary.left_stock).toEqual({ delivered: 0, removed: 0, on_hold: 0 }); // the delivered car is not "missing"
    expect((await bookingSheet()).body).toMatchObject({ created: 0, unchanged: 1, errors: [] });
    expect((await w.api("GET", "/api/data-status", undefined, d.users.sm.session)).body).toMatchObject({ stale: false, stale_files: [] });
    // The report confirming a car that was received on the screen does not tell the customer a second time.
    expect(messages("STOCK_RECEIVED", ids.B2)).toHaveLength(1);
  });

  it("9 / C: on day 6 the car is released and re-allocated to the next booking in the queue", async () => {
    w.at("2026-10-21 09:30");
    const [r] = await w.tick();
    expect(r).toMatchObject({ released: 1, held: 0 });
    const b2 = await booking(w, d, ids.B2);
    expect(b2.booking).toMatchObject({ status: "APPROVED", on_hold: 1, hold_reason: "PAYMENT_TIMEOUT" });
    expect(b2.allocation).toBeNull();
    expect(b2.allocation_history[0]).toMatchObject({ status: "RELEASED", release_reason: "PAYMENT_TIMEOUT" });
    const b3 = await booking(w, d, ids.B3);
    expect(b3.booking.status).toBe("ALLOCATED");
    expect(b3.allocation).toMatchObject({ type: "REALLOCATED", vin: V2 });
    const [m] = messages("ALLOC_REALLOCATED", ids.B3);
    expect(m.to_mobile).toBe("919876500003");
    expect(m.rendered_text).toContain("earlier allocated to another customer and is now allocated to you");
    // The sales executive of each booking was told at every step; nobody else's news reaches them.
    const mine = (await w.api("GET", "/api/alerts", undefined, d.users.se2.session)).body;
    expect(mine.filter((x: any) => x.entity_id === ids.B2).map((x: any) => x.kind).reverse()).toEqual(["ALLOCATED", "STOCK_RECEIVED", "PAYMENT_PENDING", "REALLOCATED"]);
    const other = (await w.api("GET", "/api/alerts", undefined, d.users.se1.session)).body;
    expect(other.some((x: any) => x.entity_id === ids.B2)).toBe(false);
    expect(other.find((x: any) => x.entity_id === ids.B3 && x.kind === "ALLOCATED").body).toContain(V2);
    // Management is told that a car was taken back: an alarm in the app, and on WhatsApp to the Business Head.
    const alarm = (await w.api("GET", "/api/alerts?alarms=1", undefined, d.users.head.session)).body.filter((x: any) => x.kind === "REALLOCATED");
    expect(alarm).toHaveLength(1);
    expect(alarm[0].body).toContain(`was released from booking ${nos.B2} (Meera Das) after 6 days without payment`);
    expect(messages("MANAGEMENT_ALARM").filter((x) => x.rendered_text.includes("Car released after payment timeout")).map((x) => x.to_mobile)).toEqual(["91" + d.users.head.mobile]);
    // Running again the same day does nothing more.
    w.at("2026-10-21 09:45");
    expect((await w.tick())[0]).toMatchObject({ released: 0, reminders: 0, escalations: 0 });
  });

  it("payment verified in time stops the reminders", async () => {
    // The administrator may both report and verify, but never the same payment.
    const pay = (path: string, body: unknown, who: string) => w.api("POST", `/api/bookings/${ids.B3}/${path}`, body, d.users[who].session);
    expect((await pay("payment-reported", { reference: "DD 004512" }, "admin")).status).toBe(200);
    const own = await pay("payment-received", undefined, "admin");
    expect(own.status).toBe(403);
    expect(own.body.error.message).toBe("The person who reported a payment cannot verify it");
    expect((await pay("payment-received", undefined, "accounts")).status).toBe(200);
    w.at("2026-10-28 10:00");
    expect((await w.tick())[0]).toMatchObject({ released: 0, reminders: 0, escalations: 0, held: 0 });
    expect((await booking(w, d, ids.B3)).booking.status).toBe("ALLOCATED");
    expect(messages("PAYMENT_REMINDER", ids.B3)).toHaveLength(0);
  });

  it("the customer who timed out rejoins the queue with the original priority when ready", async () => {
    expect((await w.api("POST", `/api/bookings/${ids.B2}/ready`, undefined, d.users.se2.session)).status).toBe(403);
    const res = await w.api("POST", `/api/bookings/${ids.B2}/ready`, undefined, d.users.sm.session);
    expect(res.status).toBe(200);
    const b2 = await booking(w, d, ids.B2);
    expect(b2.booking.on_hold).toBe(0);
    expect(b2.booking.priority_ts).toBe(b2.booking.booking_date);
    expect(b2.queue).toEqual({ position: 1, waiting: 1 });
  });
});

describe("step 10: change in priority and skip allocation need approval", () => {
  it("sets up a queue for the XUV 3XO at Cuttack", async () => {
    w.at("2026-10-28 11:00");
    const b4 = await approvedBooking(w, d, "se3", XUV, "CUTTACK", "Kabita Jena", "9876500004");
    w.at("2026-10-28 11:10");
    const b5 = await approvedBooking(w, d, "se3", XUV, "CUTTACK", "Lalit Sahu", "9876500005");
    w.at("2026-10-28 11:20");
    const b6 = await approvedBooking(w, d, "se3", XUV, "CUTTACK", "Nisha Patra", "9876500006");
    Object.assign(ids, { B4: b4.id, B5: b5.id, B6: b6.id });
    Object.assign(nos, { B4: b4.booking_no, B5: b5.booking_no, B6: b6.booking_no });
    expect(b4.approval.allocations[0]).toMatchObject({ type: "IN_TRANSIT", vin: V3 });
    expect((await booking(w, d, b5.id)).queue.position).toBe(1);
    expect((await booking(w, d, b6.id)).queue.position).toBe(2);
  });

  it("a priority change does nothing until the approver approves it", async () => {
    const req = await w.api("POST", "/api/exceptions", { type: "PRIORITY_CHANGE", booking_id: ids.B6, payload: { before_booking_id: ids.B5 }, reason: "Wedding in the family on 5 Nov" }, d.users.se3.session);
    expect(req.status).toBe(201);
    expect(req.body.status).toBe("PENDING");
    ids.EX1 = req.body.id;
    expect((await booking(w, d, ids.B6)).queue.position).toBe(2);
    // The sales executive can see the queue their booking stands in (numbers and dates, no customer details).
    const queue = (await w.api("GET", `/api/bookings/${ids.B6}/queue`, undefined, d.users.se3.session)).body;
    expect(queue.map((q: any) => [q.booking_no, q.position, q.is_this_booking])).toEqual([[nos.B5, 1, false], [nos.B6, 2, true]]);
    expect(queue[0].customer_name).toBeUndefined();
    // Neither the requester nor the Sales Manager can decide; the Business Head is a configured approver.
    expect((await w.api("POST", `/api/exceptions/${ids.EX1}/approve`, {}, d.users.se3.session)).status).toBe(403);
    expect((await w.api("POST", `/api/exceptions/${ids.EX1}/approve`, {}, d.users.sm2.session)).status).toBe(403);
    const pending = await w.api("GET", "/api/exceptions?status=PENDING", undefined, d.users.head.session);
    expect(pending.body.map((e: any) => e.id)).toContain(ids.EX1);
    expect(pending.body.find((e: any) => e.id === ids.EX1).before_booking_no).toBe(nos.B5);
    expect((await booking(w, d, ids.B6)).exceptions[0]).toMatchObject({ before_booking_no: nos.B5, requested_by_name: "Deepak Exec" });
    const waiting = () => w.api("GET", "/api/alerts", undefined, d.users.head.session).then((r) => r.body.find((x: any) => x.kind === "EXCEPTION_APPROVAL" && x.entity_id === ids.EX1));
    expect((await waiting()).read_at).toBeNull();
    ids.waitingAlert = (await waiting()).id;
  });

  it("once approved the queue order changes and the next car follows it", async () => {
    w.at("2026-10-28 12:00");
    const res = await w.api("POST", `/api/exceptions/${ids.EX1}/approve`, { remarks: "Approved, genuine case" }, d.users.head.session);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("APPROVED");
    // The "waiting for your decision" alert closes itself once the decision is made.
    expect(w.db.q(`SELECT read_at FROM alerts WHERE id = ?`, ids.waitingAlert)[0].read_at).toBeTruthy();
    expect((await booking(w, d, ids.B6)).queue.position).toBe(1);
    expect((await booking(w, d, ids.B5)).queue.position).toBe(2);
    // A car dispatched today is entered on the screen straight away; the next stock report will confirm it.
    const car = await addCar(w, d, V5, XUV, "CUTTACK", "IN_TRANSIT", { expected_arrival_date: "2026-11-02" });
    cars.V5 = car.id;
    expect(car.allocations[0]).toMatchObject({ bookingId: ids.B6, type: "IN_TRANSIT" });
  });

  it("skip allocation, once approved, parks the booking and passes its car to the next customer", async () => {
    const req = await w.api("POST", "/api/exceptions", { type: "SKIP_ALLOCATION", booking_id: ids.B4, payload: {}, reason: "Customer travelling abroad" }, d.users.se3.session);
    expect(req.status).toBe(201);
    expect((await booking(w, d, ids.B4)).booking.status).toBe("ALLOCATED");
    const res = await w.api("POST", `/api/exceptions/${req.body.id}/approve`, {}, d.users.head.session);
    expect(res.status).toBe(200);
    expect((await booking(w, d, ids.B4)).booking).toMatchObject({ status: "APPROVED", on_hold: 1, hold_reason: "ALLOCATION_SKIPPED" });
    const b5 = await booking(w, d, ids.B5);
    expect(b5.allocation).toMatchObject({ vin: V3, type: "REALLOCATED" });
  });

  it("a rejection needs a reason and changes nothing", async () => {
    const req = await w.api("POST", "/api/exceptions", { type: "WINDOW_EXTENSION", booking_id: ids.B5, payload: { days: 4 }, reason: "Loan sanction delayed" }, d.users.se3.session);
    expect(req.status).toBe(201);
    expect((await w.api("POST", `/api/exceptions/${req.body.id}/reject`, {}, d.users.head.session)).status).toBe(400);
    const res = await w.api("POST", `/api/exceptions/${req.body.id}/reject`, { remarks: "Not justified" }, d.users.head.session);
    expect(res.body.status).toBe("REJECTED");
    const told = (await w.api("GET", "/api/alerts", undefined, d.users.se3.session)).body.find((x: any) => x.kind === "EXCEPTION_DECIDED" && x.title.includes("not approved"));
    expect(told.body).toContain("Not justified");
    // Marking it read is personal: another user cannot mark it.
    await w.api("POST", `/api/alerts/${told.id}/read`, undefined, d.users.se1.session);
    expect(w.db.q(`SELECT read_at FROM alerts WHERE id = ?`, told.id)[0].read_at).toBeNull();
    await w.api("POST", `/api/alerts/${told.id}/read`, undefined, d.users.se3.session);
    expect(w.db.q(`SELECT read_at FROM alerts WHERE id = ?`, told.id)[0].read_at).toBeTruthy();
    expect(w.db.q(`SELECT window_extension_days FROM allocations WHERE booking_id = ? AND status = 'ACTIVE'`, ids.B5)[0].window_extension_days).toBe(0);
    // A decided request cannot be decided again.
    expect((await w.api("POST", `/api/exceptions/${req.body.id}/approve`, {}, d.users.head.session)).status).toBe(409);
  });

  it("the person who raised a request cannot approve it", async () => {
    const req = await w.api("POST", "/api/exceptions", { type: "DEFER_DELIVERY", booking_id: ids.B6, payload: { until: "2026-12-01" }, reason: "Customer asked for December" }, d.users.head.session);
    expect(req.status).toBe(201);
    const res = await w.api("POST", `/api/exceptions/${req.body.id}/approve`, {}, d.users.head.session);
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain("cannot decide");
  });

  it("an approved payment-window extension moves the reminder, escalation and release dates", async () => {
    w.at("2026-10-29 10:00");
    await w.api("POST", `/api/vehicles/${cars.V3}/receive`, undefined, d.users.stock.session);
    const before = (await booking(w, d, ids.B5)).allocation.window;
    expect(before).toMatchObject({ reminder_on: "2026-11-01", release_on: "2026-11-04" });
    const req = await w.api("POST", "/api/exceptions", { type: "WINDOW_EXTENSION", booking_id: ids.B5, payload: { days: 4 }, reason: "Loan disbursement confirmed for 6 Nov" }, d.users.sm2.session);
    await w.api("POST", `/api/exceptions/${req.body.id}/approve`, {}, d.users.head.session);
    const after = (await booking(w, d, ids.B5)).allocation.window;
    expect(after).toMatchObject({ reminder_on: "2026-11-05", escalation_on: "2026-11-07", release_on: "2026-11-08" });
    w.at("2026-11-04 10:00");
    expect((await w.tick())[0]).toMatchObject({ released: 0, reminders: 0, held: 0 });
    expect((await booking(w, d, ids.B5)).booking.status).toBe("ALLOCATED");
  });
});

describe("audit trail and day-end reconciliation", () => {
  // What the DMS shows on 4 Nov: the three cars in stock, none of them allotted there.
  const evening: StockLine[] = [
    { vin: V2, car: "THAR_WHITE", loc: "PATIA", oemInvoiceDate: "2026-10-08", grnDate: "2026-10-15" },
    { vin: V3, car: "XUV3XO_WHITE", loc: "CUTTACK", oemInvoiceDate: "2026-10-08", grnDate: "2026-10-29" },
    { vin: V5, car: "XUV3XO_WHITE", loc: "CUTTACK", status: "In Transit", oemInvoiceDate: "2026-10-27" },
  ];

  it("keeps the full history of a booking, with who did what", async () => {
    const res = await w.api("GET", `/api/audit?entity_type=booking&entity_id=${ids.B2}`, undefined, d.users.auditor.session);
    const actions = res.body.map((r: any) => r.action);
    for (const a of ["BOOKING_CREATED", "BOOKING_CHECKLIST", "BOOKING_SUBMITTED", "BOOKING_APPROVED", "ALLOCATED", "STOCK_RECEIVED", "PAYMENT_REMINDER_SENT", "PAYMENT_ESCALATED", "ALLOCATION_RELEASED", "HOLD_LIFTED"]) {
      expect(actions).toContain(a);
    }
    expect(res.body.find((r: any) => r.action === "BOOKING_APPROVED").actor_name).toBe("Sunita Manager");
    expect(res.body.find((r: any) => r.action === "BOOKING_CHECKLIST")).toMatchObject({ actor_name: "Priya Exec", detail: { DOCKET: true, KYC: true, PAN_AADHAAR: true, PAYMENT_PROOF: true } });
    // The payment trail of the first booking names who reported and who verified.
    const paid = (await w.api("GET", `/api/audit?entity_type=booking&entity_id=${ids.B1}`, undefined, d.users.auditor.session)).body;
    expect(paid.find((r: any) => r.action === "PAYMENT_REPORTED")).toMatchObject({ actor_name: "Ravi Exec", detail: { reference: "UTR2610130001", amount: 1650000 } });
    expect(paid.find((r: any) => r.action === "PAYMENT_VERIFIED")).toMatchObject({ actor_name: "Anita Accounts", detail: { reference: "UTR2610130001", reported_by: d.users.se1.id } });
    expect((await w.api("GET", "/api/audit", undefined, d.users.se1.session)).status).toBe(403);
  });

  it("the audit trail cannot be edited or deleted", () => {
    expect(() => w.db.raw.exec(`UPDATE audit_log SET action = 'X'`)).toThrow();
    expect(() => w.db.raw.exec(`DELETE FROM audit_log`)).toThrow();
    expect(() => w.db.raw.exec(`DELETE FROM vehicle_events`)).toThrow();
  });

  it("the day-end run reports the position and finds no rule breaks", async () => {
    // The day closes with the two DMS files, then the reconciliation.
    w.at("2026-11-04 20:30");
    const stock = await stockReport(evening);
    // The car entered on the screen on 28 Oct is the same car the report now lists: nothing is created twice.
    expect(stock.body).toMatchObject({ created: 0, errors: [], allocations: 0 });
    expect(stock.body.summary.left_stock).toEqual({ delivered: 0, removed: 0, on_hold: 0 });
    expect((await bookingSheet()).body).toMatchObject({ created: 0, errors: [] });
    w.at("2026-11-04 21:10");
    const [r] = await w.tick();
    expect(r.reconciliation).toBeTruthy();
    // It runs once per day on schedule.
    w.at("2026-11-04 21:25");
    expect((await w.tick())[0].reconciliation).toBeUndefined();
    const run = await w.api("GET", `/api/recon/runs/${r.reconciliation}`, undefined, d.users.head.session);
    expect(run.status).toBe(200);
    const cats = run.body.summary.items.by_category;
    for (const c of ["QUEUE_ORDER", "ALLOCATION_INTEGRITY", "UNMATCHED_STOCK", "STOCK_MOVEMENT", "BYPASS", "WINDOW_OVERDUE", "STALE_DATA", "CAR_LEFT_STOCK", "OUT_OF_TURN", "PAYMENT_UNVERIFIED"]) expect(cats[c], c).toBeUndefined();
    // What it does list is what is late: the car expected on 2 Nov, and the deferral request nobody has decided.
    expect(cats).toEqual({ TRANSIT_OVERDUE: 1, APPROVAL_PENDING: 1 });
    const patia = run.body.summary.stock.find((s: any) => s.outlet === "Patia");
    const cuttack = run.body.summary.stock.find((s: any) => s.outlet === "Cuttack");
    expect(patia).toMatchObject({ closing: 1, in_yard_allocated: 1, in_transit: 0 });
    expect(cuttack).toMatchObject({ closing: 2, in_yard_allocated: 1, in_transit: 1 });
    expect(run.body.summary.bookings).toMatchObject({ allocated: 3, on_hold: 1, waiting: 1 });
    expect(run.body.summary.day.uploads).toBe(2);
  });

  it("detects a car billed to a different booking than the one it was allocated to", async () => {
    w.at("2026-11-05 10:00");
    // The next stock report shows the car reserved for B6 invoiced against B4's booking number.
    const res = await stockReport([evening[0], evening[1], { vin: V5, car: "XUV3XO_WHITE", loc: "CUTTACK", oemInvoiceDate: "2026-10-27", grnDate: "2026-11-04", order: nos.B4, customer: "KABITA JENA", invoiceId: "INV2611040007", invoiceDate: "2026-11-04" }]);
    expect(res.body.errors).toEqual([]);
    expect(res.body.summary.orders).toMatchObject({ total: 1, bypassed: 1, recorded: 1 });
    const b6 = await booking(w, d, ids.B6);
    expect(b6.booking).toMatchObject({ status: "APPROVED", on_hold: 0, moved_ahead: true }); // back in the queue, priority intact
    expect(b6.queue).toEqual({ position: 1, waiting: 1 });
    expect(b6.allocation).toBeNull();
    expect(b6.allocation_history[0]).toMatchObject({ vin: V5, status: "RELEASED", release_reason: "ALLOTTED_IN_DMS_TO_ANOTHER_BOOKING" });
    const b4 = await booking(w, d, ids.B4);
    expect(b4.booking.status).toBe("INVOICED");
    expect(b4.allocation).toMatchObject({ vin: V5, source: "DMS", allocated_by: "DMS" });
    expect(carRow(V5)).toMatchObject({ status: "INVOICED", dms_booking_no: nos.B4 });
    // The customer who lost the car was never told it had arrived.
    expect(messages("STOCK_RECEIVED", ids.B6)).toHaveLength(0);
    // Management is told at once, in the app and on WhatsApp.
    const alerts = await w.api("GET", "/api/alerts?alarms=1", undefined, d.users.head.session);
    const bypass = alerts.body.filter((a: any) => a.kind === "BYPASS");
    expect(bypass).toHaveLength(1);
    expect(bypass[0].body).toBe(`XUV 3XO AX5 PM MT (M1024) EVEREST WHITE (${V5}) was reserved for booking ${nos.B6}, but the DMS shows it invoiced to ${nos.B4}. Booking ${nos.B6} is back in the queue with its place kept.`);
    expect(messages("MANAGEMENT_ALARM").filter((m) => m.rendered_text.includes("Car given to a different booking in the DMS")).map((m) => m.to_mobile)).toEqual(["91" + d.users.head.mobile]);
    const run = await w.api("POST", "/api/recon/run", {}, d.users.head.session);
    expect(run.status).toBe(201);
    expect(run.body.summary.items.by_category.BYPASS).toBe(1);
    const detail = await w.api("GET", `/api/recon/runs/${run.body.run_id}`, undefined, d.users.auditor.session);
    const item = detail.body.items.find((i: any) => i.category === "BYPASS");
    expect(item.severity).toBe("HIGH");
    expect(item.message).toContain(nos.B6);
    // A finding is closed with a note, by someone allowed to.
    expect((await w.api("POST", `/api/recon/items/${item.id}/resolve`, { note: "x" }, d.users.auditor.session)).status).toBe(403);
    expect((await w.api("POST", `/api/recon/items/${item.id}/resolve`, { note: "Billing corrected in DMS" }, d.users.head.session)).status).toBe(200);
    const csvOut = await w.api("GET", `/api/recon/runs/${run.body.run_id}?format=csv`, undefined, d.users.head.session);
    expect(csvOut.body).toContain("Billing corrected in DMS");
  });
});

describe("a car given to a different booking in the DMS before it is invoiced", () => {
  // BACKEND? When the report that shows a reserved car allotted to another booking is also the first to show that car
  // received, importStockReport takes its "a reserved car has arrived" step before it compares the Order ID. The
  // customer the system had reserved the car for is sent "your allocated car has now reached the dealership ...
  // complete the payment within 3 days" (and their sales executive is alerted), and a moment later, in the same load,
  // the reservation is undone as a bypass. The test above covers the invoiced case, where this does not happen.
  // Expected: no arrival message to a customer who is losing the car in the same load. Remove `.fails` when fixed.
  it("the customer who loses the car is not first told that it has arrived", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    const s = d.users.stock.session;
    await loadStock(w, s, [{ vin: V2, car: "THAR_WHITE", loc: "PATIA", status: "In Transit" }]);
    await loadBookings(w, s, [
      { no: "OTF27A000001", car: "THAR_WHITE", loc: "PATIA", created: "01-Oct-2026 10:00 AM", customer: "FIRST IN LINE" },
      { no: "OTF27A000002", car: "THAR_WHITE", loc: "PATIA", created: "02-Oct-2026 10:00 AM", customer: "SECOND IN LINE" },
    ]);
    const first = w.db.q<{ id: string }>(`SELECT id FROM bookings WHERE booking_no = 'OTF27A000001'`)[0].id;
    expect(w.db.q(`SELECT booking_id FROM allocations WHERE status = 'ACTIVE'`)).toEqual([{ booking_id: first }]);
    // Next day's report: the car is in the yard, and the DMS has it allotted to the second booking.
    w.at("2026-10-14 10:00");
    const res = await loadStock(w, s, [{ vin: V2, car: "THAR_WHITE", loc: "PATIA", grnDate: "2026-10-14", order: "OTF27A000002", customer: "SECOND IN LINE" }]);
    expect(res.body.summary.orders).toMatchObject({ bypassed: 1 });
    expect(w.db.q(`SELECT status, on_hold FROM bookings WHERE id = ?`, first)[0]).toEqual({ status: "APPROVED", on_hold: 0 });
    expect(w.db.q<{ event_key: string }>(`SELECT event_key FROM wa_messages WHERE booking_id = ? ORDER BY created_at, rowid`, first).map((m) => m.event_key)).toEqual(["ALLOC_IN_TRANSIT"]);
  });
});

describe("a payment reported by sales does not stop the payment window; Finance's verification does", () => {
  // A dealership of its own, so the days of this story do not move the ones above.
  it("the reminder and the escalation still go, the car is held on day 6 while Finance checks, and is released once Finance finds no payment", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    const tick = async () => (await w.tick())[0];
    await addCar(w, d, "MALC841CLRM500001", CRETA, "PATIA", "RECEIVED");
    const b = await approvedBooking(w, d, "se1", CRETA, "PATIA", "Paying Customer", "9876500051");
    const next = await approvedBooking(w, d, "se2", CRETA, "PATIA", "Next In Line", "9876500052");
    const pay = (path: string, body: unknown, who: string) => w.api("POST", `/api/bookings/${b.id}/${path}`, body, d.users[who].session);
    w.at("2026-10-15 16:00");
    expect((await pay("payment-reported", { reference: "CHQ 004512", note: "Cheque handed over at the showroom" }, "se1")).status).toBe(200);
    w.at("2026-10-16 10:00"); // day 3
    expect(await tick()).toMatchObject({ reminders: 1, escalations: 0, released: 0, held: 0, alarms: 0 });
    w.at("2026-10-18 10:00"); // day 5; and Finance has had the report for more than a day
    expect(await tick()).toMatchObject({ reminders: 0, escalations: 1, released: 0, held: 0, alarms: 1 });
    const alarms = (await w.api("GET", "/api/alerts?alarms=1", undefined, d.users.head.session)).body;
    expect(alarms.find((a: any) => a.kind === "ESCALATION").body).toContain("a payment has been reported and is waiting for Finance");
    expect(alarms.find((a: any) => a.kind === "PAYMENT_VERIFY_OVERDUE").body).toContain("reference CHQ 004512");
    w.at("2026-10-19 10:00"); // day 6: the car is not taken from a customer who may have paid
    expect(await tick()).toMatchObject({ released: 0, held: 1, alarms: 0 });
    expect((await booking(w, d, b.id)).booking.status).toBe("ALLOCATED");
    expect((await booking(w, d, next.id)).booking.status).toBe("APPROVED");
    // Finance looks for the cheque and it has not come in. Saying so needs a note, and is Finance's to say.
    expect((await pay("payment-not-received", { note: "Not in the bank statement up to 19 Oct" }, "se1")).status).toBe(403);
    expect((await pay("payment-not-received", {}, "accounts")).status).toBe(400);
    expect((await pay("payment-not-received", { note: "Not in the bank statement up to 19 Oct" }, "accounts")).status).toBe(200);
    expect((await booking(w, d, b.id)).booking).toMatchObject({ payment_reported_at: null, payment_ref: null, payment_received_at: null });
    const told = (await w.api("GET", "/api/alerts", undefined, d.users.se1.session)).body.find((a: any) => a.kind === "PAYMENT_NOT_RECEIVED");
    expect(told.body).toContain("Not in the bank statement up to 19 Oct");
    w.at("2026-10-19 10:15");
    expect(await tick()).toMatchObject({ released: 1, held: 0 });
    expect((await booking(w, d, b.id)).booking).toMatchObject({ status: "APPROVED", on_hold: 1, hold_reason: "PAYMENT_TIMEOUT" });
    expect((await booking(w, d, next.id)).allocation).toMatchObject({ vin: "MALC841CLRM500001", type: "REALLOCATED" });
  });
});
