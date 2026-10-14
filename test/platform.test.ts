// The platform console: the deployment's own administrators. They can see which dealerships exist and
// act on a dealership's administrator — and nothing inside any dealership.
import { describe, expect, it } from "vitest";
import { makeMahindraDealer, makeWorld, PASSWORD, PLATFORM, type World } from "./harness";

const q = <T = any>(w: World, sql: string, ...p: unknown[]) => w.db.q<T>(sql, ...p);
const SUPER = { mobile: "9800000001", name: "Platform Owner", password: "Platform@2026" };

/** The deployment creating the first super admin, as scripts/deploy.mjs does. */
const bootstrap = (w: World, body: Record<string, unknown> = SUPER, token = PLATFORM.Authorization) => w.api("POST", "/api/platform/bootstrap", body, undefined, { Authorization: token });

async function signIn(w: World, mobile = SUPER.mobile, password = SUPER.password) {
  const res = await w.api("POST", "/api/platform/login", { mobile, password });
  if (res.status !== 200) throw new Error(`platform sign-in failed: ${JSON.stringify(res.body)}`);
  return { cookie: (res.headers.get("Set-Cookie") ?? "").split(";")[0] };
}

describe("the super admin the deployment creates", () => {
  it("is created once from the deployment's secrets, and a later deployment only follows a changed password", async () => {
    const w = makeWorld();
    expect((await bootstrap(w)).status).toBe(201);
    expect((await bootstrap(w)).body).toEqual({ created: false, changed: false, mobile: "919800000001" });
    const s = await signIn(w);
    expect((await w.api("GET", "/api/platform/me", undefined, s)).body).toMatchObject({ name: "Platform Owner", mobile: "919800000001", must_change_password: false });
    // The deployment's secret is changed: the password follows it and every session ends.
    expect((await bootstrap(w, { ...SUPER, password: "Platform@2027" })).body).toEqual({ created: false, changed: true, mobile: "919800000001" });
    expect((await w.api("GET", "/api/platform/me", undefined, s)).status).toBe(401);
    expect((await w.api("POST", "/api/platform/login", { mobile: SUPER.mobile, password: SUPER.password })).status).toBe(401);
    await signIn(w, SUPER.mobile, "Platform@2027");
    // Only the deployment's own token may do this, and the password has to be a real one.
    expect((await bootstrap(w, SUPER, "Bearer wrong-token")).status).toBe(401);
    expect((await bootstrap(w, { ...SUPER, password: "short1" })).status).toBe(400);
    expect(JSON.stringify(q(w, `SELECT * FROM platform_admins`))).not.toContain("Platform@2027");
    expect(q(w, `SELECT actor, action FROM platform_audit ORDER BY at, rowid`)).toEqual([
      { actor: "DEPLOY", action: "PLATFORM_ADMIN_CREATED" },
      { actor: "DEPLOY", action: "PLATFORM_ADMIN_PASSWORD_SET" },
    ]);
  });

  it("locks after five wrong passwords and can change its own", async () => {
    const w = makeWorld();
    await bootstrap(w);
    for (let i = 0; i < 5; i++) expect((await w.api("POST", "/api/platform/login", { mobile: SUPER.mobile, password: "wrong-one-1" })).status).toBe(401);
    expect((await w.api("POST", "/api/platform/login", { mobile: SUPER.mobile, password: SUPER.password })).status).toBe(401);
    w.at("2026-10-13 10:20"); // the lock lasts fifteen minutes
    const s = await signIn(w);
    expect((await w.api("POST", "/api/platform/change-password", { current: SUPER.password, next: "short" }, s)).status).toBe(400);
    expect((await w.api("POST", "/api/platform/change-password", { current: "not-it", next: "Platform@2028" }, s)).status).toBe(400);
    const changed = await w.api("POST", "/api/platform/change-password", { current: SUPER.password, next: "Platform@2028" }, s);
    expect(changed.status).toBe(200);
    await signIn(w, SUPER.mobile, "Platform@2028");
    // Signing out ends the session on the server as well.
    const s2 = { cookie: (changed.headers.get("Set-Cookie") ?? "").split(";")[0] };
    expect((await w.api("POST", "/api/platform/logout", undefined, s2)).status).toBe(200);
    expect((await w.api("GET", "/api/platform/me", undefined, s2)).status).toBe(401);
  });
});

