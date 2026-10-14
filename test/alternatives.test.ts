// What else can be offered when the car asked for is not there. Three things are being tested: that a
// suggestion is always a car that exists, that a car someone is already waiting for is never suggested,
// and that the order is the order a sales consultant would offer them in.
import { describe, expect, it } from "vitest";
import { loadBookings, loadStock, makeMahindraDealer, makeWorld, type BookingLine, type Dealer, type StockLine, type World } from "./harness";

// The customer wants a white Thar. There is none free. Around it:
const STOCK: StockLine[] = [
  { vin: "MA1THAR0000000001", car: "THAR_BLACK", oemInvoiceDate: "2026-09-20", grnDate: "2026-09-25" }, // same car, other colour, in the yard
  { vin: "MA1THAR0000000002", car: "THAR_WHITE", status: "In Transit", oemInvoiceDate: "2026-09-28" }, // the exact car, but on the way
  { vin: "MA1XUV00000000003", car: "XUV3XO_WHITE", oemInvoiceDate: "2026-09-15", grnDate: "2026-09-20" }, // another model, same kind
  { vin: "MA1SCN00000000004", car: "SCORPIO_N", oemInvoiceDate: "2026-09-10", grnDate: "2026-09-18" }, // another model, two more seats
  { vin: "MA1MAXX0000000005", car: "MAXX_WHITE", oemInvoiceDate: "2026-09-01", grnDate: "2026-09-05" }, // a pick-up: a different kind of vehicle
  { vin: "MA1MAXX0000000006", car: "MAXX_DIAMOND", demo: true, oemInvoiceDate: "2026-08-01", grnDate: "2026-08-05" },
];
const WANT = "model=THAR&variant=LXT D MT 2WD 4S HT (M0877)&colour=EVEREST WHITE";

async function start(bookings: BookingLine[] = []): Promise<{ w: World; d: Dealer }> {
  const w = makeWorld("2026-10-10 10:00");
  const d = await makeMahindraDealer(w);
  await loadStock(w, d.users.stock.session, STOCK);
  if (bookings.length) await loadBookings(w, d.users.crm.session, bookings);
  return { w, d };
}
const ask = (w: World, d: Dealer, q = "", who = "exec") => w.api("GET", `/api/stock/alternatives?${WANT}${q}`, undefined, d.users[who].session);
const shown = (body: any) => body.alternatives.map((a: any) => [a.model, a.colour, a.spare_in_yard, a.spare_in_transit]);

