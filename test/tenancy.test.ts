// SaaS isolation: one dealership can never see or affect another, and inside a dealership each persona
// sees only its own outlets and does only what its role allows.

import { beforeAll, describe, expect, it } from "vitest";
import { addCar, approvedBooking, booking, CRETA, makeDealer, makeWorld, PASSWORD, PLATFORM, submittedBooking, VENUE, type Dealer, type World } from "./harness";

let w: World;
let a: Dealer; // Northstar Motors Hyundai
let b: Dealer; // a second dealership on the same deployment, deliberately with the same mobile numbers

beforeAll(async () => {
  w = makeWorld("2026-10-13 10:00");
  a = await makeDealer(w, "northstar-hyundai");
  b = await makeDealer(w, "sai-tata");
});

describe("onboarding a dealership", () => {
  it("needs the platform token", async () => {
    const body = { slug: "x-dealer", name: "X", oem: "Kia", outlets: [{ code: "MAIN", name: "Main" }], admin: { name: "A", mobile: "9000000001", password: PASSWORD } };
    expect((await w.api("POST", "/api/platform/tenants", body)).status).toBe(401);
    expect((await w.api("POST", "/api/platform/tenants", body, undefined, { Authorization: "Bearer wrong" })).status).toBe(401);
    expect((await w.api("POST", "/api/platform/tenants", body, a.users.admin.session)).status).toBe(401);
  });
  it("refuses a dealer code that is already in use", async () => {
    const body = { slug: "northstar-hyundai", name: "Copy", oem: "Hyundai", outlets: [{ code: "MAIN", name: "Main" }], admin: { name: "A", mobile: "9000000001", password: PASSWORD } };
    expect((await w.api("POST", "/api/platform/tenants", body, undefined, PLATFORM)).status).toBe(409);
  });
  it("gives the new dealership its own WhatsApp settings and message templates", async () => {
    const cfg = await w.api("GET", "/api/wa/config", undefined, b.users.admin.session);
    expect(cfg.body).toMatchObject({ provider: "TEST", enabled: true, connected: false });
    // Six messages of the booking-to-delivery process, the alarm to management, the sales executive's update and the one-time code for setting a password.
    expect(w.db.q<{ event_key: string }>(`SELECT event_key FROM wa_templates WHERE tenant_id = ? ORDER BY event_key`, b.tenantId).map((t) => t.event_key)).toEqual(
      ["ALLOC_FREE_STOCK", "ALLOC_IN_TRANSIT", "ALLOC_REALLOCATED", "MANAGEMENT_ALARM", "PASSWORD_OTP", "PAYMENT_ESCALATION", "PAYMENT_REMINDER", "SALES_EXEC_UPDATE", "STOCK_RECEIVED"],
    );
  });
});

