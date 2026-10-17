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
  const control = async (w: World, d: Dealer, from: string, to: string) =>
    (await w.api("GET", `/api/views/allocation-control?from=${from}&to=${to}`, undefined, d.users.head.session)).body;

  it("separates what this system decided from what the DMS did, day by day", async () => {
    const w = makeWorld("2026-10-13 10:00");
    // Two cars, two bookings: the queue allocates both here on day one.
    const d = await openWith(w, [car("VINCTL00000000001"), car("VINCTL00000000002")], [order("OTF27A000001", "01-Oct-2026 10:00 AM"), order("OTF27A000002", "02-Oct-2026 10:00 AM")]);
    const before = await control(w, d, "2026-10-13", "2026-10-13");
    expect(before.days[0]).toMatchObject({ date: "2026-10-13", by_system: 2, by_approved_request: 0, adopted_from_dms: 0, awaiting_entry_in_dms: 2, confirmed_in_dms: 0, violations: 0 });
    expect(before.controls_from).toBeNull();

    await controlFrom(w, d);
    w.at("2026-10-14 10:00");
    // Overnight: both are keyed into the DMS, and a third car turns up already allotted to a booking
    // this system has never heard of.
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

    const both = await control(w, d, "2026-10-13", "2026-10-14");
    expect(both.days.map((x: any) => x.date)).toEqual(["2026-10-13", "2026-10-14"]);
    // Day one, looked at again: the two this system decided are now confirmed, so the back office
    // has nothing left to key in for that day.
    expect(both.days[0]).toMatchObject({ by_system: 2, confirmed_in_dms: 2, awaiting_entry_in_dms: 0, violations: 0 });
    // Day two: nothing decided here, one allotment read from the DMS, and it is a violation.
    expect(both.days[1]).toMatchObject({ by_system: 0, adopted_from_dms: 1, unknown_booking: 1, overturned: 0, not_through_system: 0, violations: 1 });
    expect(both.totals).toMatchObject({ by_system: 2, adopted_from_dms: 1, violations: 1 });
    expect(both.violations[0]).toMatchObject({ date: "2026-10-14", kind: "UNKNOWN_BOOKING", booking_no: "OTF27A000077", vin: "VINCTL00000000003" });
    expect(both.controls_from).toBe("2026-10-14");
  });

  // An allotment made in the DMS arrives in a file, often days later and in a batch. Counting it on
  // the day the file was loaded would put a dealership's whole history on one spike and say nothing
  // about how it trades, so the DMS's own allotment date is the day it belongs to.
  it("dates an allotment by the day it happened, not the day the file arrived", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await openWith(w);
    await controlFrom(w, d, "2026-10-01");
    w.at("2026-10-16 10:00");
    await loadStock(w, d.users.admin.session, [car("VINOUT00000000001", { order: "OTF27A000055", type: "Alloted", allotDate: "2026-10-09", customer: "Walk In" })], { asOn: "2026-10-16" });
    const r = await control(w, d, "2026-10-05", "2026-10-16");
    const onNine = r.days.find((x: any) => x.date === "2026-10-09");
    const onSixteen = r.days.find((x: any) => x.date === "2026-10-16");
    expect(onNine).toMatchObject({ adopted_from_dms: 1, unknown_booking: 1 });
    expect(onSixteen).toMatchObject({ adopted_from_dms: 0, violations: 0 });
    expect(r.violations[0].date).toBe("2026-10-09");
  });
});

describe("what changed, day by day", () => {
  const delta = async (w: World, d: Dealer, from: string, to: string) => (await w.api("GET", `/api/views/daily-delta?from=${from}&to=${to}`, undefined, d.users.head.session)).body;
  const of = (r: any, code: string) => r.movements.find((m: any) => m.code === code);

  it("reads the movements the import already wrote down, dated by when they happened", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await openWith(w, [car("VINDLT00000000001")], [order("OTF27A000001", "10-Oct-2026 10:00 AM")]);
    w.at("2026-10-14 10:00");
    // A second car arrives, and one allotment is made in the DMS dated two days back.
    await loadStock(
      w,
      d.users.admin.session,
      [car("VINDLT00000000001", { order: "OTF27A000001", type: "Alloted", allotDate: "2026-10-14" }), car("VINDLT00000000002", { status: "In Transit" })],
      { asOn: "2026-10-14" },
    );
    const r = await delta(w, d, "2026-10-09", "2026-10-14");
    expect(r.dates).toHaveLength(6);
    // The booking is dated by the day the customer booked, not the day the sheet was read.
    expect(of(r, "B1").by_day[r.dates.indexOf("2026-10-10")]).toBe(1);
    // The queue gave the car out on the 13th; the DMS confirmed it on the 14th, which is not a
    // second allocation.
    expect(of(r, "A1").by_day[r.dates.indexOf("2026-10-13")]).toBe(1);
    expect(of(r, "A3").total).toBe(0);
    // Both cars arriving, and the second one still in transit so no GRN.
    expect(of(r, "S1").total).toBe(2);
    expect(of(r, "S2").total).toBe(0);
  });

  it("says plainly which movements need a file the dealership does not load yet", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await openWith(w);
    const r = await delta(w, d, "2026-10-13", "2026-10-13");
    const pending = r.movements.filter((m: any) => m.pending);
    // Marked and listed rather than dropped: a report that hides what it cannot see teaches people
    // to trust a number that is not whole.
    expect(pending.map((m: any) => m.code)).toEqual(["R2", "R3"]);
    expect(pending[0].note).toContain("retail export");
  });

  it("names the movements that are a question for somebody rather than a number", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await openWith(w, [car("VINDLT00000000001"), car("VINDLT00000000002")]);
    w.at("2026-10-14 10:00");
    // One car simply stops being listed, with no invoice to explain it.
    await loadStock(w, d.users.admin.session, [car("VINDLT00000000001")], { asOn: "2026-10-14", confirm: true });
    const r = await delta(w, d, "2026-10-13", "2026-10-14");
    expect(of(r, "S5").total).toBe(1);
    const row = r.rows.find((x: any) => x.code === "S5");
    expect(row).toMatchObject({ date: "2026-10-14", vin: "VINDLT00000000002" });
  });
});
