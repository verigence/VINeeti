// The retail invoice export, the third file the dealership produces every evening.
//
// The figures in the first block are the real file's figures: an anonymised copy of the dealership's
// retail export for August 2026 to date (1,166 invoices), with identifiers kept consistent with the
// stock and booking fixtures so a car or a booking that appears in two files is the same one.
//
// What the file is for: the stock report moves cars, the booking sheet moves orders, and this file
// says what the dealership earned on them. Reading it must not be able to disturb either of the
// other two, which the last block checks.
import { beforeAll, describe, expect, it } from "vitest";
import { bookingSheet, loadBookings, loadFile, loadRetail, loadStock, makeMahindraDealer, makeWorld, retailExport, retailFile, stockReport, type Dealer, type World } from "./harness";

const one = (w: World, sql: string, ...p: unknown[]) => w.db.q<{ n: number }>(sql, ...p)[0].n;
const invoice = (w: World, no: string) => w.db.q<any>(`SELECT * FROM retail_invoices WHERE invoice_no = ?`, no)[0];

describe("the dealership's own retail export", () => {
  let w: World, d: Dealer, res: any;
  beforeAll(async () => {
    w = makeWorld("2026-10-16 09:00");
    d = await makeMahindraDealer(w);
    await loadFile(w, "stock", stockReport(), d.users.stock.session);
    await loadFile(w, "bookings", bookingSheet(), d.users.crm.session);
    res = await loadFile(w, "retail", retailExport(), d.users.crm.session, "&report_date=2026-10-16");
  }, 240_000);

  it("reads every invoice in the file, with no row in error", () => {
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ kind: "RETAIL", report_date: "2026-10-16", row_count: 1166, created: 1166, updated: 0, unchanged: 0, more: false });
    expect(res.body.errors).toEqual([]);
    expect(one(w, `SELECT COUNT(*) AS n FROM retail_invoices`)).toBe(1166);
    // The export covers a period, not a position: ten weeks of invoices, not one day's.
    expect(w.db.q<any>(`SELECT MIN(invoice_date) AS lo, MAX(invoice_date) AS hi, COUNT(DISTINCT invoice_date) AS days FROM retail_invoices`)[0]).toEqual({ lo: "2026-08-01", hi: "2026-10-14", days: 65 });
    expect(w.db.q<{ k: string; n: number }>(`SELECT o.code AS k, COUNT(*) AS n FROM retail_invoices r JOIN outlets o ON o.id = r.outlet_id GROUP BY 1 ORDER BY 1`)).toEqual([
      { k: "SM01", n: 855 }, { k: "SM02", n: 196 }, { k: "SM09", n: 31 }, { k: "SM15", n: 41 }, { k: "SM17", n: 43 },
    ]);
  });

  it("ties each invoice to the car and the order it names, where the system holds them", () => {
    // 368 of the invoices are for cars still in the stock report; the rest were invoiced and have left it.
    expect(one(w, `SELECT COUNT(*) AS n FROM retail_invoices WHERE vehicle_id IS NOT NULL`)).toBe(368);
    expect(one(w, `SELECT COUNT(*) AS n FROM retail_invoices WHERE vin IS NOT NULL`)).toBe(1166);
    // The number this file calls "Booking No." is the dealer-side one, which the booking sheet calls
    // "Booking Number" -- not the DMS order number bookings are keyed by. 329 invoices name an order
    // that is in the September booking sheet; the rest are for orders from before it.
    expect(one(w, `SELECT COUNT(*) AS n FROM retail_invoices WHERE booking_id IS NOT NULL`)).toBe(329);
    expect(one(w, `SELECT COUNT(*) AS n FROM retail_invoices r JOIN bookings b ON b.id = r.booking_id WHERE b.dms_ref = r.booking_no`)).toBe(329);
    // Two chassis carry two invoices each. Both rows are kept: the file says so, and which of the two
    // stands is not something this file answers.
    expect(one(w, `SELECT COUNT(*) AS n FROM (SELECT vin FROM retail_invoices WHERE vin IS NOT NULL GROUP BY vin HAVING COUNT(*) > 1)`)).toBe(2);
  });

  it("says what the dealership earned, what it gave away, and what came attached", () => {
    const s = res.body.summary;
    expect(s.invoices).toEqual({ total: 1166, new: 1166, changed: 0, unchanged: 0, withdrawn: 0 });
    // Prices in the fixture are synthetic (they are the dealership's own commercial figures), so what
    // is asserted here is that the money adds up, not the amounts themselves.
    expect(s.money.invoiced).toBeGreaterThan(s.money.selling);
    expect(s.money.oem_discount).toBeGreaterThan(s.money.dealer_discount);
    // The attached business is the real file's: 802 cars have a delivery note, 645 were financed
    // through the dealership, 38 were exchanges.
    expect(s.attached).toEqual({ financed: 1059, dealer_arranged: 645, insured: 801, exchanged: 38, delivered: 802 });
  });

  it("does not call a discount unclaimed when the file never fills that claim column at all", () => {
    // 626 invoices carry a manufacturer's scheme discount and not one of them has a BNDP credit note
    // number, because this export leaves that column blank on every row. The file is silent, which is
    // not the same as saying nothing was claimed, so nothing is read from it -- and the silence is
    // reported rather than hidden.
    expect(res.body.summary.claims_not_stated).toEqual(["BNDP credit note number"]);
    expect(res.body.summary.issues.discount_without_claim).toBeUndefined();
    expect(res.body.summary.money.unclaimed_discount).toBe(0);
    // The two claim columns the file does fill are filled on every discount they apply to.
    expect(one(w, `SELECT COUNT(*) AS n FROM retail_invoices WHERE loyalty_discount > 0 AND loyalty_credit_note IS NULL`)).toBe(0);
    expect(one(w, `SELECT COUNT(*) AS n FROM retail_invoices WHERE exchange_discount > 0 AND exchange_credit_note IS NULL`)).toBe(0);
  });

  it("reading it again changes nothing", async () => {
    const again = await loadFile(w, "retail", retailExport(), d.users.crm.session, "&report_date=2026-10-16");
    expect(again.body).toMatchObject({ created: 0, updated: 0, unchanged: 1166 });
    expect(again.body.summary.invoices.withdrawn).toBe(0);
    expect(one(w, `SELECT COUNT(*) AS n FROM retail_invoices`)).toBe(1166);
  });
});