describe("one dealership cannot reach another", () => {
  let aBooking: { id: string };
  let bBooking: { id: string };
  let aCar: string;
  let bCar: string;

  it("the same chassis and mobile numbers can exist in both without clashing", async () => {
    aCar = (await addCar(w, a, "MALC841CLRM200001", CRETA, "PATIA", "IN_TRANSIT")).id;
    bCar = (await addCar(w, b, "MALC841CLRM200001", CRETA, "PATIA", "IN_TRANSIT")).id;
    expect(aCar).not.toBe(bCar);
    expect(a.users.se1.mobile).toBe(b.users.se1.mobile);
  });

  it("stock in one dealership is never allocated to a booking in another", async () => {
    aBooking = await approvedBooking(w, a, "se1", VENUE, "PATIA", "Asha A", "9811100001");
    await addCar(w, b, "MALC841CLRM200009", VENUE, "PATIA", "RECEIVED");
    await w.tick();
    expect((await booking(w, a, aBooking.id)).booking.status).toBe("APPROVED");
    bBooking = await approvedBooking(w, b, "se1", VENUE, "PATIA", "Bina B", "9811100002");
    expect((await booking(w, b, bBooking.id)).allocation.vin).toBe("MALC841CLRM200009");
  });

  it("records of the other dealership do not exist as far as the API is concerned", async () => {
    const s = a.users.admin.session;
    expect((await w.api("GET", `/api/bookings/${bBooking.id}`, undefined, s)).status).toBe(404);
    expect((await w.api("GET", `/api/vehicles/${bCar}`, undefined, s)).status).toBe(404);
    expect((await w.api("POST", `/api/vehicles/${bCar}/receive`, undefined, a.users.stock.session)).status).toBe(404);
    expect((await w.api("POST", `/api/bookings/${bBooking.id}/cancel`, { reason: "x" }, s)).status).toBe(404);
    expect((await w.api("POST", "/api/exceptions", { type: "OTHER", booking_id: bBooking.id, reason: "x" }, s)).status).toBe(404);
    // Nor can anything be written onto the other dealership's booking: its checklist, a payment, a decision.
    expect((await w.api("PUT", `/api/bookings/${bBooking.id}/checklist`, { DOCKET: false }, s)).status).toBe(404);
    expect((await w.api("POST", `/api/bookings/${bBooking.id}/payment-reported`, { reference: "UTR-X" }, s)).status).toBe(404);
    expect((await w.api("POST", `/api/bookings/${bBooking.id}/payment-received`, { reference: "UTR-X" }, s)).status).toBe(404);
    expect((await w.api("GET", `/api/bookings/${bBooking.id}/queue`, undefined, s)).status).toBe(404);
    expect(w.db.q(`SELECT payment_reported_at, payment_received_at FROM bookings WHERE id = ?`, bBooking.id)[0]).toEqual({ payment_reported_at: null, payment_received_at: null });
    expect(w.db.q(`SELECT id FROM audit_log WHERE entity_id = ? AND tenant_id = ?`, bBooking.id, a.tenantId)).toHaveLength(0);
    // A booking cannot be created against the other dealership's outlet.
    const cross = await w.api("POST", "/api/bookings", { outlet_id: b.outlets.PATIA, customer_name: "X", customer_mobile: "9811100003", ...CRETA }, s);
    expect(cross.status).toBe(400);
  });

  it("lists, dashboards, audit trail and message log hold only the dealership's own data", async () => {
    const s = a.users.head.session;
    const bookings = (await w.api("GET", "/api/bookings", undefined, s)).body;
    expect(bookings.every((x: any) => x.id !== bBooking.id)).toBe(true);
    const vehicles = (await w.api("GET", "/api/vehicles", undefined, s)).body;
    expect(vehicles.map((v: any) => v.id)).toContain(aCar);
    expect(vehicles.map((v: any) => v.id)).not.toContain(bCar);
    const audit = (await w.api("GET", "/api/audit?limit=1000", undefined, a.users.auditor.session)).body;
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.every((r: any) => r.tenant_id === a.tenantId)).toBe(true);
    const log = (await w.api("GET", "/api/wa/messages", undefined, a.users.auditor.session)).body.messages;
    expect(log.every((m: any) => m.booking_id !== bBooking.id)).toBe(true);
    const users = (await w.api("GET", "/api/users", undefined, a.users.admin.session)).body;
    expect(users).toHaveLength(14);
  });

  it("rules changed by one dealership do not change the other's", async () => {
    const res = await w.api("PUT", "/api/settings", { reminder_days: 2, escalation_days: 4, reallocate_days: 5 }, b.users.admin.session);
    expect(res.status).toBe(200);
    expect((await w.api("GET", "/api/settings", undefined, a.users.admin.session)).body.settings.reminder_days).toBe(3);
    expect((await w.api("GET", "/api/settings", undefined, b.users.admin.session)).body.settings.reminder_days).toBe(2);
  });

  it("a session is bound to its dealership even when the user ids are swapped", async () => {
    // Signing in with the right mobile and password but the other dealer code gives the other dealership's user.
    const sa = await w.login("northstar-hyundai", a.users.head.mobile, PASSWORD);
    const sb = await w.login("sai-tata", a.users.head.mobile, PASSWORD);
    expect((await w.api("GET", "/api/auth/me", undefined, sa)).body.tenant.slug).toBe("northstar-hyundai");
    expect((await w.api("GET", "/api/auth/me", undefined, sb)).body.tenant.slug).toBe("sai-tata");
    // The dealer code may be left out only when the mobile number says which dealership is meant. This number is
    // registered at both, so without the code nobody is signed in: the system does not pick one.
    const noCode = await w.api("POST", "/api/auth/login", { mobile: a.users.head.mobile, password: PASSWORD });
    expect(noCode.status).toBe(401);
    expect(noCode.body.error.code).toBe("INVALID_LOGIN");
    expect(noCode.headers.get("Set-Cookie")).toBeNull();
    // A number registered at one dealership only signs in to that dealership, and to no other.
    const made = await w.api("POST", "/api/users", { name: "Only At Sai", mobile: "9000000090", email: "9000000090@test.example", role: "AUDITOR", password: PASSWORD }, b.users.admin.session);
    expect(made.status).toBe(201);
    const only = await w.api("POST", "/api/auth/login", { mobile: "9000000090", password: PASSWORD });
    expect(only.status).toBe(200);
    expect((await w.api("GET", "/api/auth/me", undefined, { cookie: (only.headers.get("Set-Cookie") ?? "").split(";")[0] })).body.tenant.slug).toBe("sai-tata");
    expect((await w.api("POST", "/api/auth/login", { dealer: "northstar-hyundai", mobile: "9000000090", password: PASSWORD })).status).toBe(401);
  });
});

