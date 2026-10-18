// The three views added for the people who ask different questions: what the cars earned, whether the
// business is keeping up, and whether the system is being used.
//
// The figure worth guarding hardest is gross margin, because it is the only one here built from two
// files at once -- what the manufacturer charged for a chassis and what the customer paid for it --
// and because it is the one that would be quietly wrong rather than obviously missing. A car whose
// cost this system has never seen must not be averaged in at zero, and the share that is known has
// to be stated rather than implied.
import { describe, expect, it } from "vitest";
import { loadBookings, loadRetail, loadStock, makeMahindraDealer, makeWorld, type Dealer, type World } from "./harness";

const money = (w: World, d: Dealer, from: string, to: string) => w.api("GET", `/api/insights/money?from=${from}&to=${to}`, undefined, d.users.dp.session);
const business = (w: World, d: Dealer, from: string, to: string) => w.api("GET", `/api/insights/business?from=${from}&to=${to}`, undefined, d.users.head.session);
const system = (w: World, d: Dealer, from: string, to: string) => w.api("GET", `/api/insights/system?from=${from}&to=${to}`, undefined, d.users.admin.session);

describe("what the cars earned", () => {
  it("reports the price and what came off it, and nothing about what the car cost", async () => {
    const w = makeWorld("2026-10-14 10:00");
    const d = await makeMahindraDealer(w);
    // The stock report carries a Net Dealer Price for every chassis. Nothing here reads it: what a
    // car cost the dealership is its own buying position, and this system reports what the files
    // state about the sale rather than working out a margin no single file it was given asserts.
    await loadStock(w, d.users.stock.session, [
      { vin: "MA1THAR0000000001", car: "THAR_WHITE", price: 1_000_000 },
      { vin: "MA1THAR0000000002", car: "THAR_BLACK", price: 1_000_000 },
    ], { asOn: "2026-10-14" });
    await loadRetail(w, d.users.crm.session, [
      { no: "INV27A000001", car: "THAR_WHITE", vin: "MA1THAR0000000001", date: "2026-10-10", selling: 1_200_000, dealerDiscount: 20_000 },
      { no: "INV27A000002", car: "THAR_BLACK", vin: "MA1THAR0000000002", date: "2026-10-11", selling: 1_150_000, oemDiscount: 30_000 },
    ], { asOn: "2026-10-14" });

    const res = await money(w, d, "2026-10-01", "2026-10-14");
    expect(res.status).toBe(200);
    const t = res.body.totals;
    expect(t.invoices).toBe(2);
    expect(t.selling).toBe(2_350_000);
    expect(t.dealer_discount).toBe(20_000);
    expect(t.oem_discount).toBe(30_000);
    expect(t.discount).toBe(50_000);
    // Against the price before the discount came off, which is what a share of the price means.
    expect(t.discount_pct).toBe(2.1);
    // No field anywhere in the answer carries a cost or a margin, however plainly the dealership's
    // own buying price is sitting in the same database. (The wording of `basis` says so in prose,
    // which is why the check is on the data rather than on the whole payload.)
    const fields = (o: unknown): string[] =>
      Array.isArray(o) ? o.flatMap(fields) : o && typeof o === "object" ? Object.entries(o).flatMap(([k, v]) => [k, ...fields(v)]) : [];
    expect(fields(res.body).filter((k) => /cost|margin/i.test(k))).toEqual([]);
  });

  it("does not call scheme money unclaimed when the file never fills the credit note column", async () => {
    const w = makeWorld("2026-10-14 10:00");
    const d = await makeMahindraDealer(w);
    await loadRetail(w, d.users.crm.session, [
      { no: "INV27A000001", car: "THAR_WHITE", vin: "MA1THAR0000000001", date: "2026-10-10", oemDiscount: 30_000 },
      { no: "INV27A000002", car: "THAR_BLACK", vin: "MA1THAR0000000002", date: "2026-10-11", oemDiscount: 25_000 },
    ], { asOn: "2026-10-14" });
    let body = (await money(w, d, "2026-10-01", "2026-10-14")).body;
    expect(body.claims_not_stated).toBe(true);
    expect(body.totals.unclaimed).toBe(0);
    expect(body.unclaimed_list).toEqual([]);

    // Once the file shows it does fill that column, a discount without one is money not asked for.
    const w2 = makeWorld("2026-10-14 10:00");
    const d2 = await makeMahindraDealer(w2);
    await loadRetail(w2, d2.users.crm.session, [
      { no: "INV27A000001", car: "THAR_WHITE", vin: "MA1THAR0000000001", date: "2026-10-10", oemDiscount: 30_000, oemClaim: "CRN27A000001" },
      { no: "INV27A000002", car: "THAR_BLACK", vin: "MA1THAR0000000002", date: "2026-10-11", oemDiscount: 25_000 },
    ], { asOn: "2026-10-14" });
    body = (await money(w2, d2, "2026-10-01", "2026-10-14")).body;
    expect(body.claims_not_stated).toBe(false);
    expect(body.totals.unclaimed).toBe(25_000);
    expect(body.unclaimed_list).toHaveLength(1);
    expect(body.unclaimed_list[0]).toMatchObject({ invoice_no: "INV27A000002", amount: 25_000 });
  });

  it("counts what came attached to the sale, which the car itself does not earn", async () => {
    const w = makeWorld("2026-10-14 10:00");
    const d = await makeMahindraDealer(w);
    await loadRetail(w, d.users.crm.session, [
      { no: "INV27A000001", car: "THAR_WHITE", vin: "MA1THAR0000000001", date: "2026-10-10", financier: "SAMPLE BANK", financeBy: "Dealer", insurance: 30_000 },
      { no: "INV27A000002", car: "THAR_BLACK", vin: "MA1THAR0000000002", date: "2026-10-11", financier: "SAMPLE BANK", financeBy: "Self" },
      { no: "INV27A000003", car: "XUV3XO_WHITE", vin: "MA1THAR0000000003", date: "2026-10-12" },
      { no: "INV27A000004", car: "SCORPIO_N", vin: "MA1THAR0000000004", date: "2026-10-13", exchange: true },
    ], { asOn: "2026-10-14" });
    const a = (await money(w, d, "2026-10-01", "2026-10-14")).body.attached;
    // Two of four financed at all; one of those through the dealership, which is the one that earns.
    expect(a).toMatchObject({ financed: 2, dealer_arranged: 1, insured: 1, exchanged: 1, finance_pct: 50, dealer_finance_pct: 25, insurance_pct: 25, exchange_pct: 25 });
    expect(a.insurance_amount).toBe(30_000);
  });

  it("is not shown to someone who may not see what stock is worth", async () => {
    const w = makeWorld("2026-10-14 10:00");
    const d = await makeMahindraDealer(w);
    expect((await w.api("GET", "/api/insights/money?from=2026-10-01&to=2026-10-14", undefined, d.users.crm.session)).status).toBe(403);
  });
});

