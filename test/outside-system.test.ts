// Allotments made in the DMS instead of here.
//
// The DMS is the record, not this system, so somebody can allot a car there directly and nothing
// here can stop them. What can be done is noticing. From the day the dealership puts allocation
// through this system, an allotment that appears in the DMS without having come through it is a
// violation: recorded against its booking, listed at day end, and put in front of the people who
// approve a car being taken back — they are the ones who would have had to agree to it.
//
// Before that day, and while no day is set, the DMS's allotments are simply the history of a
// dealership that was not running on this yet, and are taken on without comment.
//
// Three shapes, and they are three different conversations:
//
//   OVERTURNED          this system allocated a car and the DMS gave it elsewhere
//   UNKNOWN_BOOKING     a booking this system never had, already allotted in the DMS
//   NOT_THROUGH_SYSTEM  a booking waiting in the queue here, allotted without being asked

import { describe, expect, it } from "vitest";
import { loadBookings, loadStock, makeMahindraDealer, makeWorld, type BookingLine, type Dealer, type StockLine, type World } from "./harness";

const car = (vin: string, extra: Partial<StockLine> = {}): StockLine => ({ vin, car: "THAR_WHITE", loc: "PATIA", ...extra });
const order = (no: string, created: string, extra: Partial<BookingLine> = {}): BookingLine => ({ no, car: "THAR_WHITE", loc: "PATIA", created, ...extra });

/** The day this dealership put allocation through the system. */
const controlFrom = (w: World, d: Dealer, date = "2026-10-14") => w.api("PUT", "/api/settings", { allocation_control_from: date }, d.users.admin.session);

const violations = (w: World) =>
  w.db.q<{ entity_id: string; detail_json: string }>(`SELECT entity_id, detail_json FROM audit_log WHERE action = 'ALLOTTED_OUTSIDE_SYSTEM' ORDER BY at`).map((r) => JSON.parse(r.detail_json));
const kinds = (w: World) => violations(w).map((v) => v.violation);
const recon = (w: World) => w.db.q<{ severity: string; message: string }>(`SELECT severity, message FROM recon_items WHERE category = 'OUTSIDE_SYSTEM_ALLOTMENT'`);

/** Day one: one free car at Patia and nothing else. Returns the dealership. */
async function openWith(w: World, lines: StockLine[] = [car("VINOUT00000000001")], bookings: BookingLine[] = []) {
  const d = await makeMahindraDealer(w);
  if (bookings.length) await loadBookings(w, d.users.admin.session, bookings);
  await loadStock(w, d.users.admin.session, lines, { asOn: "2026-10-13" });
  return d;
}

describe("before the dealership puts allocation through the system", () => {
  it("takes the DMS's allotments on without comment when no day has been set", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await openWith(w);
    w.at("2026-10-14 10:00");
    await loadStock(w, d.users.admin.session, [car("VINOUT00000000001", { order: "OTF27A000002", type: "Alloted", allotDate: "2026-10-14", customer: "Walk In" })], { asOn: "2026-10-14" });
    expect(violations(w)).toHaveLength(0);
  });

  it("says nothing about a report that pre-dates the day", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await openWith(w);
    await controlFrom(w, d, "2026-10-20");
    w.at("2026-10-14 10:00");
    await loadStock(w, d.users.admin.session, [car("VINOUT00000000001", { order: "OTF27A000002", type: "Alloted", allotDate: "2026-10-14", customer: "Walk In" })], { asOn: "2026-10-14" });
    expect(violations(w)).toHaveLength(0);
  });
});

