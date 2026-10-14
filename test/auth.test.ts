import { beforeAll, describe, expect, it } from "vitest";
import { makeDealer, makeWorld, PASSWORD, type Dealer, type World } from "./harness";

let w: World;
let d: Dealer;

beforeAll(async () => {
  w = makeWorld("2026-10-13 10:00");
  d = await makeDealer(w);
});

describe("signing in", () => {
  it("nothing but health, sign-in and the WhatsApp webhook is reachable without a session", async () => {
    expect((await w.api("GET", "/api/health")).status).toBe(200);
    for (const path of ["/api/auth/me", "/api/bookings", "/api/vehicles", "/api/stock/summary", "/api/users", "/api/settings", "/api/wa/config", "/api/wa/messages", "/api/audit", "/api/recon/runs", "/api/dashboards/overview", "/api/uploads", "/api/payments", "/api/master", "/api/master/export", "/api/data-status", "/api/roles", "/api/catalog"]) {
      expect((await w.api("GET", path)).status, path).toBe(401);
    }
    expect((await w.api("POST", "/api/allocations/run")).status).toBe(401);
    // The DMS files are loaded by a signed-in person, or by the dealership's end-of-day job with its own key: not by anyone else.
    for (const path of ["/api/uploads/stock", "/api/uploads/bookings", "/api/uploads/master", `/api/eod/${d.slug}/stock`, `/api/eod/${d.slug}/bookings`, `/api/eod/${d.slug}/run`]) {
      expect((await w.api("POST", path, "VIN,Model Description\nX,Y")).status, path).toBe(401);
    }
    expect((await w.api("GET", "/api/nope", undefined, d.users.admin.session)).status).toBe(404);
  });

  it("rejects a forged or altered session", async () => {
    const good = d.users.se1.session.cookie;
    const [payload, sig] = good.replace("session=", "").split(".");
    expect((await w.api("GET", "/api/auth/me", undefined, { cookie: `session=${payload}.${sig.slice(0, -2)}AA` })).status).toBe(401);
    const forged = btoa(JSON.stringify({ tid: d.tenantId, uid: d.users.admin.id, tv: 0, exp: 9999999999 })).replace(/=+$/, "");
    expect((await w.api("GET", "/api/auth/me", undefined, { cookie: `session=${forged}.${sig}` })).status).toBe(401);
  });

  it("gives the same answer for a wrong dealer code, mobile or password", async () => {
    const tries = [
      { dealer: "no-such-dealer", mobile: d.users.se1.mobile, password: PASSWORD },
      { dealer: d.slug, mobile: "9111111111", password: PASSWORD },
      { dealer: d.slug, mobile: d.users.se1.mobile, password: "wrong-password1" },
    ];
    for (const t of tries) {
      const res = await w.api("POST", "/api/auth/login", t);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("INVALID_LOGIN");
    }
  });

  it("locks the account for 15 minutes after five wrong passwords", async () => {
    const mobile = d.users.se2.mobile;
    for (let i = 0; i < 5; i++) expect((await w.api("POST", "/api/auth/login", { dealer: d.slug, mobile, password: "wrong-password1" })).status).toBe(401);
    // Locked: even the right password is refused, with the same answer as any other failure.
    const locked = await w.api("POST", "/api/auth/login", { dealer: d.slug, mobile, password: PASSWORD });
    expect(locked.status).toBe(401);
    expect(locked.body.error.code).toBe("INVALID_LOGIN");
    w.at("2026-10-13 10:16");
    expect((await w.api("POST", "/api/auth/login", { dealer: d.slug, mobile, password: PASSWORD })).status).toBe(200);
  });

  it("a session ends after 12 hours", async () => {
    w.at("2026-10-13 10:20");
    const s = { cookie: (await w.login(d.slug, d.users.sm.mobile, PASSWORD)).cookie };
    w.at("2026-10-13 22:10");
    expect((await w.api("GET", "/api/auth/me", undefined, s)).status).toBe(200);
    w.at("2026-10-13 22:25");
    expect((await w.api("GET", "/api/auth/me", undefined, s)).status).toBe(401);
  });

  it("signing out ends the session on the server, not only in the browser", async () => {
    const s = { cookie: (await w.login(d.slug, d.users.auditor.mobile, PASSWORD)).cookie };
    expect((await w.api("GET", "/api/auth/me", undefined, s)).status).toBe(200);
    await w.api("POST", "/api/auth/logout", undefined, s);
    expect((await w.api("GET", "/api/auth/me", undefined, s)).status).toBe(401);
  });

  it("sets the session cookie so scripts and other sites cannot use it", async () => {
    const res = await w.api("POST", "/api/auth/login", { dealer: d.slug, mobile: d.users.sm.mobile, password: PASSWORD });
    const cookie = res.headers.get("Set-Cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
  });
});

describe("passwords", () => {
  it("a new user can do nothing until they replace the password the administrator gave them", async () => {
    const created = await w.api("POST", "/api/users", { name: "New Joiner", mobile: "9000000077", role: "SALES_EXEC", password: PASSWORD, outlet_ids: [d.outlets.PATIA] }, d.users.admin.session);
    expect(created.status).toBe(201);
    const old = { cookie: (await w.login(d.slug, "9000000077", PASSWORD)).cookie };
    const me = await w.api("GET", "/api/auth/me", undefined, old);
    expect(me.body.user.mustChangePassword).toBe(true);
    for (const path of ["/api/bookings", "/api/stock/summary", "/api/vehicles"]) {
      const res = await w.api("GET", path, undefined, old);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("PASSWORD_CHANGE_REQUIRED");
    }
    expect((await w.api("POST", "/api/auth/change-password", { current: PASSWORD, next: "short1" }, old)).status).toBe(400);
    expect((await w.api("POST", "/api/auth/change-password", { current: PASSWORD, next: "allletters" }, old)).status).toBe(400);
    expect((await w.api("POST", "/api/auth/change-password", { current: "wrong", next: "NewPassw0rd" }, old)).status).toBe(400);
    const res = await w.api("POST", "/api/auth/change-password", { current: PASSWORD, next: "NewPassw0rd" }, old);
    expect(res.status).toBe(200);
    expect((await w.api("GET", "/api/auth/me", undefined, old)).status).toBe(401);
    const fresh = { cookie: res.headers.get("Set-Cookie")!.split(";")[0] };
    expect((await w.api("GET", "/api/auth/me", undefined, fresh)).body.user.mustChangePassword).toBe(false);
    expect((await w.api("GET", "/api/bookings", undefined, fresh)).status).toBe(200);
    expect((await w.api("POST", "/api/auth/login", { dealer: d.slug, mobile: "9000000077", password: PASSWORD })).status).toBe(401);
  });

  it("stores passwords only as salted hashes", () => {
    const rows = w.db.q<{ password_hash: string }>(`SELECT password_hash FROM users`);
    expect(new Set(rows.map((r) => r.password_hash)).size).toBe(rows.length); // same password, different hashes
    for (const r of rows) expect(r.password_hash).not.toContain(PASSWORD);
  });

  it("an administrator's password reset signs the user out everywhere", async () => {
    const u = d.users.accounts;
    const old = { cookie: u.session.cookie };
    await w.api("PATCH", `/api/users/${u.id}`, { password: "Reset1234" }, d.users.admin.session);
    expect((await w.api("GET", "/api/auth/me", undefined, old)).status).toBe(401);
    const s = await w.login(d.slug, u.mobile, "Reset1234");
    expect((await w.api("GET", "/api/auth/me", undefined, s)).body.user.mustChangePassword).toBe(true);
  });
});

describe("request guards", () => {
  it("refuses state-changing requests from another site", async () => {
    const res = await w.api("POST", "/api/allocations/run", {}, d.users.head.session, { Origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect((await w.api("POST", "/api/allocations/run", {}, d.users.head.session, { Origin: "https://app.test" })).status).toBe(200);
  });
  it("refuses form posts that a plain HTML form on another site could make", async () => {
    const res = await w.api("POST", "/api/allocations/run", "a=b", d.users.head.session, { "Content-Type": "application/x-www-form-urlencoded" });
    expect(res.status).toBe(415);
  });
  it("does not leak internal errors", async () => {
    const res = await w.api("POST", "/api/bookings", "{not json", d.users.se1.session, { "Content-Type": "application/json" });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("The request body is not valid JSON");
  });
});