describe("outlets inside a dealership", () => {
  let patia: { id: string };
  let cuttack: { id: string };

  it("a Sales Manager works only in the outlets assigned", async () => {
    patia = await submittedBooking(w, a, "se1", CRETA, "PATIA", "Patia Customer", "9822200001");
    cuttack = await submittedBooking(w, a, "se3", CRETA, "CUTTACK", "Cuttack Customer", "9822200002");
    const sm = a.users.sm.session; // Patia only
    const list = (await w.api("GET", "/api/bookings", undefined, sm)).body;
    expect(list.map((x: any) => x.id)).toContain(patia.id);
    expect(list.map((x: any) => x.id)).not.toContain(cuttack.id);
    expect((await w.api("GET", `/api/bookings/${cuttack.id}`, undefined, sm)).status).toBe(403);
    expect((await w.api("POST", `/api/bookings/${cuttack.id}/approve`, {}, sm)).status).toBe(403);
    const create = await w.api("POST", "/api/bookings", { outlet_id: a.outlets.CUTTACK, customer_name: "X", customer_mobile: "9822200003", ...CRETA }, sm);
    expect(create.status).toBe(403);
    // The same goes for the submission checklist of another outlet's draft.
    const draft = await w.api("POST", "/api/bookings", { outlet_id: a.outlets.CUTTACK, customer_name: "Cuttack Draft", customer_mobile: "9822200004", ...CRETA }, a.users.se3.session);
    expect((await w.api("PUT", `/api/bookings/${draft.body.id}/checklist`, { DOCKET: true }, sm)).status).toBe(403);
    expect((await w.api("PUT", `/api/bookings/${draft.body.id}/checklist`, { DOCKET: true }, a.users.sm2.session)).body).toEqual({ checklist_missing: ["KYC", "PAN_AADHAAR", "PAYMENT_PROOF"] });
    await w.api("POST", `/api/bookings/${draft.body.id}/cancel`, { reason: "test draft" }, a.users.se3.session);
    // The Business Head sees both.
    const all = (await w.api("GET", "/api/bookings", undefined, a.users.head.session)).body.map((x: any) => x.id);
    expect(all).toEqual(expect.arrayContaining([patia.id, cuttack.id]));
  });

  it("a Sales Executive sees only their own bookings, but all stock", async () => {
    const se2 = a.users.se2.session;
    expect((await w.api("GET", "/api/bookings", undefined, se2)).body.map((x: any) => x.id)).not.toContain(patia.id);
    expect((await w.api("GET", `/api/bookings/${patia.id}`, undefined, se2)).status).toBe(403);
    await w.api("POST", `/api/bookings/${patia.id}/approve`, {}, a.users.sm.session);
    const vin = w.db.q<any>(`SELECT v.vin FROM allocations a JOIN vehicles v ON v.id = a.vehicle_id WHERE a.booking_id = ? AND a.status = 'ACTIVE'`, patia.id)[0].vin;
    const allocated = (await w.api("GET", "/api/vehicles", undefined, se2)).body.find((c: any) => c.vin === vin);
    // The car shows as committed, but whose it is, is not shown to a sales executive.
    expect(allocated).toMatchObject({ customer_name: "Allocated", booking_no: null, booking_id: null });
    expect(allocated.allocation_id).toBeTruthy();
    // The outlet's own manager sees the customer; the other outlet's manager does not.
    const own = (await w.api("GET", "/api/vehicles", undefined, a.users.sm.session)).body.find((c: any) => c.vin === vin);
    expect(own).toMatchObject({ customer_name: "Patia Customer", booking_id: patia.id });
    const otherOutlet = (await w.api("GET", "/api/vehicles", undefined, a.users.sm2.session)).body.find((c: any) => c.vin === vin);
    expect(otherOutlet).toMatchObject({ customer_name: "Allocated", booking_id: null });
    // The same holds on the car's own page.
    const page = (id: string, who: string) => w.api("GET", `/api/vehicles/${id}`, undefined, a.users[who].session).then((r) => r.body.allocations[0]);
    expect(await page(allocated.id, "se2")).toMatchObject({ booking_id: null, booking_no: null, status: "ACTIVE" });
    expect(await page(allocated.id, "sm2")).toMatchObject({ booking_id: null, booking_no: null });
    expect(await page(allocated.id, "sm")).toMatchObject({ booking_id: patia.id });
    // A sales executive's home numbers count their own bookings, like the list behind them.
    const home = (who: string) => w.api("GET", "/api/dashboards/overview", undefined, a.users[who].session).then((r) => r.body.bookings);
    expect((await home("se2")).allocated).toBe(0);
    expect((await home("se1")).allocated).toBeGreaterThan(0);
    expect((await home("sm")).allocated).toBeGreaterThanOrEqual((await home("se1")).allocated);
  });

  it("a Stock In-charge cannot change stock of an outlet they are not assigned to", async () => {
    const created = await w.api("POST", "/api/users", { name: "Patia Stock", mobile: "9000000050", email: "9000000050@test.example", role: "EDP_MANAGER", password: PASSWORD, all_outlets: false, outlet_ids: [a.outlets.PATIA] }, a.users.admin.session);
    expect(created.status).toBe(201);
    w.db.raw.exec(`UPDATE users SET must_change_password = 0 WHERE mobile = '919000000050'`);
    const s = await w.login("northstar-hyundai", "9000000050", PASSWORD);
    const car = await addCar(w, a, "MALC841CLRM200020", VENUE, "CUTTACK", "IN_TRANSIT");
    expect((await w.api("POST", `/api/vehicles/${car.id}/receive`, undefined, s)).status).toBe(403);
    expect((await w.api("POST", "/api/vehicles", { vin: "MALC841CLRM200021", ...VENUE, outlet_id: a.outlets.CUTTACK, status: "RECEIVED" }, s)).status).toBe(403);
    expect((await w.api("POST", "/api/vehicles", { vin: "MALC841CLRM200021", ...VENUE, outlet_id: a.outlets.PATIA, status: "RECEIVED" }, s)).status).toBe(201);
  });
});

