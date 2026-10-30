// What the deployment itself is doing, counted cheaply.
//
// A Worker has no process to watch and no machine to read: an isolate appears when a request arrives at
// a location, serves requests for a while, and is gone. So this file counts what one isolate sees --
// requests by route group, how they ended, how long they took, and what each database call cost (D1
// returns that with every result) -- in memory, and writes the totals in one batch at most once a
// minute, after the response has gone out. Several isolates write the same minute; the statements add
// to the row rather than replace it. An isolate that is evicted loses at most its last minute, which is
// the price of not writing one row per request. Nothing here waits in front of a user.

import { AsyncLocalStorage } from "node:async_hooks";
import type { Env } from "../env";
import { iso, newId } from "./util";

const FLUSH_EVERY_MS = 60_000;
const SLOW_MS = 2_000;
const FAST_MS = 200;

/**
 * This isolate. A new value means a cold start somewhere. Workers forbid random values and the clock in
 * global scope, so both are taken on the first request rather than at load.
 */
const boot: { id: string | null; at: Date | null } = { id: null, at: null };
export function bootId(): string {
  return (boot.id ??= newId("iso"));
}
export function bootAt(now: Date): Date {
  return (boot.at ??= now);
}

interface Counters {
  requests: number;
  ok: number;
  client_errors: number;
  server_errors: number;
  ms_total: number;
  ms_max: number;
  fast: number;
  slow: number;
  db_queries: number;
  db_ms_total: number;
  db_ms_max: number;
  db_rows_read: number;
  db_rows_written: number;
}
const zero = (): Counters => ({ requests: 0, ok: 0, client_errors: 0, server_errors: 0, ms_total: 0, ms_max: 0, fast: 0, slow: 0, db_queries: 0, db_ms_total: 0, db_ms_max: 0, db_rows_read: 0, db_rows_written: 0 });

/** The database cost of whatever is running now: a request, or the scheduled job. */
export interface DbTally {
  queries: number;
  ms: number;
  ms_max: number;
  rows_read: number;
  rows_written: number;
}
const tally = (): DbTally => ({ queries: 0, ms: 0, ms_max: 0, rows_read: 0, rows_written: 0 });

interface ErrorRow {
  hour: string;
  fingerprint: string;
  source: "HTTP" | "CRON";
  route: string | null;
  status: number | null;
  code: string | null;
  message: string;
  count: number;
  first_at: string;
  last_at: string;
}

/** Everything this isolate has counted since its last flush. */
const state = {
  minutes: new Map<string, Counters>(), // `${minute}|${group}`
  errors: new Map<string, ErrorRow>(),
  requests: 0, // since boot
  colo: null as string | null,
  dbSize: null as number | null,
  // The first write comes a minute after the isolate's first request, not on that request.
  lastFlushAt: null as number | null,
  flushing: false,
};

const als = new AsyncLocalStorage<DbTally>();

const minuteOf = (d: Date) => d.toISOString().slice(0, 16);
const hourOf = (d: Date) => d.toISOString().slice(0, 13);

/** Which part of the system a path belongs to. The groups are the route files, plus the web app and the webhook. */
export function routeGroup(path: string): string {
  if (!path.startsWith("/api/")) return "assets";
  const seg = path.split("/")[2] ?? "";
  if (seg === "wa") return path.startsWith("/api/wa/webhook") ? "webhook" : "ops";
  if (["auth", "eod", "platform", "stock", "bookings", "master", "health"].includes(seg)) return seg === "health" ? "ops" : seg;
  return "ops";
}

/** A path with its ids taken out, so the same route fails as one line. */
export function routePattern(method: string, path: string): string {
  return `${method} ${path.replace(/\/[a-z]{2,4}_[A-Za-z0-9]{8,}/g, "/:id").replace(/\/\d{6,}/g, "/:n")}`.slice(0, 160);
}

