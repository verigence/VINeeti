// Segments: a person who works with one kind of vehicle (passenger, electric, commercial) sees and
// raises requests for that kind only. The segment is the manufacturer's own category on the master, so
// it comes from the stock report; the approver is unchanged and sees every segment.
import { describe, expect, it } from "vitest";
import { loadBookings, loadStock, makeMahindraDealer, makeWorld, PASSWORD, type Dealer, type World } from "./harness";

const q = <T = any>(w: World, sql: string, ...p: unknown[]) => w.db.q<T>(sql, ...p);
const MAXX = { model: "BOL MAXX PUP HD", variant: "1.7 LX (M0246)", colour: "WHITE" }; // PROSPER: a pick-up
const THAR = { model: "THAR", variant: "LXT D MT 2WD 4S HT (M0877)", colour: "STEALTH BLACK" }; // PERSONAL

/** A dealership with one pick-up and one Thar in the yard, a booking for each, and a Sales Lead who works with commercial vehicles only. */
async function start(): Promise<{ w: World; d: Dealer }> {
  const w = makeWorld("2026-10-10 10:00");
  const d = await makeMahindraDealer(w);
  await loadStock(w, d.users.stock.session, [
    { vin: "MA1MAXX0000000001", car: "MAXX_WHITE", oemInvoiceDate: "2026-09-01", grnDate: "2026-09-05" },
    { vin: "MA1THAR0000000002", car: "THAR_BLACK", oemInvoiceDate: "2026-09-20", grnDate: "2026-09-25" },
  ]);
  await loadBookings(w, d.users.crm.session, [
    { no: "OTF27A000001", car: "MAXX_WHITE", created: "01-Oct-2026 10:00 AM", customer: "PICKUP BUYER" },
    { no: "OTF27A000002", car: "THAR_BLACK", created: "02-Oct-2026 10:00 AM", customer: "THAR BUYER" },
  ]);
  const set = await w.api("PATCH", `/api/users/${d.users.lead.id}`, { segments: ["PROSPER"] }, d.users.admin.session);
  expect(set.status).toBe(200);
  return { w, d };
}
const bookingId = (w: World, no: string) => q(w, `SELECT id FROM bookings WHERE booking_no = ?`, no)[0].id;
const vehicleId = (w: World, vin: string) => q(w, `SELECT id FROM vehicles WHERE vin = ?`, vin)[0].id;

describe("giving a person segments", () => {
  it("is done on the Users screen with the manufacturer's segments, and shown with the dealership's names", async () => {
    const { w, d } = await start();
    const users = (await w.api("GET", "/api/users", undefined, d.users.admin.session)).body;
    expect(users.find((u: any) => u.id === d.users.lead.id).segments).toEqual(["PROSPER"]);
    expect(users.find((u: any) => u.id === d.users.head.id).segments).toEqual([]);
    expect((await w.api("PATCH", `/api/users/${d.users.lead.id}`, { segments: ["TRACTORS"] }, d.users.admin.session)).status).toBe(400);
    const me = (await w.api("GET", "/api/auth/me", undefined, d.users.lead.session)).body;
    expect(me.user.segments).toEqual(["PROSPER"]);
    expect(me.segments).toEqual([
      { key: "PERSONAL", label: "Passenger vehicles", short: "PV" },
      { key: "BEV", label: "Electric vehicles", short: "EV" },
      { key: "PROSPER", label: "Commercial vehicles", short: "CV" },
    ]);
    // Created with segments too, and the audit trail says so.
    const made = await w.api("POST", "/api/users", { name: "Eva EV", mobile: "9100000099", role: "SALES_MANAGER", password: PASSWORD, all_outlets: true, outlet_ids: [], segments: ["BEV"] }, d.users.admin.session);
    expect(made.status).toBe(201);
    expect(q(w, `SELECT segment FROM user_segments WHERE user_id = ?`, made.body.id)).toEqual([{ segment: "BEV" }]);
    expect(q(w, `SELECT detail_json FROM audit_log WHERE action = 'USER_CREATED' AND entity_id = ?`, made.body.id)[0].detail_json).toContain('"segments":["BEV"]');
  });
});

