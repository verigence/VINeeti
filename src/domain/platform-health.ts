// The System health page of the platform console: is the deployment up, is it fast, is the database
// well, did the scheduled job run, and is each dealership's data flowing. Read from the health tables the
// Worker keeps (src/lib/health.ts) and from a few counts taken when the page is opened. Nothing here
// reads a customer, a booking or a message; a dealership is a row of counts.

import type { Env, TenantRow } from "../env";
import { all, first } from "../lib/db";
import { bootAt, bootId } from "../lib/health";
import { parseSettings } from "../lib/settings";
import { iso, localParts, safeJson } from "../lib/util";

export interface Window {
  label: string;
  hours: number;
  requests: number;
  ok: number;
  client_errors: number;
  server_errors: number;
  /** Server errors as a share of requests, in percent. */
  error_pct: number | null;
  avg_ms: number | null;
  max_ms: number;
  fast_pct: number | null;
  slow: number;
  db_queries: number;
  db_avg_ms: number | null;
  db_max_ms: number;
  db_rows_read: number;
  db_rows_written: number;
}

export interface Alert {
  severity: "high" | "medium" | "low";
  text: string;
}

export interface PlatformHealth {
  now: string;
  worker: {
    version: string | null;
    deployed_at: string | null;
    version_first_seen_at: string | null;
    /** The isolate answering this request. */
    boot_id: string;
    booted_at: string;
    isolates_last_hour: number;
    cold_starts_24h: number;
    colos_24h: { colo: string; isolates: number; requests: number }[];
  };
  windows: Window[];
  /** The last 24 hours in 15-minute steps. */
  series: { at: string; requests: number; server_errors: number; client_errors: number; avg_ms: number | null; db_queries: number }[];
  groups: { group: string; requests: number; server_errors: number; client_errors: number; avg_ms: number | null; max_ms: number; slow: number; db_queries: number; db_rows_read: number; db_rows_written: number }[];
  cron: {
    expected_every_min: number;
    last_run_at: string | null;
    last_duration_ms: number | null;
    last_ok: boolean | null;
    minutes_since_last: number | null;
    runs_24h: number;
    failed_24h: number;
    missed_24h: number;
    avg_duration_ms: number | null;
    max_duration_ms: number;
    recent: { started_at: string; duration_ms: number; ok: boolean; tenants: number; errors: number; report: unknown }[];
  };
  errors: { hour: string; source: string; route: string | null; status: number | null; code: string | null; message: string; count: number; first_at: string; last_at: string }[];
  database: {
    size_bytes: number | null;
    size_at: string | null;
    migration: string | null;
    tables: { table: string; rows: number }[];
    rows_read_24h: number;
    rows_written_24h: number;
  };
  tenants: {
    slug: string;
    name: string;
    is_active: boolean;
    timezone: string;
    stock: { report_date: string | null; loaded_at: string | null; age_days: number | null };
    bookings: { report_date: string | null; loaded_at: string | null; age_days: number | null };
    expected_every_days: number;
    stale: boolean;
    uploads_running: number;
    uploads_7d: number;
    upload_error_rows_7d: number;
    last_recon_date: string | null;
    last_recon_finished: boolean | null;
    open_recon_items: number;
    whatsapp: { provider: string | null; enabled: boolean; queued: number; stuck: number; failed_24h: number; sent_24h: number };
    locked_users: number;
    open_alarms: number;
  }[];
  alerts: Alert[];
  basis: string;
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
const avg = (n: number, d: number) => (d > 0 ? Math.round(n / d) : null);
const num = (v: unknown) => Number(v ?? 0);

async function window(env: Env, now: Date, label: string, hours: number): Promise<Window> {
  const from = new Date(now.getTime() - hours * 3_600_000).toISOString().slice(0, 16);
  const r = await first<Record<string, number>>(
    env.DB,
    `SELECT COALESCE(SUM(requests),0) requests, COALESCE(SUM(ok),0) ok, COALESCE(SUM(client_errors),0) client_errors, COALESCE(SUM(server_errors),0) server_errors,
            COALESCE(SUM(ms_total),0) ms_total, COALESCE(MAX(ms_max),0) ms_max, COALESCE(SUM(fast),0) fast, COALESCE(SUM(slow),0) slow,
            COALESCE(SUM(db_queries),0) db_queries, COALESCE(SUM(db_ms_total),0) db_ms_total, COALESCE(MAX(db_ms_max),0) db_ms_max,
            COALESCE(SUM(db_rows_read),0) db_rows_read, COALESCE(SUM(db_rows_written),0) db_rows_written
       FROM health_minutes WHERE minute >= ? AND group_name <> 'cron'`,
    from,
  );
  const requests = num(r?.requests);
  return {
    label,
    hours,
    requests,
    ok: num(r?.ok),
    client_errors: num(r?.client_errors),
    server_errors: num(r?.server_errors),
    error_pct: pct(num(r?.server_errors), requests),
    avg_ms: avg(num(r?.ms_total), requests),
    max_ms: num(r?.ms_max),
    fast_pct: pct(num(r?.fast), requests),
    slow: num(r?.slow),
    db_queries: num(r?.db_queries),
    db_avg_ms: num(r?.db_queries) > 0 ? Math.round((num(r?.db_ms_total) / num(r?.db_queries)) * 10) / 10 : null,
    db_max_ms: num(r?.db_ms_max),
    db_rows_read: num(r?.db_rows_read),
    db_rows_written: num(r?.db_rows_written),
  };
}

const TABLES = ["tenants", "users", "outlets", "vehicles", "bookings", "allocations", "exceptions", "uploads", "recon_runs", "recon_items", "wa_messages", "alerts", "audit_log", "retail_invoices", "health_minutes", "health_errors", "health_cron_runs"];

export async function platformHealth(env: Env, now: Date): Promise<PlatformHealth> {
  const nowIso = iso(now);
  const ago = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
  const alerts: Alert[] = [];

  // ---------------------------------------------------------------- traffic
  const windows = [await window(env, now, "Last hour", 1), await window(env, now, "Last 24 hours", 24), await window(env, now, "Last 7 days", 168)];
  const series = (
    await all<Record<string, number | string>>(
      env.DB,
      `SELECT substr(minute, 1, 14) || printf('%02d', (CAST(substr(minute, 15, 2) AS INTEGER) / 15) * 15) AS at,
              SUM(requests) requests, SUM(server_errors) server_errors, SUM(client_errors) client_errors, SUM(ms_total) ms_total, SUM(db_queries) db_queries
         FROM health_minutes WHERE minute >= ? AND group_name <> 'cron' GROUP BY 1 ORDER BY 1`,
      ago(24).slice(0, 16),
    )
  ).map((r) => ({ at: `${r.at}:00.000Z`, requests: num(r.requests), server_errors: num(r.server_errors), client_errors: num(r.client_errors), avg_ms: avg(num(r.ms_total), num(r.requests)), db_queries: num(r.db_queries) }));
  const groups = (
    await all<Record<string, number | string>>(
      env.DB,
      `SELECT group_name, SUM(requests) requests, SUM(server_errors) server_errors, SUM(client_errors) client_errors, SUM(ms_total) ms_total, MAX(ms_max) max_ms, SUM(slow) slow,
              SUM(db_queries) db_queries, SUM(db_rows_read) db_rows_read, SUM(db_rows_written) db_rows_written
         FROM health_minutes WHERE minute >= ? GROUP BY group_name ORDER BY requests DESC`,
      ago(24).slice(0, 16),
    )
  ).map((r) => ({
    group: String(r.group_name),
    requests: num(r.requests),
    server_errors: num(r.server_errors),
    client_errors: num(r.client_errors),
    avg_ms: avg(num(r.ms_total), num(r.requests)),
    max_ms: num(r.max_ms),
    slow: num(r.slow),
    db_queries: num(r.db_queries),
    db_rows_read: num(r.db_rows_read),
    db_rows_written: num(r.db_rows_written),
  }));

  // ---------------------------------------------------------------- isolates
  const iso1h = await first<{ n: number }>(env.DB, `SELECT COUNT(*) n FROM health_isolates WHERE last_seen_at >= ?`, ago(1));
  const cold24 = await first<{ n: number }>(env.DB, `SELECT COUNT(*) n FROM health_isolates WHERE started_at >= ?`, ago(24));
  const colos = (await all<{ colo: string | null; isolates: number; requests: number }>(env.DB, `SELECT colo, COUNT(*) isolates, SUM(requests) requests FROM health_isolates WHERE last_seen_at >= ? GROUP BY colo ORDER BY requests DESC`, ago(24))).map((r) => ({ colo: r.colo ?? "unknown", isolates: num(r.isolates), requests: num(r.requests) }));
  const versionMeta = await first<{ value: string; at: string }>(env.DB, `SELECT value, at FROM health_meta WHERE key = 'version'`);

  // ---------------------------------------------------------------- the scheduled job
  const runs = await all<{ started_at: string; duration_ms: number; ok: number; tenants: number; errors: number; report_json: string }>(env.DB, `SELECT started_at, duration_ms, ok, tenants, errors, report_json FROM health_cron_runs WHERE started_at >= ? ORDER BY started_at DESC`, ago(24));
  const lastRun = runs[0] ?? (await first<{ started_at: string; duration_ms: number; ok: number; tenants: number; errors: number; report_json: string }>(env.DB, `SELECT started_at, duration_ms, ok, tenants, errors, report_json FROM health_cron_runs ORDER BY started_at DESC LIMIT 1`));
  const expectedEvery = 15;
  // A gap of more than one and a half intervals between consecutive firings is a missed firing (or more).
  let missed = 0;
  const points = [...runs.map((r) => Date.parse(r.started_at)).sort((a, b) => a - b), now.getTime()];
  for (let i = 1; i < points.length; i++) {
    const gapMin = (points[i] - points[i - 1]) / 60_000;
    if (gapMin > expectedEvery * 1.5) missed += Math.round(gapMin / expectedEvery) - 1;
  }
  const minutesSince = lastRun ? Math.round((now.getTime() - Date.parse(lastRun.started_at)) / 60_000) : null;
  const cron: PlatformHealth["cron"] = {
    expected_every_min: expectedEvery,
    last_run_at: lastRun?.started_at ?? null,
    last_duration_ms: lastRun ? num(lastRun.duration_ms) : null,
    last_ok: lastRun ? Boolean(lastRun.ok) : null,
    minutes_since_last: minutesSince,
    runs_24h: runs.length,
    failed_24h: runs.filter((r) => !r.ok).length,
    missed_24h: missed,
    avg_duration_ms: avg(runs.reduce((n, r) => n + num(r.duration_ms), 0), runs.length),
    max_duration_ms: runs.reduce((m, r) => Math.max(m, num(r.duration_ms)), 0),
    recent: runs.slice(0, 20).map((r) => ({ started_at: r.started_at, duration_ms: num(r.duration_ms), ok: Boolean(r.ok), tenants: num(r.tenants), errors: num(r.errors), report: safeJson(r.report_json, []) })),
  };

  // ---------------------------------------------------------------- errors
  const errors = (await all<PlatformHealth["errors"][number]>(env.DB, `SELECT hour, source, route, status, code, message, count, first_at, last_at FROM health_errors ORDER BY last_at DESC LIMIT 50`)).map((e) => ({ ...e, count: num(e.count) }));

  // ---------------------------------------------------------------- the database
  const sizeMeta = await first<{ value: string; at: string }>(env.DB, `SELECT value, at FROM health_meta WHERE key = 'db_size_bytes'`);
  let migration: string | null = null;
  try {
    migration = (await first<{ name: string }>(env.DB, `SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1`))?.name ?? null;
  } catch {
    migration = null; // not a D1 database (tests), or the table is not there yet
  }
  const tables: { table: string; rows: number }[] = [];
  const counts = await first<Record<string, number>>(env.DB, `SELECT ${TABLES.map((t) => `(SELECT COUNT(*) FROM ${t}) AS ${t}`).join(", ")}`);
  for (const t of TABLES) tables.push({ table: t, rows: num(counts?.[t]) });
  const day = windows[1];

  // ---------------------------------------------------------------- each dealership, as counts
  const tenantRows = await all<TenantRow>(env.DB, `SELECT * FROM tenants ORDER BY name`);
  const tenants: PlatformHealth["tenants"] = [];
  for (const t of tenantRows) {
    const settings = parseSettings(t.settings_json);
    const today = localParts(now, t.timezone).date;
    const latest = await all<{ kind: string; report_date: string | null; at: string }>(
      env.DB,
      `SELECT u.kind, u.report_date, u.at FROM uploads u WHERE u.tenant_id = ?1 AND u.status = 'DONE' AND u.kind IN ('STOCK','BOOKINGS') AND u.id IN (
         SELECT id FROM uploads x WHERE x.tenant_id = ?1 AND x.status = 'DONE' AND x.kind = u.kind ORDER BY COALESCE(x.report_date, substr(x.at, 1, 10)) DESC, x.at DESC LIMIT 1)`,
      t.id,
    );
    const file = (kind: string) => {
      const r = latest.find((x) => x.kind === kind);
      if (!r) return { report_date: null, loaded_at: null, age_days: null };
      const date = r.report_date ?? localParts(new Date(r.at), t.timezone).date;
      return { report_date: date, loaded_at: r.at, age_days: Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000)) };
    };
    const stock = file("STOCK"), bookings = file("BOOKINGS");
    const limit = settings.data_stale_days;
    const stale = Boolean(latest.length) && ((stock.age_days ?? Infinity) > limit || (bookings.age_days ?? Infinity) > limit);
    const up = await first<{ running: number; n7: number; err7: number }>(
      env.DB,
      `SELECT SUM(CASE WHEN status = 'RUNNING' AND at < ? THEN 1 ELSE 0 END) running, SUM(CASE WHEN at >= ? THEN 1 ELSE 0 END) n7, COALESCE(SUM(CASE WHEN at >= ? THEN error_count ELSE 0 END), 0) err7
         FROM uploads WHERE tenant_id = ?`,
      ago(0.5), ago(168), ago(168), t.id,
    );
    const recon = await first<{ business_date: string; finished_at: string | null }>(env.DB, `SELECT business_date, finished_at FROM recon_runs WHERE tenant_id = ? ORDER BY business_date DESC, started_at DESC LIMIT 1`, t.id);
    const openItems = await first<{ n: number }>(env.DB, `SELECT COUNT(*) n FROM recon_items WHERE tenant_id = ? AND status = 'OPEN'`, t.id);
    const wa = await first<{ provider: string; enabled: number }>(env.DB, `SELECT provider, enabled FROM wa_config WHERE tenant_id = ?`, t.id);
    const waq = await first<{ queued: number; stuck: number; failed_24h: number; sent_24h: number }>(
      env.DB,
      `SELECT SUM(CASE WHEN status = 'QUEUED' THEN 1 ELSE 0 END) queued,
              SUM(CASE WHEN status = 'QUEUED' AND COALESCE(next_attempt_at, created_at) < ? THEN 1 ELSE 0 END) stuck,
              SUM(CASE WHEN status = 'FAILED' AND created_at >= ? THEN 1 ELSE 0 END) failed_24h,
              SUM(CASE WHEN status IN ('SENT','DELIVERED','READ') AND created_at >= ? THEN 1 ELSE 0 END) sent_24h
         FROM wa_messages WHERE tenant_id = ? AND (status = 'QUEUED' OR created_at >= ?)`,
      ago(1), ago(24), ago(24), t.id, ago(24),
    );
    const locked = await first<{ n: number }>(env.DB, `SELECT COUNT(*) n FROM users WHERE tenant_id = ? AND is_active = 1 AND locked_until IS NOT NULL AND locked_until > ?`, t.id, nowIso);
    const alarms = await first<{ n: number }>(env.DB, `SELECT COUNT(*) n FROM alerts WHERE tenant_id = ? AND is_alarm = 1 AND read_at IS NULL`, t.id);
    const row: PlatformHealth["tenants"][number] = {
      slug: t.slug,
      name: t.name,
      is_active: Boolean(t.is_active),
      timezone: t.timezone,
      stock,
      bookings,
      expected_every_days: limit,
      stale,
      uploads_running: num(up?.running),
      uploads_7d: num(up?.n7),
      upload_error_rows_7d: num(up?.err7),
      last_recon_date: recon?.business_date ?? null,
      last_recon_finished: recon ? Boolean(recon.finished_at) : null,
      open_recon_items: num(openItems?.n),
      whatsapp: { provider: wa?.provider ?? null, enabled: Boolean(wa?.enabled ?? 0), queued: num(waq?.queued), stuck: num(waq?.stuck), failed_24h: num(waq?.failed_24h), sent_24h: num(waq?.sent_24h) },
      locked_users: num(locked?.n),
      open_alarms: num(alarms?.n),
    };
    tenants.push(row);
    if (!row.is_active) continue;
    if (row.stale) alerts.push({ severity: "medium", text: `${t.name}: DMS files are older than the agreed ${limit} day(s) (stock ${stock.age_days ?? "never"}, bookings ${bookings.age_days ?? "never"} days old).` });
    if (row.uploads_running) alerts.push({ severity: "high", text: `${t.name}: ${row.uploads_running} file load(s) still marked running after 30 minutes.` });
    if (row.whatsapp.stuck) alerts.push({ severity: "medium", text: `${t.name}: ${row.whatsapp.stuck} WhatsApp message(s) queued for over an hour and not sent.` });
    if (row.whatsapp.failed_24h >= 5) alerts.push({ severity: "medium", text: `${t.name}: ${row.whatsapp.failed_24h} WhatsApp message(s) failed in the last 24 hours.` });
    if (recon && !recon.finished_at) alerts.push({ severity: "medium", text: `${t.name}: the reconciliation for ${recon.business_date} started and did not finish.` });
  }

  // ---------------------------------------------------------------- the alerts that are about the deployment
  if (lastRun === null) alerts.push({ severity: "low", text: "The scheduled job has not been recorded yet since this version was deployed." });
  else if (minutesSince !== null && minutesSince > expectedEvery * 2) alerts.push({ severity: "high", text: `The scheduled job last ran ${minutesSince} minutes ago; it is due every ${expectedEvery}.` });
  if (lastRun && !lastRun.ok) alerts.push({ severity: "high", text: `The last scheduled run reported ${num(lastRun.errors)} failure(s).` });
  if (cron.missed_24h > 0) alerts.push({ severity: "medium", text: `${cron.missed_24h} scheduled firing(s) missed in the last 24 hours.` });
  const hour = windows[0];
  if (hour.requests >= 20 && (hour.error_pct ?? 0) >= 2) alerts.push({ severity: "high", text: `${hour.error_pct}% of requests in the last hour ended in a server error (${hour.server_errors} of ${hour.requests}).` });
  else if (day.requests >= 50 && (day.error_pct ?? 0) >= 1) alerts.push({ severity: "medium", text: `${day.error_pct}% of requests in the last 24 hours ended in a server error (${day.server_errors} of ${day.requests}).` });
  if (hour.requests >= 20 && (hour.avg_ms ?? 0) >= 1500) alerts.push({ severity: "medium", text: `Requests in the last hour took ${hour.avg_ms} ms on average.` });
  if (day.db_max_ms >= 1000) alerts.push({ severity: "low", text: `The slowest database query in the last 24 hours took ${day.db_max_ms} ms.` });
  if (sizeMeta && Number(sizeMeta.value) >= 8 * 1024 ** 3) alerts.push({ severity: "medium", text: "The database is over 8 GB; D1's limit is 10 GB." });
  const order = { high: 0, medium: 1, low: 2 };
  alerts.sort((a, b) => order[a.severity] - order[b.severity]);

  return {
    now: nowIso,
    worker: {
      version: env.APP_VERSION ?? null,
      deployed_at: env.APP_DEPLOYED_AT ?? null,
      version_first_seen_at: versionMeta && versionMeta.value === env.APP_VERSION ? versionMeta.at : null,
      boot_id: bootId(),
      booted_at: iso(bootAt(now)),
      isolates_last_hour: num(iso1h?.n),
      cold_starts_24h: num(cold24?.n),
      colos_24h: colos,
    },
    windows,
    series,
    groups,
    cron,
    errors,
    database: {
      size_bytes: sizeMeta ? Number(sizeMeta.value) : null,
      size_at: sizeMeta?.at ?? null,
      migration,
      tables,
      rows_read_24h: day.db_rows_read,
      rows_written_24h: day.db_rows_written,
    },
    tenants,
    alerts,
    basis:
      "Every isolate of the Worker counts its own requests and writes the totals once a minute, so the last minute of a busy isolate may be missing and figures are complete to the minute before. " +
      "Time to answer is wall time as the Worker sees it, which does not advance while the Worker is computing, so it is mostly time spent waiting on the database and on WhatsApp. " +
      "Database figures are what D1 reports with each result: rows read and written are what D1 bills, and the database size is as of the last query. " +
      "A cold start is an isolate serving its first request; Cloudflare starts and stops them as traffic moves between locations, so a count of them is not a count of failures. " +
      "CPU time and memory are not visible to the Worker itself and are read in the Cloudflare dashboard. " +
      "Server errors are those the Worker answered with a 5xx, grouped by their message within the hour.",
  };
}