describe("personas", () => {
  it("each role gets exactly the screens and actions meant for it", async () => {
    const perms = async (who: string) => new Set<string>((await w.api("GET", "/api/auth/me", undefined, a.users[who].session)).body.user.permissions);
    const se = await perms("se1");
    expect(se.has("booking.create")).toBe(true);
    expect(se.has("booking.payment_report")).toBe(true); // sales reports a payment ...
    for (const p of ["booking.approve", "exception.decide", "stock.manage", "upload.stock", "upload.bookings", "booking.payment", "wa.manage", "admin.users", "admin.settings", "audit.view"]) expect(se.has(p), p).toBe(false);
    const sm = await perms("sm");
    expect(sm.has("booking.approve")).toBe(true);
    expect(sm.has("exception.decide")).toBe(false);
    const head = await perms("head");
    expect(head.has("booking.approve") && head.has("exception.decide")).toBe(true);
    expect(head.has("admin.settings")).toBe(true); // the dealership's rules are management's to set
    // The CEO / VP answers for execution and holds everything bar one thing: acting on money.
    for (const p of ["stock.manage", "upload.stock", "upload.bookings", "booking.payment_report", "admin.users", "wa.manage"]) expect(head.has(p), p).toBe(true);
    for (const p of ["booking.payment", "booking.deliver"]) expect(head.has(p), p).toBe(false);
    const accounts = await perms("accounts");
    expect(accounts.has("booking.payment")).toBe(true); // ... and Finance verifies it; nobody but the administrator holds both
    expect(accounts.has("booking.payment_report")).toBe(false);
    const stock = await perms("stock");
    expect(stock.has("upload.stock") && stock.has("upload.bookings") && stock.has("stock.manage")).toBe(true);
    for (const p of ["booking.approve", "booking.payment", "admin.settings"]) expect(stock.has(p), p).toBe(false);
    const auditor = await perms("auditor");
    expect(auditor.has("audit.view")).toBe(true);
    expect([...auditor].filter((p) => /manage|create|approve|decide|cancel|payment|deliver|upload|run/.test(p))).toEqual([]);
  });

  it("who approves is a dealership setting, not fixed in the product", async () => {
    const bk = await submittedBooking(w, a, "se1", VENUE, "PATIA", "Approver Test", "9833300001");
    // The setting is management's: the people it governs cannot rewrite it in their own favour.
    for (const who of ["sm", "se1", "stock", "accounts", "auditor"]) expect((await w.api("PUT", "/api/settings", { booking_approver_roles: ["SALES_CONSULTANT", "SALES_LEAD"] }, a.users[who].session)).status, who).toBe(403);
    expect((await w.api("GET", "/api/settings", undefined, a.users.admin.session)).body.settings.booking_approver_roles).toEqual(["SALES_LEAD", "GM_SALES"]);
    expect((await w.api("PUT", "/api/settings", { booking_approver_roles: ["CEO_VP"] }, a.users.head.session)).status).toBe(200);
    expect((await w.api("POST", `/api/bookings/${bk.id}/approve`, {}, a.users.sm.session)).status).toBe(403);
    expect((await w.api("POST", `/api/bookings/${bk.id}/approve`, {}, a.users.head.session)).status).toBe(200);
    // The change is on record under the name of whoever made it.
    const logged = w.db.q<any>(`SELECT u.name, l.detail_json FROM audit_log l JOIN users u ON u.id = l.actor WHERE l.tenant_id = ? AND l.action = 'SETTINGS_CHANGED' ORDER BY l.rowid DESC LIMIT 1`, a.tenantId)[0];
    expect(logged.name).toBe("Bikram Head");
    expect(JSON.parse(logged.detail_json).after.booking_approver_roles).toEqual(["CEO_VP"]);
    await w.api("PUT", "/api/settings", { booking_approver_roles: ["SALES_LEAD", "CEO_VP"] }, a.users.admin.session);
  });

  it("refuses rules that do not make sense", async () => {
    const s = a.users.admin.session;
    expect((await w.api("PUT", "/api/settings", { reminder_days: 5, escalation_days: 5 }, s)).status).toBe(400);
    expect((await w.api("PUT", "/api/settings", { outlet_scope: "EVERYWHERE" }, s)).status).toBe(400);
    expect((await w.api("PUT", "/api/settings", { exception_approver_roles: [] }, s)).status).toBe(400);
  });

  it("an administrator cannot lock themselves out, and a deactivated user is signed out at once", async () => {
    const admin = a.users.admin;
    expect((await w.api("PATCH", `/api/users/${admin.id}`, { is_active: false }, admin.session)).status).toBe(403);
    expect((await w.api("PATCH", `/api/users/${admin.id}`, { role: "SALES_CONSULTANT" }, admin.session)).status).toBe(403);
    const victim = a.users.ordering;
    expect((await w.api("GET", "/api/auth/me", undefined, victim.session)).status).toBe(200);
    await w.api("PATCH", `/api/users/${victim.id}`, { is_active: false }, admin.session);
    const old = { cookie: victim.session.cookie };
    expect((await w.api("GET", "/api/auth/me", undefined, old)).status).toBe(401);
    expect((await w.api("POST", "/api/auth/login", { dealer: a.slug, mobile: victim.mobile, password: PASSWORD })).status).toBe(401);
  });
});

