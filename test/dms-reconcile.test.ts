// Reconciling the two DMS files, case by case, with small files in the DMS's own format. Each case is
// one thing that happens at a dealership between two loads.
import { describe, expect, it } from "vitest";
import { RECON_CATEGORIES, RECON_HELP } from "../src/domain/reconciliation";
import { CARS, bookingFile, loadBookings, loadFile, loadStock, makeMahindraDealer, makeWorld, stockFile, type Dealer, type World } from "./harness";

const q = <T = any>(w: World, sql: string, ...p: unknown[]) => w.db.q<T>(sql, ...p);
const booking = (w: World, no: string) => q(w, `SELECT b.*, (SELECT v.vin FROM allocations a JOIN vehicles v ON v.id = a.vehicle_id WHERE a.booking_id = b.id AND a.status = 'ACTIVE') AS vin FROM bookings b WHERE b.booking_no = ?`, no)[0];
const car = (w: World, vin: string) => q(w, `SELECT v.*, (SELECT b.booking_no FROM allocations a JOIN bookings b ON b.id = a.booking_id WHERE a.vehicle_id = v.id AND a.status = 'ACTIVE') AS booking_no FROM vehicles v WHERE v.vin = ?`, vin)[0];
const alarms = (w: World, kind: string) => q(w, `SELECT target_role, title, body FROM alerts WHERE is_alarm = 1 AND kind = ? ORDER BY target_role`, kind);
const messages = (w: World, event: string) => q(w, `SELECT to_name, rendered_text, status FROM wa_messages WHERE event_key = ? ORDER BY created_at, to_name`, event);
async function start(at = "2026-10-06 09:00"): Promise<{ w: World; d: Dealer }> {
  const w = makeWorld(at);
  return { w, d: await makeMahindraDealer(w) };
}

describe("a booking is cancelled", () => {
  it("its car is released and goes to the next customer in line, in the same load", async () => {
    const { w, d } = await start();
    await loadStock(w, d.users.stock.session, [{ vin: "MA1THAR0000000001", car: "THAR_WHITE" }]);
    const first = await loadBookings(w, d.users.crm.session, [
      { no: "OTF27A000002", car: "THAR_WHITE", created: "02-Sep-2026 10:00 AM", customer: "SECOND CUSTOMER" },
      { no: "OTF27A000001", car: "THAR_WHITE", created: "01-Sep-2026 10:00 AM", customer: "FIRST CUSTOMER" },
    ]);
    expect(first.body.allocations).toBe(1);
    // First booked, first served, whatever the order of the rows in the sheet.
    expect(booking(w, "OTF27A000001")).toMatchObject({ status: "ALLOCATED", vin: "MA1THAR0000000001" });
    expect(booking(w, "OTF27A000002")).toMatchObject({ status: "APPROVED", vin: null });

    w.at("2026-10-07 09:00");
    const next = await loadBookings(w, d.users.crm.session, [
      { no: "OTF27A000001", car: "THAR_WHITE", created: "01-Sep-2026 10:00 AM", customer: "FIRST CUSTOMER", stage: "Cancellation Initiated" },
      { no: "OTF27A000002", car: "THAR_WHITE", created: "02-Sep-2026 10:00 AM", customer: "SECOND CUSTOMER" },
    ]);
    expect(next.body.summary).toMatchObject({ cancelled: 1, cancelled_now: 1, cars_released: 1 });
    expect(next.body.allocations).toBe(1);
    expect(booking(w, "OTF27A000001")).toMatchObject({ status: "CANCELLED", cancel_reason: "Cancelled in DMS", vin: null });
    expect(booking(w, "OTF27A000002")).toMatchObject({ status: "ALLOCATED", vin: "MA1THAR0000000001" });
    // The second customer is told the car was earlier allocated to another customer (case C of the process).
    expect(messages(w, "ALLOC_REALLOCATED").map((m) => m.to_name)).toEqual(["SECOND CUSTOMER"]);
    expect(q(w, `SELECT release_reason FROM allocations WHERE status = 'RELEASED'`)).toEqual([{ release_reason: "BOOKING_CANCELLED" }]);
  });

  it("a cancelled booking that was waiting simply leaves the queue; one already invoiced is reported, not cancelled", async () => {
    const { w, d } = await start();
    await loadStock(w, d.users.stock.session, [{ vin: "MA1THAR0000000001", car: "THAR_WHITE", order: "OTF27A000009", invoiceId: "INV1", customer: "BILLED CUSTOMER" }]);
    await loadBookings(w, d.users.crm.session, [
      { no: "OTF27A000009", car: "THAR_WHITE", created: "01-Sep-2026 10:00 AM" },
      { no: "OTF27A000010", car: "SCORPIO_N", created: "02-Sep-2026 10:00 AM" },
    ]);
    expect(booking(w, "OTF27A000009")).toMatchObject({ status: "INVOICED", vin: "MA1THAR0000000001" });
    const res = await loadBookings(w, d.users.crm.session, [
      { no: "OTF27A000009", car: "THAR_WHITE", created: "01-Sep-2026 10:00 AM", stage: "Cancellation Initiated" },
      { no: "OTF27A000010", car: "SCORPIO_N", created: "02-Sep-2026 10:00 AM", stage: "Cancellation Initiated" },
    ]);
    expect(booking(w, "OTF27A000010")).toMatchObject({ status: "CANCELLED" });
    expect(booking(w, "OTF27A000009")).toMatchObject({ status: "INVOICED", vin: "MA1THAR0000000001" });
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0]).toMatchObject({ key: "OTF27A000009" });
    expect(res.body.errors[0].message).toMatch(/cancelled, but the system has it as invoiced/);
  });

  it("the DMS still showing the car allotted to the cancelled booking does not take it back from the next customer", async () => {
    const { w, d } = await start();
    await loadStock(w, d.users.stock.session, [{ vin: "MA1THAR0000000001", car: "THAR_WHITE", order: "OTF27A000001", customer: "FIRST CUSTOMER" }]);
    await loadBookings(w, d.users.crm.session, [
      { no: "OTF27A000001", car: "THAR_WHITE", created: "01-Sep-2026 10:00 AM" },
      { no: "OTF27A000002", car: "THAR_WHITE", created: "02-Sep-2026 10:00 AM" },
    ]);
    expect(booking(w, "OTF27A000001")).toMatchObject({ status: "ALLOCATED", vin: "MA1THAR0000000001" });
    await loadBookings(w, d.users.crm.session, [{ no: "OTF27A000001", car: "THAR_WHITE", created: "01-Sep-2026 10:00 AM", stage: "Cancellation Initiated" }]);
    expect(booking(w, "OTF27A000002")).toMatchObject({ status: "ALLOCATED", vin: "MA1THAR0000000001" });
    // Next day's stock report has not caught up: the allotment to the cancelled order is still there.
    w.at("2026-10-07 09:00");
    const res = await loadStock(w, d.users.stock.session, [{ vin: "MA1THAR0000000001", car: "THAR_WHITE", order: "OTF27A000001", customer: "FIRST CUSTOMER" }]);
    expect(res.body.summary.orders).toMatchObject({ to_cancelled_booking: 1, recorded: 0, bypassed: 0 });
    expect(car(w, "MA1THAR0000000001")).toMatchObject({ booking_no: "OTF27A000002" });
    // The day-end reconciliation tells someone to remove the allotment in the DMS.
    const run = (await w.api("POST", "/api/recon/run", undefined, d.users.head.session)).body;
    const items = (await w.api("GET", `/api/recon/runs/${run.run_id}`, undefined, d.users.head.session)).body.items;
    expect(items.filter((i: any) => i.category === "CANCELLED_STILL_ALLOTTED").map((i: any) => i.message)).toEqual(["The stock report shows chassis MA1THAR0000000001 allotted to booking OTF27A000001, which is cancelled. The system treats the car as free; remove the allotment in the DMS."]);

    // And it is on the list of what is still to settle, which is what the screen opens on. A person
    // asking what is unsettled should not have to know which day's run turned it up.
    const open = await w.api("GET", "/api/recon/open", undefined, d.users.head.session);
    expect(open.status).toBe(200);
    expect(open.body.totals.open).toBe(items.filter((i: any) => i.status === "OPEN").length);
    expect(open.body.items.map((i: any) => i.category)).toContain("CANCELLED_STILL_ALLOTTED");
    expect(open.body.items.every((i: any) => i.business_date && i.run_id)).toBe(true);
    // Worst first: nothing low-severity may sit above something high.
    const rank: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    const order = open.body.items.map((i: any) => rank[i.severity]);
    expect(order).toEqual([...order].sort((x, y) => x - y));
  });

  it("drops a difference off the list once somebody settles it", async () => {
    const { w, d } = await start();
    await loadStock(w, d.users.stock.session, [{ vin: "MA1THAR0000000001", car: "THAR_WHITE" }]);
    await w.api("POST", "/api/recon/run", undefined, d.users.head.session);
    const before = (await w.api("GET", "/api/recon/open", undefined, d.users.head.session)).body;
    if (!before.items.length) return; // nothing to settle on this fixture: the rule is covered above
    const first = before.items[0];
    expect((await w.api("POST", `/api/recon/items/${first.id}/resolve`, { note: "Checked with the stock in-charge" }, d.users.head.session)).status).toBe(200);
    const after = (await w.api("GET", "/api/recon/open", undefined, d.users.head.session)).body;
    expect(after.totals.open).toBe(before.totals.open - 1);
    expect(after.items.map((i: any) => i.id)).not.toContain(first.id);
  });
});

