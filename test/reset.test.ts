// Emptying a dealership so it can start afresh. What matters is the line between what a dealership did
// and what it is: the doing goes, the being stays, and nothing of another dealership is touched.
import { describe, expect, it } from "vitest";
import { approvedBooking, addCar, CRETA, makeDealer, makeMahindraDealer, makeWorld, PASSWORD, PLATFORM, VENUE, type Session, type World } from "./harness";
import { CLEARED, KEPT } from "../src/domain/reset";
import { hashPassword } from "../src/lib/crypto";

const count = (w: World, table: string, tenant: string) => w.db.q<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ?`, tenant)[0].n;
const clear = (w: World, s: Session, confirm: string, password = PASSWORD) => w.api("POST", "/api/settings/clear-data", { confirm, password }, s);

describe("clearing a dealership's data, from inside the dealership", () => {
  it("clears what was done, keeps what was set up, and leaves other dealerships alone", async () => {
    const w = makeWorld();
    const a = await makeDealer(w);
    const b = await makeMahindraDealer(w, "other-mahindra", "92000000");

    // A dealership with a day behind it: cars, a booking, an approval, an allocation.
    await addCar(w, a, "MALC841CLRM200021", VENUE, "PATIA", "RECEIVED");
    await approvedBooking(w, a, "se1", CRETA, "PATIA", "Vikram Rao", "9811111111");
    const aId = a.tenantId;
    const bId = w.db.q<{ id: string }>(`SELECT id FROM tenants WHERE slug = ?`, b.slug)[0].id;
    expect(count(w, "bookings", aId)).toBeGreaterThan(0);
    expect(count(w, "vehicles", aId)).toBeGreaterThan(0);
    expect(count(w, "audit_log", aId)).toBeGreaterThan(0);
    const usersBefore = count(w, "users", aId);
    const outletsBefore = count(w, "outlets", aId);
    const variantsBefore = count(w, "vehicle_variants", aId);
    const otherBookings = count(w, "bookings", bId);
    const name = w.db.q<{ name: string }>(`SELECT name FROM tenants WHERE id = ?`, aId)[0].name;

    // The name has to be typed, and a near miss removes nothing at all.
    const wrongName = await clear(w, a.users.admin.session, a.slug);
    expect(wrongName.status).toBe(400);
    expect(wrongName.body.error.message).toContain("Nothing has been removed");
    // So does the password: a screen somebody walked away from is not enough.
    const wrongPassword = await clear(w, a.users.admin.session, name, "Not-the-password-1");
    expect(wrongPassword.status).toBe(403);
    expect(wrongPassword.body.error.message).toContain("Nothing has been removed");
    expect(count(w, "bookings", aId)).toBeGreaterThan(0);

    const res = await clear(w, a.users.admin.session, name);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.total).toBeGreaterThan(0);

    // Everything the dealership did is gone, bar the one line saying it was cleared.
    for (const table of CLEARED) expect(count(w, table, aId), table).toBe(table === "audit_log" ? 1 : 0);
    // Everything it is remains: its people, its outlets, its vehicle master.
    expect(count(w, "users", aId)).toBe(usersBefore);
    expect(count(w, "outlets", aId)).toBe(outletsBefore);
    expect(count(w, "vehicle_variants", aId)).toBe(variantsBefore);
    expect(KEPT).toContain("users");
    // The other dealership is untouched.
    expect(count(w, "bookings", bId)).toBe(otherBookings);

    // People can still sign in, which is the point of keeping them -- and the person who pressed it
    // is still signed in, with the same session.
    expect((await w.api("POST", "/api/auth/login", { dealer: a.slug, mobile: a.users.se1.mobile, password: PASSWORD })).status).toBe(200);
    expect((await w.api("GET", "/api/auth/me", undefined, a.users.admin.session)).status).toBe(200);

    // The clear is on the dealership's own record, saying who did it and what went.
    const line = w.db.q<{ actor: string; detail_json: string }>(`SELECT actor, detail_json FROM audit_log WHERE tenant_id = ? AND action = 'DEALERSHIP_RESET'`, aId);
    expect(line.length).toBe(1);
    expect(line[0].actor).toBe(a.users.admin.id);
    expect(line[0].detail_json).toContain("bookings");
    // And on the platform's, which the dealership cannot reach or clear.
    const kept = w.db.q<{ actor: string; detail_json: string }>(`SELECT actor, detail_json FROM platform_audit WHERE action = 'TENANT_RESET' AND entity = ?`, aId);
    expect(kept.length).toBe(1);
    expect(kept[0].actor).toBe(a.users.admin.id);
    expect(JSON.parse(kept[0].detail_json)).toMatchObject({ from: "dealership", slug: a.slug });

    // The guarantee the clear had to suspend is back: neither history can be written over again.
    for (const t of ["audit_log", "vehicle_events"]) {
      const guards = w.db.q<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND tbl_name = ?`, t)[0].n;
      expect(guards, t).toBe(2);
    }
    expect(() => w.db.raw.exec(`DELETE FROM audit_log WHERE tenant_id = '${aId}'`)).toThrow(/append-only/);
  });

  it("is the System Admin's alone: nobody else can, not even the owner", async () => {
    const w = makeWorld();
    const d = await makeDealer(w);
    const name = w.db.q<{ name: string }>(`SELECT name FROM tenants WHERE id = ?`, d.tenantId)[0].name;
    // The Dealer Principal is built from "everything" by subtraction; this must not be in it.
    const dp = await w.api("POST", "/api/users", { name: "Deepa Principal", mobile: "9000000099", email: "dp@test.example", role: "DEALER_PRINCIPAL", all_outlets: true, outlet_ids: [] }, d.users.admin.session);
    expect(dp.status, JSON.stringify(dp.body)).toBe(201);
    w.db.raw.exec(`UPDATE users SET must_change_password = 0, password_hash = '${await hashPassword(PASSWORD)}' WHERE id = '${dp.body.id}'`);
    const dpSession = await w.login(d.slug, "9000000099", PASSWORD);
    const before = count(w, "audit_log", d.tenantId);

    for (const who of ["head", "gm", "sm", "stock", "accounts", "auditor", "se1"]) {
      expect((await clear(w, d.users[who].session, name)).status, who).toBe(403);
    }
    expect((await clear(w, dpSession, name)).status, "dealer principal").toBe(403);
    // Signed out, nothing either.
    expect((await w.api("POST", "/api/settings/clear-data", { confirm: name, password: PASSWORD })).status).toBe(401);
    // Every refusal removed nothing: the trail still holds exactly what it held.
    expect(count(w, "audit_log", d.tenantId)).toBe(before);

    // Only the System Admin is told the screen exists.
    const admin = await w.api("GET", "/api/auth/me", undefined, d.users.admin.session);
    expect(admin.body.user.permissions).toContain("admin.reset");
    const head = await w.api("GET", "/api/auth/me", undefined, d.users.head.session);
    expect(head.body.user.permissions).not.toContain("admin.reset");
  });

  it("is no longer offered from the platform console, outside the dealership", async () => {
    const w = makeWorld();
    const d = await makeDealer(w);
    const who = { mobile: "9800000001", name: "Platform Owner", password: "Platform@2026" };
    await w.api("POST", "/api/platform/bootstrap", who, undefined, { Authorization: PLATFORM.Authorization });
    const login = await w.api("POST", "/api/platform/login", { mobile: who.mobile, password: who.password });
    const su = { cookie: (login.headers.get("Set-Cookie") ?? "").split(";")[0] } as Session;
    const name = w.db.q<{ name: string }>(`SELECT name FROM tenants WHERE id = ?`, d.tenantId)[0].name;
    const before = count(w, "audit_log", d.tenantId);
    expect((await w.api("POST", `/api/platform/tenants/${d.slug}/reset`, { confirm: name }, su)).status).toBe(404);
    expect(count(w, "audit_log", d.tenantId)).toBe(before);
  });
});

describe("WhatsApp, until a dealership has it", () => {
  it("is not offered at all: no permission, and the screens behind it refuse", async () => {
    const w = makeWorld();
    const d = await makeDealer(w);
    // The fixtures switch it on. Off is the default, and off means gone rather than hidden.
    await w.api("PUT", "/api/settings", { whatsapp_enabled: false }, d.users.admin.session);
    const me = await w.api("GET", "/api/auth/me", undefined, d.users.admin.session);
    for (const p of ["wa.view", "wa.manage", "wa.resend"]) expect(me.body.user.permissions, p).not.toContain(p);
    // A saved link to the screen is refused too, not merely absent from the menu.
    expect((await w.api("GET", "/api/wa/messages", undefined, d.users.admin.session)).status).toBe(403);
    expect((await w.api("GET", "/api/wa/config", undefined, d.users.admin.session)).status).toBe(403);
    // Switched back on, it returns as it was.
    await w.api("PUT", "/api/settings", { whatsapp_enabled: true }, d.users.admin.session);
    expect((await w.api("GET", "/api/wa/messages", undefined, d.users.admin.session)).status).toBe(200);
  });
});