describe("how far allocation looks for a car (dealership setting)", () => {
  it("own outlet first: another outlet's spare car is used and flagged for transfer", async () => {
    const w2 = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w2);
    await addCar(w2, d, "MALC841CLRM300001", CRETA, "CUTTACK", "RECEIVED");
    const bk = await approvedBooking(w2, d, "se1", CRETA, "PATIA", "Transfer Customer", "9844400001");
    expect(bk.approval.allocations[0]).toMatchObject({ vin: "MALC841CLRM300001", needsTransfer: true });
    const alerts = (await w2.api("GET", "/api/alerts", undefined, d.users.stock.session)).body;
    expect(alerts.some((x: any) => x.kind === "TRANSFER_NEEDED")).toBe(true);
    // Once the car is moved to the customer's outlet the flag clears.
    const car = w2.db.q<{ id: string }>(`SELECT id FROM vehicles WHERE vin = 'MALC841CLRM300001'`)[0];
    await w2.api("POST", `/api/vehicles/${car.id}/transfer`, { outlet_id: d.outlets.PATIA }, d.users.stock.session);
    expect((await booking(w2, d, bk.id)).allocation.needs_transfer).toBe(0);
  });

  it("own outlet first: a car is not taken from an outlet where an earlier or later customer of that outlet is waiting", async () => {
    const w2 = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w2);
    const patia = await approvedBooking(w2, d, "se1", CRETA, "PATIA", "Patia First", "9844400002");
    w2.at("2026-10-13 11:00");
    const cuttack = await approvedBooking(w2, d, "se3", CRETA, "CUTTACK", "Cuttack Later", "9844400003");
    await addCar(w2, d, "MALC841CLRM300002", CRETA, "CUTTACK", "RECEIVED");
    expect((await booking(w2, d, cuttack.id)).allocation.vin).toBe("MALC841CLRM300002");
    expect((await booking(w2, d, patia.id)).booking.status).toBe("APPROVED");
  });

  it("own outlet only: a car never serves another outlet", async () => {
    const w2 = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w2);
    await w2.api("PUT", "/api/settings", { outlet_scope: "SAME_OUTLET_ONLY" }, d.users.admin.session);
    await addCar(w2, d, "MALC841CLRM300003", CRETA, "CUTTACK", "RECEIVED");
    const bk = await approvedBooking(w2, d, "se1", CRETA, "PATIA", "Patia Only", "9844400004");
    expect(bk.approval.allocations).toHaveLength(0);
    const avail = await w2.api("GET", `/api/stock/availability?model=CRETA&variant=${encodeURIComponent(CRETA.variant)}&colour=ABYSS%20BLACK&outlet_id=${d.outlets.PATIA}`, undefined, d.users.se1.session);
    expect(avail.body.answer).toBe("NEEDS_ORDER");
  });

  it("whole dealership: strictly first booked, first served across outlets", async () => {
    const w2 = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w2);
    await w2.api("PUT", "/api/settings", { outlet_scope: "ANY_OUTLET" }, d.users.admin.session);
    const patia = await approvedBooking(w2, d, "se1", CRETA, "PATIA", "Patia First", "9844400005");
    w2.at("2026-10-13 11:00");
    const cuttack = await approvedBooking(w2, d, "se3", CRETA, "CUTTACK", "Cuttack Later", "9844400006");
    await addCar(w2, d, "MALC841CLRM300004", CRETA, "CUTTACK", "RECEIVED");
    expect((await booking(w2, d, patia.id)).allocation).toMatchObject({ vin: "MALC841CLRM300004", needs_transfer: 1 });
    expect((await booking(w2, d, cuttack.id)).booking.status).toBe("APPROVED");
  });
});