describe("what the export says, and what it does not", () => {
  let w: World, d: Dealer;
  beforeAll(async () => {
    w = makeWorld("2026-10-16 09:00");
    d = await makeMahindraDealer(w);
  }, 60_000);

  it("flags a discount with no credit note, once the file shows it fills that column", async () => {
    const res = await loadRetail(w, d.users.crm.session, [
      { no: "INV99A000001", car: "THAR_WHITE", vin: "MA1SAMPLE00000001", loyaltyDiscount: 20000, loyaltyClaim: "CRN99A000001" },
      { no: "INV99A000002", car: "THAR_BLACK", vin: "MA1SAMPLE00000002", loyaltyDiscount: 15000 },
    ], { asOn: "2026-10-16" });
    expect(res.status).toBe(200);
    expect(res.body.summary.issues).toEqual({ discount_without_claim: 1, no_booking: 2 });
    expect(res.body.summary.money.unclaimed_discount).toBe(15000);
    expect(res.body.summary.claims_not_stated).toEqual([]);
  });

  it("marks an invoice withdrawn when it stops being listed, and keeps the row", async () => {
    const lines = [
      { no: "INV99B000001", car: "THAR_WHITE", vin: "MA1SAMPLE00000011", date: "2026-10-10" },
      { no: "INV99B000002", car: "THAR_BLACK", vin: "MA1SAMPLE00000012", date: "2026-10-11" },
    ] as const;
    await loadRetail(w, d.users.crm.session, [...lines], { asOn: "2026-10-16" });
    expect(invoice(w, "INV99B000002").withdrawn_on).toBe(null);

    const res = await loadRetail(w, d.users.crm.session, [lines[0]], { asOn: "2026-10-16" });
    expect(res.body.summary.invoices.withdrawn).toBe(1);
    // The row stays, marked. An invoice that was withdrawn is a thing that happened.
    expect(invoice(w, "INV99B000002")).toMatchObject({ invoice_no: "INV99B000002", withdrawn_on: "2026-10-16" });
    expect(one(w, `SELECT COUNT(*) AS n FROM alerts WHERE kind = 'INVOICE_REVERSED' AND is_alarm = 1`)).toBeGreaterThan(0);

    // Listed again, it is no longer withdrawn: the row counts as changed even though every other
    // value matches, because the withdrawal is what the new file undoes.
    const back = await loadRetail(w, d.users.crm.session, [...lines], { asOn: "2026-10-17" });
    expect(back.body.summary.invoices).toMatchObject({ changed: 1, unchanged: 1, withdrawn: 0 });
    expect(invoice(w, "INV99B000002").withdrawn_on).toBe(null);
  });

  it("will not withdraw invoices from a period the file does not cover", async () => {
    await loadRetail(w, d.users.crm.session, [{ no: "INV99C000001", car: "THAR_WHITE", vin: "MA1SAMPLE00000021", date: "2026-09-02" }], { asOn: "2026-09-30" });
    // A file for October says nothing about September.
    await loadRetail(w, d.users.crm.session, [{ no: "INV99C000002", car: "THAR_BLACK", vin: "MA1SAMPLE00000022", date: "2026-10-05" }], { asOn: "2026-10-16" });
    expect(invoice(w, "INV99C000001").withdrawn_on).toBe(null);
  });

  it("refuses a file that is not the retail export, and says which one it looks like", async () => {
    const asStock = await loadFile(w, "retail", stockReport(), d.users.crm.session, "&report_date=2026-10-16");
    expect(asStock.status).toBe(400);
    expect(asStock.body.error.message).toContain("stock report");
    const asBookings = await loadFile(w, "retail", bookingSheet(), d.users.crm.session, "&report_date=2026-10-16");
    expect(asBookings.status).toBe(400);
    expect(asBookings.body.error.message).toContain("booking sheet");
  });

  it("refuses a file for another dealership", async () => {
    const res = await loadFile(w, "retail", retailFile([{ no: "INV99D000001", car: "THAR_WHITE", vin: "MA1SAMPLE00000031" }], "OTHER MOTORS"), d.users.crm.session, "&report_date=2026-10-16");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("WRONG_DEALER");
  });

  it("does not move a car or a booking", async () => {
    const w2 = makeWorld("2026-10-16 09:00");
    const d2 = await makeMahindraDealer(w2);
    await loadStock(w2, d2.users.stock.session, [
      { vin: "MA1SAMPLE00000101", car: "THAR_WHITE" },
      { vin: "MA1SAMPLE00000102", car: "THAR_BLACK" },
    ], { asOn: "2026-10-16" });
    await loadBookings(w2, d2.users.crm.session, [{ no: "OTF99A000101", car: "THAR_WHITE", created: "01-Oct-2026 10:00 AM" }]);
    const before = {
      vehicles: w2.db.q<any>(`SELECT vin, status, dms_stock_type FROM vehicles ORDER BY vin`),
      bookings: w2.db.q<any>(`SELECT booking_no, status FROM bookings ORDER BY booking_no`),
      allocations: w2.db.q<any>(`SELECT booking_id, vehicle_id, status FROM allocations ORDER BY booking_id`),
      events: one(w2, `SELECT COUNT(*) AS n FROM vehicle_events`),
    };
    // A retail export that says both cars were invoiced to orders the system has never seen.
    const res = await loadRetail(w2, d2.users.crm.session, [
      { no: "INV99E000001", car: "THAR_WHITE", vin: "MA1SAMPLE00000101", booking: "B-00009901" },
      { no: "INV99E000002", car: "THAR_BLACK", vin: "MA1SAMPLE00000102", booking: "B-00009902" },
    ], { asOn: "2026-10-16" });
    expect(res.status).toBe(200);
    expect(res.body.allocations).toBe(0);
    expect(w2.db.q<any>(`SELECT vin, status, dms_stock_type FROM vehicles ORDER BY vin`)).toEqual(before.vehicles);
    expect(w2.db.q<any>(`SELECT booking_no, status FROM bookings ORDER BY booking_no`)).toEqual(before.bookings);
    expect(w2.db.q<any>(`SELECT booking_id, vehicle_id, status FROM allocations ORDER BY booking_id`)).toEqual(before.allocations);
    expect(one(w2, `SELECT COUNT(*) AS n FROM vehicle_events`)).toBe(before.events);
  });
});
