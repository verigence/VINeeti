// What the DMS has not been told yet.
//
// This system decides and the DMS records, which leaves a gap: until somebody keys a decision in,
// the two disagree. The list is built from that disagreement rather than from what changed today, so
// a line nobody acted on is still there tomorrow, and a line goes on its own once a stock report
// shows the DMS agreeing. What is worth guarding hardest is what it leaves OUT: the DMS does not
// need telling about decisions it made itself.
import { describe, expect, it } from "vitest";
import { loadBookings, loadStock, makeMahindraDealer, makeWorld, type BookingLine, type Dealer, type StockLine, type World } from "./harness";

const WHITE_THAR: StockLine = { vin: "MA1THAR0000000001", car: "THAR_WHITE", oemInvoiceDate: "2026-09-20", grnDate: "2026-09-25" };
const wants = (no: string, customer: string, created = "01-Oct-2026 10:00 AM"): BookingLine => ({ no, car: "THAR_WHITE", created, customer });

const sheet = (w: World, d: Dealer) => w.api("GET", "/api/reports/dms-writeback", undefined, d.users.head.session);
const rows = async (w: World, d: Dealer) => (await sheet(w, d)).body.rows as any[];
const bookingId = (w: World, no: string) => w.db.q<{ id: string }>(`SELECT id FROM bookings WHERE booking_no = ?`, no)[0].id;

/** Raises a release request and has the Business Head approve it. */
async function release(w: World, d: Dealer, no: string, payload: Record<string, unknown>, reason = "Because of the following") {
  const ex = await w.api("POST", "/api/exceptions", { type: "RELEASE_ALLOCATION", booking_id: bookingId(w, no), payload, reason }, d.users.lead.session);
  if (ex.status !== 201) throw new Error(`request not raised: ${JSON.stringify(ex.body)}`);
  const ok = await w.api("POST", `/api/exceptions/${ex.body.id}/approve`, {}, d.users.head.session);
  if (ok.status !== 200) throw new Error(`not approved: ${JSON.stringify(ok.body)}`);
  return ex.body.id as string;
}