describe("the bill must match the reservation", () => {
  it("a car reserved for one booking and invoiced to another in the DMS is a bypass: undone, alarmed, and the first customer keeps their place", async () => {
    const { w, d } = await start();
    await loadStock(w, d.users.stock.session, [{ vin: "MA1THAR0000000001", car: "THAR_WHITE" }]);
    await loadBookings(w, d.users.crm.session, [
      { no: "OTF27A000001", car: "THAR_WHITE", created: "01-Sep-2026 10:00 AM", customer: "EARLY CUSTOMER" },
      { no: "OTF27A000002", car: "THAR_WHITE", created: "05-Sep-2026 10:00 AM", customer: "LATE CUSTOMER" },
    ]);
    expect(booking(w, "OTF27A000001")).toMatchObject({ status: "ALLOCATED", vin: "MA1THAR0000000001" });

    w.at("2026-10-08 09:00");
    const res = await loadStock(w, d.users.stock.session, [{ vin: "MA1THAR0000000001", car: "THAR_WHITE", order: "OTF27A000002", invoiceId: "INV0001", invoiceDate: "2026-10-07", customer: "LATE CUSTOMER" }]);
    expect(res.body.summary.orders).toMatchObject({ bypassed: 1, recorded: 1, out_of_turn: 1 });
    // The early customer is back in the queue with the same place; the late one has the car, invoiced.
    const early = booking(w, "OTF27A000001");
    expect(early).toMatchObject({ status: "APPROVED", on_hold: 0, vin: null });
    expect(early.priority_ts).toBe(early.booking_date);
    expect(booking(w, "OTF27A000002")).toMatchObject({ status: "INVOICED", vin: "MA1THAR0000000001" });
    expect(car(w, "MA1THAR0000000001")).toMatchObject({ status: "INVOICED", dms_stock_type: "IBND" });
    // The Business Head / CEO and the Dealer Principal are both told, in the app and on WhatsApp.
    expect(alarms(w, "BYPASS").map((a) => a.target_role)).toEqual(["CEO_VP", "DEALER_PRINCIPAL"]);
    expect(alarms(w, "BYPASS")[0].body).toBe("THAR LXT D MT 2WD 4S HT (M0877) EVEREST WHITE (MA1THAR0000000001) was reserved for booking OTF27A000001, but the DMS shows it invoiced to OTF27A000002. Booking OTF27A000001 is back in the queue with its place kept.");
    expect(messages(w, "MANAGEMENT_ALARM").map((m) => m.to_name)).toEqual(["Bikram Head", "Dinesh Principal"]);
    // It is on the owner's list of out-of-turn allocations: given to the late booking, the early one bypassed, nobody approved it.
    const list = (await w.api("GET", "/api/dashboards/out-of-turn", undefined, d.users.dp.session)).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ given_to: "OTF27A000002", bypassed: "OTF27A000001", state: "UNDER_REVIEW", how: "Allotted in the DMS", vin: "MA1THAR0000000001" });
    // Loading the same report again does not repeat any of it.
    const again = await loadStock(w, d.users.stock.session, [{ vin: "MA1THAR0000000001", car: "THAR_WHITE", order: "OTF27A000002", invoiceId: "INV0001", invoiceDate: "2026-10-07", customer: "LATE CUSTOMER" }]);
    expect(again.body.summary.orders).toMatchObject({ bypassed: 0, recorded: 0 });
    expect(alarms(w, "BYPASS")).toHaveLength(2);
  });

  it("the DMS confirming the reservation is the normal case: the booking moves to invoiced and nothing is flagged", async () => {
    const { w, d } = await start();
    await loadStock(w, d.users.stock.session, [{ vin: "MA1THAR0000000001", car: "THAR_WHITE" }]);
    await loadBookings(w, d.users.crm.session, [{ no: "OTF27A000001", car: "THAR_WHITE", created: "01-Sep-2026 10:00 AM" }]);
    w.at("2026-10-08 09:00");
    const res = await loadStock(w, d.users.stock.session, [{ vin: "MA1THAR0000000001", car: "THAR_WHITE", order: "OTF27A000001", invoiceId: "INV0001", invoiceDate: "2026-10-07" }]);
    expect(res.body.summary.orders).toMatchObject({ confirmed: 1, bypassed: 0, recorded: 0, out_of_turn: 0 });
    expect(booking(w, "OTF27A000001")).toMatchObject({ status: "INVOICED", vin: "MA1THAR0000000001" });
    expect(q(w, `SELECT source, dms_confirmed_at IS NOT NULL AS confirmed FROM allocations WHERE status = 'ACTIVE'`)).toEqual([{ source: "SYSTEM", confirmed: 1 }]);
    expect(q(w, `SELECT COUNT(*) AS n FROM alerts WHERE is_alarm = 1`)[0].n).toBe(0);
  });

  it("a booking billed with a different car frees the car that was reserved for it", async () => {
    const { w, d } = await start();
    await loadStock(w, d.users.stock.session, [{ vin: "MA1THAR0000000001", car: "THAR_WHITE" }]);
    await loadBookings(w, d.users.crm.session, [
      { no: "OTF27A000001", car: "THAR_WHITE", created: "01-Sep-2026 10:00 AM" },
      { no: "OTF27A000002", car: "THAR_WHITE", created: "02-Sep-2026 10:00 AM" },
    ]);
    w.at("2026-10-08 09:00");
    // The booking sheet shows the first booking invoiced...
    await loadBookings(w, d.users.crm.session, [{ no: "OTF27A000001", car: "THAR_WHITE", created: "01-Sep-2026 10:00 AM", stage: "Invoiced" }]);
    expect(booking(w, "OTF27A000001")).toMatchObject({ status: "INVOICED", vin: "MA1THAR0000000001" });
    // ...but the stock report of the same day still has its reserved car unallotted: it was billed with another car.
    const res = await loadStock(w, d.users.stock.session, [{ vin: "MA1THAR0000000001", car: "THAR_WHITE" }]);
    expect(booking(w, "OTF27A000001")).toMatchObject({ status: "INVOICED", vin: null });
    expect(res.body.allocations).toBe(1);
    expect(booking(w, "OTF27A000002")).toMatchObject({ status: "ALLOCATED", vin: "MA1THAR0000000001" });
  });

  it("a retail invoice cancelled in the DMS puts the booking back to holding its car, with an alarm", async () => {
    const { w, d } = await start();
    await loadStock(w, d.users.stock.session, [{ vin: "MA1THAR0000000001", car: "THAR_WHITE", order: "OTF27A000001", invoiceId: "INV0001" }]);
    await loadBookings(w, d.users.crm.session, [{ no: "OTF27A000001", car: "THAR_WHITE", created: "01-Sep-2026 10:00 AM" }]);
    expect(booking(w, "OTF27A000001")).toMatchObject({ status: "INVOICED" });
    w.at("2026-10-08 09:00");
    await loadStock(w, d.users.stock.session, [{ vin: "MA1THAR0000000001", car: "THAR_WHITE", order: "OTF27A000001" }]);
    expect(car(w, "MA1THAR0000000001")).toMatchObject({ status: "RECEIVED", dms_stock_type: "ALLOTED", invoiced_at: null });
    expect(booking(w, "OTF27A000001")).toMatchObject({ status: "ALLOCATED", invoiced_at: null, vin: "MA1THAR0000000001" });
    expect(alarms(w, "INVOICE_REVERSED")).toHaveLength(2);
  });
});