describe("what else can be offered", () => {
  it("offers the same car in another colour first, because that is the smallest thing to ask of a customer", async () => {
    const { w, d } = await start();
    const res = await ask(w, d);
    expect(res.status).toBe(200);
    expect(res.body.alternatives[0]).toMatchObject({ model: "THAR", colour: "STEALTH BLACK", spare_in_yard: 1 });
    expect(res.body.alternatives[0].differs).toEqual(["STEALTH BLACK instead of EVEREST WHITE"]);
    expect(res.body.alternatives[0].headline).toContain("1 in the yard");
  });

  it("never offers the car the customer asked for: that is the answer they already have", async () => {
    const { w, d } = await start();
    const res = await ask(w, d);
    expect(res.body.alternatives.every((a: any) => !(a.model === "THAR" && a.colour === "EVEREST WHITE"))).toBe(true);
  });

  it("never offers a car that a waiting customer is already in the queue for", async () => {
    // One customer is already waiting for the black Thar, and there is exactly one of them.
    const { w, d } = await start([{ no: "OTF27A000001", car: "THAR_BLACK", created: "01-Sep-2026 10:00 AM", customer: "WAITING ONE" }]);
    const res = await ask(w, d);
    const black = res.body.alternatives.find((a: any) => a.colour === "STEALTH BLACK");
    expect(black).toBeUndefined();
    // And what is suggested instead is still a real car.
    expect(res.body.alternatives.length).toBeGreaterThan(0);
    expect(shown(res.body).every(([, , yard, transit]: any[]) => yard + transit > 0)).toBe(true);
  });

  it("offers a car that is spare once the queue is counted, and says how many are waiting for it", async () => {
    // Two black Thars, one customer waiting: one is spoken for, one is spare.
    const w = makeWorld("2026-10-10 10:00");
    const d = await makeMahindraDealer(w);
    await loadStock(w, d.users.stock.session, [
      ...STOCK,
      { vin: "MA1THAR0000000007", car: "THAR_BLACK", oemInvoiceDate: "2026-09-21", grnDate: "2026-09-26" },
    ]);
    await loadBookings(w, d.users.crm.session, [{ no: "OTF27A000001", car: "THAR_BLACK", created: "01-Sep-2026 10:00 AM", customer: "WAITING ONE" }]);
    const res = await w.api("GET", `/api/stock/alternatives?${WANT}`, undefined, d.users.exec.session);
    const black = res.body.alternatives.find((a: any) => a.colour === "STEALTH BLACK");
    // One of the two is reserved for the customer who booked, so it is not counted as free at all;
    // that customer is no longer waiting, so the waiting count is zero. One car is left to offer.
    expect(black).toMatchObject({ spare_in_yard: 1, waiting: 0 });
  });

  it("keeps what can be given now apart from what is on the way, and puts the ready ones first", async () => {
    // Nothing of the model asked for is free in the yard; another model is standing there, and the same
    // model is on the road. Both are worth saying, and they are two different conversations, so they come
    // back in two lists rather than being argued into one order.
    const w = makeWorld("2026-10-10 10:00");
    const d = await makeMahindraDealer(w);
    await loadStock(w, d.users.stock.session, [
      { vin: "MA1THAR0000000010", car: "THAR_WHITE", status: "In Transit", oemInvoiceDate: "2026-09-18" },
      { vin: "MA1THAR0000000011", car: "THAR_BLACK", status: "In Transit", oemInvoiceDate: "2026-09-20" },
      { vin: "MA1XUV00000000012", car: "XUV3XO_WHITE", oemInvoiceDate: "2026-09-15", grnDate: "2026-09-20" },
    ]);
    const res = await w.api("GET", `/api/stock/alternatives?${WANT}`, undefined, d.users.exec.session);
    expect(res.body.can_give_now.map((a: any) => a.model)).toEqual(["XUV 3XO"]);
    expect(res.body.on_the_way.map((a: any) => [a.model, a.colour])).toEqual([["THAR", "STEALTH BLACK"]]);
    // Every car that can be given now comes before every car that is still on the way.
    expect(res.body.alternatives.map((a: any) => a.spare_in_yard > 0)).toEqual([true, false]);
  });

  it("ranks by how little is different, not by what happens to be standing there", async () => {
    // Both are in the yard: the same model in another colour is a smaller thing to ask of a customer
    // than a different model, so it comes first even though both can be handed over today.
    const { w, d } = await start();
    const res = await ask(w, d);
    const ready = res.body.can_give_now.map((a: any) => a.model);
    expect(ready[0]).toBe("THAR");
    expect(ready).toContain("XUV 3XO");
    expect(res.body.can_give_now[0].closeness).toBeLessThan(res.body.can_give_now[1].closeness);
  });

  it("does not offer a different kind of vehicle, however free it is", async () => {
    const { w, d } = await start();
    // The pick-up is free and in the yard, but nobody who came for a Thar is served by one.
    expect(res_models(await ask(w, d))).not.toContain("BOL MAXX PUP HD");
  });

  it("never offers a demo car", async () => {
    const { w, d } = await start();
    const all = await ask(w, d, "&limit=12");
    expect(all.body.alternatives.every((a: any) => a.colour !== "DIAMOND WHITE")).toBe(true);
  });

  it("says in plain words what is different about each suggestion", async () => {
    const { w, d } = await start();
    const res = await ask(w, d, "&limit=12");
    for (const a of res.body.alternatives) {
      expect(a.differs.length).toBeGreaterThan(0);
      for (const line of a.differs) expect(line).toMatch(/[a-z]/); // words, not codes
    }
    // Another model is offered only when it is the same kind of vehicle and within two seats of what
    // was asked for: the XUV is, the seven-seat Scorpio-N is not.
    const xuv = res.body.alternatives.find((a: any) => a.model === "XUV 3XO");
    expect(xuv?.differs).toContain("a different model: XUV 3XO");
    expect(xuv?.differs).toContain("5 seats instead of 4");
    expect(res.body.alternatives.some((a: any) => a.model === "SCORPIO-N")).toBe(false);
  });

  it("keeps the dealer price out of it unless the person may see stock value", async () => {
    const { w, d } = await start();
    const exec = await ask(w, d);
    expect(exec.body.alternatives.every((a: any) => a.price_gap === null)).toBe(true);
    const head = await ask(w, d, "", "head");
    expect(head.body.alternatives.length).toBeGreaterThan(0);
  });

  it("says what the suggestions were worked out from", async () => {
    const { w, d } = await start();
    const res = await ask(w, d);
    expect(res.body.basis).toContain("served first");
    expect(res.body.basis).toContain("Nothing is reserved");
    expect(res.body.source.stock_as_on).toBe("2026-10-10");
  });

  it("gives the same suggestions in the same order every time it is asked of the same files", async () => {
    const { w, d } = await start();
    const a = await ask(w, d);
    const b = await ask(w, d);
    expect(a.body).toEqual(b.body);
  });

  it("is open to the people on the sales floor, who are the ones who need it", async () => {
    const { w, d } = await start();
    for (const who of ["exec", "lead", "crm", "stock"]) expect((await ask(w, d, "", who)).status).toBe(200);
  });
});

const res_models = (res: any) => res.body.alternatives.map((a: any) => a.model);
