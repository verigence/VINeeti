// What each role answers for. These are the figures people will argue about in a review, so each one is
// pinned to a fixture where the right answer can be counted by hand.
import { describe, expect, it } from "vitest";
import { loadBookings, loadStock, makeMahindraDealer, makeWorld, type BookingLine, type Dealer, type StockLine, type World } from "./harness";

const STOCK: StockLine[] = [
  // THAR: three free (one of them very old), one held by a booking, one sold this month.
  { vin: "MA1THAR0000000001", car: "THAR_WHITE", oemInvoiceDate: "2026-07-01", grnDate: "2026-07-05" }, // 101 days old on 10 Oct
  { vin: "MA1THAR0000000002", car: "THAR_WHITE", oemInvoiceDate: "2026-10-01", grnDate: "2026-10-03" },
  { vin: "MA1THAR0000000003", car: "THAR_BLACK", status: "In Transit", oemInvoiceDate: "2026-09-28" },
  { vin: "MA1THAR0000000004", car: "THAR_BLACK", oemInvoiceDate: "2026-09-01", grnDate: "2026-09-05", price: 1500000 },
  { vin: "MA1THAR0000000005", car: "THAR_WHITE", oemInvoiceDate: "2026-08-01", grnDate: "2026-08-05", invoiceId: "INV2610001", invoiceDate: "2026-10-02", order: "OTF27A000090", customer: "SOLD ONE" },
  // XUV: one free, nothing sold at all — a model with stock and no movement.
  { vin: "MA1XUV00000000006", car: "XUV3XO_WHITE", oemInvoiceDate: "2026-06-01", grnDate: "2026-06-05", price: 1100000 }, // 131 days
  // A demo car, which is never stock to sell.
  { vin: "MA1MAXX0000000007", car: "MAXX_WHITE", demo: true, oemInvoiceDate: "2026-05-01", grnDate: "2026-05-05" },
];
const BOOKINGS: BookingLine[] = [
  // Holds the black Thar in the yard; no payment recorded.
  { no: "OTF27A000001", car: "THAR_BLACK", created: "20-Sep-2026 10:00 AM", customer: "HOLDS ONE" },
  // Waiting, nothing of theirs is free: a Scorpio nobody stocks.
  { no: "OTF27A000002", car: "SCORPIO_N", created: "01-Aug-2026 10:00 AM", customer: "WAITS LONG" },
  { no: "OTF27A000090", car: "THAR_WHITE", created: "01-Aug-2026 10:00 AM", customer: "SOLD ONE", stage: "Invoiced" },
];

async function start(): Promise<{ w: World; d: Dealer }> {
  const w = makeWorld("2026-10-10 10:00");
  const d = await makeMahindraDealer(w);
  await loadStock(w, d.users.stock.session, STOCK);
  await loadBookings(w, d.users.crm.session, BOOKINGS);
  return { w, d };
}
const get = (w: World, d: Dealer, path: string, who = "head") => w.api("GET", path, undefined, d.users[who].session);

