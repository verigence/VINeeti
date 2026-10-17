// The DMS is the record, not this system, so somebody can allot a car there directly and nothing
// here can stop them. What can be done is noticing: the next stock report carries an allotment the
// system never made, and that difference against what the system held yesterday is the only way
// anyone finds out it happened.
//
// The allotment itself is not undone. The DMS is the record and the customer has been told; what is
// reported is that the decision was made somewhere else.

import { describe, expect, it } from "vitest";
import { CARS, loadBookings, loadStock, makeMahindraDealer, makeWorld, type BookingLine, type StockLine, type World } from "./harness";

const car = (vin: string, extra: Partial<StockLine> = {}): StockLine => ({ vin, car: "THAR_WHITE", loc: "PATIA", ...extra });
const order = (no: string, created: string, extra: Partial<BookingLine> = {}): BookingLine => ({ no, car: "THAR_WHITE", loc: "PATIA", created, ...extra });

const audits = (w: World, action: string) => w.db.q<{ entity_id: string; detail_json: string }>(`SELECT entity_id, detail_json FROM audit_log WHERE action = ? ORDER BY at`, action);
const recon = (w: World, category: string) => w.db.q<{ severity: string; message: string }>(`SELECT severity, message FROM recon_items WHERE category = ?`, category);

describe("an allotment made in the DMS instead of here", () => {
  it("is not flagged on the first stock report, when every allotment pre-dates the system", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeMahindraDealer(w);
    await loadBookings(w, d.users.admin.session, [order("OTF27A000001", "01-Oct-2026 10:00 AM")]);
    // The opening position: the dealership's existing allotments come in as they stand. Flagging
    // every one of them would bury the ones that matter from tomorrow onwards.
    await loadStock(w, d.users.admin.session, [car("VINOUT00000000001", { order: "OTF27A000001", type: "Alloted", allotDate: "2026-10-01" })]);
    expect(audits(w, "ALLOTTED_OUTSIDE_SYSTEM")).toHaveLength(0);
  });

  it("is flagged when it turns up in a later report", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeMahindraDealer(w);
    // Day one: a free car and nobody waiting for it, so the system allocates nothing and holds nothing.
    await loadStock(w, d.users.admin.session, [car("VINOUT00000000001")], { asOn: "2026-10-13" });
    expect(audits(w, "ALLOTTED_OUTSIDE_SYSTEM")).toHaveLength(0);

    // Overnight somebody allots it in the DMS, to an order this system has never seen.
    w.at("2026-10-14 10:00");
    await loadStock(w, d.users.admin.session, [car("VINOUT00000000001", { order: "OTF27A000002", type: "Alloted", allotDate: "2026-10-14", customer: "Walk In" })], { asOn: "2026-10-14" });
    const found = audits(w, "ALLOTTED_OUTSIDE_SYSTEM");
    expect(found).toHaveLength(1);
    const detail = JSON.parse(found[0].detail_json);
    expect(detail).toMatchObject({ vin: "VINOUT00000000001", booking_no: "OTF27A000002", stock_type: "ALLOTED" });

    // The allotment stands — the DMS is the record — and the car is that booking's.
    expect(w.db.q(`SELECT b.booking_no FROM allocations a JOIN bookings b ON b.id = a.booking_id WHERE a.status = 'ACTIVE'`)).toEqual([{ booking_no: "OTF27A000002" }]);
  });

  it("reaches the day-end check as something for a person to answer for", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeMahindraDealer(w);
    await loadStock(w, d.users.admin.session, [car("VINOUT00000000001")], { asOn: "2026-10-13" });
    w.at("2026-10-14 10:00");
    await loadStock(w, d.users.admin.session, [car("VINOUT00000000001", { order: "OTF27A000002", type: "Alloted", allotDate: "2026-10-14", customer: "Walk In" })], { asOn: "2026-10-14" });
    expect((await w.api("POST", "/api/recon/run", undefined, d.users.admin.session)).status).toBe(201);
    const items = recon(w, "OUTSIDE_SYSTEM_ALLOTMENT");
    expect(items).toHaveLength(1);
    expect(items[0].severity).toBe("HIGH");
    expect(items[0].message).toContain("VINOUT00000000001");
    expect(items[0].message).toContain("without going through the system");
  });

  // The ordinary path, and the one that must stay quiet: the system allocates, the back office keys
  // that allotment into the DMS, and tomorrow's report simply confirms it. Flagging this would make
  // the report worthless within a week.
  it("stays quiet when the DMS is only confirming what the system already decided", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeMahindraDealer(w);
    await loadBookings(w, d.users.admin.session, [order("OTF27A000001", "01-Oct-2026 10:00 AM")]);
    await loadStock(w, d.users.admin.session, [car("VINOUT00000000001")], { asOn: "2026-10-13" });
    // The system allocated it to the waiting booking when the car arrived.
    const held = w.db.q<{ booking_no: string }>(`SELECT b.booking_no FROM allocations a JOIN bookings b ON b.id = a.booking_id WHERE a.status = 'ACTIVE'`);
    expect(held).toEqual([{ booking_no: "OTF27A000001" }]);

    w.at("2026-10-14 10:00");
    await loadStock(w, d.users.admin.session, [car("VINOUT00000000001", { order: "OTF27A000001", type: "Alloted", allotDate: "2026-10-14" })], { asOn: "2026-10-14" });
    expect(audits(w, "ALLOTTED_OUTSIDE_SYSTEM")).toHaveLength(0);
  });

  // A car that arrives already billed was decided and sold before this system saw it, which is
  // ordinary for a booking that never passed through here. Reporting it as an allotment made outside
  // the system would raise a second item for something OUTSIDE_ALLOCATION already covers, and would
  // fill the day-end check with noise for any dealership not yet running everything through here.
  it("is not raised for a car that arrives already invoiced", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeMahindraDealer(w);
    await loadStock(w, d.users.admin.session, [car("VINOUT00000000001")], { asOn: "2026-10-13" });
    w.at("2026-10-14 10:00");
    await loadStock(
      w,
      d.users.admin.session,
      [car("VINOUT00000000001", { order: "OTF27A000003", type: "IBND", allotDate: "2026-10-14", invoiceId: "INV-0003", invoiceDate: "2026-10-14", customer: "Walk In" })],
      { asOn: "2026-10-14" },
    );
    expect(audits(w, "ALLOTTED_OUTSIDE_SYSTEM")).toHaveLength(0);
  });

  it("is flagged when the DMS gives the booking a different car from the one the system reserved", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeMahindraDealer(w);
    await loadBookings(w, d.users.admin.session, [order("OTF27A000001", "01-Oct-2026 10:00 AM")]);
    await loadStock(w, d.users.admin.session, [car("VINOUT00000000001")], { asOn: "2026-10-13" });
    const reserved = w.db.q<{ vin: string }>(`SELECT v.vin FROM allocations a JOIN vehicles v ON v.id = a.vehicle_id WHERE a.status = 'ACTIVE'`);
    expect(reserved).toEqual([{ vin: "VINOUT00000000001" }]);

    // A second car arrives and the DMS puts the booking on that one instead.
    w.at("2026-10-14 10:00");
    await loadStock(
      w,
      d.users.admin.session,
      [car("VINOUT00000000001"), car("VINOUT00000000002", { order: "OTF27A000001", type: "Alloted", allotDate: "2026-10-14" })],
      { asOn: "2026-10-14" },
    );
    const found = audits(w, "ALLOTTED_OUTSIDE_SYSTEM");
    expect(found).toHaveLength(1);
    expect(JSON.parse(found[0].detail_json)).toMatchObject({ vin: "VINOUT00000000002", booking_no: "OTF27A000001" });
    expect(JSON.parse(found[0].detail_json).instead_of_vehicle_id).toBeTruthy();
  });
});

// Keeps the fixture honest: the car used throughout is the one the booking sheet asks for, or none
// of the above would be testing what it claims to.
it("the test cars and orders are for the same vehicle", () => {
  expect(CARS.THAR_WHITE.is.model).toBe("THAR");
});