describe("from the day it does", () => {
  it("flags a booking this system never had, already allotted in the DMS", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await openWith(w);
    await controlFrom(w, d);
    w.at("2026-10-14 10:00");
    await loadStock(w, d.users.admin.session, [car("VINOUT00000000001", { order: "OTF27A000002", type: "Alloted", allotDate: "2026-10-14", customer: "Walk In" })], { asOn: "2026-10-14" });
    expect(kinds(w)).toEqual(["UNKNOWN_BOOKING"]);
    expect(violations(w)[0]).toMatchObject({ vin: "VINOUT00000000001", booking_no: "OTF27A000002" });
    // The allotment stands: the DMS is the record and the customer has been told.
    expect(w.db.q(`SELECT b.booking_no FROM allocations a JOIN bookings b ON b.id = a.booking_id WHERE a.status = 'ACTIVE'`)).toEqual([{ booking_no: "OTF27A000002" }]);
  });

  it("flags a booking that was waiting in the queue here and was gone round", async () => {
    const w = makeWorld("2026-10-13 10:00");
    // A booking and no car at all, so this system is holding nothing for it: it is simply waiting.
    const d = await openWith(w, [], [order("OTF27A000001", "01-Oct-2026 10:00 AM")]);
    await controlFrom(w, d);
    w.at("2026-10-14 10:00");
    // Overnight a car arrives and the DMS has already put this booking on it.
    await loadStock(w, d.users.admin.session, [car("VINOUT00000000002", { order: "OTF27A000001", type: "Alloted", allotDate: "2026-10-14" })], { asOn: "2026-10-14" });
    expect(kinds(w)).toEqual(["NOT_THROUGH_SYSTEM"]);
  });

  it("flags an allocation this system made that the DMS gave to somebody else", async () => {
    const w = makeWorld("2026-10-13 10:00");
    // Two real bookings, both known here. The queue gives the car to the earlier one.
    const d = await openWith(w, [car("VINOUT00000000001")], [order("OTF27A000001", "01-Oct-2026 10:00 AM"), order("OTF27A000009", "05-Oct-2026 10:00 AM")]);
    expect(w.db.q(`SELECT b.booking_no FROM allocations a JOIN bookings b ON b.id = a.booking_id WHERE a.status = 'ACTIVE'`)).toEqual([{ booking_no: "OTF27A000001" }]);
    await controlFrom(w, d);
    w.at("2026-10-14 10:00");
    await loadStock(w, d.users.admin.session, [car("VINOUT00000000001", { order: "OTF27A000009", type: "Alloted", allotDate: "2026-10-14" })], { asOn: "2026-10-14" });
    const v = violations(w).find((x) => x.violation === "OVERTURNED");
    expect(v).toBeTruthy();
    expect(v).toMatchObject({ vin: "VINOUT00000000001", booking_no: "OTF27A000009", taken_from_booking_no: "OTF27A000001" });
  });

  it("flags a booking given a different car from the one this system allocated it", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await openWith(w, [car("VINOUT00000000001")], [order("OTF27A000001", "01-Oct-2026 10:00 AM")]);
    await controlFrom(w, d);
    w.at("2026-10-14 10:00");
    await loadStock(w, d.users.admin.session, [car("VINOUT00000000001"), car("VINOUT00000000002", { order: "OTF27A000001", type: "Alloted", allotDate: "2026-10-14" })], { asOn: "2026-10-14" });
    const v = violations(w).find((x) => x.instead_of_vehicle_id);
    expect(v).toMatchObject({ violation: "OVERTURNED", vin: "VINOUT00000000002", booking_no: "OTF27A000001" });
  });

  // The ordinary path, and the one that must stay quiet: this system allocates, the back office keys
  // that allotment into the DMS, and the next report confirms it. Flagging this would make the whole
  // check worthless within a week.
  it("stays quiet when the DMS is only confirming what this system decided", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await openWith(w, [car("VINOUT00000000001")], [order("OTF27A000001", "01-Oct-2026 10:00 AM")]);
    await controlFrom(w, d);
    w.at("2026-10-14 10:00");
    await loadStock(w, d.users.admin.session, [car("VINOUT00000000001", { order: "OTF27A000001", type: "Alloted", allotDate: "2026-10-14" })], { asOn: "2026-10-14" });
    expect(violations(w)).toHaveLength(0);
  });

  // A car that arrives already billed was decided and sold before this system saw it. Reporting it
  // here would raise a second item for something OUTSIDE_ALLOCATION already covers.
  it("is not raised for a car that arrives already invoiced", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await openWith(w);
    await controlFrom(w, d);
    w.at("2026-10-14 10:00");
    await loadStock(w, d.users.admin.session, [car("VINOUT00000000001", { order: "OTF27A000003", type: "IBND", allotDate: "2026-10-14", invoiceId: "INV-0003", invoiceDate: "2026-10-14", customer: "Walk In" })], { asOn: "2026-10-14" });
    expect(violations(w)).toHaveLength(0);
  });
});