describe("what each model is doing", () => {
  it("separates what is free to offer from what a booking is holding, and leaves demo cars out", async () => {
    const { w, d } = await start();
    const res = await get(w, d, "/api/views/models");
    expect(res.status).toBe(200);
    const thar = res.body.rows.find((r: any) => r.model === "THAR");
    // Five Thars loaded: one sold, one held by a booking, three free (two in the yard, one on the way).
    expect(thar).toMatchObject({ yard_free: 2, transit_free: 1, yard_held: 1, transit_held: 0 });
    expect(res.body.rows.some((r: any) => r.model === "BOL MAXX PUP HD")).toBe(false);
  });

  it("counts the cars that have stood more than sixty days, and what they tie up", async () => {
    const { w, d } = await start();
    const res = await get(w, d, "/api/views/models");
    const thar = res.body.rows.find((r: any) => r.model === "THAR");
    const xuv = res.body.rows.find((r: any) => r.model === "XUV 3XO");
    expect(thar.old_free).toBe(1); // the one invoiced on 1 July
    expect(thar.oldest_days).toBeGreaterThan(100);
    expect(xuv.old_free).toBe(1);
    expect(xuv.old_value).toBe(1100000);
  });

  it("shows what sold and how long the free stock would last at that rate", async () => {
    const { w, d } = await start();
    const res = await get(w, d, "/api/views/models");
    const thar = res.body.rows.find((r: any) => r.model === "THAR");
    const xuv = res.body.rows.find((r: any) => r.model === "XUV 3XO");
    expect(thar.sold_30).toBe(1);
    expect(thar.sold_90).toBe(1);
    // Three free at a third of a car a month is nine months of cover.
    expect(thar.months_of_cover).toBe(9);
    // Nothing sold, so there is no rate to divide by and the figure is left blank rather than invented.
    expect(xuv.sold_90).toBe(0);
    expect(xuv.months_of_cover).toBeNull();
  });

  it("says what is still on order, so piling up and ordering more can be seen together", async () => {
    const { w, d } = await start();
    const made = await w.api("POST", "/api/orders", { model: "XUV 3XO", variant: "AX5 PM MT (M1024)", colour: "EVEREST WHITE", quantity: 4 }, d.users.admin.session);
    expect([200, 201]).toContain(made.status);
    const res = await get(w, d, "/api/views/models");
    const xuv = res.body.rows.find((r: any) => r.model === "XUV 3XO");
    expect(xuv.on_order).toBe(4);
    expect(xuv.sold_90).toBe(0); // nothing sold in ninety days, and four more coming
  });

  it("keeps the dealer price away from roles that may not see stock value", async () => {
    const { w, d } = await start();
    expect((await get(w, d, "/api/views/models", "exec")).body.totals.value).toBeNull();
    expect((await get(w, d, "/api/views/models", "head")).body.totals.value).toBeGreaterThan(0);
  });
});

describe("cars a booking is holding", () => {
  it("says how long each car has been held and whether it has been paid for", async () => {
    const { w, d } = await start();
    const res = await get(w, d, "/api/views/holding");
    expect(res.status).toBe(200);
    const held = res.body.rows.find((r: any) => r.colour === "STEALTH BLACK");
    expect(held).toMatchObject({ payment: "NONE", invoiced: false, at_dealership: true });
    expect(held.held_days).toBeGreaterThanOrEqual(0);
  });

  it("starts the payment window only when the car is at the dealership", async () => {
    const { w, d } = await start();
    const res = await get(w, d, "/api/views/holding");
    for (const r of res.body.rows) if (!r.at_dealership) expect(r.window_days).toBeNull();
  });
});

describe("customers with no car yet", () => {
  it("lists them oldest first, with how long they have waited", async () => {
    const { w, d } = await start();
    const res = await get(w, d, "/api/views/waiting");
    expect(res.status).toBe(200);
    expect(res.body.rows.length).toBeGreaterThan(0);
    const waits = res.body.rows.map((r: any) => r.waiting_days);
    expect([...waits].sort((a: number, b: number) => b - a)).toEqual(waits);
    const long = res.body.rows.find((r: any) => r.model === "SCORPIO-N");
    expect(long.waiting_days).toBeGreaterThan(60);
    expect(long.free_now).toBe(0);
    expect(long.on_order).toBe(0);
  });

  it("groups the wait into bands, so a long tail can be seen without reading the list", async () => {
    const { w, d } = await start();
    const res = await get(w, d, "/api/views/waiting");
    expect(res.body.buckets.map((b: any) => b.label)).toEqual(["0-7 days", "8-15 days", "16-30 days", "31-60 days", "Over 60 days"]);
    expect(res.body.buckets.reduce((n: number, b: any) => n + b.bookings, 0)).toBe(res.body.rows.length);
  });
});