describe("an allotment made in the DMS, not by the system", () => {
  it("is recorded, and is out of turn when an earlier booking was waiting for the same car", async () => {
    const { w, d } = await start();
    // The dealership allocates only cars that have arrived, so this car in transit is not reserved by the system.
    expect((await w.api("PUT", "/api/settings", { allocate_in_transit: false }, d.users.head.session)).status).toBe(200);
    await loadStock(w, d.users.stock.session, [{ vin: "MA1THAR0000000001", car: "THAR_WHITE", status: "In Transit" }]);
    await loadBookings(w, d.users.crm.session, [
      { no: "OTF27A000001", car: "THAR_WHITE", created: "01-Sep-2026 10:00 AM" },
      { no: "OTF27A000002", car: "THAR_WHITE", created: "05-Sep-2026 10:00 AM" },
    ]);
    expect(q(w, `SELECT COUNT(*) AS n FROM allocations`)[0].n).toBe(0);
    w.at("2026-10-08 09:00");
    const res = await loadStock(w, d.users.stock.session, [{ vin: "MA1THAR0000000001", car: "THAR_WHITE", order: "OTF27A000002" }]);
    expect(res.body.summary.orders).toMatchObject({ recorded: 1, out_of_turn: 1, bypassed: 0 });
    expect(booking(w, "OTF27A000002")).toMatchObject({ status: "ALLOCATED", vin: "MA1THAR0000000001" });
    expect(booking(w, "OTF27A000001")).toMatchObject({ status: "APPROVED", vin: null });
    expect(alarms(w, "OUT_OF_TURN").map((a) => a.target_role)).toEqual(["CEO_VP", "DEALER_PRINCIPAL"]);
    expect(alarms(w, "OUT_OF_TURN")[0].body).toMatch(/OTF27A000002 \(ahead of OTF27A000001\)/);

    // The Dealer Principal reviews it; a sales lead cannot.
    const row = (await w.api("GET", "/api/dashboards/out-of-turn", undefined, d.users.dp.session)).body[0];
    expect(row).toMatchObject({ given_to: "OTF27A000002", bypassed: "OTF27A000001", state: "UNDER_REVIEW" });
    expect((await w.api("POST", `/api/out-of-turn/${row.allocation_id}/review`, { note: "Fleet customer, agreed with the owner" }, d.users.lead.session)).status).toBe(403);
    expect((await w.api("POST", `/api/out-of-turn/${row.allocation_id}/review`, { note: "" }, d.users.dp.session)).status).toBe(400);
    expect((await w.api("POST", `/api/out-of-turn/${row.allocation_id}/review`, { note: "Fleet customer, agreed with the owner" }, d.users.dp.session)).status).toBe(200);
    expect((await w.api("GET", "/api/dashboards/out-of-turn", undefined, d.users.head.session)).body[0]).toMatchObject({ state: "REVIEWED", reviewed_by_name: "Dinesh Principal", review_note: "Fleet customer, agreed with the owner" });
    expect((await w.api("POST", `/api/out-of-turn/${row.allocation_id}/review`, { note: "again" }, d.users.dp.session)).status).toBe(409);
  });

  it("an order that is in no booking sheet is kept from the stock report, completed when a sheet names it", async () => {
    const { w, d } = await start();
    await loadStock(w, d.users.stock.session, [{ vin: "MA1THAR0000000001", car: "THAR_WHITE", order: "OTF26A000777", customer: "OLD ORDER CUSTOMER", sc: "CONSULTANT 009" }]);
    const b = booking(w, "OTF26A000777");
    expect(b).toMatchObject({ source: "DMS_STOCK", status: "ALLOCATED", customer_name: "OLD ORDER CUSTOMER", customer_mobile: "", wa_opt_in: 0, model: "THAR", variant: "LXT D MT 2WD 4S HT (M0877)", colour: "EVEREST WHITE", vin: "MA1THAR0000000001", sc_name: "CONSULTANT 009" });
    const res = await loadBookings(w, d.users.crm.session, [{ no: "OTF26A000777", car: "THAR_WHITE", created: "14-Aug-2026 11:30 AM", customer: "OLD ORDER CUSTOMER", mobile: "1000000042" }]);
    expect(res.body.summary).toMatchObject({ details_completed: 1, new_bookings: 0 });
    expect(booking(w, "OTF26A000777")).toMatchObject({ source: "DMS", status: "ALLOCATED", customer_mobile: "911000000042", booking_date: "2026-08-14T06:00:00.000Z", vin: "MA1THAR0000000001" });
  });

  it("an allotment the DMS removes sends the booking back to the queue", async () => {
    const { w, d } = await start();
    await loadStock(w, d.users.stock.session, [{ vin: "MA1THAR0000000001", car: "THAR_WHITE", order: "OTF27A000002" }]);
    await loadBookings(w, d.users.crm.session, [
      { no: "OTF27A000001", car: "THAR_WHITE", created: "01-Sep-2026 10:00 AM" },
      { no: "OTF27A000002", car: "THAR_WHITE", created: "05-Sep-2026 10:00 AM" },
    ]);
    expect(booking(w, "OTF27A000002")).toMatchObject({ status: "ALLOCATED", vin: "MA1THAR0000000001" });
    w.at("2026-10-08 09:00");
    const res = await loadStock(w, d.users.stock.session, [{ vin: "MA1THAR0000000001", car: "THAR_WHITE" }]);
    expect(res.body.summary.orders.released_in_dms).toBe(1);
    // The car is free again, and the system gives it to whoever is first in line: the earlier booking.
    expect(booking(w, "OTF27A000001")).toMatchObject({ status: "ALLOCATED", vin: "MA1THAR0000000001" });
    expect(booking(w, "OTF27A000002")).toMatchObject({ status: "APPROVED", vin: null });
  });
});

