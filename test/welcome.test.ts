// The welcome screen is shown once to each person: the first time they reach the application itself,
// after replacing the temporary password, and never again on any device. What is tested is the flag
// the screen turns on, because that is the whole of the behaviour; the words on the screen are not.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hashPassword } from "../src/lib/crypto";
import { makeDealer, makeWorld, PASSWORD } from "./harness";

describe("the welcome screen", () => {
  it("is owed to a new person once they have set their password, and is not owed again once seen", async () => {
    const w = makeWorld();
    const d = await makeDealer(w);
    const made = await w.api("POST", "/api/users", { name: "Nisha New", mobile: "9000000077", email: "nisha@test.example", role: "SALES_CONSULTANT", all_outlets: true, outlet_ids: [] }, d.users.admin.session);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    // A temporary password, as an administrator's new person has. The welcome waits behind it.
    w.db.raw.exec(`UPDATE users SET must_change_password = 1, password_hash = '${await hashPassword(PASSWORD)}' WHERE id = '${made.body.id}'`);
    const s = await w.login(d.slug, "9000000077", PASSWORD);
    expect((await w.api("GET", "/api/auth/me", undefined, s)).body.user).toMatchObject({ mustChangePassword: true, welcomed: false });

    expect((await w.api("POST", "/api/auth/change-password", { current: PASSWORD, next: "Nisha@2026" }, s)).status).toBe(200);
    const fresh = await w.login(d.slug, "9000000077", "Nisha@2026");
    // Password set: now the welcome is owed.
    expect((await w.api("GET", "/api/auth/me", undefined, fresh)).body.user).toMatchObject({ mustChangePassword: false, welcomed: false });

    expect((await w.api("POST", "/api/auth/welcomed", undefined, fresh)).status).toBe(200);
    expect((await w.api("GET", "/api/auth/me", undefined, fresh)).body.user.welcomed).toBe(true);
    // Kept on the account, not the browser: a new sign-in elsewhere does not see it again.
    const elsewhere = await w.login(d.slug, "9000000077", "Nisha@2026");
    expect((await w.api("GET", "/api/auth/me", undefined, elsewhere)).body.user.welcomed).toBe(true);

    // Saying it twice changes nothing: the first time stands.
    const at = w.db.q<{ welcomed_at: string }>(`SELECT welcomed_at FROM users WHERE id = ?`, made.body.id)[0].welcomed_at;
    w.at("2026-10-20 10:00");
    await w.api("POST", "/api/auth/welcomed", undefined, elsewhere);
    expect(w.db.q<{ welcomed_at: string }>(`SELECT welcomed_at FROM users WHERE id = ?`, made.body.id)[0].welcomed_at).toBe(at);
  });

  it("is only ever about the person asking", async () => {
    const w = makeWorld();
    const d = await makeDealer(w);
    await w.api("POST", "/api/auth/welcomed", undefined, d.users.se1.session);
    expect((await w.api("GET", "/api/auth/me", undefined, d.users.se1.session)).body.user.welcomed).toBe(true);
    expect((await w.api("GET", "/api/auth/me", undefined, d.users.se2.session)).body.user.welcomed).toBe(false);
    expect((await w.api("POST", "/api/auth/welcomed")).status).toBe(401);
  });

  it("does not interrupt the people already using the system on the day it arrives", () => {
    const w = makeWorld();
    // The migration's own statement, run against the two kinds of person there are on the day it
    // arrives: one who has been signing in for weeks, one who has not yet set their password.
    w.db.raw.exec(`CREATE TEMP TABLE probe (must_change_password INTEGER, welcomed_at TEXT)`);
    w.db.raw.exec(`INSERT INTO probe VALUES (0, NULL), (1, NULL)`);
    const sql = readFileSync("migrations/0017_user_welcomed.sql", "utf8");
    w.db.raw.exec(/UPDATE users SET[\s\S]*?;/.exec(sql)![0].replace("UPDATE users", "UPDATE probe"));
    const rows = w.db.q<{ must_change_password: number; welcomed_at: string | null }>(`SELECT * FROM probe ORDER BY must_change_password`);
    expect(rows[0].welcomed_at, "already using it").toBeTruthy();
    expect(rows[1].welcomed_at, "not yet set a password").toBeNull();
  });
});