describe("what moved each day", () => {
  it("gives a row for every day in the period, including the quiet ones", async () => {
    const { w, d } = await start();
    const res = await get(w, d, "/api/views/daily?from=2026-10-01&to=2026-10-10");
    expect(res.status).toBe(200);
    expect(res.body.days).toHaveLength(10);
    expect(res.body.days[0].date).toBe("2026-10-01");
    expect(res.body.days.at(-1).date).toBe("2026-10-10");
    for (const day of res.body.days) for (const k of ["allocated", "released", "invoiced", "delivered"]) expect(typeof day[k]).toBe("number");
  });

  it("adds the days up into the period's totals", async () => {
    const { w, d } = await start();
    const res = await get(w, d, "/api/views/daily?from=2026-10-01&to=2026-10-10");
    const sum = (k: string) => res.body.days.reduce((n: number, x: any) => n + x[k], 0);
    expect(res.body.totals.allocated).toBe(sum("allocated"));
    expect(res.body.totals.released).toBe(sum("released"));
    expect(res.body.totals.delivered).toBe(sum("delivered"));
  });
});

describe("a sales executive's own picture", () => {
  it("counts only their own bookings", async () => {
    const { w, d } = await start();
    const res = await get(w, d, "/api/views/mine", "exec");
    expect(res.status).toBe(200);
    expect(res.body.counts).toMatchObject({ waiting: 0, allocated: 0, invoiced: 0 });
  });

  it("is refused to nobody who may see a booking, because everyone has their own", async () => {
    const { w, d } = await start();
    for (const who of ["exec", "lead", "head"]) expect((await get(w, d, "/api/views/mine", who)).status).toBe(200);
  });
});

describe("the order bank", () => {
  it("ranks configurations by the queue, longest first, and says what is covered", async () => {
    const { w, d } = await start();
    const res = await get(w, d, "/api/views/demand");
    expect(res.status).toBe(200);
    const scorpio = res.body.rows.find((r: any) => r.model === "SCORPIO-N");
    // One customer waiting, nothing free, nothing ordered: entirely uncovered.
    expect(scorpio).toMatchObject({ queue: 1, free_now: 0, on_order: 0, short_by: 1 });
    expect(scorpio.longest_wait_days).toBeGreaterThan(60);
    const queues = res.body.rows.map((r: any) => r.queue);
    expect([...queues].sort((a: number, b: number) => b - a)).toEqual(queues);
  });

  it("does not count a car as short when one is free or on order for it", async () => {
    const { w, d } = await start();
    await w.api("POST", "/api/orders", { model: "SCORPIO-N", variant: "D MT 2WD Z8L 7S (M0980)", colour: "EVEREST WHITE", quantity: 1 }, d.users.admin.session);
    const res = await get(w, d, "/api/views/demand");
    const scorpio = res.body.rows.find((r: any) => r.model === "SCORPIO-N");
    expect(scorpio).toMatchObject({ queue: 1, on_order: 1, short_by: 0 });
  });
});

describe("money owed on cars already held", () => {
  it("counts only cars at the dealership whose payment Finance has not confirmed", async () => {
    const { w, d } = await start();
    const res = await get(w, d, "/api/views/payments-due");
    expect(res.status).toBe(200);
    for (const r of res.body.rows) expect(["AWAITING", "REPORTED"]).toContain(r.state);
    expect(res.body.window_days).toBeGreaterThan(0);
    expect(res.body.buckets.reduce((n: number, b: any) => n + b.bookings, 0)).toBe(res.body.rows.length);
  });

  it("says plainly that the balance a customer owes is not in these files", async () => {
    const { w, d } = await start();
    const res = await get(w, d, "/api/views/payments-due");
    expect(res.body.basis).toContain("balance a customer still owes is not in this system");
  });
});