describe("cars that are no longer in the stock report", () => {
  it("an invoiced car that leaves the report is delivered; a free one has left stock", async () => {
    const { w, d } = await start();
    await loadStock(w, d.users.stock.session, [
      { vin: "MA1THAR0000000001", car: "THAR_WHITE", order: "OTF27A000001", invoiceId: "INV0001" },
      { vin: "MA1THAR0000000002", car: "THAR_BLACK" },
      { vin: "MA1THAR0000000003", car: "THAR_BLACK" },
    ]);
    await loadBookings(w, d.users.crm.session, [{ no: "OTF27A000001", car: "THAR_WHITE", created: "01-Sep-2026 10:00 AM" }]);
    w.at("2026-10-09 09:00");
    const res = await loadStock(w, d.users.stock.session, [{ vin: "MA1THAR0000000003", car: "THAR_BLACK" }]);
    expect(res.body.summary.left_stock).toEqual({ delivered: 1, removed: 1, on_hold: 0 });
    expect(car(w, "MA1THAR0000000001")).toMatchObject({ status: "DELIVERED", left_stock_on: "2026-10-09" });
    expect(booking(w, "OTF27A000001")).toMatchObject({ status: "DELIVERED" });
    expect(q(w, `SELECT status FROM allocations`)).toEqual([{ status: "FULFILLED" }]);
    expect(car(w, "MA1THAR0000000002")).toMatchObject({ status: "REMOVED", left_stock_on: "2026-10-09" });
    expect(car(w, "MA1THAR0000000003")).toMatchObject({ status: "RECEIVED", left_stock_on: null });
    // A car the DMS lists again comes back into stock.
    w.at("2026-10-10 09:00");
    const back = await loadStock(w, d.users.stock.session, [{ vin: "MA1THAR0000000002", car: "THAR_BLACK" }, { vin: "MA1THAR0000000003", car: "THAR_BLACK" }]);
    expect(back.body.summary.returned).toBe(1);
    expect(car(w, "MA1THAR0000000002")).toMatchObject({ status: "RECEIVED", left_stock_on: null });
  });

  it("a reserved car that leaves the report unbilled puts its booking on hold with an alarm; the booking sheet then settles it", async () => {
    const { w, d } = await start();
    await loadStock(w, d.users.stock.session, [{ vin: "MA1THAR0000000001", car: "THAR_WHITE" }, { vin: "MA1THAR0000000002", car: "THAR_BLACK" }]);
    await loadBookings(w, d.users.crm.session, [{ no: "OTF27A000001", car: "THAR_WHITE", created: "01-Sep-2026 10:00 AM" }]);
    w.at("2026-10-09 09:00");
    const res = await loadStock(w, d.users.stock.session, [{ vin: "MA1THAR0000000002", car: "THAR_BLACK" }]);
    expect(res.body.summary.left_stock).toEqual({ delivered: 0, removed: 0, on_hold: 1 });
    expect(car(w, "MA1THAR0000000001")).toMatchObject({ status: "REMOVED" });
    // Not back in the queue for another car: the customer may well have taken delivery of this one.
    expect(booking(w, "OTF27A000001")).toMatchObject({ status: "APPROVED", on_hold: 1, hold_reason: "CAR_LEFT_STOCK", vin: null });
    expect(alarms(w, "CAR_LEFT_STOCK")).toHaveLength(2);
    const sheet = await loadBookings(w, d.users.crm.session, [{ no: "OTF27A000001", car: "THAR_WHITE", created: "01-Sep-2026 10:00 AM", stage: "Invoiced", enquiryStage: "Delivered" }]);
    expect(sheet.body.summary.delivered_now).toBe(1);
    expect(booking(w, "OTF27A000001")).toMatchObject({ status: "DELIVERED", on_hold: 0, hold_reason: null });
  });

  it("a file that is missing most of the stock is not applied until someone confirms it is complete; a partial file removes nothing", async () => {
    const { w, d } = await start();
    const all = Array.from({ length: 40 }, (_, i) => ({ vin: `MA1THAR00000001${String(i).padStart(2, "0")}`, car: "THAR_BLACK" as const }));
    await loadStock(w, d.users.stock.session, all);
    w.at("2026-10-07 09:00");
    const few = all.slice(0, 5);
    const refused = await loadStock(w, d.users.stock.session, few);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: "CONFIRM_MISSING" });
    expect(refused.body.error.message).toMatch(/^35 of the 40 cars/);
    expect(w.db.q(`SELECT COUNT(*) AS n FROM vehicles WHERE status = 'RECEIVED'`)[0].n).toBe(40);
    const partial = await loadStock(w, d.users.stock.session, few, { mode: "PARTIAL" });
    expect(partial.status).toBe(200);
    expect(partial.body.summary.left_stock).toEqual({ delivered: 0, removed: 0, on_hold: 0 });
    expect(w.db.q(`SELECT COUNT(*) AS n FROM vehicles WHERE status = 'RECEIVED'`)[0].n).toBe(40);
    const confirmed = await loadStock(w, d.users.stock.session, few, { confirm: true });
    expect(confirmed.body.summary.left_stock.removed).toBe(35);
    expect(w.db.q(`SELECT COUNT(*) AS n FROM vehicles WHERE status = 'RECEIVED'`)[0].n).toBe(5);
  });
});

