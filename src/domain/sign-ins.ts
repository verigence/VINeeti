// Where people sign in from, and when.
//
// Written on every attempt, refused ones included: a log of successes answers "was that me?" while a
// dealership asking after the fact wants "is somebody trying?", and only the refusals answer that.
//
// The address is taken from CF-Connecting-IP, which Cloudflare sets from the connection itself and a
// browser cannot forge; X-Forwarded-For is not trusted here because anybody can send one. Whether the
// request came from the installed app is a hint, not proof: the app is a window onto the same site, so
// it says so with a header the site itself sets. Nothing is decided from it — it only labels the row.

import type { Env, Role } from "../env";
import { all, run } from "../lib/db";
import { iso, newId } from "../lib/util";

export type Outcome = "IN" | "REFUSED" | "LOCKED";

export interface Attempt {
  tenantId: string;
  userId?: string | null;
  mobile: string;
  name?: string | null;
  role?: Role | null;
  outcome: Outcome;
}

/** How long a row lives. Long enough to investigate something; not a permanent record of whereabouts. */
export const KEEP_DAYS = 180;

/** What the request itself says about where it came from. */
export function origin(req: Request): { ip: string | null; country: string | null; client: string; userAgent: string | null } {
  const cf = (req as { cf?: { country?: string } }).cf;
  const ua = req.headers.get("User-Agent");
  return {
    ip: req.headers.get("CF-Connecting-IP"),
    country: cf?.country ?? null,
    // The installed app says so for itself; everything else is a browser until it does.
    client: req.headers.get("X-VINeeti-Client")?.trim().toUpperCase() === "APP" ? "APP" : "BROWSER",
    userAgent: ua ? ua.slice(0, 300) : null,
  };
}

/** Records one attempt. Never throws: a log that can refuse a sign-in is worse than no log. */
export async function recordSignIn(env: Env, req: Request, a: Attempt, now: Date): Promise<void> {
  const o = origin(req);
  await run(
    env.DB,
    `INSERT INTO sign_ins (id, tenant_id, user_id, mobile, name, role, outcome, ip, country, client, user_agent, at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    newId("sin"), a.tenantId, a.userId ?? null, a.mobile, a.name ?? null, a.role ?? null, a.outcome, o.ip, o.country, o.client, o.userAgent, iso(now),
  ).catch(() => undefined);
}

export interface SignInRow {
  id: string;
  user_id: string | null;
  mobile: string;
  name: string | null;
  role: string | null;
  outcome: Outcome;
  ip: string | null;
  country: string | null;
  client: string;
  user_agent: string | null;
  at: string;
}

/** The dealership's own sign-ins, newest first. */
export async function signIns(env: Env, tenantId: string, opts: { outcome?: string; userId?: string; limit?: number } = {}): Promise<SignInRow[]> {
  const where = ["tenant_id = ?"];
  const p: unknown[] = [tenantId];
  if (opts.outcome === "IN" || opts.outcome === "REFUSED" || opts.outcome === "LOCKED") (where.push("outcome = ?"), p.push(opts.outcome));
  if (opts.userId) (where.push("user_id = ?"), p.push(opts.userId));
  return all<SignInRow>(
    env.DB,
    `SELECT id, user_id, mobile, name, role, outcome, ip, country, client, user_agent, at FROM sign_ins WHERE ${where.join(" AND ")} ORDER BY at DESC LIMIT ?`,
    ...p, Math.min(Math.max(Number(opts.limit) || 200, 1), 500),
  );
}

/** Drops rows past their keeping. Run by the nightly job. */
export async function pruneSignIns(env: Env, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - KEEP_DAYS * 86_400_000);
  await run(env.DB, `DELETE FROM sign_ins WHERE at < ?`, iso(cutoff)).catch(() => undefined);
}