describe("whether the business is keeping up", () => {
  it("counts each step on the day it happened and carries the queue forward", async () => {
    const w = makeWorld("2026-10-05 10:00");
    const d = await makeMahindraDealer(w);
    // Three customers want the same car; there is none, so all three wait.
    await loadBookings(w, d.users.crm.session, [
      { no: "OTF27A000001", car: "THAR_WHITE", created: "01-Oct-2026 10:00 AM", customer: "FIRST" },
      { no: "OTF27A000002", car: "THAR_WHITE", created: "02-Oct-2026 10:00 AM", customer: "SECOND" },
      { no: "OTF27A000003", car: "THAR_WHITE", created: "03-Oct-2026 10:00 AM", customer: "THIRD" },
    ]);
    let body = (await business(w, d, "2026-10-01", "2026-10-05")).body;
    expect(body.totals.booked).toBe(3);
    // The queue deepens by one a day as each booking is taken, and nothing leaves it.
    expect(body.days.map((x: any) => x.queue)).toEqual([1, 2, 3, 3, 3]);

    // A car arrives on the 6th and the queue gives it to whoever has waited longest.
    w.at("2026-10-06 09:00");
    await loadStock(w, d.users.stock.session, [{ vin: "MA1THAR0000000001", car: "THAR_WHITE" }], { asOn: "2026-10-06" });
    body = (await business(w, d, "2026-10-01", "2026-10-06")).body;
    expect(body.days[5].allocated).toBe(1);
    expect(body.days.map((x: any) => x.queue)).toEqual([1, 2, 3, 3, 3, 2]);
    expect(body.totals.queue_start).toBe(1);
    expect(body.totals.queue_end).toBe(2);
    // Booked on the 1st, given a car on the 6th.
    expect(body.totals.median_days_to_allocate).toBe(5);
  });

  it("puts a consultant's sales and the discount they gave side by side", async () => {
    const w = makeWorld("2026-10-14 10:00");
    const d = await makeMahindraDealer(w);
    await loadBookings(w, d.users.crm.session, [
      { no: "OTF27A000001", car: "THAR_WHITE", created: "01-Oct-2026 10:00 AM", customer: "ONE", sc: "CONSULTANT 001" },
      { no: "OTF27A000002", car: "THAR_WHITE", created: "02-Oct-2026 10:00 AM", customer: "TWO", sc: "CONSULTANT 002" },
    ]);
    await loadRetail(w, d.users.crm.session, [
      { no: "INV27A000001", car: "THAR_WHITE", vin: "MA1THAR0000000001", date: "2026-10-10", selling: 1_000_000, dealerDiscount: 50_000, raw: { "SC Name": "CONSULTANT 001" } },
      { no: "INV27A000002", car: "THAR_WHITE", vin: "MA1THAR0000000002", date: "2026-10-11", selling: 1_000_000, raw: { "SC Name": "CONSULTANT 002" } },
    ], { asOn: "2026-10-14" });

    const rows = (await business(w, d, "2026-10-01", "2026-10-14")).body.consultants;
    const one = rows.find((r: any) => r.name === "CONSULTANT 001");
    const two = rows.find((r: any) => r.name === "CONSULTANT 002");
    // Both sold one car. Only one of them paid for it out of the dealership's margin, which is the
    // whole reason the column sits next to the revenue.
    expect(one).toMatchObject({ bookings: 1, invoiced: 1, avg_dealer_discount: 50_000 });
    expect(two).toMatchObject({ bookings: 1, invoiced: 1, avg_dealer_discount: 0 });
  });

  it("counts what was put to an approver and what went round them, day by day", async () => {
    const w = makeWorld("2026-10-14 10:00");
    const d = await makeMahindraDealer(w);
    await loadBookings(w, d.users.crm.session, [
      { no: "OTF27A000001", car: "THAR_WHITE", created: "01-Oct-2026 10:00 AM", customer: "HOLDING IT" },
      { no: "OTF27A000002", car: "THAR_BLACK", created: "02-Oct-2026 10:00 AM", customer: "WALKED IN" },
    ]);
    await loadStock(w, d.users.stock.session, [{ vin: "MA1THAR0000000001", car: "THAR_WHITE" }], { asOn: "2026-10-14" });
    await w.api("PUT", "/api/settings", { allocation_control_from: "2026-10-01" }, d.users.admin.session);

    // One change put up for approval and left waiting.
    const bookingId = w.db.q<{ id: string }>(`SELECT id FROM bookings WHERE booking_no = 'OTF27A000001'`)[0].id;
    const ex = await w.api(
      "POST", "/api/exceptions",
      { type: "RELEASE_ALLOCATION", booking_id: bookingId, payload: { release_reason: "MANAGEMENT_PRIORITY", until: "2026-11-30" }, reason: "Wanted for a demonstration" },
      d.users.lead.session,
    );
    expect(ex.status).toBe(201);

    // And one car allotted straight in the DMS that nobody here was asked about.
    w.at("2026-10-15 09:00");
    await loadStock(w, d.users.stock.session, [
      { vin: "MA1THAR0000000001", car: "THAR_WHITE" },
      { vin: "MA1THAR0000000002", car: "THAR_BLACK", order: "OTF27A000002", customer: "WALKED IN", allotDate: "2026-10-15" },
    ], { asOn: "2026-10-15" });

    const g = (await business(w, d, "2026-10-13", "2026-10-15")).body.governance;
    expect(g.totals).toMatchObject({ requested: 1, approved: 0, rejected: 0, pending: 1, outside: 1 });
    // Each on its own day: the request on the 14th, the DMS allotment on the day the DMS allotted it.
    expect(g.days.map((x: any) => [x.date.slice(5), x.requested, x.outside])).toEqual([
      ["10-13", 0, 0],
      ["10-14", 1, 0],
      ["10-15", 0, 1],
    ]);
    expect(g.pending).toHaveLength(1);
    expect(g.pending[0]).toMatchObject({ booking_no: "OTF27A000001", customer_name: "HOLDING IT", what: "Priority changed by management", status: "PENDING" });
    expect(g.pending[0].requested_by).toBe("Sunita Lead");
  });

  it("shows a decision once it is made, with who made it", async () => {
    const w = makeWorld("2026-10-14 10:00");
    const d = await makeMahindraDealer(w);
    await loadBookings(w, d.users.crm.session, [{ no: "OTF27A000001", car: "THAR_WHITE", created: "01-Oct-2026 10:00 AM", customer: "HOLDING IT" }]);
    await loadStock(w, d.users.stock.session, [{ vin: "MA1THAR0000000001", car: "THAR_WHITE" }], { asOn: "2026-10-14" });
    const bookingId = w.db.q<{ id: string }>(`SELECT id FROM bookings WHERE booking_no = 'OTF27A000001'`)[0].id;
    const ex = await w.api(
      "POST", "/api/exceptions",
      { type: "RELEASE_ALLOCATION", booking_id: bookingId, payload: { release_reason: "MANAGEMENT_PRIORITY", until: "2026-11-30" }, reason: "Wanted for a demonstration" },
      d.users.lead.session,
    );
    expect((await w.api("POST", `/api/exceptions/${ex.body.id}/approve`, {}, d.users.head.session)).status).toBe(200);

    const g = (await business(w, d, "2026-10-14", "2026-10-14")).body.governance;
    expect(g.totals).toMatchObject({ requested: 1, approved: 1, pending: 0 });
    expect(g.decided[0]).toMatchObject({ booking_no: "OTF27A000001", status: "APPROVED", decided_by: "Bikram Head" });
  });

  it("is not shown to someone who only sees their own bookings", async () => {
    const w = makeWorld("2026-10-14 10:00");
    const d = await makeMahindraDealer(w);
    expect((await w.api("GET", "/api/insights/business?from=2026-10-01&to=2026-10-14", undefined, d.users.exec.session)).status).toBe(403);
  });
});

