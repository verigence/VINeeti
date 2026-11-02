// The day-end report: the numbers it gives for a day, who may read it, how it is configured, and that
// the scheduled job sends each day's report once.
import { beforeAll, describe, expect, it } from "vitest";
import { addCar, approvedBooking, CRETA, makeDealer, makeWorld, stockFile, type Dealer, type World } from "./harness";

let w: World, d: Dealer;
const report = async (session = d.users.admin.session, date = "2026-10-13") => w.api("GET", `/api/reports/day-end?date=${date}&format=json`, undefined, session);

beforeAll(async () => {
  w = makeWorld("2026-10-13 10:00");
  d = await makeDealer(w);
  // Three approved bookings, and a request against each: one approved, one rejected, one left open.
  const ids: string[] = [];
  for (const [i, outlet] of (["PATIA", "PATIA", "CUTTACK"] as const).entries()) ids.push((await approvedBooking(w, d, outlet === "PATIA" ? "se1" : "se3", CRETA, outlet, `Report Customer ${i + 1}`, `98000002${i}0`)).id);
  const raise = (id: string) => w.api("POST", "/api/exceptions", { type: "DEFER_DELIVERY", booking_id: id, payload: { until: "2026-12-01" }, reason: "Customer asked for December" }, d.users.agm.session);
  const ex = [];
  for (const id of ids) {
    const r = await raise(id);
    expect(r.status).toBe(201);
    ex.push(r.body.id);
  }
  expect((await w.api("POST", `/api/exceptions/${ex[0]}/approve`, {}, d.users.head.session)).status).toBe(200);
  expect((await w.api("POST", `/api/exceptions/${ex[1]}/reject`, { remarks: "Not justified" }, d.users.head.session)).status).toBe(200);
  // A car comes in and goes to the one booking still in the queue; then the day's stock report is loaded.
  await addCar(w, d, "MA1REPORT00000001", CRETA, "CUTTACK", "RECEIVED");
  const up = await w.send("/api/uploads/stock?filename=stock.csv&mode=PARTIAL", stockFile([{ vin: "MA1THAR0000000091", car: "THAR_WHITE", loc: "PATIA" }]), d.users.stock.session);
  expect(up.status).toBe(200);
  // An allotment the DMS made outside the system, as a stock report records it.
  w.db.raw.exec(
    `INSERT INTO audit_log (id, tenant_id, actor, action, entity_type, entity_id, detail_json, at)
     SELECT 'aud_outside_1', tenant_id, 'UPLOAD:x', 'ALLOTTED_OUTSIDE_SYSTEM', 'booking', id, json_object('violation', 'NOT_THROUGH_SYSTEM', 'outlet_id', outlet_id), '2026-10-13T08:00:00.000Z' FROM bookings WHERE customer_name = 'Report Customer 1'`,
  );
}, 120_000);

