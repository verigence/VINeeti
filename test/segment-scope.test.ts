// Segments: a person who works with one kind of vehicle (passenger, electric, commercial) sees and
// raises requests for that kind only. The segment is the manufacturer's own category on the master, so
// it comes from the stock report; the approver is unchanged and sees every segment.
import { describe, expect, it } from "vitest";
import { addCar, approvedBooking, CRETA, loadBookings, loadStock, makeDealer, makeMahindraDealer, makeWorld, PASSWORD, type Dealer, type Session, type World } from "./harness";

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
  const set = await w.api("PATCH", `/api/users/${d.users.agm.id}`, { segments: ["PROSPER"] }, d.users.admin.session);
  expect(set.status).toBe(200);
  return { w, d };
}
/** Creates a person with a role and their outlets, signed in and past the first-password screen. */
async function addUser(w: World, d: Dealer, name: string, mobile: string, role: string, outletIds: string[]): Promise<Session> {
  const made = await w.api("POST", "/api/users", { name, mobile, email: `${mobile}@test.example`, role, all_outlets: false, outlet_ids: outletIds }, d.users.admin.session);
  if (made.status !== 201) throw new Error(`${name} not created: ${JSON.stringify(made.body)}`);
  w.db.raw.exec(`UPDATE users SET must_change_password = 0 WHERE mobile = '91${mobile}'`);
  return w.login(d.slug, mobile, made.body.temporary_password);
}

const bookingId = (w: World, no: string) => q(w, `SELECT id FROM bookings WHERE booking_no = ?`, no)[0].id;
const vehicleId = (w: World, vin: string) => q(w, `SELECT id FROM vehicles WHERE vin = ?`, vin)[0].id;

describe("giving a person segments", () => {
  it("is done on the Users screen with the manufacturer's segments, and shown with the dealership's names", async () => {
    const { w, d } = await start();
    const users = (await w.api("GET", "/api/users", undefined, d.users.admin.session)).body;
    expect(users.find((u: any) => u.id === d.users.agm.id).segments).toEqual(["PROSPER"]);
    expect(users.find((u: any) => u.id === d.users.head.id).segments).toEqual([]);
    expect((await w.api("PATCH", `/api/users/${d.users.agm.id}`, { segments: ["TRACTORS"] }, d.users.admin.session)).status).toBe(400);
    const me = (await w.api("GET", "/api/auth/me", undefined, d.users.agm.session)).body;
    expect(me.user.segments).toEqual(["PROSPER"]);
    expect(me.segments).toEqual([
      { key: "PERSONAL", label: "Passenger vehicles", short: "PV" },
      { key: "BEV", label: "Electric vehicles", short: "EV" },
      { key: "PROSPER", label: "Commercial vehicles", short: "CV" },
    ]);
    // Created with segments too, and the audit trail says so.
    const made = await w.api("POST", "/api/users", { name: "Eva EV", mobile: "9100000099", email: "9100000099@test.example", role: "SALES_LEAD", all_outlets: true, outlet_ids: [], segments: ["BEV"] }, d.users.admin.session);
    expect(made.status).toBe(201);
    expect(q(w, `SELECT segment FROM user_segments WHERE user_id = ?`, made.body.id)).toEqual([{ segment: "BEV" }]);
    expect(q(w, `SELECT detail_json FROM audit_log WHERE action = 'USER_CREATED' AND entity_id = ?`, made.body.id)[0].detail_json).toContain('"segments":["BEV"]');
  });
});

describe("what a commercial-vehicles person sees", () => {
  it("lists only the bookings and cars of their segment, and the home tiles agree with the lists", async () => {
    const { w, d } = await start();
    const bookings = (await w.api("GET", "/api/bookings", undefined, d.users.agm.session)).body;
    expect(bookings.map((b: any) => b.booking_no)).toEqual(["OTF27A000001"]);
    const cars = (await w.api("GET", "/api/vehicles", undefined, d.users.agm.session)).body;
    expect(cars.map((v: any) => v.vin)).toEqual(["MA1MAXX0000000001"]);
    const summary = (await w.api("GET", "/api/stock/summary", undefined, d.users.agm.session)).body;
    expect(summary.map((r: any) => r.model)).toEqual(["BOL MAXX PUP HD"]);
    const browse = (await w.api("GET", "/api/stock/browse?show=ALL", undefined, d.users.agm.session)).body;
    expect(browse.total).toBe(1);
    const home = (await w.api("GET", "/api/dashboards/overview", undefined, d.users.agm.session)).body;
    expect(home.stock.yard_free + home.stock.yard_allocated).toBe(1);
    expect(home.bookings.waiting + home.bookings.allocated).toBe(1);
    // The Business Head, who works with every segment, sees both.
    expect((await w.api("GET", "/api/bookings", undefined, d.users.head.session)).body).toHaveLength(2);
    expect((await w.api("GET", "/api/vehicles", undefined, d.users.head.session)).body).toHaveLength(2);
  });

  it("cannot open a booking or a car of another segment, and is told which segment it is", async () => {
    const { w, d } = await start();
    const thar = await w.api("GET", `/api/bookings/${bookingId(w, "OTF27A000002")}`, undefined, d.users.agm.session);
    expect(thar.status).toBe(403);
    expect(thar.body.error.message).toContain("Passenger vehicles (PV)");
    expect((await w.api("GET", `/api/vehicles/${vehicleId(w, "MA1THAR0000000002")}`, undefined, d.users.agm.session)).status).toBe(403);
    expect((await w.api("GET", `/api/bookings/${bookingId(w, "OTF27A000001")}`, undefined, d.users.agm.session)).status).toBe(200);
    expect((await w.api("GET", `/api/vehicles/${vehicleId(w, "MA1MAXX0000000001")}`, undefined, d.users.agm.session)).status).toBe(200);
    // The availability answer and the alternatives are for the segment too.
    expect((await w.api("GET", `/api/stock/availability?model=${encodeURIComponent(THAR.model)}&variant=${encodeURIComponent(THAR.variant)}&colour=${encodeURIComponent(THAR.colour)}`, undefined, d.users.agm.session)).status).toBe(403);
    expect((await w.api("GET", `/api/stock/availability?model=${encodeURIComponent(MAXX.model)}&variant=${encodeURIComponent(MAXX.variant)}&colour=${encodeURIComponent(MAXX.colour)}`, undefined, d.users.agm.session)).status).toBe(200);
  });
});