describe("what the super admin can do", () => {
  it("creates a dealership, lists the deployment's dealerships and switches one off", async () => {
    const w = makeWorld();
    await bootstrap(w);
    const s = await signIn(w);
    const made = await w.api("POST", "/api/platform/tenants", { slug: "new-motors", name: "New Motors", oem: "Mahindra", admin: { name: "Their Admin", mobile: "9700000001", password: "FirstPass123" } }, s);
    expect(made.status).toBe(201);
    const d = await makeMahindraDealer(w);
    const list = (await w.api("GET", "/api/platform/tenants", undefined, s)).body;
    expect(list.map((t: any) => [t.slug, t.is_active, t.users])).toEqual([["new-motors", true, 1], [d.slug, true, 9]]);
    expect(list[1]).toMatchObject({ name: "Sample Motors", oem: "Mahindra", outlets: 1, cars_in_stock: 0, open_bookings: 0, last_file_at: null });
    // Switching a dealership off stops its people signing in, and ends the sessions they have.
    expect((await w.api("GET", "/api/auth/me", undefined, d.users.exec.session)).status).toBe(200);
    const off = await w.api("PATCH", `/api/platform/tenants/${d.slug}`, { is_active: false }, s);
    expect(off.status).toBe(200);
    expect((await w.api("GET", "/api/auth/me", undefined, { cookie: d.users.exec.session.cookie })).status).toBe(401);
    expect((await w.api("POST", "/api/auth/login", { dealer: d.slug, mobile: d.users.exec.mobile, password: PASSWORD })).status).toBe(401);
    expect((await w.api("PATCH", `/api/platform/tenants/${d.slug}`, { is_active: true }, s)).status).toBe(200);
    expect((await w.api("POST", "/api/auth/login", { dealer: d.slug, mobile: d.users.exec.mobile, password: PASSWORD })).status).toBe(200);
    expect((await w.api("PATCH", "/api/platform/tenants/no-such-dealer", { is_active: false }, s)).status).toBe(404);
  });

  it("gives a locked-out dealership's administrator a new temporary password, shown once and recorded on both trails", async () => {
    const w = makeWorld();
    await bootstrap(w);
    const s = await signIn(w);
    const d = await makeMahindraDealer(w);
    const res = await w.api("POST", `/api/platform/tenants/${d.slug}/admin-password`, {}, s);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dealer: d.slug, mobile: `91${d.users.admin.mobile}`, role_label: "System Admin" });
    expect(res.body.temporary_password).toMatch(/^[a-z2-9]{10}$/);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    // The old password and the open session stop working; the new one must be replaced at sign-in.
    expect((await w.api("POST", "/api/auth/login", { dealer: d.slug, mobile: d.users.admin.mobile, password: PASSWORD })).status).toBe(401);
    expect((await w.api("GET", "/api/auth/me", undefined, { cookie: d.users.admin.session.cookie })).status).toBe(401);
    const fresh = await w.login(d.slug, d.users.admin.mobile, res.body.temporary_password);
    expect((await w.api("GET", "/api/users", undefined, fresh)).body.error.code).toBe("PASSWORD_CHANGE_REQUIRED");
    // The dealership sees it on its own audit trail, and the platform on its.
    expect(q(w, `SELECT actor, action FROM audit_log WHERE action = 'PASSWORD_RESET_BY_PLATFORM'`)).toEqual([{ actor: "PLATFORM", action: "PASSWORD_RESET_BY_PLATFORM" }]);
    expect(q(w, `SELECT action FROM platform_audit WHERE action = 'TENANT_ADMIN_PASSWORD_RESET'`)).toHaveLength(1);
    expect(JSON.stringify(q(w, `SELECT * FROM platform_audit`))).not.toContain(res.body.temporary_password);
    const audit = (await w.api("GET", "/api/platform/audit", undefined, s)).body;
    expect(audit[0]).toMatchObject({ action: "TENANT_ADMIN_PASSWORD_RESET", actor_name: "Platform Owner" });
  });
});

describe("the platform console reaches no dealership's data", () => {
  it("a platform session is not a sign-in to any dealership, and a dealership's people cannot reach the console", async () => {
    const w = makeWorld();
    await bootstrap(w);
    const s = await signIn(w);
    const d = await makeMahindraDealer(w);
    // Nothing of a dealership is readable with a platform session.
    for (const path of ["/api/auth/me", "/api/bookings", "/api/vehicles", "/api/users", "/api/analytics/ageing", "/api/recon/runs", "/api/wa/messages", "/api/audit"]) {
      expect((await w.api("GET", path, undefined, s)).status, path).toBe(401);
    }
    // And the console is closed to everyone at a dealership, including its System Admin.
    for (const who of ["admin", "dp", "head", "finance"]) {
      for (const path of ["/api/platform/tenants", "/api/platform/audit", "/api/platform/me"]) {
        expect((await w.api("GET", path, undefined, d.users[who].session)).status, `${who} ${path}`).toBe(401);
      }
      expect((await w.api("POST", `/api/platform/tenants/${d.slug}/admin-password`, {}, d.users[who].session)).status, who).toBe(401);
    }
    // A platform session cannot be used as a dealership cookie, nor the other way about.
    const asDealerCookie = { cookie: s.cookie.replace("platform_session=", "session=") };
    expect((await w.api("GET", "/api/auth/me", undefined, asDealerCookie)).status).toBe(401);
    const asPlatformCookie = { cookie: d.users.admin.session.cookie.replace("session=", "platform_session=") };
    expect((await w.api("GET", "/api/platform/me", undefined, asPlatformCookie)).status).toBe(401);
  });

  it("nothing works until a first password set by the deployment has been replaced, when it is marked so", async () => {
    const w = makeWorld();
    await bootstrap(w);
    w.db.raw.exec(`UPDATE platform_admins SET must_change_password = 1`);
    const s = await signIn(w);
    expect((await w.api("GET", "/api/platform/tenants", undefined, s)).body.error.code).toBe("PASSWORD_CHANGE_REQUIRED");
    expect((await w.api("GET", "/api/platform/me", undefined, s)).body.must_change_password).toBe(true);
    expect((await w.api("POST", "/api/platform/change-password", { current: SUPER.password, next: "Platform@2029" }, s)).status).toBe(200);
    expect((await w.api("GET", "/api/platform/tenants", undefined, await signIn(w, SUPER.mobile, "Platform@2029"))).status).toBe(200);
  });
});