/** A short stable hash (FNV-1a) for grouping errors. */
export function fingerprint(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

function bucket(minute: string, group: string): Counters {
  const key = `${minute}|${group}`;
  let c = state.minutes.get(key);
  if (!c) state.minutes.set(key, (c = zero()));
  return c;
}

function addDb(c: Counters, t: DbTally) {
  c.db_queries += t.queries;
  c.db_ms_total += Math.round(t.ms);
  c.db_ms_max = Math.max(c.db_ms_max, Math.round(t.ms_max));
  c.db_rows_read += t.rows_read;
  c.db_rows_written += t.rows_written;
}

/** Runs `fn` with its own database tally and returns both. */
export async function withTally<T>(fn: () => Promise<T>): Promise<{ result: T; db: DbTally }> {
  const db = tally();
  const result = await als.run(db, fn);
  return { result, db };
}

/** Called by the instrumented database binding with the meta of every result. */
function noteQuery(meta: { duration?: number; rows_read?: number; rows_written?: number; size_after?: number } | undefined) {
  if (!meta) return;
  if (typeof meta.size_after === "number" && meta.size_after > 0) state.dbSize = meta.size_after;
  const t = als.getStore();
  if (!t) return;
  t.queries++;
  const ms = Number(meta.duration ?? 0);
  t.ms += ms;
  t.ms_max = Math.max(t.ms_max, ms);
  t.rows_read += Number(meta.rows_read ?? 0);
  t.rows_written += Number(meta.rows_written ?? 0);
}

/**
 * The D1 binding, with every result's meta noted on the way back. The binding itself is untouched: the
 * wrapper calls through, so a method it does not know is still there.
 */
export function instrumentD1(db: D1Database): D1Database {
  const note = <R>(r: R): R => {
    const m = (r as { meta?: Record<string, unknown> } | null)?.meta;
    if (m) noteQuery(m as never);
    return r;
  };
  const realOf = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const wrapStatement = (s: D1PreparedStatement): D1PreparedStatement => {
    const w: D1PreparedStatement = Object.create(s);
    realOf.set(w, s);
    w.bind = (...v: unknown[]) => wrapStatement(s.bind(...v));
    w.all = (async <T>() => note(await s.all<T>())) as D1PreparedStatement["all"];
    w.run = (async <T>() => note(await s.run<T>())) as D1PreparedStatement["run"];
    w.raw = (async (...a: unknown[]) => {
      // raw() carries no meta either; it is still one query.
      const r = await (s.raw as (...x: unknown[]) => Promise<unknown>)(...a);
      const t = als.getStore();
      if (t) t.queries++;
      return r;
    }) as D1PreparedStatement["raw"];
    w.first = (async <T>(col?: string) => {
      // first() carries no meta; it is still one query.
      const t = als.getStore();
      if (t) t.queries++;
      return (col === undefined ? s.first<T>() : s.first<T>(col)) as Promise<T | null>;
    }) as D1PreparedStatement["first"];
    return w;
  };
  const w: D1Database = Object.create(db);
  w.prepare = (sql: string) => wrapStatement(db.prepare(sql));
  w.batch = (async <T>(stmts: D1PreparedStatement[]) => {
    // The statements may be wrapped; D1 gets its own back.
    const out = await db.batch<T>(stmts.map((s) => realOf.get(s) ?? s));
    for (const r of out) note(r);
    return out;
  }) as D1Database["batch"];
  return w;
}

const instrumented = new WeakMap<object, D1Database>();
/** The env's DB binding instrumented once; the same env object is shared by every request of an isolate. */
export function instrumentEnv(env: Env): void {
  const raw = env.DB as unknown as object;
  if (!raw || instrumented.has(raw)) return;
  const wrapped = instrumentD1(env.DB);
  instrumented.set(raw, wrapped);
  instrumented.set(wrapped, wrapped);
  env.DB = wrapped;
}

/** One finished request. */
export function recordRequest(a: { now: Date; path: string; status: number; ms: number; db: DbTally; colo?: string | null }) {
  bootAt(a.now);
  const c = bucket(minuteOf(a.now), routeGroup(a.path));
  c.requests++;
  state.requests++;
  if (a.status >= 500) c.server_errors++;
  else if (a.status >= 400) c.client_errors++;
  else c.ok++;
  const ms = Math.max(0, Math.round(a.ms));
  c.ms_total += ms;
  c.ms_max = Math.max(c.ms_max, ms);
  if (ms < FAST_MS) c.fast++;
  if (ms >= SLOW_MS) c.slow++;
  addDb(c, a.db);
  if (a.colo) state.colo = a.colo;
}

/** One firing of the scheduled job, as a minute row in the "cron" group. */
export function recordCron(now: Date, ms: number, ok: boolean, db: DbTally) {
  bootAt(now);
  const c = bucket(minuteOf(now), "cron");
  c.requests++;
  if (ok) c.ok++;
  else c.server_errors++;
  c.ms_total += Math.round(ms);
  c.ms_max = Math.max(c.ms_max, Math.round(ms));
  addDb(c, db);
}

export function recordError(a: { now: Date; source: "HTTP" | "CRON"; route?: string | null; status?: number | null; code?: string | null; message: string }) {
  const hour = hourOf(a.now);
  const message = String(a.message ?? "").slice(0, 300);
  const fp = fingerprint([a.source, a.status ?? "", a.code ?? "", a.route ?? "", message.replace(/\d+/g, "#")].join("|"));
  const key = `${hour}|${fp}`;
  const at = iso(a.now);
  const row = state.errors.get(key);
  if (row) {
    row.count++;
    row.last_at = at;
  } else state.errors.set(key, { hour, fingerprint: fp, source: a.source, route: a.route ?? null, status: a.status ?? null, code: a.code ?? null, message, count: 1, first_at: at, last_at: at });
}

/** True when it is time to write; the caller decides whether it can afford to wait on it. */
export function flushDue(now: Date): boolean {
  state.lastFlushAt ??= now.getTime();
  return now.getTime() - state.lastFlushAt >= FLUSH_EVERY_MS && (state.minutes.size > 0 || state.errors.size > 0);
}

/** Writes what has been counted since the last flush, in one batch. Safe to call at any time. */
export async function flush(env: Env, now: Date, force = false): Promise<boolean> {
  if (state.flushing) return false;
  if (!force && !flushDue(now)) return false;
  if (!state.minutes.size && !state.errors.size && !force) return false;
  state.flushing = true;
  const minutes = [...state.minutes.entries()].map(([k, c]) => ({ minute: k.split("|")[0], group_name: k.split("|")[1], ...c }));
  const errors = [...state.errors.values()];
  state.minutes = new Map();
  state.errors = new Map();
  state.lastFlushAt = now.getTime();
  try {
    const stmts: D1PreparedStatement[] = [];
    if (minutes.length) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO health_minutes (minute, group_name, requests, ok, client_errors, server_errors, ms_total, ms_max, fast, slow, db_queries, db_ms_total, db_ms_max, db_rows_read, db_rows_written)
           SELECT json_extract(j.value, '$.minute'), json_extract(j.value, '$.group_name'), json_extract(j.value, '$.requests'), json_extract(j.value, '$.ok'), json_extract(j.value, '$.client_errors'),
                  json_extract(j.value, '$.server_errors'), json_extract(j.value, '$.ms_total'), json_extract(j.value, '$.ms_max'), json_extract(j.value, '$.fast'), json_extract(j.value, '$.slow'),
                  json_extract(j.value, '$.db_queries'), json_extract(j.value, '$.db_ms_total'), json_extract(j.value, '$.db_ms_max'), json_extract(j.value, '$.db_rows_read'), json_extract(j.value, '$.db_rows_written')
           FROM json_each(?) AS j WHERE true
           ON CONFLICT (minute, group_name) DO UPDATE SET
             requests = requests + excluded.requests, ok = ok + excluded.ok, client_errors = client_errors + excluded.client_errors, server_errors = server_errors + excluded.server_errors,
             ms_total = ms_total + excluded.ms_total, ms_max = MAX(ms_max, excluded.ms_max), fast = fast + excluded.fast, slow = slow + excluded.slow,
             db_queries = db_queries + excluded.db_queries, db_ms_total = db_ms_total + excluded.db_ms_total, db_ms_max = MAX(db_ms_max, excluded.db_ms_max),
             db_rows_read = db_rows_read + excluded.db_rows_read, db_rows_written = db_rows_written + excluded.db_rows_written`,
        ).bind(JSON.stringify(minutes)),
      );
    }
    if (errors.length) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO health_errors (hour, fingerprint, source, route, status, code, message, count, first_at, last_at)
           SELECT json_extract(j.value, '$.hour'), json_extract(j.value, '$.fingerprint'), json_extract(j.value, '$.source'), json_extract(j.value, '$.route'), json_extract(j.value, '$.status'),
                  json_extract(j.value, '$.code'), json_extract(j.value, '$.message'), json_extract(j.value, '$.count'), json_extract(j.value, '$.first_at'), json_extract(j.value, '$.last_at')
           FROM json_each(?) AS j WHERE true
           ON CONFLICT (hour, fingerprint) DO UPDATE SET count = count + excluded.count, last_at = MAX(last_at, excluded.last_at), first_at = MIN(first_at, excluded.first_at)`,
        ).bind(JSON.stringify(errors)),
      );
    }
    stmts.push(
      env.DB.prepare(
        `INSERT INTO health_isolates (boot_id, started_at, last_seen_at, colo, version, requests) VALUES (?,?,?,?,?,?)
         ON CONFLICT (boot_id) DO UPDATE SET last_seen_at = excluded.last_seen_at, colo = COALESCE(excluded.colo, colo), requests = excluded.requests`,
      ).bind(bootId(), iso(bootAt(now)), iso(now), state.colo, env.APP_VERSION ?? null, state.requests),
    );
    if (state.dbSize !== null) {
      stmts.push(env.DB.prepare(`INSERT INTO health_meta (key, value, at) VALUES ('db_size_bytes', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, at = excluded.at`).bind(String(state.dbSize), iso(now)));
    }
    if (env.APP_VERSION) {
      stmts.push(env.DB.prepare(`INSERT INTO health_meta (key, value, at) VALUES ('version', ?, ?) ON CONFLICT (key) DO UPDATE SET at = CASE WHEN value = excluded.value THEN at ELSE excluded.at END, value = excluded.value`).bind(env.APP_VERSION, iso(now)));
    }
    // The flush itself is not counted: it runs outside any tally.
    await als.exit(() => env.DB.batch(stmts));
    return true;
  } catch (e) {
    // Counting must never break the thing being counted. What was lost is this isolate's last minute.
    console.error("health flush failed:", e);
    return false;
  } finally {
    state.flushing = false;
  }
}

/** For tests: what has been counted and not yet written. */
export function pending(): { minutes: number; errors: number } {
  return { minutes: state.minutes.size, errors: state.errors.size };
}

/** For tests: forget everything counted so far, as if the isolate had just started at `now`. */
export function resetForTests(now = new Date(0)) {
  state.minutes = new Map();
  state.errors = new Map();
  state.lastFlushAt = now.getTime();
  state.requests = 0;
  state.dbSize = null;
  state.colo = null;
  boot.id = null;
  boot.at = null;
}

/** Rows older than their keep are removed. Called by the scheduled job once a day. */
export function pruneStmts(env: Env, now: Date): D1PreparedStatement[] {
  const ago = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
  return [
    env.DB.prepare(`DELETE FROM health_minutes WHERE minute < ?`).bind(ago(7).slice(0, 16)),
    env.DB.prepare(`DELETE FROM health_isolates WHERE last_seen_at < ?`).bind(ago(7)),
    env.DB.prepare(`DELETE FROM health_cron_runs WHERE started_at < ?`).bind(ago(30)),
    env.DB.prepare(`DELETE FROM health_errors WHERE last_at < ?`).bind(ago(30)),
  ];
}