describe("what a commercial-vehicles person may raise", () => {
  it("books, requests and acts only within the segment; the approver still decides every segment", async () => {
    const { w, d } = await start();
    const outlet = Object.values(d.outlets)[0] ?? q(w, `SELECT id FROM outlets WHERE tenant_id = ?`, d.tenantId)[0].id;
    const tharBooking = await w.api("POST", "/api/bookings", { outlet_id: outlet, customer_name: "Nope", customer_mobile: "9876500001", ...THAR }, d.users.agm.session);
    expect(tharBooking.status).toBe(403);
    const maxxBooking = await w.api("POST", "/api/bookings", { outlet_id: outlet, customer_name: "Yes", customer_mobile: "9876500002", ...MAXX }, d.users.agm.session);
    expect(maxxBooking.status).toBe(201);
    // A request on a booking of another segment is refused at the door, whatever it asks for.
    expect((await w.api("POST", "/api/exceptions", { type: "RELEASE_ALLOCATION", booking_id: bookingId(w, "OTF27A000002"), payload: { release_reason: "MANAGEMENT_PRIORITY" }, reason: "x" }, d.users.agm.session)).status).toBe(403);
    expect((await w.api("POST", `/api/bookings/${bookingId(w, "OTF27A000002")}/cancel`, { reason: "x" }, d.users.agm.session)).status).toBe(403);
    // A car of another segment cannot be touched either.
    expect((await w.api("POST", `/api/vehicles/${vehicleId(w, "MA1THAR0000000002")}/block`, { reason: "x" }, d.users.agm.session)).status).toBe(403);
    // Taking the segment away opens everything again, from the next request.
    expect((await w.api("PATCH", `/api/users/${d.users.agm.id}`, { segments: [] }, d.users.admin.session)).status).toBe(200);
    expect((await w.api("GET", `/api/bookings/${bookingId(w, "OTF27A000002")}`, undefined, d.users.agm.session)).status).toBe(200);
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
    const res = await w.api("GET", "/api/bookings/bk_new", undefined, d.users.agm.session);
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

describe("a request belongs to the billing centre it was raised at", () => {
  it("is decided by that centre's GM, is read-only to the other centre's GM, and the CEO decides either", async () => {
    const w = makeWorld("2026-10-10 10:00");
    const d = await makeDealer(w);
    // A GM for each billing centre, and an AGM at Patia who raises the request.
    const gmPatia = await addUser(w, d, "Gita GM Patia", "9000000071", "GM_SALES", [d.outlets.PATIA]);
    const gmCuttack = await addUser(w, d, "Gopal GM Cuttack", "9000000072", "GM_SALES", [d.outlets.CUTTACK]);
    const car = await addCar(w, d, "VINPATIA000000099", CRETA, "PATIA", "RECEIVED");
    const b = await approvedBooking(w, d, "se1", CRETA, "PATIA", "Patia Holder", "9811100099");
    expect(car.id).toBeTruthy();
    const ex = await w.api("POST", "/api/exceptions", { type: "RELEASE_ALLOCATION", booking_id: b.id, payload: { release_reason: "MANAGEMENT_PRIORITY", until: "2026-11-30" }, reason: "Needed for a fleet order" }, d.users.agm.session);
    expect(ex.status).toBe(201);

    // Both GMs see it; only Patia's may answer it.
    const seen = async (s: any) => ((await w.api("GET", "/api/exceptions", undefined, s)).body as any[]).find((r) => r.id === ex.body.id);
    const atPatia = await seen(gmPatia);
    const atCuttack = await seen(gmCuttack);
    expect(atPatia).toMatchObject({ can_decide: true, outlet: "Patia" });
    expect(atCuttack).toMatchObject({ can_decide: false, outlet: "Patia" });
    // What the other centre is shown is the request, not the booking behind it.
    expect(atCuttack.customer_name).toBe("Patia Holder");
    expect((await w.api("GET", `/api/bookings/${b.id}`, undefined, gmCuttack)).status).toBe(403);

    // And the refusal is real, not only a hidden button.
    expect((await w.api("POST", `/api/exceptions/${ex.body.id}/approve`, {}, gmCuttack)).status).toBe(403);
    expect(w.db.q<{ status: string }>(`SELECT status FROM exceptions WHERE id = ?`, ex.body.id)[0].status).toBe("PENDING");
    // The CEO / VP works across every centre.
    expect((await w.api("POST", `/api/exceptions/${ex.body.id}/approve`, {}, d.users.head.session)).status).toBe(200);
  });
});
