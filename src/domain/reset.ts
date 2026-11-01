// Emptying a dealership's day-to-day record so it can start afresh, keeping what was set up.
//
// The line between the two is the question this file answers, so it is drawn once, here, and named:
// what a dealership DID is cleared, what a dealership IS stays. Bookings, cars, allocations, requests,
// payments, files, messages, alerts, tickets and the audit trail are the doing. The dealership itself,
// its outlets, its people, the vehicle master and the WhatsApp setup are the being, and a reset that
// took those would lock everybody out and leave somebody retyping the staff list.
//
// It is not offered to a dealership's own administrator. This erases everything their dealership has
// done, and that should not sit one mis-click away on a settings screen: the platform console does it,
// for them, with the dealership named out loud.

import type { Env } from "../env";
import { all, run } from "../lib/db";

/**
 * Two of these tables the product forbids itself to delete from: the audit trail and the stock movement
 * history are append-only, enforced by triggers, so that nothing running in the application can rewrite
 * what happened. A reset is not the application changing its mind — it is the vendor emptying a
 * dealership that asked to start again — but the guarantee is worth more than the convenience, so it is
 * suspended by name, for the length of one transaction, and put back exactly as it was. The triggers are
 * read from the database rather than written out here, so they cannot drift from the real ones.
 *
 * What is never suspended is platform_audit. The record that a dealership was emptied, by whom and of
 * how much, is kept where the dealership cannot reach it and this code does not touch it.
 */
const PROTECTED = ["audit_log", "vehicle_events"];

/**
 * In order: children before parents, so a foreign key never stands in the way. Each is counted before
 * it is emptied, and the counts are what the console reports and the record keeps.
 */
export const CLEARED = [
  "vehicle_events",
  "allocations",
  "exceptions",
  "retail_invoices",
  "recon_items",
  "recon_runs",
  "wa_messages",
  "wa_inbound",
  "alerts",
  "support_tickets",
  "order_requests",
  "stock_positions",
  "uploads",
  "password_otps",
  "sign_ins",
  "bookings",
  "vehicles",
  "audit_log",
] as const;

/** Kept, and listed so the answer can say so rather than leaving it to be inferred from silence. */
export const KEPT = ["tenants", "outlets", "users", "user_outlets", "user_segments", "vehicle_variants", "vehicle_colours", "vehicle_paints", "vehicle_aliases", "wa_config", "wa_templates"] as const;

export interface ResetResult {
  removed: Record<string, number>;
  total: number;
}

/**
 * Also clears the staff list, keeping the System Admins. Off unless asked for, because the same
 * dealership starting its year again wants its people; a different customer taking over the same
 * dealership does not, and would otherwise be handing out sign-ins to strangers.
 */
export interface ResetOptions {
  people?: boolean;
}

/** Counts every table first, then empties them. The counts are the only record of what was there. */
export async function resetTenant(env: Env, tenantId: string, opts: ResetOptions = {}): Promise<ResetResult> {
  const removed: Record<string, number> = {};
  for (const table of CLEARED) {
    const rows = await all<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ?`, tenantId);
    removed[table] = rows[0]?.n ?? 0;
  }
  const guards = await all<{ name: string; sql: string }>(
    env.DB,
    `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN (${PROTECTED.map(() => "?").join(",")}) AND sql IS NOT NULL`,
    ...PROTECTED,
  );
  try {
    for (const g of guards) await run(env.DB, `DROP TRIGGER IF EXISTS ${g.name}`);
    // One statement at a time rather than one batch: a dealership with a year behind it is more rows
    // than a single batch should carry, and each table empties independently of the next.
    for (const table of CLEARED) {
      if (removed[table]) await run(env.DB, `DELETE FROM ${table} WHERE tenant_id = ?`, tenantId);
    }
  } finally {
    // Put back whatever happened, including after a failure part way through: a dealership left with
    // its history writable would be a worse outcome than a reset that did not finish.
    for (const g of guards) await run(env.DB, g.sql).catch(() => undefined);
  }
  if (opts.people) {
    // After the rest: their bookings and requests are already gone, so nothing points at them but the
    // two lists of what they could reach. The administrators stay — somebody has to be able to sign in.
    const gone = await all<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND role <> 'ADMIN'`, tenantId);
    removed.users = gone[0]?.n ?? 0;
    if (removed.users) {
      await run(env.DB, `DELETE FROM user_outlets WHERE tenant_id = ? AND user_id IN (SELECT id FROM users WHERE tenant_id = ? AND role <> 'ADMIN')`, tenantId, tenantId);
      await run(env.DB, `DELETE FROM user_segments WHERE tenant_id = ? AND user_id IN (SELECT id FROM users WHERE tenant_id = ? AND role <> 'ADMIN')`, tenantId, tenantId);
      await run(env.DB, `DELETE FROM users WHERE tenant_id = ? AND role <> 'ADMIN'`, tenantId);
    }
  }
  return { removed, total: Object.values(removed).reduce((a, b) => a + b, 0) };
}