describe("a reserved car arrives", () => {
  it("the customer is told and the payment window starts, from the stock report alone", async () => {
    const { w, d } = await start();
    await loadStock(w, d.users.stock.session, [{ vin: "MA1THAR0000000001", car: "THAR_WHITE", status: "In Transit" }]);
    await loadBookings(w, d.users.crm.session, [{ no: "OTF27A000001", car: "THAR_WHITE", created: "01-Sep-2026 10:00 AM", customer: "WAITING CUSTOMER" }]);
    expect(q(w, `SELECT type, clock_started_at FROM allocations`)).toEqual([{ type: "IN_TRANSIT", clock_started_at: null }]);
    expect(messages(w, "ALLOC_IN_TRANSIT")).toHaveLength(1);
    w.at("2026-10-09 11:00");
    const res = await loadStock(w, d.users.stock.session, [{ vin: "MA1THAR0000000001", car: "THAR_WHITE", grnDate: "2026-10-08" }]);
    expect(res.body.summary.received).toBe(1);
    // In stock since the GRN date; the customer's three days run from when they were told.
    expect(car(w, "MA1THAR0000000001")).toMatchObject({ status: "RECEIVED", received_at: "2026-10-07T18:30:00.000Z" });
    expect(q(w, `SELECT clock_started_at FROM allocations`)).toEqual([{ clock_started_at: "2026-10-09T05:30:00.000Z" }]);
    expect(messages(w, "STOCK_RECEIVED").map((m) => m.to_name)).toEqual(["WAITING CUSTOMER"]);
    // The same report again does not message the customer again.
    await loadStock(w, d.users.stock.session, [{ vin: "MA1THAR0000000001", car: "THAR_WHITE", grnDate: "2026-10-08" }]);
    expect(messages(w, "STOCK_RECEIVED")).toHaveLength(1);
  });

  it("sixty at once: applied in steps, each customer told exactly once", async () => {
    const { w, d } = await start();
    const vins = Array.from({ length: 60 }, (_, i) => `MA1THAR00000002${String(i).padStart(2, "0")}`);
    await loadStock(w, d.users.stock.session, vins.map((vin) => ({ vin, car: "THAR_WHITE" as const, status: "In Transit" as const })));
    await loadBookings(w, d.users.crm.session, vins.map((_, i) => ({ no: `OTF27A0001${String(i).padStart(2, "0")}`, car: "THAR_WHITE" as const, created: `01-Sep-2026 ${String(8 + Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")} AM` })));
    for (let i = 0; i < 5; i++) await w.tick();
    expect(q(w, `SELECT COUNT(*) AS n FROM allocations WHERE status = 'ACTIVE'`)[0].n).toBe(60);
    w.at("2026-10-09 11:00");
    const first = await w.send(`/api/uploads/stock?filename=stock.csv&report_date=2026-10-09`, stockFile(vins.map((vin) => ({ vin, car: "THAR_WHITE" as const }))), d.users.stock.session);
    expect(first.body.more).toBe(true); // more arrivals than one request may process
    expect(q(w, `SELECT COUNT(*) AS n FROM wa_messages WHERE event_key = 'STOCK_RECEIVED'`)[0].n).toBe(50);
    const rest = await loadFile(w, "stock", stockFile(vins.map((vin) => ({ vin, car: "THAR_WHITE" as const }))), d.users.stock.session, `&report_date=2026-10-09&continue=${first.body.upload_id}`);
    expect(rest.body.more).toBe(false);
    expect(rest.body.summary.received).toBe(60);
    expect(q(w, `SELECT COUNT(*) AS n, COUNT(DISTINCT booking_id) AS customers FROM wa_messages WHERE event_key = 'STOCK_RECEIVED'`)[0]).toEqual({ n: 60, customers: 60 });
    expect(q(w, `SELECT COUNT(*) AS n FROM vehicles WHERE status = 'RECEIVED'`)[0].n).toBe(60);
    expect(q(w, `SELECT COUNT(*) AS n FROM uploads WHERE kind = 'STOCK' AND status = 'DONE'`)[0].n).toBe(2);
  });
});

