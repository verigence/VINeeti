// The System health page of the platform console. Three things are being tested: that the Worker counts
// what it serves without writing a row per request, that the scheduled job's firing is recorded, and
// that the page is readable only by a platform administrator and never reaches into a dealership.
import { beforeEach, describe, expect, it } from "vitest";
import { runScheduledWithHealth } from "../src/index";
import { flush, pending, recordError, resetForTests } from "../src/lib/health";
import { makeMahindraDealer, makeWorld, PLATFORM, type World } from "./harness";

const q = <T = any>(w: World, sql: string, ...p: unknown[]) => w.db.q<T>(sql, ...p);
const SUPER = { mobile: "9800000001", name: "Platform Owner", password: "Platform@2026" };
const bootstrap = (w: World) => w.api("POST", "/api/platform/bootstrap", SUPER, undefined, { Authorization: PLATFORM.Authorization });
async function signIn(w: World) {
  const res = await w.api("POST", "/api/platform/login", { mobile: SUPER.mobile, password: SUPER.password });
  if (res.status !== 200) throw new Error(`platform sign-in failed: ${JSON.stringify(res.body)}`);
  return { cookie: (res.headers.get("Set-Cookie") ?? "").split(";")[0] };
}

beforeEach(() => resetForTests());

describe("counting what the Worker serves", () => {
  it("counts requests in memory and writes them in one batch, not one row each", async () => {
    const w = makeWorld("2026-10-13 10:00");
    await bootstrap(w);
    const s = await signIn(w);
    const d = await makeMahindraDealer(w);
    // Nothing has been written yet: the first minute's counts are still in memory.
    resetForTests(w.now());
    w.db.raw.exec(`DELETE FROM health_minutes`);
    w.db.raw.exec(`DELETE FROM health_isolates`);
    for (let i = 0; i < 5; i++) expect((await w.api("GET", "/api/auth/me", undefined, d.users.exec.session)).status).toBe(200);
    expect((await w.api("GET", "/api/no-such-thing", undefined, d.users.exec.session)).status).toBe(404);
    expect((await w.api("GET", "/api/bookings", undefined, s)).status).toBe(401);
    expect(q(w, `SELECT COUNT(*) n FROM health_minutes`)[0].n).toBe(0);
    expect(pending().minutes).toBeGreaterThan(0);
    // A minute later the next request writes the batch in the background.
    w.at("2026-10-13 10:02");
    expect((await w.api("GET", "/api/auth/me", undefined, d.users.exec.session)).status).toBe(200);
    const rows = q(w, `SELECT minute, group_name, requests, ok, client_errors, server_errors FROM health_minutes ORDER BY minute, group_name`);
    expect(rows.find((r) => r.group_name === "auth" && r.minute === "2026-10-13T04:30")).toMatchObject({ requests: 5, ok: 5, client_errors: 0, server_errors: 0 });
    expect(rows.find((r) => r.group_name === "ops")).toMatchObject({ requests: 1, client_errors: 1 });
    expect(rows.find((r) => r.group_name === "bookings")).toMatchObject({ requests: 1, client_errors: 1 });
    // Database work was attributed to the requests that did it.
    expect(rows.length).toBeGreaterThan(0);
    const auth = q(w, `SELECT db_queries FROM health_minutes WHERE group_name = 'auth' AND minute = '2026-10-13T04:30'`)[0];
    expect(auth.db_queries).toBeGreaterThan(0);
    // The isolate is known, with its start.
    expect(q(w, `SELECT COUNT(*) n FROM health_isolates`)[0].n).toBe(1);
  });

  it("merges a second write into the same minute instead of replacing it", async () => {
    const w = makeWorld("2026-10-13 11:00");
    await bootstrap(w);
    const d = await makeMahindraDealer(w);
    resetForTests(w.now());
    await w.api("GET", "/api/auth/me", undefined, d.users.exec.session);
    await flush(w.env, w.now(), true);
    await w.api("GET", "/api/auth/me", undefined, d.users.exec.session);
    await w.api("GET", "/api/auth/me", undefined, d.users.exec.session);
    await flush(w.env, w.now(), true);
    expect(q(w, `SELECT requests FROM health_minutes WHERE group_name = 'auth'`)).toEqual([{ requests: 3 }]);
  });

  it("records a server error once per hour with a count, never once per occurrence", async () => {
    const w = makeWorld("2026-10-13 12:00");
    for (let i = 0; i < 7; i++) recordError({ now: w.now(), source: "HTTP", route: "GET /api/x/:id", status: 500, code: "INTERNAL", message: "boom 12345" });
    recordError({ now: w.now(), source: "HTTP", route: "GET /api/x/:id", status: 500, code: "INTERNAL", message: "boom 99999" }); // same failure, other number
    recordError({ now: w.now(), source: "CRON", route: "scheduled", message: "boom" });
    await flush(w.env, w.now(), true);
    const rows = q(w, `SELECT source, route, status, count FROM health_errors ORDER BY source`);
    expect(rows).toEqual([
      { source: "CRON", route: "scheduled", status: null, count: 1 },
      { source: "HTTP", route: "GET /api/x/:id", status: 500, count: 8 },
    ]);
  });
});

