// Taking a car back from the customer who holds it.
//
// Allocation by hand is closed, so this is the only way a named car reaches a named booking. Each
// reason has to bring its own evidence, and each does something different with the car — the one
// worth guarding hardest is the deferral, which keeps the car rather than freeing it, because a
// customer who politely asks for a later date should not lose their place to someone who didn't ask.

import { describe, expect, it } from "vitest";
import { addCar, approvedBooking, booking, CRETA, makeDealer, makeWorld, PASSWORD, type Dealer, type World } from "./harness";

const one = <T = any>(w: World, sql: string, ...p: unknown[]) => w.db.q<T>(sql, ...p)[0];
const activeVin = (w: World, bookingId: string) =>
  one(w, `SELECT v.vin FROM allocations a JOIN vehicles v ON v.id = a.vehicle_id WHERE a.booking_id = ? AND a.status = 'ACTIVE'`, bookingId)?.vin ?? null;
const payload = (w: World, id: string) => JSON.parse(one(w, `SELECT payload_json FROM exceptions WHERE id = ?`, id).payload_json);

/** One car, one booking holding it. The commonest starting point for all of this. */
async function held(w: World, d: Dealer, vin = "VINREL00000000001") {
  const car = await addCar(w, d, vin, CRETA, "PATIA", "RECEIVED");
  const b = await approvedBooking(w, d, "se1", CRETA, "PATIA", "Holder", "9811100001");
  expect(activeVin(w, b.id)).toBe(vin);
  return { car, b };
}

const raise = (w: World, d: Dealer, bookingId: string, p: Record<string, unknown>, reason = "Because of the following") =>
  w.api("POST", "/api/exceptions", { type: "RELEASE_ALLOCATION", booking_id: bookingId, payload: p, reason }, d.users.sm.session);

const approve = (w: World, d: Dealer, id: string) => w.api("POST", `/api/exceptions/${id}/approve`, {}, d.users.head.session);

describe("a release has to say why, and prove it", () => {
  it("refuses a reason nobody is allowed to ask for", async () => {
    const w = makeWorld();
    const d = await makeDealer(w);
    const { b } = await held(w, d);
    // PAYMENT_TIMEOUT is real, but it is the system's to write — a person cannot claim it.
    expect((await raise(w, d, b.id, { release_reason: "PAYMENT_TIMEOUT" })).status).toBe(400);
    expect((await raise(w, d, b.id, { release_reason: "" })).status).toBe(400);
    expect(activeVin(w, b.id)).toBe("VINREL00000000001");
  });

  it("will not release a car from a booking that is not holding one", async () => {
    const w = makeWorld();
    const d = await makeDealer(w);
    const b = await approvedBooking(w, d, "se1", CRETA, "PATIA", "Waiting", "9811100002");
    expect((await raise(w, d, b.id, { release_reason: "MANAGEMENT_PRIORITY" })).status).toBe(409);
  });

  it("wants the DMS cancellation reference before it will cancel a booking", async () => {
    const w = makeWorld();
    const d = await makeDealer(w);
    const { b } = await held(w, d);
    expect((await raise(w, d, b.id, { release_reason: "BOOKING_CANCELLED" })).status).toBe(400);
    expect((await raise(w, d, b.id, { release_reason: "BOOKING_CANCELLED", cancellation_ref: "CAN27A000123" })).status).toBe(201);
  });

  it("wants the customer's own words before it will call something a deferral", async () => {
    const w = makeWorld();
    const d = await makeDealer(w);
    const { b } = await held(w, d);
    // A date but no document: this is a priority change wearing a kinder name, and the two are
    // reported differently, so it is refused rather than quietly recorded as the gentler one.
    expect((await raise(w, d, b.id, { release_reason: "CUSTOMER_DEFERRED", until: "2026-12-01" })).status).toBe(400);
    expect((await raise(w, d, b.id, { release_reason: "CUSTOMER_DEFERRED", document_id: "doc_abc" })).status).toBe(400);
    expect((await raise(w, d, b.id, { release_reason: "CUSTOMER_DEFERRED", until: "2026-10-01", document_id: "doc_abc" })).status).toBe(400); // in the past
    expect((await raise(w, d, b.id, { release_reason: "CUSTOMER_DEFERRED", until: "2026-12-01", document_id: "doc_abc" })).status).toBe(201);
  });

  // A car taken off the front of the queue is handed straight back by the queue, so a priority
  // change with no stand-down date does nothing whatever. Refusing it is the only honest answer.
  it("makes management say how long the booking stands down, or the change does nothing", async () => {
    const w = makeWorld();
    const d = await makeDealer(w);
    const { b } = await held(w, d);
    expect((await w.api("POST", "/api/exceptions", { type: "RELEASE_ALLOCATION", booking_id: b.id, payload: { release_reason: "MANAGEMENT_PRIORITY", until: "2026-11-01" }, reason: "" }, d.users.sm.session)).status).toBe(400);
    expect((await raise(w, d, b.id, { release_reason: "MANAGEMENT_PRIORITY" }, "Board member's family, agreed with the DP")).status).toBe(400);
    expect((await raise(w, d, b.id, { release_reason: "MANAGEMENT_PRIORITY", until: "2026-11-01" }, "Board member's family, agreed with the DP")).status).toBe(201);
  });
});

