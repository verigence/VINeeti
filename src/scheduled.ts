// The scheduled job (every 15 minutes). For each dealership it advances the payment windows, lifts
// expired holds, repairs anything a cut-short request left half done, re-runs allocation for anything
// left unmatched, runs the day-end reconciliation when it is due, and finally sends queued WhatsApp
// messages. Every step is idempotent and each tenant is isolated: one dealership's failure never
// stops the others.
//
// One firing has a fixed allowance of database calls, shared by every dealership on the deployment. So
// the work per firing is budgeted, and the dealership that goes first rotates from one firing to the
// next. Whatever is not done now is done a few minutes later; nothing is skipped.

import type { Ctx, Env, TenantRow } from "./env";
import { all, first as firstRow } from "./lib/db";
import { localDayBounds, localParts } from "./lib/util";
import { alarmStmts } from "./domain/alarms";
import { allocateAll, releaseAllocation } from "./domain/allocation";
import { raiseOverdueVerifications } from "./domain/bookings";
import { dataStatus } from "./domain/data-status";
import { announceArrival } from "./domain/inventory";
import { dayEndDue, runReconciliation } from "./domain/reconciliation";
import { liftExpiredHolds, processPaymentWindows, withinBusinessHours } from "./domain/timers";
import { buildCtx } from "./http/app";
import { dispatchQueued } from "./whatsapp/outbox";

export interface ScheduledReport {
  tenant: string;
  reminders?: number;
  escalations?: number;
  released?: number;
  /** Cars due for release that stayed with their customer: a payment is waiting for Finance, or the DMS files are out of date. */
  held?: number;
  alarms?: number;
  holds_lifted?: number;
  repaired?: number;
  allocated?: number;
  reconciliation?: string;
  error?: string;
}

const STEPS_PER_FIRING = 200; // reminders, escalations, releases and allocations across all dealerships
const RECONCILIATIONS_PER_FIRING = 3;

/**
 * Puts right the two states that a request interrupted between database calls, or two requests arriving
 * together, can leave behind: a car that arrived while its allocation was being written (arrival not
 * announced, payment clock not started), and a cancelled booking still holding a car.
 */
async function repair(ctx: Ctx, mayMessage: boolean): Promise<number> {
  let n = 0;
  // A reserved car that is in the yard with no payment window: its arrival was never announced. The customer is
  // told now and the window starts now. Like every customer message this waits for business hours.
  if (mayMessage) {
    const missed = await all<{ id: string }>(
      ctx.db,
      `SELECT a.id FROM allocations a JOIN vehicles v ON v.id = a.vehicle_id JOIN bookings b ON b.id = a.booking_id
       WHERE a.tenant_id = ? AND a.status = 'ACTIVE' AND a.clock_started_at IS NULL AND v.status = 'RECEIVED' AND b.status = 'ALLOCATED' LIMIT 20`,
      ctx.tenantId,
    );
    for (const m of missed) if (await announceArrival(ctx, m.id).catch(() => false)) n++;
  }
  const orphans = await all<{ id: string; booking_id: string; vehicle_id: string }>(
    ctx.db,
    `SELECT a.id, a.booking_id, a.vehicle_id FROM allocations a JOIN bookings b ON b.id = a.booking_id
     WHERE a.tenant_id = ? AND a.status = 'ACTIVE' AND b.status = 'CANCELLED' LIMIT 10`,
    ctx.tenantId,
  );
  for (const o of orphans) {
    await releaseAllocation(ctx, o, "BOOKING_CANCELLED").catch(() => undefined);
    n++;
  }
  return n;
}

/** Once a day, in business hours: if the DMS files are older than agreed, say so to the people who receive alarms. */
async function staleDataAlarm(ctx: Ctx): Promise<number> {
  const status = await dataStatus(ctx);
  if (!status.stale) return 0;
  const { start } = localDayBounds(localParts(ctx.now, ctx.tenant.timezone).date, ctx.tenant.timezone);
  if (await firstRow(ctx.db, `SELECT id FROM alerts WHERE tenant_id = ? AND kind = 'STALE_DATA' AND created_at >= ? LIMIT 1`, ctx.tenantId, start)) return 0;
  const part = (label: string, f: typeof status.stock) => (f ? `${label} is ${f.age_days} day(s) old (as on ${f.report_date})` : `${label} has not been loaded`);
  const body = `${[status.stale_files.includes("STOCK") ? part("The stock report", status.stock) : "", status.stale_files.includes("BOOKINGS") ? part("The booking sheet", status.bookings) : ""].filter(Boolean).join("; ")}. The files are expected every ${status.expected_every_days} day(s). Until they are loaded, stock and queue positions may be out of date and no car is re-allocated automatically.`;
  await ctx.db.batch(await alarmStmts(ctx, { kind: "STALE_DATA", title: "DMS files not updated", body }));
  return 1;
}

export async function runScheduled(env: Env, now: Date): Promise<ScheduledReport[]> {
  const tenants = await all<TenantRow>(env.DB, `SELECT * FROM tenants WHERE is_active = 1 ORDER BY id`);
  const reports: ScheduledReport[] = [];
  const budget = { left: STEPS_PER_FIRING };
  let reconBudget = RECONCILIATIONS_PER_FIRING;
  const first = tenants.length ? Math.floor(now.getTime() / 900_000) % tenants.length : 0;
  for (let i = 0; i < tenants.length; i++) {
    const tenant = tenants[(first + i) % tenants.length];
    const report: ScheduledReport = { tenant: tenant.slug };
    try {
      const ctx = buildCtx(env, tenant, "SYSTEM", now);
      if (withinBusinessHours(ctx)) {
        // Customer-facing steps only run in business hours, so nobody is messaged at night.
        const w = await processPaymentWindows(ctx, budget);
        Object.assign(report, { reminders: w.reminders, escalations: w.escalations, released: w.released, held: w.held });
        report.alarms = (await raiseOverdueVerifications(ctx)) + (await staleDataAlarm(ctx));
      }
      report.holds_lifted = await liftExpiredHolds(ctx);
      report.repaired = await repair(ctx, withinBusinessHours(ctx));
      const allocated = (await allocateAll(ctx, Math.min(25, budget.left))).length;
      budget.left -= allocated;
      report.allocated = allocated;
      if (reconBudget > 0 && (await dayEndDue(ctx))) {
        reconBudget--;
        report.reconciliation = (await runReconciliation(ctx, "SCHEDULED")).run_id;
      }
    } catch (e) {
      report.error = (e as Error).message;
      console.error(`scheduled job failed for ${tenant.slug}:`, e);
    }
    reports.push(report);
  }
  await dispatchQueued(env, env.DB, now, { limit: 100 });
  // Reports come back in a fixed order, whichever dealership went first this time.
  return reports.sort((a, b) => (a.tenant < b.tenant ? -1 : 1));
}
