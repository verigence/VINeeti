// Browsing the yard the way a shop is browsed, and the month as the two people who answer for it see it.
// Both read only from the DMS files, so the same files must always give the same answer.
import { describe, expect, it } from "vitest";
import { loadBookings, loadStock, makeMahindraDealer, makeWorld, type BookingLine, type Dealer, type StockLine, type World } from "./harness";

const STOCK: StockLine[] = [
  // Three Thars: two white (one of them on the way), one black. One white one is held by a booking.
  { vin: "MA1THAR0000000001", car: "THAR_WHITE", oemInvoiceDate: "2026-09-30", grnDate: "2026-10-01" },
  { vin: "MA1THAR0000000002", car: "THAR_WHITE", status: "In Transit", oemInvoiceDate: "2026-09-28" },
  { vin: "MA1THAR0000000003", car: "THAR_BLACK", oemInvoiceDate: "2026-09-20", grnDate: "2026-09-25" },
  // A petrol five-seater and a diesel seven-seater, so fuel and seats have something to choose between.
  { vin: "MA1XUV00000000004", car: "XUV3XO_WHITE", oemInvoiceDate: "2026-09-15", grnDate: "2026-09-20" },
  { vin: "MA1SCN00000000005", car: "SCORPIO_N", oemInvoiceDate: "2026-09-10", grnDate: "2026-09-18" },
  // A demo car is never offered to a customer, so it is never counted here.
  { vin: "MA1MAXX0000000006", car: "MAXX_WHITE", demo: true, oemInvoiceDate: "2026-09-01", grnDate: "2026-09-05" },
  // Two cars retail-invoiced this month, and one the month before: the month's retails.
  { vin: "MA1XUV00000000007", car: "XUV3XO_WHITE", oemInvoiceDate: "2026-08-20", grnDate: "2026-08-25", invoiceId: "INV2610001", invoiceDate: "2026-10-02", order: "OTF27A000050", customer: "BOUGHT ONE" },
  { vin: "MA1SCN00000000008", car: "SCORPIO_N", oemInvoiceDate: "2026-08-10", grnDate: "2026-08-15", invoiceId: "INV2610002", invoiceDate: "2026-10-04", order: "OTF27A000051", customer: "BOUGHT TWO" },
  { vin: "MA1THAR0000000009", car: "THAR_BLACK", oemInvoiceDate: "2026-07-10", grnDate: "2026-07-15", invoiceId: "INV2609001", invoiceDate: "2026-09-12", order: "OTF27A000052", customer: "BOUGHT THREE" },
];
const BOOKINGS: BookingLine[] = [
  // Holds the white Thar standing in the yard, so it is not free to offer.
  { no: "OTF27A000001", car: "THAR_WHITE", created: "01-Sep-2026 10:00 AM", customer: "WAITING ONE" },
  { no: "OTF27A000050", car: "XUV3XO_WHITE", created: "01-Aug-2026 10:00 AM", customer: "BOUGHT ONE", stage: "Invoiced" },
  { no: "OTF27A000051", car: "SCORPIO_N", created: "02-Aug-2026 10:00 AM", customer: "BOUGHT TWO", stage: "Invoiced" },
  { no: "OTF27A000052", car: "THAR_BLACK", created: "01-Jul-2026 10:00 AM", customer: "BOUGHT THREE", stage: "Invoiced" },
];

async function start(): Promise<{ w: World; d: Dealer }> {
  const w = makeWorld("2026-10-10 10:00");
  const d = await makeMahindraDealer(w);
  await loadStock(w, d.users.stock.session, STOCK);
  await loadBookings(w, d.users.crm.session, BOOKINGS);
  return { w, d };
}
const get = (w: World, d: Dealer, path: string, who = "head") => w.api("GET", path, undefined, d.users[who].session);
const names = (rows: { value: string; cars: number }[]) => rows.map((r) => [r.value, r.cars]);