describe("the scheduled job's firing", () => {
  it("is recorded with its duration and each dealership's report, and old rows are pruned in the night", async () => {
    const w = makeWorld("2026-10-13 10:00");
    await makeMahindraDealer(w);
    await runScheduledWithHealth(w.env, w.now());
    const run = q(w, `SELECT ok, tenants, errors, report_json FROM health_cron_runs`);
    expect(run).toHaveLength(1);
    expect(run[0]).toMatchObject({ ok: 1, tenants: 1, errors: 0 });
    expect(JSON.parse(run[0].report_json)[0].tenant).toBe("sample-mahindra");
    expect(q(w, `SELECT requests, ok FROM health_minutes WHERE group_name = 'cron'`)).toEqual([{ requests: 1, ok: 1 }]);
    // Rows past their keep are removed at the nightly firing (around 01:30 IST), and nothing else is.
    w.db.raw.exec(`INSERT INTO health_minutes (minute, group_name, requests) VALUES ('2026-09-01T00:00', 'auth', 1)`);
    w.db.raw.exec(`INSERT INTO health_cron_runs (id, started_at, finished_at, duration_ms) VALUES ('old', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:01.000Z', 1000)`);
    await runScheduledWithHealth(w.env, w.at("2026-10-14 01:30"));
    expect(q(w, `SELECT COUNT(*) n FROM health_minutes WHERE minute < '2026-10-01'`)[0].n).toBe(0);
    expect(q(w, `SELECT COUNT(*) n FROM health_cron_runs`)[0].n).toBe(2);
  });
});

describe("the System health page", () => {
  it("is read by a platform administrator, and by nobody at a dealership", async () => {
    const w = makeWorld("2026-10-13 10:00");
    await bootstrap(w);
    const s = await signIn(w);
    const d = await makeMahindraDealer(w);
    await runScheduledWithHealth(w.env, w.now());
    w.at("2026-10-13 10:05");
    for (const who of ["admin", "dp", "head"]) expect((await w.api("GET", "/api/platform/health", undefined, d.users[who].session)).status, who).toBe(401);
    expect((await w.api("GET", "/api/platform/health")).status).toBe(401);
    const res = await w.api("GET", "/api/platform/health", undefined, s);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const h = res.body;
    expect(h.windows.map((x: any) => x.label)).toEqual(["Last hour", "Last 24 hours", "Last 7 days"]);
    expect(h.cron).toMatchObject({ runs_24h: 1, failed_24h: 0, missed_24h: 0, last_ok: true, minutes_since_last: 5 });
    expect(h.tenants).toHaveLength(1);
    expect(h.tenants[0]).toMatchObject({ slug: d.slug, is_active: true, stale: false, uploads_running: 0, locked_users: 0 });
    expect(h.tenants[0].stock).toEqual({ report_date: null, loaded_at: null, age_days: null });
    expect(h.database.tables.find((t: any) => t.table === "users").rows).toBe(11);
    expect(h.worker.boot_id).toMatch(/^iso_/);
    expect(typeof h.basis).toBe("string");
    // Counts only: no name, mobile number or booking of the dealership is in the answer.
    const text = JSON.stringify(h);
    expect(text).not.toContain(d.users.exec.mobile);
    expect(text).not.toContain(d.users.admin.mobile);
  });

  it("raises the alerts that matter: a job that stopped, files that are late, messages that are stuck", async () => {
    const w = makeWorld("2026-10-13 10:00");
    await bootstrap(w);
    const s = await signIn(w);
    const d = await makeMahindraDealer(w);
    await runScheduledWithHealth(w.env, w.now());
    // The job has not fired for an hour; a dealership's stock report is five days old; a message is stuck.
    w.db.raw.exec(`INSERT INTO uploads (id, tenant_id, kind, report_date, uploaded_by, at, status) VALUES ('up1', '${d.tenantId}', 'STOCK', '2026-10-08', 'x', '2026-10-08T05:00:00.000Z', 'DONE')`);
    w.db.raw.exec(`INSERT INTO uploads (id, tenant_id, kind, uploaded_by, at, status) VALUES ('up2', '${d.tenantId}', 'BOOKINGS', 'x', '2026-10-13T03:00:00.000Z', 'RUNNING')`);
    w.db.raw.exec(
      `INSERT INTO wa_messages (id, tenant_id, event_key, audience, to_mobile, template_name, language, rendered_text, status, provider, created_at, next_attempt_at)
       VALUES ('m1', '${d.tenantId}', 'k', 'CUSTOMER', '919999999999', 't', 'en', 'hello', 'QUEUED', 'TEST', '2026-10-13T01:00:00.000Z', '2026-10-13T01:05:00.000Z')`,
    );
    w.at("2026-10-13 11:00");
    const h = (await w.api("GET", "/api/platform/health", undefined, s)).body;
    const texts = h.alerts.map((a: any) => a.text);
    expect(texts.some((t: string) => t.includes("scheduled job last ran 60 minutes ago"))).toBe(true);
    expect(texts.some((t: string) => t.includes("DMS files are older than the agreed"))).toBe(true);
    expect(texts.some((t: string) => t.includes("still marked running"))).toBe(true);
    expect(texts.some((t: string) => t.includes("queued for over an hour"))).toBe(true);
    expect(h.tenants[0]).toMatchObject({ stale: true, uploads_running: 1 });
    expect(h.tenants[0].stock.age_days).toBe(5);
    expect(h.tenants[0].whatsapp).toMatchObject({ queued: 1, stuck: 1 });
    // The customer's number is not in the answer.
    expect(JSON.stringify(h)).not.toContain("919999999999");
  });
});