describe("what approval does with the car", () => {
  it("a short deferral keeps the car for the customer who asked, and moves their payment window", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    const { b } = await held(w, d);
    // Somebody else is waiting for exactly this car. They must not get it: this customer asked.
    const waiting = await approvedBooking(w, d, "se1", CRETA, "PATIA", "Next in line", "9811100003");
    const ex = await raise(w, d, b.id, { release_reason: "CUSTOMER_DEFERRED", until: "2026-10-23", document_id: "doc_defer_1" }, "Customer travelling for a week, email attached");
    expect(payload(w, ex.body.id)).toMatchObject({ days_away: 10, keep_days: 10 });
    expect((await approve(w, d, ex.body.id)).status).toBe(200);
    expect(activeVin(w, b.id)).toBe("VINREL00000000001");
    expect(activeVin(w, waiting.id)).toBeNull();
    // Still holding it, not on hold — and the payment window now reaches past the date they gave.
    expect(one(w, `SELECT status, on_hold, expected_delivery_date FROM bookings WHERE id = ?`, b.id)).toMatchObject({ status: "ALLOCATED", on_hold: 0, expected_delivery_date: "2026-10-23" });
    expect(one(w, `SELECT window_extension_days, status FROM allocations WHERE booking_id = ?`, b.id)).toMatchObject({ window_extension_days: 10, status: "ACTIVE" });
  });

  // The other half of the same rule. Holding a car for months costs the dealership its own interest,
  // so beyond the threshold the car goes back and the customer keeps their place instead.
  it("a long deferral frees the car and the customer keeps their place in the queue", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    const { b } = await held(w, d);
    const waiting = await approvedBooking(w, d, "se1", CRETA, "PATIA", "Next in line", "9811100003");
    const ex = await raise(w, d, b.id, { release_reason: "CUSTOMER_DEFERRED", until: "2026-12-01", document_id: "doc_defer_2" }, "Customer abroad until December, email attached");
    expect(payload(w, ex.body.id)).toMatchObject({ days_away: 49 });
    expect(payload(w, ex.body.id).keep_days).toBeUndefined();
    expect((await approve(w, d, ex.body.id)).status).toBe(200);
    expect(activeVin(w, b.id)).toBeNull();
    expect(activeVin(w, waiting.id)).toBe("VINREL00000000001");
    expect(one(w, `SELECT on_hold, hold_reason, hold_until, expected_delivery_date FROM bookings WHERE id = ?`, b.id)).toMatchObject({
      on_hold: 1, hold_reason: "CUSTOMER_DEFERRED", hold_until: "2026-12-01", expected_delivery_date: "2026-12-01",
    });
  });

  it("a cancellation closes the booking and the car goes to whoever is next", async () => {
    const w = makeWorld();
    const d = await makeDealer(w);
    const { b } = await held(w, d);
    const next = await approvedBooking(w, d, "se1", CRETA, "PATIA", "Next in line", "9811100003");
    const ex = await raise(w, d, b.id, { release_reason: "BOOKING_CANCELLED", cancellation_ref: "CAN27A000123" }, "Customer cancelled, refund raised");
    expect((await approve(w, d, ex.body.id)).status).toBe(200);
    expect(one(w, `SELECT status FROM bookings WHERE id = ?`, b.id).status).toBe("CANCELLED");
    expect(activeVin(w, next.id)).toBe("VINREL00000000001");
    expect(one(w, `SELECT release_reason, release_request_id FROM allocations WHERE booking_id = ? AND status = 'RELEASED'`, b.id)).toMatchObject({
      release_reason: "BOOKING_CANCELLED", release_request_id: ex.body.id,
    });
    expect(payload(w, ex.body.id).cancellation_ref).toBe("CAN27A000123");
  });

  it("a priority change frees the car for somebody else and keeps this customer's place", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    const { b } = await held(w, d);
    const next = await approvedBooking(w, d, "se1", CRETA, "PATIA", "Next in line", "9811100003");
    const before = one(w, `SELECT priority_ts FROM bookings WHERE id = ?`, b.id).priority_ts;
    const ex = await raise(w, d, b.id, { release_reason: "MANAGEMENT_PRIORITY", until: "2026-11-01" }, "Needed for a demonstration this week");
    expect((await approve(w, d, ex.body.id)).status).toBe(200);
    // The car actually reaches somebody else, which is the whole point and the thing that fails if
    // the booking does not stand down: the queue would hand it straight back.
    expect(activeVin(w, next.id)).toBe("VINREL00000000001");
    expect(one(w, `SELECT status, on_hold, hold_reason, hold_until, priority_ts FROM bookings WHERE id = ?`, b.id)).toMatchObject({
      status: "APPROVED", on_hold: 1, hold_reason: "MANAGEMENT_PRIORITY", hold_until: "2026-11-01", priority_ts: before,
    });
  });
});