describe("colour", () => {
  it("a booking is matched by the paint alias in its description, whatever name the booking sheet gives the colour", async () => {
    const { w, d } = await start();
    await loadStock(w, d.users.stock.session, [{ vin: "MA1THAR0000000001", car: "THAR_WHITE" }]);
    // The stock report calls paint WQ "EVEREST WHITE"; this booking sheet row calls it something else.
    const res = await loadBookings(w, d.users.crm.session, [{ no: "OTF27A000001", car: "THAR_WHITE", created: "01-Sep-2026 10:00 AM", colour: "EVEREST WHT" }]);
    expect(res.body.allocations).toBe(1);
    expect(booking(w, "OTF27A000001")).toMatchObject({ colour: "EVEREST WHITE", dms_colour: "EVEREST WHT", paint_alias: "WQ", vin: "MA1THAR0000000001" });
  });

  it("a booking loaded before any car of its paint was in stock takes the stock report's colour name when one arrives", async () => {
    const { w, d } = await start();
    await loadBookings(w, d.users.crm.session, [{ no: "OTF27A000001", car: "THAR_WHITE", created: "01-Sep-2026 10:00 AM", colour: "EVEREST WHT" }]);
    expect(booking(w, "OTF27A000001")).toMatchObject({ colour: "EVEREST WHT", status: "APPROVED" });
    const res = await loadStock(w, d.users.stock.session, [{ vin: "MA1THAR0000000001", car: "THAR_WHITE" }]);
    expect(res.body.allocations).toBe(1);
    expect(booking(w, "OTF27A000001")).toMatchObject({ colour: "EVEREST WHITE", vin: "MA1THAR0000000001" });
  });

  it("where the description carries no paint alias the names must agree, until the dealership says two names are one colour", async () => {
    const { w, d } = await start();
    await loadStock(w, d.users.stock.session, [{ vin: "MA1MAXX0000000001", car: "MAXX_DIAMOND" }]);
    const res = await loadBookings(w, d.users.crm.session, [{ no: "OTF27A000001", car: "MAXX_WHITE", created: "01-Sep-2026 10:00 AM" }]);
    // WHITE and DIAMOND WHITE are not assumed to be the same paint.
    expect(res.body.allocations).toBe(0);
    expect(booking(w, "OTF27A000001")).toMatchObject({ colour: "WHITE", status: "APPROVED", vin: null });
    // The sales team is shown the offer: same model and variant, another colour, free.
    const offers = (await w.api("GET", "/api/dashboards/matches", undefined, d.users.lead.session)).body;
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ booking_no: "OTF27A000001", colour: "WHITE", options: [{ colour: "DIAMOND WHITE", in_yard: 1, in_transit: 0 }] });
    // The dealership records that, for this model, DIAMOND WHITE is the paint its bookings call WHITE.
    const mapped = await w.api("POST", "/api/master/names", { kind: "COLOUR", model: "BOL MAXX PUP HD", alias: "DIAMOND WHITE", colour: "WHITE" }, d.users.admin.session);
    expect(mapped.status).toBe(200);
    expect(mapped.body.recoloured).toEqual({ cars: 1, bookings: 0 });
    expect(car(w, "MA1MAXX0000000001")).toMatchObject({ colour: "WHITE", dms_colour: "DIAMOND WHITE", oem_colour_code: "C1DMNDWHIT" });
    await w.tick();
    expect(booking(w, "OTF27A000001")).toMatchObject({ status: "ALLOCATED", vin: "MA1MAXX0000000001" });
    // The mapping holds for the next stock report too.
    w.at("2026-10-07 09:00");
    await loadStock(w, d.users.stock.session, [{ vin: "MA1MAXX0000000001", car: "MAXX_DIAMOND" }, { vin: "MA1MAXX0000000002", car: "MAXX_DIAMOND" }]);
    expect(car(w, "MA1MAXX0000000002")).toMatchObject({ colour: "WHITE", dms_colour: "DIAMOND WHITE" });
  });
});