describe("whether the system is being used", () => {
  it("counts how much allocation went through the system rather than round it", async () => {
    const w = makeWorld("2026-10-14 10:00");
    const d = await makeMahindraDealer(w);
    await loadBookings(w, d.users.crm.session, [
      { no: "OTF27A000001", car: "THAR_WHITE", created: "01-Oct-2026 10:00 AM", customer: "ONE" },
      { no: "OTF27A000002", car: "THAR_BLACK", created: "02-Oct-2026 10:00 AM", customer: "TWO" },
    ]);
    // One car free for the queue to allocate; one already allotted in the DMS.
    await loadStock(w, d.users.stock.session, [
      { vin: "MA1THAR0000000001", car: "THAR_WHITE" },
      { vin: "MA1THAR0000000002", car: "THAR_BLACK", order: "OTF27A000002", customer: "TWO" },
    ], { asOn: "2026-10-14" });

    const body = (await system(w, d, "2026-10-01", "2026-10-14")).body;
    expect(body.control).toMatchObject({ decided_here: 1, made_in_dms: 1, through_system_pct: 50 });
    expect(body.files).toMatchObject({ days_with_stock: 1, days_with_bookings: 1, days_with_retail: 0, error_rows: 0 });
  });

  it("counts a person as using the system when they have done something, not when they signed in", async () => {
    const w = makeWorld("2026-10-14 10:00");
    const d = await makeMahindraDealer(w);
    // Everybody has signed in to be created, but only the ones who loaded a file have done anything.
    await loadStock(w, d.users.stock.session, [{ vin: "MA1THAR0000000001", car: "THAR_WHITE" }], { asOn: "2026-10-14" });
    const people = (await system(w, d, "2026-10-01", "2026-10-14")).body.people;
    expect(people.users).toBe(Object.keys(d.users).length);
    expect(people.active_30 + people.idle).toBe(people.users);
    expect(people.idle).toBeGreaterThan(0);
    expect(people.by_role.reduce((n: number, r: any) => n + r.n, 0)).toBe(people.users);
  });

  it("is not shown to someone who does not run the system", async () => {
    const w = makeWorld("2026-10-14 10:00");
    const d = await makeMahindraDealer(w);
    expect((await w.api("GET", "/api/insights/system?from=2026-10-01&to=2026-10-14", undefined, d.users.lead.session)).status).toBe(403);
  });
});