describe("the changes the DMS has not been told about", () => {
  it("lists a car this system allocated that the DMS does not show against that booking", async () => {
    const w = makeWorld("2026-10-14 10:00");
    const d = await makeMahindraDealer(w);
    await loadStock(w, d.users.stock.session, [WHITE_THAR], { asOn: "2026-10-14" });
    await loadBookings(w, d.users.crm.session, [wants("OTF27A000001", "WAITING ONE")]);

    const list = await rows(w, d);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      action: "ALLOT",
      booking_no: "OTF27A000001",
      customer_name: "WAITING ONE",
      vin: "MA1THAR0000000001",
      dms_shows: "Free stock",
      reason: "Allocated by the queue",
    });
    expect(list[0].instruction).toBe("Allot MA1THAR0000000001 to booking OTF27A000001");
    expect(list[0].days_waiting).toBe(0);
  });

  it("drops the line by itself once a stock report shows the DMS agreeing", async () => {
    const w = makeWorld("2026-10-14 10:00");
    const d = await makeMahindraDealer(w);
    await loadStock(w, d.users.stock.session, [WHITE_THAR], { asOn: "2026-10-14" });
    await loadBookings(w, d.users.crm.session, [wants("OTF27A000001", "WAITING ONE")]);
    expect((await rows(w, d)).map((r) => r.action)).toEqual(["ALLOT"]);

    // The back office keys it in; tomorrow's report comes back with the allotment on it. Nothing is
    // ticked off anywhere: the line goes because the disagreement it was made of has gone.
    w.at("2026-10-15 09:00");
    await loadStock(w, d.users.stock.session, [{ ...WHITE_THAR, order: "OTF27A000001", customer: "WAITING ONE", allotDate: "2026-10-15" }], { asOn: "2026-10-15" });
    expect(await rows(w, d)).toEqual([]);
  });

  it("asks for the allotment to be removed when this system has let the car go but the DMS still shows it", async () => {
    const w = makeWorld("2026-10-14 10:00");
    const d = await makeMahindraDealer(w);
    await loadBookings(w, d.users.crm.session, [wants("OTF27A000001", "WAITING ONE")]);
    await loadStock(w, d.users.stock.session, [{ ...WHITE_THAR, order: "OTF27A000001", customer: "WAITING ONE", allotDate: "2026-10-14" }], { asOn: "2026-10-14" });
    expect(await rows(w, d)).toEqual([]); // the two agree

    // A release decided here. The DMS knows nothing of it until somebody tells it.
    await release(w, d, "OTF27A000001", { release_reason: "MANAGEMENT_PRIORITY", until: "2026-11-30" }, "Needed for a demonstration");

    const list = await rows(w, d);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      action: "REMOVE_ALLOTMENT",
      booking_no: "OTF27A000001",
      vin: "MA1THAR0000000001",
      reason: "Priority changed by management",
      dms_shows: "Allotted to OTF27A000001",
    });
    expect(list[0].instruction).toBe("Remove the allotment of MA1THAR0000000001 from booking OTF27A000001");
    expect(list[0].by).toBe("Bikram Head");
  });

  it("says nothing about an allotment the DMS made itself", async () => {
    const w = makeWorld("2026-10-14 10:00");
    const d = await makeMahindraDealer(w);
    await loadBookings(w, d.users.crm.session, [wants("OTF27A000001", "WAITING ONE")]);
    // Allotted in the DMS and read from the report: already true there, so there is nothing to key.
    await loadStock(w, d.users.stock.session, [{ ...WHITE_THAR, order: "OTF27A000001", customer: "WAITING ONE", allotDate: "2026-10-14" }], { asOn: "2026-10-14" });
    expect(await rows(w, d)).toEqual([]);
  });

  it("says nothing about a release the DMS already knows about", async () => {
    const w = makeWorld("2026-10-14 10:00");
    const d = await makeMahindraDealer(w);
    await loadBookings(w, d.users.crm.session, [wants("OTF27A000001", "WAITING ONE"), wants("OTF27A000002", "WALKED IN", "02-Oct-2026 10:00 AM")]);
    await loadStock(w, d.users.stock.session, [{ ...WHITE_THAR, order: "OTF27A000001", customer: "WAITING ONE", allotDate: "2026-10-14" }], { asOn: "2026-10-14" });
    expect(await rows(w, d)).toEqual([]);

    // The DMS gives the car to the other booking. This system lets go of it, but the release came
    // out of the DMS in the first place: asking the DMS to remove an allotment it has already moved
    // would be this system correcting the DMS about the DMS's own facts.
    w.at("2026-10-15 09:00");
    await loadStock(w, d.users.stock.session, [{ ...WHITE_THAR, order: "OTF27A000002", customer: "WALKED IN", allotDate: "2026-10-15" }], { asOn: "2026-10-15" });
    expect((await rows(w, d)).filter((r) => r.action === "REMOVE_ALLOTMENT")).toEqual([]);
  });

  it("puts removals before the allotments that depend on them", async () => {
    const w = makeWorld("2026-10-14 10:00");
    const d = await makeMahindraDealer(w);
    await loadBookings(w, d.users.crm.session, [wants("OTF27A000001", "HOLDING IT"), wants("OTF27A000002", "GETTING IT", "02-Oct-2026 10:00 AM")]);
    await loadStock(w, d.users.stock.session, [{ ...WHITE_THAR, order: "OTF27A000001", customer: "HOLDING IT", allotDate: "2026-10-14" }], { asOn: "2026-10-14" });

    await release(w, d, "OTF27A000001", { release_reason: "MANAGEMENT_PRIORITY", until: "2026-11-30", to_booking_id: bookingId(w, "OTF27A000002") }, "Fleet order agreed");

    // A car cannot go onto the second booking in the DMS until it comes off the first, and a sheet
    // worked down in the wrong order is rejected for a reason nobody enjoys diagnosing.
    const list = await rows(w, d);
    expect(list.map((r) => [r.action, r.booking_no])).toEqual([
      ["REMOVE_ALLOTMENT", "OTF27A000001"],
      ["ALLOT", "OTF27A000002"],
    ]);
    expect(list[0].paired_with).toBe("Then allot it to OTF27A000002");
  });

  it("never asks for a completed sale to be reversed", async () => {
    const w = makeWorld("2026-10-14 10:00");
    const d = await makeMahindraDealer(w);
    await loadBookings(w, d.users.crm.session, [wants("OTF27A000001", "WAITING ONE"), wants("OTF27A000002", "WALKED IN", "02-Oct-2026 10:00 AM")]);
    await loadStock(w, d.users.stock.session, [{ ...WHITE_THAR, order: "OTF27A000001", customer: "WAITING ONE", allotDate: "2026-10-14" }], { asOn: "2026-10-14" });
    await w.api("PUT", "/api/settings", { allocation_control_from: "2026-10-14" }, d.users.admin.session);

    // The car comes back invoiced to the other order. A merely-allotted car would be put back, but
    // this one has been sold: there is a customer with paperwork and most likely the car itself.
    // Undoing that is not a data correction and must never arrive as a line on an upload sheet.
    w.at("2026-10-15 09:00");
    await loadStock(w, d.users.stock.session, [{ ...WHITE_THAR, order: "OTF27A000002", customer: "WALKED IN", type: "IBND", invoiceId: "INV27A000001", allotDate: "2026-10-15" }], { asOn: "2026-10-15" });

    for (const r of await rows(w, d)) expect(r.vin).not.toBe("MA1THAR0000000001");
    // It is not silently dropped either: the approvers are told, because a car this system was
    // holding for one customer was sold to another.
    const raised = w.db.q<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'ALLOTTED_OUTSIDE_SYSTEM'`)[0].n;
    expect(raised).toBeGreaterThan(0);
  });

  it("accounts for every allocation, so the difference from the allocations report is not a mystery", async () => {
    const w = makeWorld("2026-10-14 10:00");
    const d = await makeMahindraDealer(w);
    await loadBookings(w, d.users.crm.session, [wants("OTF27A000001", "ALREADY IN"), wants("OTF27A000002", "NOT YET", "02-Oct-2026 10:00 AM")]);
    // One car the DMS already shows against its booking, one the DMS has not been told about.
    await loadStock(w, d.users.stock.session, [
      { ...WHITE_THAR, order: "OTF27A000001", customer: "ALREADY IN", allotDate: "2026-10-14" },
      { vin: "MA1THAR0000000002", car: "THAR_WHITE", oemInvoiceDate: "2026-09-20", grnDate: "2026-09-25" },
    ], { asOn: "2026-10-14" });

    const r = (await sheet(w, d)).body.reconcile;
    // The list carries one line; the other allocation is accounted for rather than unexplained.
    expect(r.to_allot).toBe(1);
    expect(r.confirmed).toBe(1);
    expect(r.total).toBe(2);
    // Whatever the shape, the lines add up to every allocation on record. That is the whole point:
    // a reader can finish the arithmetic without being told where the rest went.
    expect(r.confirmed + r.to_allot + r.to_remove + r.sold_elsewhere + r.released_settled + r.fulfilled).toBe(r.total);
  });

  it("gives the same list as a spreadsheet", async () => {
    const w = makeWorld("2026-10-14 10:00");
    const d = await makeMahindraDealer(w);
    await loadStock(w, d.users.stock.session, [WHITE_THAR], { asOn: "2026-10-14" });
    await loadBookings(w, d.users.crm.session, [wants("OTF27A000001", "WAITING ONE")]);
    const res = await w.api("GET", "/api/reports/dms-writeback?format=xlsx", undefined, d.users.head.session);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("spreadsheetml");
    expect(res.headers.get("content-disposition")).toContain("dms-updates-2026-10-14.xlsx");
  });
});