describe("what happens to a violation", () => {
  it("reaches the day-end check, named for what it actually is", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await openWith(w);
    await controlFrom(w, d);
    w.at("2026-10-14 10:00");
    await loadStock(w, d.users.admin.session, [car("VINOUT00000000001", { order: "OTF27A000002", type: "Alloted", allotDate: "2026-10-14", customer: "Walk In" })], { asOn: "2026-10-14" });
    expect((await w.api("POST", "/api/recon/run", undefined, d.users.admin.session)).status).toBe(201);
    const items = recon(w);
    expect(items).toHaveLength(1);
    expect(items[0].severity).toBe("HIGH");
    expect(items[0].message).toContain("was never in this system");
    expect(items[0].message).toContain("VINOUT00000000001");
  });

  it("is put in front of the people who approve a car being taken back", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await openWith(w);
    await controlFrom(w, d);
    w.at("2026-10-14 10:00");
    await loadStock(w, d.users.admin.session, [car("VINOUT00000000001", { order: "OTF27A000002", type: "Alloted", allotDate: "2026-10-14", customer: "Walk In" })], { asOn: "2026-10-14" });
    // The release approvers, because they are the ones who would have had to agree to this.
    const alerts = w.db.q<{ target_role: string; title: string; body: string }>(`SELECT target_role, title, body FROM alerts WHERE kind = 'OUTSIDE_SYSTEM_ALLOTMENT'`);
    expect(alerts.map((a) => a.target_role).sort()).toEqual(["BUSINESS_HEAD", "VP"]);
    expect(alerts[0].title).toBe("1 car allotted outside the system");
    expect(alerts[0].body).toContain("never seen");
  });
});

describe("the day's allocation control, in numbers", () => {
  it("separates what this system decided from what the DMS did, and counts the violations by kind", async () => {
    const w = makeWorld("2026-10-13 10:00");
    // Two cars, two bookings: the queue allocates both here on day one.
    const d = await openWith(w, [car("VINCTL00000000001"), car("VINCTL00000000002")], [order("OTF27A000001", "01-Oct-2026 10:00 AM"), order("OTF27A000002", "02-Oct-2026 10:00 AM")]);
    const day1 = (await w.api("GET", "/api/views/allocation-control?date=2026-10-13", undefined, d.users.head.session)).body;
    expect(day1.allocated).toMatchObject({ by_system: 2, by_approved_request: 0, adopted_from_dms: 0, total: 2 });
    // Neither has been keyed into the DMS yet: both are the back office's to enter.
    expect(day1.awaiting_entry_in_dms).toBe(2);
    expect(day1.confirmed_in_dms).toBe(0);
    expect(day1.in_control).toBe(false);

    await controlFrom(w, d);
    w.at("2026-10-14 10:00");
    // Overnight: one of them is keyed in correctly, the other is given to somebody the system has
    // never heard of, and a third car turns up already allotted to an unknown booking.
    await loadStock(
      w,
      d.users.admin.session,
      [
        car("VINCTL00000000001", { order: "OTF27A000001", type: "Alloted", allotDate: "2026-10-14" }),
        car("VINCTL00000000002", { order: "OTF27A000002", type: "Alloted", allotDate: "2026-10-14" }),
        car("VINCTL00000000003", { order: "OTF27A000077", type: "Alloted", allotDate: "2026-10-14", customer: "Walk In" }),
      ],
      { asOn: "2026-10-14" },
    );
    const day2 = (await w.api("GET", "/api/views/allocation-control?date=2026-10-14", undefined, d.users.head.session)).body;
    expect(day2.in_control).toBe(true);
    expect(day2.controls_from).toBe("2026-10-14");
    // The two the DMS confirmed were allocated on the 13th, so they are not counted again today.
    expect(day2.allocated).toMatchObject({ by_system: 0, adopted_from_dms: 1 });
    expect(day2.violations).toMatchObject({ total: 1, unknown_booking: 1, overturned: 0, not_through_system: 0 });
    expect(day2.violations.rows[0]).toMatchObject({ kind: "UNKNOWN_BOOKING", booking_no: "OTF27A000077", vin: "VINCTL00000000003" });

    // Yesterday's two allocations are now confirmed, so the back office has nothing left to key in.
    const back = (await w.api("GET", "/api/views/allocation-control?date=2026-10-13", undefined, d.users.head.session)).body;
    expect(back).toMatchObject({ confirmed_in_dms: 2, awaiting_entry_in_dms: 0 });
  });
});