describe("the day-end report", () => {
  it("counts who signed in, by role and by person", async () => {
    const r = await report();
    expect(r.status).toBe(200);
    const signedIn = w.db.q<{ n: number }>(`SELECT COUNT(DISTINCT user_id) AS n FROM sign_ins WHERE outcome = 'IN'`)[0].n;
    expect(r.body.people.signed_in).toBe(signedIn);
    expect(r.body.people.active).toBe(w.db.q<{ n: number }>(`SELECT COUNT(*) AS n FROM users WHERE is_active = 1`)[0].n);
    expect(r.body.people.list.length).toBe(signedIn);
    expect(r.body.people.by_role.find((x: any) => x.label === "GM Sales")).toMatchObject({ active: 1, signed_in: 1 });
  });

  it("lists the DMS files loaded, with what each said", async () => {
    const r = await report();
    expect(r.body.files).toHaveLength(1);
    expect(r.body.files[0]).toMatchObject({ kind: "STOCK", label: "Stock report", rows: 1, created: 1, errors: 0 });
    expect(r.body.files[0].brief).toContain("1 car,");
  });

  it("counts requests raised, approved, rejected and pending, by type and by outlet and segment", async () => {
    const r = await report();
    expect(r.body.requests).toMatchObject({ raised: 3, approved: 1, rejected: 1, pending: 1, withdrawn: 0 });
    expect(r.body.requests.by_type).toEqual([{ label: "Defer delivery", raised: 3, approved: 1, rejected: 1, pending: 1 }]);
    expect(r.body.requests.by_place).toEqual([
      { outlet: "Cuttack", segment: "Not set", raised: 1, approved: 0, rejected: 0, pending: 1 },
      { outlet: "Patia", segment: "Not set", raised: 2, approved: 1, rejected: 1, pending: 0 },
    ]);
  });

  it("counts allocations made here and allotments made in the DMS outside the system", async () => {
    const r = await report();
    expect(r.body.allocations).toMatchObject({ made_here: 1, outside: 1 });
    expect(r.body.allocations.outside_by_kind).toEqual([{ label: "Allotted to a waiting booking without going through the queue", n: 1 }]);
    expect(r.body.allocations.outside_by_place).toEqual([{ outlet: "Patia", segment: "Not set", n: 1 }]);
  });

  it("is a page of numbers that names no customer", async () => {
    const r = await w.api("GET", "/api/reports/day-end?date=2026-10-13", undefined, d.users.admin.session);
    expect(r.status).toBe(200);
    const html = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    for (const s of ["Northstar Motors", "Tuesday, 13 Oct 2026", "People who signed in", "DMS data loaded", "Allocation and deallocation requests", "Allotted in the DMS outside VINeeti", "Defer delivery"]) expect(html, s).toContain(s);
    expect(html).not.toContain("Report Customer");
    // Another day is just as readable; one that has not happened is refused.
    expect((await report(d.users.admin.session, "2026-10-12")).body.requests.raised).toBe(0);
    expect((await report(d.users.admin.session, "2026-10-14")).status).toBe(400);
  });

  it("is read by whoever configures it and the roles it goes to, and nobody else", async () => {
    expect((await report(d.users.gm.session)).status).toBe(200);
    expect((await report(d.users.head.session)).status).toBe(200);
    expect((await report(d.users.se1.session)).status).toBe(403);
    expect((await w.api("GET", "/api/reports/day-end/setup", undefined, d.users.gm.session)).status).toBe(403);
  });
});

describe("configuring and sending it", () => {
  it("refuses a report switched on with nobody to send it to, and saves one that names GM Sales", async () => {
    const save = (day_end_report: Record<string, unknown>) => w.api("PUT", "/api/settings", { day_end_report }, d.users.admin.session);
    expect((await save({ enabled: true, roles: [], emails: [] })).status).toBe(400);
    expect((await save({ enabled: true, emails: ["not-an-address"] })).status).toBe(400);
    expect((await save({ enabled: true, time: "25:00" })).status).toBe(400);
    const ok = await save({ enabled: true, time: "20:00", days: [0, 1, 2, 3, 4, 5, 6], roles: ["GM_SALES", "CEO_VP", "DEALER_PRINCIPAL"], emails: ["Owner@Example.com"] });
    expect(ok.status).toBe(200);
    expect(ok.body.settings.day_end_report).toEqual({ enabled: true, time: "20:00", days: [0, 1, 2, 3, 4, 5, 6], roles: ["GM_SALES", "CEO_VP", "DEALER_PRINCIPAL"], emails: ["owner@example.com"] });
    // The approver lists name GM Sales too, and save.
    expect((await w.api("PUT", "/api/settings", { release_approver_roles: ["GM_SALES", "AGM_SALES"] }, d.users.admin.session)).status).toBe(200);
    const setup = await w.api("GET", "/api/reports/day-end/setup", undefined, d.users.admin.session);
    expect(setup.body.recipients.map((r: any) => r.role)).toEqual(["CEO / VP", "GM Sales", "Added address"]);
  });

  it("is sent by the scheduled job once a day, after its time", async () => {
    w.at("2026-10-13 19:30");
    await w.tick();
    expect(w.db.q(`SELECT * FROM day_end_reports`)).toHaveLength(0);
    w.at("2026-10-13 20:15");
    await w.tick();
    // The test deployment has no mail account: the attempt is recorded and not repeated.
    expect(w.db.q(`SELECT business_date, status, attempts FROM day_end_reports`)).toEqual([{ business_date: "2026-10-13", status: "MAIL_NOT_CONFIGURED", attempts: 1 }]);
    w.at("2026-10-13 20:45");
    await w.tick();
    expect(w.db.q(`SELECT attempts FROM day_end_reports`)).toEqual([{ attempts: 1 }]);
  });

  it("is not sent once switched off", async () => {
    expect((await w.api("PUT", "/api/settings", { day_end_report: { enabled: false } }, d.users.admin.session)).status).toBe(200);
    w.at("2026-10-14 21:00");
    await w.tick();
    expect(w.db.q(`SELECT business_date FROM day_end_reports`)).toEqual([{ business_date: "2026-10-13" }]);
  });
});