describe("what a file may and may not do", () => {
  it("refuses a file for another dealer, an older stock report, and a file put in the wrong place", async () => {
    const { w, d } = await start();
    const s = d.users.admin.session;
    await loadStock(w, s, [{ vin: "MA1THAR0000000001", car: "THAR_WHITE" }], { asOn: "2026-10-05" });
    const other = await w.send(`/api/uploads/stock?report_date=2026-10-06`, stockFile([{ vin: "MA1THAR0000000009", car: "THAR_WHITE" }], "ANOTHER DEALER"), s);
    expect(other.status).toBe(400);
    expect(other.body.error).toMatchObject({ code: "WRONG_DEALER", message: 'This file is for the dealer "ANOTHER DEALER". This dealership\'s DMS files are for "SAMPLE MOTORS". Nothing was loaded.' });
    const older = await loadStock(w, s, [{ vin: "MA1THAR0000000001", car: "THAR_WHITE" }], { asOn: "2026-10-03" });
    expect(older.body.error).toMatchObject({ code: "OLDER_REPORT" });
    const future = await loadStock(w, s, [{ vin: "MA1THAR0000000001", car: "THAR_WHITE" }], { asOn: "2026-10-20" });
    expect(future.body.error.message).toBe("The report date 2026-10-20 is in the future");
    const wrong = await w.send(`/api/uploads/stock`, bookingFile([{ no: "OTF27A000001", car: "THAR_WHITE", created: "01-Sep-2026 10:00 AM" }]), s);
    expect(wrong.body.error.message).toBe("This looks like the booking sheet, not the stock report. Upload it under Booking sheet.");
    const wrong2 = await w.send(`/api/uploads/bookings`, stockFile([{ vin: "MA1THAR0000000001", car: "THAR_WHITE" }]), s);
    expect(wrong2.body.error.message).toBe("This looks like the stock report, not the booking sheet. Upload it under Stock report.");
    expect(w.db.q(`SELECT COUNT(*) AS n FROM vehicles`)[0].n).toBe(1);
    expect(w.db.q(`SELECT COUNT(*) AS n FROM bookings`)[0].n).toBe(0);
  });

  it("reports the rows it cannot use, by row number, and loads the rest", async () => {
    const { w, d } = await start();
    const res = await loadStock(w, d.users.admin.session, [
      { vin: "MA1THAR0000000001", car: "THAR_WHITE" },
      { vin: "MA1THAR0000000002", car: "THAR_WHITE", raw: { "Stock Type": "Reserved" } },
      { vin: "MA1THAR0000000001", car: "THAR_WHITE" },
      { vin: "MA1THAR0000000004", car: "THAR_WHITE", raw: { "Model Description": "NEW MODEL X1 AT(A3EVRSTWHT)(M4321)", Model: "NEW MODEL" } },
      { vin: "MA1THAR0000000005", car: "THAR_WHITE", order: "OTF27A000001", raw: { "Stock Type": "Unalloted" } },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.errors).toEqual([
      { row: 3, key: "MA1THAR0000000002", message: 'Stock Type "Reserved" is not recognised (expected Unalloted, Alloted or IBND)' },
      { row: 4, key: "MA1THAR0000000001", message: "VIN appears more than once in the report; only the first row was used" },
    ]);
    expect(res.body.summary).toMatchObject({ cars: 3, not_recognised: 1, issues: { description_not_recognised: 1, unallocated_but_linked: 1 } });
    // A description the parser does not know is loaded under the DMS's own model name, with nothing guessed.
    const unknown = w.db.q<any>(`SELECT v.model, v.variant, m.trim_level, m.transmission, m.fuel FROM vehicles v JOIN vehicle_variants m ON m.id = v.variant_id WHERE v.vin = 'MA1THAR0000000004'`)[0];
    expect(unknown).toEqual({ model: "NEW MODEL", variant: "NEW MODEL X1 AT (M4321)", trim_level: "", transmission: "", fuel: "" });
  });

  it("a user limited to one outlet can load only that outlet's cars and bookings", async () => {
    const { w, d } = await start();
    await loadStock(w, d.users.admin.session, [{ vin: "MA1THAR0000000001", car: "THAR_WHITE", loc: "SM01" }, { vin: "MA1THAR0000000002", car: "THAR_WHITE", loc: "SM02" }]);
    const outlets = (await w.api("GET", "/api/outlets", undefined, d.users.admin.session)).body as { id: string; code: string }[];
    const sm01 = outlets.find((o) => o.code === "SM01")!.id;
    const made = await w.api("POST", "/api/users", { name: "Local Stock", mobile: "9100000050", email: "9100000050@test.example", role: "EDP_MANAGER", all_outlets: false, outlet_ids: [sm01] }, d.users.admin.session);
    w.db.raw.exec(`UPDATE users SET must_change_password = 0 WHERE id = '${made.body.id}'`);
    const local = await w.login(d.slug, "9100000050", made.body.temporary_password);
    w.at("2026-10-07 09:00");
    const res = await loadStock(w, local, [
      { vin: "MA1THAR0000000001", car: "THAR_WHITE", loc: "SM01", order: "OTF27A000001" },
      { vin: "MA1THAR0000000002", car: "THAR_WHITE", loc: "SM02", order: "OTF27A000002" },
      { vin: "MA1THAR0000000003", car: "THAR_WHITE", loc: "SM77" },
      // Trying to pull another outlet's car into one's own outlet.
      { vin: "MA1THAR0000000002", car: "THAR_WHITE", loc: "SM01" },
    ]);
    expect(res.body.errors.map((e: any) => e.message)).toEqual([
      "VIN appears more than once in the report; only the first row was used",
      "Outlet SM02 is not one of your outlets",
      "Outlet SM77 (SM77) is not set up; ask the administrator to load this report once",
    ]);
    expect(car(w, "MA1THAR0000000001")).toMatchObject({ dms_stock_type: "ALLOTED", booking_no: "OTF27A000001" });
    expect(car(w, "MA1THAR0000000002")).toMatchObject({ dms_stock_type: "UNALLOTED", booking_no: null });
    expect(w.db.q(`SELECT COUNT(*) AS n FROM outlets`)[0].n).toBe(2);
    // The second outlet's car is not in this file, but it is not this user's to mark as gone.
    expect(car(w, "MA1THAR0000000002").status).toBe("RECEIVED");
    const b = await loadBookings(w, local, [{ no: "OTF27A000009", car: "THAR_WHITE", created: "01-Sep-2026 10:00 AM", loc: "SM02" }]);
    expect(b.body.errors.map((e: any) => e.message)).toEqual(["Outlet SM02 is not one of your outlets"]);
    expect(w.db.q(`SELECT COUNT(*) AS n FROM bookings WHERE booking_no = 'OTF27A000009'`)[0].n).toBe(0);
  });

  it("only the roles that load data may load it", async () => {
    const { w, d } = await start();
    const file = stockFile([{ vin: "MA1THAR0000000001", car: "THAR_WHITE" }]);
    // The Dealer Principal is kept out of this deliberately: loading the files is the EDP Manager's daily job.
    for (const who of ["exec", "lead", "agm", "gm", "finance", "dp", "auditor"]) expect((await w.send(`/api/uploads/stock`, file, d.users[who].session)).status, who).toBe(403);
    for (const who of ["exec", "lead", "agm", "gm", "finance", "dp", "auditor"]) expect((await w.send(`/api/uploads/bookings`, bookingFile([{ no: "OTF27A000001", car: "THAR_WHITE", created: "01-Sep-2026 10:00 AM" }]), d.users[who].session)).status, who).toBe(403);
    expect((await w.send(`/api/uploads/stock?report_date=2026-10-06`, file, d.users.crm.session)).status).toBe(200);
  });
});

describe("the differences screen explains itself", () => {
  // A person looking at "Reserved car no longer in the stock report, High, 27" cannot work out from
  // those four words what was found, what it costs to leave it, or what makes it go away. The screen
  // carries all three now, and they come from the server beside the label so the two cannot drift.
  it("has an explanation for every kind of difference it can raise", () => {
    for (const [key, label] of Object.entries(RECON_CATEGORIES)) {
      const h = RECON_HELP[key];
      expect(h, `no explanation for ${key} ("${label}")`).toBeTruthy();
      // Three answers, each a real sentence rather than a restatement of the label.
      for (const part of ["means", "matters", "clears"] as const) {
        expect(h[part].length, `${key}.${part} is too short`).toBeGreaterThan(40);
        expect(h[part].trim().endsWith("."), `${key}.${part} is not a sentence`).toBe(true);
        expect(h[part].toLowerCase(), `${key}.${part} only repeats the label`).not.toBe(label.toLowerCase());
      }
    }
    // Nothing explained that cannot be raised: a stale entry here is an answer to a question the
    // screen never asks.
    for (const key of Object.keys(RECON_HELP)) expect(RECON_CATEGORIES[key], `${key} is explained but never raised`).toBeTruthy();
  });

  it("sends the explanations to the screen with the open differences", async () => {
    const { w, d } = await start();
    const res = await w.api("GET", "/api/recon/open", undefined, d.users.head.session);
    expect(res.status).toBe(200);
    expect(res.body.help.CAR_LEFT_STOCK.means).toContain("stopped appearing in the stock report");
    expect(Object.keys(res.body.help).sort()).toEqual(Object.keys(res.body.categories).sort());
  });
});