describe("finding the car in the first place", () => {
  it("finds a held car by chassis, by customer, and by two words at once", async () => {
    const w = makeWorld();
    const d = await makeDealer(w);
    const { b } = await held(w, d);
    const find = async (q: string) => (await w.api("GET", `/api/held-cars?q=${encodeURIComponent(q)}`, undefined, d.users.sm.session)).body as any[];
    // The chassis is the tail of the VIN in the DMS, so a chassis on its own has to find the car —
    // and punctuation is a break, because it is being read off a printed form.
    expect((await find("0000000001")).map((r) => r.vin)).toEqual(["VINREL00000000001"]);
    expect((await find("Holder")).map((r) => r.booking_no)).toEqual([b.booking_no]);
    expect((await find("creta abyss")).map((r) => r.vin)).toEqual(["VINREL00000000001"]);
    expect(await find("venue")).toEqual([]);
    expect(await find("")).toEqual([]);
  });

  it("says when a car already has a release waiting for approval, so nobody asks twice", async () => {
    const w = makeWorld();
    const d = await makeDealer(w);
    const { b } = await held(w, d);
    const ex = await raise(w, d, b.id, { release_reason: "MANAGEMENT_PRIORITY", until: "2026-11-01" }, "Asked already");
    const found = (await w.api("GET", "/api/held-cars?q=Holder", undefined, d.users.sm.session)).body as any[];
    expect(found[0].pending_request_id).toBe(ex.body.id);
  });
});