describe("what a commercial-vehicles person sees", () => {
  it("lists only the bookings and cars of their segment, and the home tiles agree with the lists", async () => {
    const { w, d } = await start();
    const bookings = (await w.api("GET", "/api/bookings", undefined, d.users.lead.session)).body;
    expect(bookings.map((b: any) => b.booking_no)).toEqual(["OTF27A000001"]);
    const cars = (await w.api("GET", "/api/vehicles", undefined, d.users.lead.session)).body;
    expect(cars.map((v: any) => v.vin)).toEqual(["MA1MAXX0000000001"]);
    const summary = (await w.api("GET", "/api/stock/summary", undefined, d.users.lead.session)).body;
    expect(summary.map((r: any) => r.model)).toEqual(["BOL MAXX PUP HD"]);
    const browse = (await w.api("GET", "/api/stock/browse?show=ALL", undefined, d.users.lead.session)).body;
    expect(browse.total).toBe(1);
    const home = (await w.api("GET", "/api/dashboards/overview", undefined, d.users.lead.session)).body;
    expect(home.stock.yard_free + home.stock.yard_allocated).toBe(1);
    expect(home.bookings.waiting + home.bookings.allocated).toBe(1);
    // The Business Head, who works with every segment, sees both.
    expect((await w.api("GET", "/api/bookings", undefined, d.users.head.session)).body).toHaveLength(2);
    expect((await w.api("GET", "/api/vehicles", undefined, d.users.head.session)).body).toHaveLength(2);
  });

  it("cannot open a booking or a car of another segment, and is told which segment it is", async () => {
    const { w, d } = await start();
    const thar = await w.api("GET", `/api/bookings/${bookingId(w, "OTF27A000002")}`, undefined, d.users.lead.session);
    expect(thar.status).toBe(403);
    expect(thar.body.error.message).toContain("Passenger vehicles (PV)");
    expect((await w.api("GET", `/api/vehicles/${vehicleId(w, "MA1THAR0000000002")}`, undefined, d.users.lead.session)).status).toBe(403);
    expect((await w.api("GET", `/api/bookings/${bookingId(w, "OTF27A000001")}`, undefined, d.users.lead.session)).status).toBe(200);
    expect((await w.api("GET", `/api/vehicles/${vehicleId(w, "MA1MAXX0000000001")}`, undefined, d.users.lead.session)).status).toBe(200);
    // The availability answer and the alternatives are for the segment too.
    expect((await w.api("GET", `/api/stock/availability?model=${encodeURIComponent(THAR.model)}&variant=${encodeURIComponent(THAR.variant)}&colour=${encodeURIComponent(THAR.colour)}`, undefined, d.users.lead.session)).status).toBe(403);
    expect((await w.api("GET", `/api/stock/availability?model=${encodeURIComponent(MAXX.model)}&variant=${encodeURIComponent(MAXX.variant)}&colour=${encodeURIComponent(MAXX.colour)}`, undefined, d.users.lead.session)).status).toBe(200);
  });
});

