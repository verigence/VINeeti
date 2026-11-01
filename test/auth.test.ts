import { beforeAll, describe, expect, it } from "vitest";
import { CRETA, makeDealer, makeWorld, PASSWORD, submittedBooking, type Dealer, type World } from "./harness";

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
    const created = await w.api("POST", "/api/users", { name: "New Joiner", mobile: "9000000077", email: "9000000077@test.example", role: "SALES_CONSULTANT", outlet_ids: [d.outlets.PATIA] }, d.users.admin.session);
    expect(created.status).toBe(201);
    // The administrator does not choose it: the server makes one and, with no mail account on this
    // deployment, hands it back this once instead of emailing it.
    const given: string = created.body.temporary_password;
    expect(given).toMatch(/^[a-z2-9]{10}$/);
    const old = { cookie: (await w.login(d.slug, "9000000077", given)).cookie };
    const me = await w.api("GET", "/api/auth/me", undefined, old);
    expect(me.body.user.mustChangePassword).toBe(true);
    for (const path of ["/api/bookings", "/api/stock/summary", "/api/vehicles"]) {
      const res = await w.api("GET", path, undefined, old);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("PASSWORD_CHANGE_REQUIRED");
    }
    expect((await w.api("POST", "/api/auth/change-password", { current: given, next: "short1" }, old)).status).toBe(400);
    expect((await w.api("POST", "/api/auth/change-password", { current: given, next: "allletters" }, old)).status).toBe(400);
    expect((await w.api("POST", "/api/auth/change-password", { current: "wrong", next: "NewPassw0rd" }, old)).status).toBe(400);
    const res = await w.api("POST", "/api/auth/change-password", { current: given, next: "NewPassw0rd" }, old);
    expect(res.status).toBe(200);
    expect((await w.api("GET", "/api/auth/me", undefined, old)).status).toBe(401);
    const fresh = { cookie: res.headers.get("Set-Cookie")!.split(";")[0] };
    expect((await w.api("GET", "/api/auth/me", undefined, fresh)).body.user.mustChangePassword).toBe(false);
    expect((await w.api("GET", "/api/bookings", undefined, fresh)).status).toBe(200);
    expect((await w.api("POST", "/api/auth/login", { dealer: d.slug, mobile: "9000000077", password: given })).status).toBe(401);
  });

  it("stores passwords only as salted hashes", () => {
    const rows = w.db.q<{ password_hash: string }>(`SELECT password_hash FROM users`);
    expect(new Set(rows.map((r) => r.password_hash)).size).toBe(rows.length); // same password, different hashes
    for (const r of rows) expect(r.password_hash).not.toContain(PASSWORD);
  });

  it("an administrator's password reset signs the user out everywhere", async () => {
    const u = d.users.accounts;
    const old = { cookie: u.session.cookie };
    // The one way an administrator gives somebody a password: the server makes it, and nobody types it.
    const reset = await w.api("POST", `/api/users/${u.id}/reset-password`, undefined, d.users.admin.session);
    expect(reset.status).toBe(200);
    expect((await w.api("PATCH", `/api/users/${u.id}`, { password: "Chosen1234" }, d.users.admin.session)).status).toBe(200);
    expect((await w.api("GET", "/api/auth/me", undefined, old)).status).toBe(401);
    // A password named in an update is ignored rather than honoured.
    expect((await w.api("POST", "/api/auth/login", { dealer: d.slug, mobile: u.mobile, password: "Chosen1234" })).status).toBe(401);
    const s = await w.login(d.slug, u.mobile, reset.body.temporary_password);
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

describe("removing a user", () => {
  it("removes an account nobody has used, records a departure for one that has worked, and lets nobody else do either", async () => {
    const w2 = makeWorld("2026-10-13 10:00");
    const d2 = await makeDealer(w2);

    // Added by mistake five minutes ago: there is nothing of theirs to keep, so it goes for good.
    const made = await w2.api("POST", "/api/users", { name: "Wrong Number", mobile: "9000000066", email: "wrong@test.example", role: "SALES_CONSULTANT", outlet_ids: [d2.outlets.PATIA], segments: [] }, d2.users.admin.session);
    expect(made.status).toBe(201);
    const gone = await w2.api("DELETE", `/api/users/${made.body.id}`, undefined, d2.users.admin.session);
    expect(gone.status).toBe(200);
    expect(gone.body.removed).toBe("Wrong Number");
    expect(w2.db.q(`SELECT id FROM users WHERE id = ?`, made.body.id)).toEqual([]);
    expect(w2.db.q(`SELECT user_id FROM user_outlets WHERE user_id = ?`, made.body.id)).toEqual([]);
    // The removal itself is on the record, so a name that disappears can still be accounted for.
    expect(w2.db.q<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'USER_DELETED' AND entity_id = ?`, made.body.id)[0].n).toBe(1);

    // Somebody who has worked: the dealership's own record needs their name, so the account is kept
    // rather than deleted — but the departure itself is recorded rather than refused. The system is
    // role-driven: a person leaving is a thing that happens, not a thing to argue with.
    await submittedBooking(w2, d2, "se1", CRETA, "PATIA", "Vikram Rao", "9811111111");
    const kept = await w2.api("DELETE", `/api/users/${d2.users.se1.id}`, undefined, d2.users.admin.session);
    expect(kept.status).toBe(200);
    expect(kept.body).toMatchObject({ left: true, left_on: "2026-10-13" });
    const row = w2.db.q<{ is_active: number; left_on: string | null }>(`SELECT is_active, left_on FROM users WHERE id = ?`, d2.users.se1.id);
    expect(row.length).toBe(1);
    expect(row[0]).toMatchObject({ is_active: 0, left_on: "2026-10-13" });
    // Their name is still on the booking they took.
    expect(w2.db.q<{ n: number }>(`SELECT COUNT(*) AS n FROM bookings WHERE sales_exec_id = ?`, d2.users.se1.id)[0].n).toBeGreaterThan(0);

    // Not a manager's to do, and not one's own to do either.
    expect((await w2.api("DELETE", `/api/users/${d2.users.se2.id}`, undefined, d2.users.sm.session)).status).toBe(403);
    const self = await w2.api("DELETE", `/api/users/${d2.users.admin.id}`, undefined, d2.users.admin.session);
    expect(self.status).toBe(400);
    expect(self.body.error.message).toContain("your own account");
  });
});

describe("correcting a mobile number", () => {
  it("is allowed, signs the person out, refuses a number somebody else uses, and keeps their history", async () => {
    const w2 = makeWorld("2026-10-13 10:00");
    const d2 = await makeDealer(w2);
    const u = d2.users.se1;
    const old = { cookie: u.session.cookie };

    // Typed wrongly at first — eleven digits — and the account is unusable until it is corrected.
    w2.db.raw.exec(`UPDATE users SET mobile = '90000000099' WHERE id = '${u.id}'`);
    expect((await w2.api("POST", "/api/auth/login", { dealer: d2.slug, mobile: "9000000099", password: PASSWORD })).status).toBe(401);

    // Another person's number is refused rather than quietly taken.
    const taken = await w2.api("PATCH", `/api/users/${u.id}`, { mobile: d2.users.se2.mobile }, d2.users.admin.session);
    expect(taken.status).toBe(409);
    expect(taken.body.error.message).toContain("already signs in with that mobile number");

    const fixed = await w2.api("PATCH", `/api/users/${u.id}`, { mobile: "9000000099" }, d2.users.admin.session);
    expect(fixed.status).toBe(200);
    expect(w2.db.q<{ mobile: string }>(`SELECT mobile FROM users WHERE id = ?`, u.id)[0].mobile).toBe("919000000099");

    // Signed out everywhere, because whoever was signed in was signed in as the old number.
    expect((await w2.api("GET", "/api/auth/me", undefined, old)).status).toBe(401);
    // And in with the corrected one.
    w2.db.raw.exec(`UPDATE users SET must_change_password = 0 WHERE id = '${u.id}'`);
    expect((await w2.api("POST", "/api/auth/login", { dealer: d2.slug, mobile: "9000000099", password: PASSWORD })).status).toBe(200);

    // The change is on the record, old number and new, and the person is still the same person.
    const line = w2.db.q<{ detail_json: string }>(`SELECT detail_json FROM audit_log WHERE action = 'USER_UPDATED' AND entity_id = ? ORDER BY at DESC`, u.id)[0];
    expect(line.detail_json).toContain("90000000099");
    expect(line.detail_json).toContain("919000000099");
    expect((await w2.api("PATCH", `/api/users/${u.id}`, { mobile: "not a number" }, d2.users.admin.session)).status).toBe(400);
  });
});
