// The dealership's other booking export.
//
// It exports its bookings from two different DMS screens and they do not agree on a single heading:
// the September order book calls the DMS order "DMS Booking Number", the live order book calls the
// same number "OTF Number", gives the outlet by name with no code at all, carries no phone number or
// booking amount, and uses a status the other one never does. Both are "the booking sheet" to the
// person uploading, so which arrived is worked out from the headings rather than asked.
//
// The figures here are the real file's: an anonymised copy of the live order book as on 16 Oct 2026,
// with identifiers consistent with the other fixtures.
import { beforeAll, describe, expect, it } from "vitest";
import { bookingSheet, liveBookings, loadFile, makeMahindraDealer, makeWorld, retailExport, stockReport, type Dealer, type World } from "./harness";

const one = (w: World, sql: string, ...p: unknown[]) => w.db.q<{ n: number }>(sql, ...p)[0].n;

describe("the live order book", () => {
  let w: World, d: Dealer, res: any;
  beforeAll(async () => {
    w = makeWorld("2026-10-17 09:00");
    d = await makeMahindraDealer(w);
    // The stock report comes first: it is what names the outlets, and this export has no codes.
    await loadFile(w, "stock", stockReport(), d.users.stock.session);
    res = await loadFile(w, "bookings", liveBookings(), d.users.crm.session);
  }, 240_000);

  it("is recognised as a booking export despite naming everything differently", () => {
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ kind: "BOOKINGS", row_count: 1409, created: 1399, more: false });
    expect(res.body.summary.bookings).toBe(1409);
  });

  it("reads the DMS order number from the column this export calls OTF Number", () => {
    // The same namespace as the stock report's Order ID, which is what makes a car's allotment
    // findable from a booking. The dealer-side B-... number is kept beside it, as the other export does.
    expect(one(w, `SELECT COUNT(*) AS n FROM bookings WHERE source = 'DMS' AND booking_no LIKE 'OTF%'`)).toBe(1404);
    expect(one(w, `SELECT COUNT(*) AS n FROM bookings WHERE source = 'DMS' AND dms_ref LIKE 'B-%'`)).toBe(1404);
  });

  it("matches outlets by name, because this export carries no codes, and says so when one is unknown", () => {
    expect(w.db.q<{ k: string; n: number }>(`SELECT o.code AS k, COUNT(*) AS n FROM bookings b JOIN outlets o ON o.id = b.outlet_id WHERE b.source = 'DMS' GROUP BY 1 ORDER BY 1`)).toEqual([
      { k: "SM01", n: 1098 }, { k: "SM02", n: 137 }, { k: "SM09", n: 29 }, { k: "SM15", n: 69 }, { k: "SM17", n: 71 },
    ]);
    // One booking is for a branch with no car in the stock report. Nothing is invented from a name:
    // an outlet made up here would be a second one for the same branch the moment codes arrive.
    const unknown = res.body.errors.filter((e: any) => e.message.includes("JAGATSINGHPUR_SZS"));
    expect(unknown).toHaveLength(1);
    expect(one(w, `SELECT COUNT(*) AS n FROM outlets`)).toBe(5);
  });

  it("treats a booking the DMS calls Allotted as an open booking", () => {
    // It is waiting to be invoiced like any other; which car it holds is the stock report's to say.
    expect(res.body.summary.booked).toBe(1409);
    expect(res.body.summary.cancelled).toBe(0);
  });

  it("reads the model, colour and model codes out of the description, which this export carries in full", () => {
    // The older sheet had the description stripped of its codes and needed a Model Code column to
    // recover them; this one carries the stock report's form, codes and all, and is read the same
    // way. Read as bare text instead, the codes stay stuck in the variant and are lost as codes --
    // which is every booking in the file, not a handful.
    expect(one(w, `SELECT COUNT(*) AS n FROM bookings WHERE source = 'DMS' AND oem_model_code IS NULL`)).toBe(0);
    expect(one(w, `SELECT COUNT(*) AS n FROM bookings WHERE source = 'DMS' AND variant_id IS NULL`)).toBe(0);
    expect(w.db.q<any>(`SELECT oem_model_code, variant, colour FROM bookings WHERE booking_no = 'OTF99A000004'`)[0]).toEqual({
      oem_model_code: "M0246", variant: "1.7 LX (M0246)", colour: "WHITE",
    });
    // And because they are read the same way, a booking and a car for the same thing agree on what
    // that thing is, rather than the file inventing a second variant for every model in it.
    expect(res.body.summary.variants_added).toBe(150);
  });

  it("does not complain about a missing phone number on every row of a file that has no phone column", () => {
    // The warning is for a row whose number is unusable, not for a file that was never going to have
    // one: 1,409 of them would bury the errors that are about the dealership's data.
    expect(res.body.errors.filter((e: any) => e.message.includes("mobile"))).toEqual([]);
    // What is left is about the dealership's own data: one booking at a branch with no outlet, and
    // four rows with no colour in them.
    expect(res.body.errors).toHaveLength(5);
    expect(res.body.errors.filter((e: any) => e.message === "Colour is blank")).toHaveLength(4);
  });

  it("puts the bookings in the queue in the order the dealership took them", () => {
    const first = w.db.q<any>(`SELECT booking_date, priority_ts FROM bookings WHERE source = 'DMS' ORDER BY priority_ts LIMIT 1`)[0];
    expect(first.priority_ts).toBe(first.booking_date);
    expect(res.body.summary.entered_queue).toBe(1399);
  });

  it("will not take the stock report or the retail export under this name either", async () => {
    const asStock = await loadFile(w, "bookings", stockReport(), d.users.crm.session);
    expect(asStock.body.error.message).toContain("stock report");
    const asRetail = await loadFile(w, "bookings", retailExport(), d.users.crm.session);
    expect(asRetail.body.error.message).toContain("retail export");
  });

  it("still reads the other booking export, unchanged", async () => {
    const w2 = makeWorld("2026-10-17 09:00");
    const d2 = await makeMahindraDealer(w2);
    const old = await loadFile(w2, "bookings", bookingSheet(), d2.users.crm.session);
    expect(old.status).toBe(200);
    expect(old.body.summary).toMatchObject({ bookings: 636, booked: 368, cancelled: 16 });
  });
});