describe("what a commercial-vehicles person may raise", () => {
  it("books, requests and acts only within the segment; the approver still decides every segment", async () => {
    const { w, d } = await start();
    const outlet = Object.values(d.outlets)[0] ?? q(w, `SELECT id FROM outlets WHERE tenant_id = ?`, d.tenantId)[0].id;
    const tharBooking = await w.api("POST", "/api/bookings", { outlet_id: outlet, customer_name: "Nope", customer_mobile: "9876500001", ...THAR }, d.users.lead.session);
    expect(tharBooking.status).toBe(403);
    const maxxBooking = await w.api("POST", "/api/bookings", { outlet_id: outlet, customer_name: "Yes", customer_mobile: "9876500002", ...MAXX }, d.users.lead.session);
    expect(maxxBooking.status).toBe(201);
    // A request on a booking of another segment is refused at the door, whatever it asks for.
    expect((await w.api("POST", "/api/exceptions", { type: "RELEASE_ALLOCATION", booking_id: bookingId(w, "OTF27A000002"), payload: { release_reason: "MANAGEMENT_PRIORITY" }, reason: "x" }, d.users.lead.session)).status).toBe(403);
    expect((await w.api("POST", `/api/bookings/${bookingId(w, "OTF27A000002")}/cancel`, { reason: "x" }, d.users.lead.session)).status).toBe(403);
    // A car of another segment cannot be touched either.
    expect((await w.api("POST", `/api/vehicles/${vehicleId(w, "MA1THAR0000000002")}/block`, { reason: "x" }, d.users.lead.session)).status).toBe(403);
    // Taking the segment away opens everything again, from the next request.
    expect((await w.api("PATCH", `/api/users/${d.users.lead.id}`, { segments: [] }, d.users.admin.session)).status).toBe(200);
    expect((await w.api("GET", `/api/bookings/${bookingId(w, "OTF27A000002")}`, undefined, d.users.lead.session)).status).toBe(200);
  });

  it("is refused on a model whose segment the master does not know yet, with the reason", async () => {
    const { w, d } = await start();
    // A model that only a booking sheet has named: no stock report has given its category.
    w.db.raw.exec(`INSERT INTO vehicle_variants (id, tenant_id, category, model, variant, variant_key, created_at, updated_at) VALUES ('var_new', '${d.tenantId}', '', 'NEWMODEL', 'BASE', 'BASE', '2026-10-01', '2026-10-01')`);
    const outlet = q(w, `SELECT id FROM outlets WHERE tenant_id = ?`, d.tenantId)[0].id;
    w.db.raw.exec(
      `INSERT INTO bookings (id, tenant_id, outlet_id, booking_no, customer_name, customer_mobile, variant_id, model, variant, colour, booking_date, priority_ts, status, created_by, created_at, updated_at)
       VALUES ('bk_new', '${d.tenantId}', '${outlet}', 'NEW1', 'X', '919000000000', 'var_new', 'NEWMODEL', 'BASE', 'RED', '2026-10-01', '2026-10-01T04:30:00.000Z', 'APPROVED', 'x', '2026-10-01T04:30:00.000Z', '2026-10-01T04:30:00.000Z')`,
    );
    const res = await w.api("GET", "/api/bookings/bk_new", undefined, d.users.lead.session);
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain("has no segment on the Vehicle master yet");
    expect((await w.api("GET", "/api/bookings/bk_new", undefined, d.users.head.session)).status).toBe(200);
  });
});

describe("a model's segment on the master", () => {
  it("is filled in for a variant that a booking sheet named before any stock report had, as soon as a sibling knows it", async () => {
    const w = makeWorld("2026-10-10 10:00");
    const d = await makeMahindraDealer(w);
    // A variant of the pick-up that only a booking sheet has ever named: registered with no category.
    w.db.raw.exec(`INSERT INTO vehicle_variants (id, tenant_id, category, model, variant, variant_key, origin, created_at, updated_at) VALUES ('var_sheet', '${d.tenantId}', '', 'BOL MAXX PUP HD', '1.7 BASE (M0245)', '17BASEM0245', 'DMS', '2026-10-01', '2026-10-01')`);
    // Another variant of the same model arrives in a stock report with its category: the blank takes it.
    await loadStock(w, d.users.stock.session, [{ vin: "MA1MAXX0000000009", car: "MAXX_DIAMOND", oemInvoiceDate: "2026-09-01", grnDate: "2026-09-05" }]);
    expect(q(w, `SELECT variant, category FROM vehicle_variants WHERE model = 'BOL MAXX PUP HD' ORDER BY variant`)).toEqual([
      { variant: "1.7 BASE (M0245)", category: "PROSPER" },
      { variant: "1.7 LX (M0246)", category: "PROSPER" },
    ]);
  });
});