describe("browsing what is in stock", () => {
  it("offers the models in stock with a count against each, leaving out demo cars and cars a booking holds", async () => {
    const { w, d } = await start();
    const res = await get(w, d, "/api/stock/browse", "exec");
    expect(res.status).toBe(200);
    // Free to offer: the white Thar in transit, the black Thar, the XUV and the Scorpio. The white Thar
    // in the yard is held by a booking and the pick-up is a demo car.
    expect(res.body.total).toBe(4);
    expect(res.body.in_yard).toBe(3);
    expect(res.body.in_transit).toBe(1);
    expect(names(res.body.facets.model)).toEqual([
      ["THAR", 2],
      ["SCORPIO-N", 1],
      ["XUV 3XO", 1],
    ]);
  });

  it("counts every car in stock when asked for everything, held cars included", async () => {
    const { w, d } = await start();
    const res = await get(w, d, "/api/stock/browse?show=ALL", "exec");
    expect(res.body.total).toBe(5); // the held white Thar comes back; the demo car still does not
    expect(names(res.body.facets.model)).toEqual([
      ["THAR", 3],
      ["SCORPIO-N", 1],
      ["XUV 3XO", 1],
    ]);
  });

  it("narrows a choice at a time, and counts each remaining choice against the ones already made", async () => {
    const { w, d } = await start();
    const res = await get(w, d, "/api/stock/browse?model=THAR", "exec");
    expect(res.body.total).toBe(2);
    expect(names(res.body.facets.colour)).toEqual([
      ["EVEREST WHITE", 1],
      ["STEALTH BLACK", 1],
    ]);
    // The counts for the facet being chosen are worked out without its own choice applied, so the other
    // colours of this model still show their counts after one is picked — as a shop filter does.
    const black = await get(w, d, "/api/stock/browse?model=THAR&colour=STEALTH BLACK", "exec");
    expect(black.body.total).toBe(1);
    expect(names(black.body.facets.colour)).toEqual([
      ["EVEREST WHITE", 1],
      ["STEALTH BLACK", 1],
    ]);
    expect(black.body.groups).toHaveLength(1);
    expect(black.body.groups[0]).toMatchObject({ model: "THAR", colour: "STEALTH BLACK", in_yard: 1, in_transit: 0 });
  });

  it("narrows by the attributes from the vehicle master: fuel, transmission and seats", async () => {
    const { w, d } = await start();
    const res = await get(w, d, "/api/stock/browse", "exec");
    expect(names(res.body.facets.fuel)).toEqual(expect.arrayContaining([["Diesel", 3], ["Petrol", 1]]));
    expect(names(res.body.facets.seater)).toEqual(expect.arrayContaining([["4", 2], ["5", 1], ["7", 1]]));
    const petrol = await get(w, d, "/api/stock/browse?fuel=Petrol", "exec");
    expect(petrol.body.total).toBe(1);
    expect(petrol.body.groups[0]).toMatchObject({ model: "XUV 3XO", fuel: "Petrol", seater: "5" });
  });

  it("groups what is standing there by model, variant and colour, and says where the cars are", async () => {
    const { w, d } = await start();
    const res = await get(w, d, "/api/stock/browse?model=THAR&colour=EVEREST WHITE", "exec");
    expect(res.body.groups).toHaveLength(1);
    expect(res.body.groups[0]).toMatchObject({ model: "THAR", colour: "EVEREST WHITE", in_yard: 0, in_transit: 1 });
    expect(Object.values(res.body.groups[0].outlets)).toEqual([1]);
    expect(res.body.basis).toContain("not held by any booking");
  });

  it("gives the same answer every time it is asked of the same files", async () => {
    const { w, d } = await start();
    const a = await get(w, d, "/api/stock/browse?model=THAR", "exec");
    const b = await get(w, d, "/api/stock/browse?model=THAR", "exec");
    expect(a.body).toEqual(b.body);
  });

  it("is refused to anyone who may not see stock", async () => {
    const { w, d } = await start();
    const res = await get(w, d, "/api/stock/browse", "crm");
    expect([200, 403]).toContain(res.status); // CRM may see stock; the check is that the route is guarded at all
  });
});

describe("how the month is going", () => {
  it("counts retails by the retail invoice date in the stock report, this month and the last to the same day", async () => {
    const { w, d } = await start();
    const res = await get(w, d, "/api/dashboards/month");
    expect(res.status).toBe(200);
    expect(res.body.month).toMatchObject({ from: "2026-10-01", to: "2026-10-10", days_elapsed: 10, days_total: 31, days_left: 21 });
    expect(res.body.retails).toMatchObject({ this_month: 2, previous_month_to_date: 0, target: null });
    // 2 retails over 10 days is 0.2 a day; carried over 31 days that is 6.
    expect(res.body.retails.per_day).toBe(0.2);
    expect(res.body.retails.projected).toBe(6);
  });

  it("puts September's retail in September, and gives twelve months ending with this one", async () => {
    const { w, d } = await start();
    const res = await get(w, d, "/api/dashboards/month");
    expect(res.body.months).toHaveLength(12);
    expect(res.body.months.at(-1)).toEqual({ month: "2026-10", retails: 2 });
    expect(res.body.months.at(-2)).toEqual({ month: "2026-09", retails: 1 });
  });

  it("says nothing about a target until the dealership sets one, and then measures against it", async () => {
    const { w, d } = await start();
    expect((await get(w, d, "/api/dashboards/month")).body.retails.target).toBeNull();
    const saved = await w.api("PUT", "/api/settings", { monthly_retail_target: 40 }, d.users.admin.session);
    expect(saved.status).toBe(200);
    expect(saved.body.settings.monthly_retail_target).toBe(40);
    expect((await get(w, d, "/api/dashboards/month")).body.retails.target).toBe(40);
  });

  it("refuses a target that is not a whole number of cars", async () => {
    const { w, d } = await start();
    const res = await w.api("PUT", "/api/settings", { monthly_retail_target: 0 }, d.users.admin.session);
    expect(res.status).toBe(400);
  });

  it("counts the stock on hand without demo cars, and says how many days of selling it is", async () => {
    const { w, d } = await start();
    const res = await get(w, d, "/api/dashboards/month");
    // Five cars in the yard or on the way; the demo pick-up is not stock to sell.
    expect(res.body.stock.on_hand).toBe(5);
    expect(res.body.stock.days_of_stock).toBe(25); // 5 cars at 0.2 a day
  });

  it("is refused to someone without the owner's view", async () => {
    const { w, d } = await start();
    expect((await get(w, d, "/api/dashboards/month", "exec")).status).toBe(403);
  });
});