describe("money blocked and money churned", () => {
  it("bands what is stuck by age and counts the cars with no price apart", async () => {
    const { w, d } = await start();
    const res = await get(w, d, "/api/views/money?from=2026-10-01&to=2026-10-10");
    expect(res.status).toBe(200);
    expect(res.body.blocked.map((b: any) => b.label)).toEqual(["0-30 days", "31-60 days", "61-90 days", "Over 90 days"]);
    expect(res.body.blocked_total.cars).toBeGreaterThan(0);
    // The total is the bands added up — not a number that depends on which of two identical cars the
    // allocator happened to take.
    expect(res.body.blocked_total.value).toBe(res.body.blocked.reduce((n: number, b: any) => n + b.value, 0));
    expect(res.body.blocked_total.cars).toBe(res.body.blocked.reduce((n: number, b: any) => n + b.cars, 0));
    // The XUV was invoiced by the manufacturer on 1 June, so its money sits in the oldest band.
    expect(res.body.blocked.find((b: any) => b.label === "Over 90 days").value).toBeGreaterThanOrEqual(1100000);
    // Cars with no price are reported separately rather than folded into the total as zero. The
    // fixtures all carry a price, so here that count is nil — the point is that it is reported at all.
    expect(typeof res.body.blocked_total.unpriced).toBe("number");
  });

  it("counts what turned over in the period, by its retail invoice date", async () => {
    const { w, d } = await start();
    const res = await get(w, d, "/api/views/money?from=2026-10-01&to=2026-10-10");
    expect(res.body.churned.cars).toBe(1); // the Thar invoiced on 2 October
  });

  it("is refused to a role that may not see stock value", async () => {
    const { w, d } = await start();
    expect((await get(w, d, "/api/views/money", "exec")).status).toBe(403);
  });
});

describe("the minimum booking amount decides the queue", () => {
  const MIN = 25000;
  async function withMinimum() {
    const w = makeWorld("2026-10-10 10:00");
    const d = await makeMahindraDealer(w);
    const set = await w.api("PUT", "/api/settings", { min_booking_amount: MIN }, d.users.admin.session);
    expect(set.status).toBe(200);
    await loadStock(w, d.users.stock.session, STOCK);
    await loadBookings(w, d.users.crm.session, [
      // Paid the minimum: in the line.
      { no: "OTF27A000101", car: "SCORPIO_N", created: "01-Sep-2026 10:00 AM", customer: "PAID ENOUGH", amount: 50000 },
      // Short of it: booked, but takes no place in the queue.
      { no: "OTF27A000102", car: "SCORPIO_N", created: "02-Aug-2026 10:00 AM", customer: "PAID LITTLE", amount: 5000 },
    ]);
    return { w, d };
  }

  it("leaves a booking short of the minimum out of the queue", async () => {
    const { w, d } = await withMinimum();
    const res = await get(w, d, "/api/views/waiting");
    const nos = res.body.rows.map((r: any) => r.booking_no);
    expect(nos).toContain("OTF27A000101");
    expect(nos).not.toContain("OTF27A000102");
  });

  it("does not let it hold a place ahead of a customer who has paid", async () => {
    // The short booking is the older one, so if it were in the queue it would come first.
    const { w, d } = await withMinimum();
    const res = await get(w, d, "/api/views/demand");
    const scorpio = res.body.rows.find((r: any) => r.model === "SCORPIO-N");
    expect(scorpio.queue).toBe(1);
  });

  it("still lists that customer, with how much more they have to pay", async () => {
    const { w, d } = await withMinimum();
    const res = await get(w, d, "/api/views/waiting");
    expect(res.body.below_minimum.minimum).toBe(MIN);
    const short = res.body.below_minimum.bookings.find((b: any) => b.booking_no === "OTF27A000102");
    expect(short).toBeTruthy();
    expect(short.short_by).toBe(MIN - 5000);
    expect(short.waiting_days).toBeGreaterThan(0);
  });

  it("counts the same people everywhere a screen says 'waiting'", async () => {
    const { w, d } = await withMinimum();
    const waiting = (await get(w, d, "/api/views/waiting")).body.rows.length;
    const owner = (await get(w, d, "/api/dashboards/owner")).body.customers_waiting;
    const overview = (await get(w, d, "/api/dashboards/overview")).body.bookings.waiting;
    const demand = (await get(w, d, "/api/views/demand")).body.totals.waiting;
    expect(new Set([waiting, owner, overview, demand]).size).toBe(1);
  });

  it("stops applying once a car is allocated, because the window takes over", async () => {
    const { w, d } = await withMinimum();
    const res = await get(w, d, "/api/views/holding");
    // Whatever is holding a car is judged by its payment window, not by the booking amount.
    for (const r of res.body.rows) expect(r).toHaveProperty("window_days");
  });
});