describe("what the approver is shown", () => {
  it("counts the earlier bookings a reallocation would step over", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    const { b } = await held(w, d);
    // An older booking that is still waiting, and a newer one that is to be given the car.
    w.at("2026-10-14 10:00");
    const older = await approvedBooking(w, d, "se1", CRETA, "PATIA", "Waited longer", "9811100004");
    w.at("2026-10-15 10:00");
    const newer = await approvedBooking(w, d, "se1", CRETA, "PATIA", "Walked in today", "9811100005");
    const ex = await raise(w, d, b.id, { release_reason: "REALLOCATED_TO_BOOKING", to_booking_id: newer.id }, "Paying cash, taking it today");
    expect(ex.status).toBe(201);
    const p = payload(w, ex.body.id);
    // The approver sees that this does not only cost the holder — it steps over someone else too.
    expect(p.to_booking_no).toBe(newer.booking_no);
    expect(p.jumped).toBe(1);
    expect(p.jumped_booking_nos).toEqual([older.booking_no]);
    expect(p.vin).toBe("VINREL00000000001");
  });

  it("will not let the person who asked for it approve it", async () => {
    const w = makeWorld();
    const d = await makeDealer(w);
    const { b } = await held(w, d);
    const ex = await raise(w, d, b.id, { release_reason: "MANAGEMENT_PRIORITY", until: "2026-11-01" }, "Mine to decide, surely");
    expect((await w.api("POST", `/api/exceptions/${ex.body.id}/approve`, {}, d.users.sm.session)).status).toBe(403);
    expect(activeVin(w, b.id)).toBe("VINREL00000000001");
  });

  // The narrower gate. Allocation by hand is gone, so this is the one door to a named car, and it
  // answers to a shorter list of approvers than window extensions and outlet changes do.
  it("answers to its own list of approvers, not the one for ordinary exceptions", async () => {
    const w = makeWorld();
    const d = await makeDealer(w);
    const { b } = await held(w, d);
    const ex = await raise(w, d, b.id, { release_reason: "MANAGEMENT_PRIORITY", until: "2026-11-01" }, "Needed this week");
    // The Business Head approves exceptions, and by default releases too. Point releases at someone
    // else and the same person can still decide a window extension but no longer this.
    expect((await w.api("PUT", "/api/settings", { release_approver_roles: ["DEALER_PRINCIPAL"] }, d.users.admin.session)).status).toBe(200);
    expect((await w.api("POST", `/api/exceptions/${ex.body.id}/approve`, {}, d.users.head.session)).status).toBe(403);
    expect(one(w, `SELECT status FROM exceptions WHERE id = ?`, ex.body.id).status).toBe("PENDING");
    expect((await w.api("PUT", "/api/settings", { release_approver_roles: ["BUSINESS_HEAD"] }, d.users.admin.session)).status).toBe(200);
    expect((await approve(w, d, ex.body.id)).status).toBe(200);
  });

  // The role exists so that this decision sits above the day's running. Allocation by hand is
  // closed, so a release is the only way a named car reaches a named booking, and the person who
  // signs it off should not be the person running the queue.
  it("is what a Vice President is for", async () => {
    const w = makeWorld();
    const d = await makeDealer(w);
    const made = await w.api("POST", "/api/users", { name: "Varsha Prasad", mobile: "9000009999", role: "VP", password: PASSWORD, all_outlets: true, outlet_ids: [] }, d.users.admin.session);
    expect(made.status).toBe(201);
    // Every new user has to set a password before doing anything; the harness does the same for the
    // people it creates, and the point here is the role, not the first sign-in.
    w.db.raw.exec(`UPDATE users SET must_change_password = 0 WHERE tenant_id = '${d.tenantId}'`);
    const vp = await w.login(d.slug, "9000009999", PASSWORD);

    const { b } = await held(w, d);
    const ex = await raise(w, d, b.id, { release_reason: "MANAGEMENT_PRIORITY", until: "2026-11-01" }, "Board member's family");
    // A Sales Lead may ask but not decide, whatever else they can approve.
    expect((await w.api("POST", `/api/exceptions/${ex.body.id}/approve`, {}, d.users.sm.session)).status).toBe(403);
    expect((await w.api("POST", `/api/exceptions/${ex.body.id}/approve`, {}, vp)).status).toBe(200);
    expect(one(w, `SELECT decided_by FROM exceptions WHERE id = ?`, ex.body.id).decided_by).toBe(made.body.id);
  });

  it("will not take two requests for the same car at once", async () => {
    const w = makeWorld();
    const d = await makeDealer(w);
    const { b } = await held(w, d);
    expect((await raise(w, d, b.id, { release_reason: "MANAGEMENT_PRIORITY", until: "2026-11-01" }, "First ask")).status).toBe(201);
    expect((await raise(w, d, b.id, { release_reason: "BOOKING_CANCELLED", cancellation_ref: "CAN1" }, "Second ask")).status).toBe(409);
  });

  it("keeps a refused request, because a pattern of refusals is the point", async () => {
    const w = makeWorld();
    const d = await makeDealer(w);
    const { b } = await held(w, d);
    const ex = await raise(w, d, b.id, { release_reason: "MANAGEMENT_PRIORITY", until: "2026-11-01" }, "No particular reason");
    expect((await w.api("POST", `/api/exceptions/${ex.body.id}/reject`, { remarks: "Not good enough" }, d.users.head.session)).status).toBe(200);
    expect(one(w, `SELECT status, decision_remarks FROM exceptions WHERE id = ?`, ex.body.id)).toMatchObject({ status: "REJECTED", decision_remarks: "Not good enough" });
    expect(activeVin(w, b.id)).toBe("VINREL00000000001");
  });
});
