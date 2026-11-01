// The sign-in log: who got in, who was turned away, from which address and when.
//
// The log exists to answer a question after something has gone wrong, so the tests are mostly about
// the cases nobody plans for: a wrong password, a number that belongs to nobody, an account that has
// locked itself. They also pin down the two things that make a log like this safe to keep — that it
// cannot be read by whoever feels like it, and that it does not keep people's whereabouts for ever.

import { beforeAll, describe, expect, it } from "vitest";
import { makeDealer, makeWorld, PASSWORD, type Dealer, type World } from "./harness";
import { KEEP_DAYS } from "../src/domain/sign-ins";

let w: World;
let d: Dealer;

const OFFICE = { "CF-Connecting-IP": "49.207.10.20" };
const ELSEWHERE = { "CF-Connecting-IP": "203.0.113.77" };

const rows = (tenantId: string) => w.db.q<any>(`SELECT * FROM sign_ins WHERE tenant_id = ? ORDER BY at DESC, rowid DESC`, tenantId);
const signIn = (mobile: string, password: string, headers: Record<string, string> = OFFICE) =>
  w.api("POST", "/api/auth/login", { dealer: d.slug, mobile, password }, undefined, headers);

beforeAll(async () => {
  w = makeWorld("2026-10-13 10:00");
  d = await makeDealer(w, "signin-mahindra");
});

describe("what is recorded", () => {
  it("records a sign-in with the address it came from, and says whether it was the app", async () => {
    const before = rows(d.tenantId).length;
    const res = await signIn(d.users.sm.mobile, PASSWORD, { ...OFFICE, "X-VINeeti-Client": "APP" });
    expect(res.status).toBe(200);
    const [last] = rows(d.tenantId);
    expect(rows(d.tenantId).length).toBe(before + 1);
    expect(last).toMatchObject({ outcome: "IN", ip: "49.207.10.20", client: "APP", name: "Sunita Manager", role: "SALES_LEAD" });
    expect(last.user_id).toBe(d.users.sm.id);
  });

  it("calls anything that is not the app a browser, rather than guessing from the user agent", async () => {
    await signIn(d.users.sm.mobile, PASSWORD, { ...OFFICE, "User-Agent": "Mozilla/5.0 (Linux; Android 14)" });
    expect(rows(d.tenantId)[0]).toMatchObject({ outcome: "IN", client: "BROWSER" });
  });

  it("records a wrong password as refused, against the account it was tried on", async () => {
    const res = await signIn(d.users.se1.mobile, "not-the-password", ELSEWHERE);
    expect(res.status).toBe(401);
    expect(rows(d.tenantId)[0]).toMatchObject({ outcome: "REFUSED", ip: "203.0.113.77", user_id: d.users.se1.id, name: "Ravi Exec" });
  });

  it("records a number that belongs to nobody, keeping the number as it was typed", async () => {
    const res = await signIn("9100000099", "anything");
    expect(res.status).toBe(401);
    // This is the row that answers "is somebody trying?": no account, so no name, but the number stands.
    expect(rows(d.tenantId)[0]).toMatchObject({ outcome: "REFUSED", user_id: null, name: null, mobile: "919100000099" });
  });

  it("records the attempt that locks an account, and the attempts refused while it stays locked", async () => {
    const mobile = d.users.se2.mobile;
    for (let i = 0; i < 4; i++) expect((await signIn(mobile, "wrong")).status).toBe(401);
    expect(rows(d.tenantId).filter((r) => r.user_id === d.users.se2.id && r.outcome === "REFUSED")).toHaveLength(4);
    // The fifth is the one that locks it, and is recorded as such rather than as another refusal.
    expect((await signIn(mobile, "wrong")).status).toBe(401);
    expect(rows(d.tenantId)[0]).toMatchObject({ outcome: "LOCKED", user_id: d.users.se2.id });
    // And the right password, while it is locked, is still turned away — and still logged.
    expect((await signIn(mobile, PASSWORD)).status).toBe(401);
    expect(rows(d.tenantId)[0]).toMatchObject({ outcome: "LOCKED", user_id: d.users.se2.id });
  });

  it("gives the caller the same answer whether or not the number exists, so the log leaks nothing", async () => {
    const nobody = await signIn("9100000098", "anything");
    const wrong = await signIn(d.users.se3.mobile, "not-the-password");
    expect(nobody.status).toBe(wrong.status);
    expect(nobody.body).toEqual(wrong.body);
  });
});

describe("reading the log", () => {
  it("is for the people who can read the audit trail, and nobody else", async () => {
    for (const who of ["sm", "se1", "accounts", "gm"] as const) {
      expect((await w.api("GET", "/api/sign-ins", undefined, d.users[who].session)).status).toBe(403);
    }
    const ok = await w.api("GET", "/api/sign-ins", undefined, d.users.admin.session);
    expect(ok.status).toBe(200);
    expect(ok.body.keep_days).toBe(KEEP_DAYS);
    expect(ok.body.sign_ins.length).toBeGreaterThan(0);
  });

  it("needs a sign-in of its own", async () => {
    expect((await w.api("GET", "/api/sign-ins")).status).toBe(401);
  });

  it("shows one dealership nothing of another's", async () => {
    const other = await makeDealer(w, "signin-other");
    await w.api("POST", "/api/auth/login", { dealer: other.slug, mobile: other.users.sm.mobile, password: PASSWORD }, undefined, OFFICE);
    // Both dealerships hand out the same mobile numbers in the fixtures, so the row itself is the
    // only honest way to ask: this one belongs to the other dealership and must not appear here.
    const [theirRow] = rows(other.tenantId);
    expect(theirRow).toBeTruthy();
    const mine = (await w.api("GET", "/api/sign-ins", undefined, d.users.admin.session)).body.sign_ins;
    expect(mine.some((r: any) => r.id === theirRow.id)).toBe(false);
    expect(mine.every((r: any) => rows(d.tenantId).some((o) => o.id === r.id))).toBe(true);
    const theirs = (await w.api("GET", "/api/sign-ins", undefined, other.users.admin.session)).body.sign_ins;
    expect(theirs.some((r: any) => r.id === theirRow.id)).toBe(true);
    expect(theirs.length).toBeLessThan(mine.length);
  });

  it("narrows to refusals, which is what somebody checking after the fact is looking for", async () => {
    const res = await w.api("GET", "/api/sign-ins?outcome=REFUSED", undefined, d.users.admin.session);
    expect(res.status).toBe(200);
    expect(res.body.sign_ins.length).toBeGreaterThan(0);
    expect(res.body.sign_ins.every((r: any) => r.outcome === "REFUSED")).toBe(true);
  });
});

describe("how long it is kept", () => {
  it("drops rows past their keeping, and leaves the rest alone", async () => {
    const old = new Date(Date.parse("2026-10-13T10:00:00Z") - (KEEP_DAYS + 1) * 86_400_000).toISOString();
    w.db.raw.exec(`INSERT INTO sign_ins (id, tenant_id, mobile, outcome, client, at) VALUES ('sin_old', '${d.tenantId}', '919100000001', 'IN', 'BROWSER', '${old}')`);
    const before = rows(d.tenantId).length;
    expect(rows(d.tenantId).some((r) => r.id === "sin_old")).toBe(true);
    const { pruneSignIns } = await import("../src/domain/sign-ins");
    await pruneSignIns(w.env, new Date("2026-10-13T10:00:00Z"));
    expect(rows(d.tenantId).some((r) => r.id === "sin_old")).toBe(false);
    expect(rows(d.tenantId).length).toBe(before - 1);
  });
});
