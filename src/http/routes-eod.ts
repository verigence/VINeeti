// End of day. The day closes in three steps: the booking sheet is read, the stock report is read, and
// the day-end reconciliation is run on the result. A person can do this on the End of day screen. It can
// also be left to a scheduled job on the dealership's side (see scripts/eod-push.mjs): the job sends the
// two files with the dealership's end-of-day key, and the reconciliation then runs, either when the job
// asks for it or by itself at the day-end time set in Settings.
//
// The key is a credential for exactly this: sending the two DMS files and asking for the reconciliation.
// It cannot read anything back except the result of what it sent, and only its hash is stored.

import type { Env, TenantRow } from "../env";
import { hex, timingSafeEqual } from "../lib/crypto";
import { all, audit, first, run } from "../lib/db";
import { HttpError, bad, iso, localDayBounds, localParts, parseDate, safeJson } from "../lib/util";
import { dataStatus } from "../domain/data-status";
import { importBookingSheet, importStockReport } from "../domain/dms-import";
import { runReconciliation } from "../domain/reconciliation";
import { dispatchQueued } from "../whatsapp/outbox";
import { buildCtx, clock, need, type App, type C } from "./app";

const sha256 = async (s: string) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));

/** The dealership an end-of-day request speaks for, proven by its key. */
async function feedTenant(c: C): Promise<TenantRow> {
  const header = c.req.header("Authorization") ?? "";
  const key = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const denied = new HttpError(401, "The dealer code or the end-of-day key is not correct", "UNAUTHENTICATED");
  const tenant = await first<TenantRow & { eod_key_hash: string | null }>(c.env.DB, `SELECT * FROM tenants WHERE slug = ? AND is_active = 1`, String(c.req.param("dealer") ?? "").toLowerCase());
  if (!tenant?.eod_key_hash || !key || !timingSafeEqual(await sha256(key), tenant.eod_key_hash)) throw denied;
  return tenant;
}

const MAX_BYTES = 12 * 1024 * 1024;

export function eodFeedRoutes(app: App) {
  // ------------------------------------------------------------ the feed (called by the dealership's scheduled job; no sign-in)
  app.post("/api/eod/:dealer/:kind{stock|bookings}", async (c) => {
    const tenant = await feedTenant(c);
    if (Number(c.req.header("Content-Length") ?? "0") > MAX_BYTES + 64 * 1024) throw bad("The file is larger than 12 MB");
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.length > MAX_BYTES) throw bad("The file is larger than 12 MB");
    const ctx = buildCtx(c.env, tenant, "EOD", clock.now());
    const q = c.req.query();
    const out =
      c.req.param("kind") === "stock"
        ? await importStockReport(ctx, bytes, { filename: q.filename, reportDate: q.report_date ? parseDate(q.report_date) : null, mode: "COMPLETE", outletScope: null, confirmMissing: q.confirm_missing === "1", continueUpload: q.continue ?? null })
        : await importBookingSheet(ctx, bytes, { filename: q.filename, outletScope: null, continueUpload: q.continue ?? null });
    if (ctx.flags.dispatch) c.executionCtx.waitUntil(dispatchQueued(c.env, c.env.DB, ctx.now, { tenantId: tenant.id, limit: 25 }).catch(() => undefined));
    // The job gets the outcome, not the dealership's data: counts, and the rows the file itself had wrong.
    return c.json({ upload_id: out.upload_id, kind: out.kind, report_date: out.report_date, more: out.more, row_count: out.row_count, created: out.created, updated: out.updated, unchanged: out.unchanged, allocations: out.allocations, error_count: out.errors.length, errors: out.errors.slice(0, 50), summary: out.summary });
  });

  /** Runs the day-end reconciliation now and answers with its totals. */
  app.post("/api/eod/:dealer/run", async (c) => {
    const tenant = await feedTenant(c);
    const ctx = buildCtx(c.env, tenant, "EOD", clock.now());
    const status = await dataStatus(ctx);
    const { run_id, summary } = await runReconciliation(ctx, "EOD");
    if (ctx.flags.dispatch) c.executionCtx.waitUntil(dispatchQueued(c.env, c.env.DB, ctx.now, { tenantId: tenant.id, limit: 25 }).catch(() => undefined));
    return c.json({ run_id, business_date: summary.business_date, files: { stock_as_on: status.stock?.report_date ?? null, bookings_as_on: status.bookings?.report_date ?? null, out_of_date: status.stale_files }, findings: summary.items, bookings: summary.bookings });
  });
}

export function eodRoutes(app: App) {
  // ------------------------------------------------------------ the End of day screen (signed-in users)
  app.get("/api/eod/status", async (c) => {
    need(c, "recon.view");
    const ctx = c.get("ctx");
    const today = localParts(ctx.now, ctx.tenant.timezone).date;
    const { start } = localDayBounds(today, ctx.tenant.timezone);
    const status = await dataStatus(ctx);
    const loads = await all<any>(ctx.db, `SELECT u.id, u.kind, u.filename, u.report_date, u.at, u.status, u.row_count, u.created_count, u.updated_count, u.error_count, u.uploaded_by, us.name AS uploaded_by_name FROM uploads u LEFT JOIN users us ON us.id = u.uploaded_by WHERE u.tenant_id = ? AND u.at >= ? ORDER BY u.at DESC LIMIT 20`, ctx.tenantId, start);
    const lastRun = await first<any>(ctx.db, `SELECT r.id, r.business_date, r.trigger, r.started_at, r.summary_json, (SELECT COUNT(*) FROM recon_items i WHERE i.run_id = r.id AND i.status = 'OPEN') AS open_items FROM recon_runs r WHERE r.tenant_id = ? ORDER BY r.started_at DESC LIMIT 1`, ctx.tenantId);
    const key = await first<{ eod_key_set_at: string | null }>(ctx.db, `SELECT eod_key_set_at FROM tenants WHERE id = ?`, ctx.tenantId);
    const loadedToday = (kind: string) => loads.find((l) => l.kind === kind && l.status === "DONE") ?? null;
    return c.json({
      business_date: today,
      day_end_time: ctx.settings.day_end_time,
      files: status,
      steps: [
        { key: "BOOKINGS", label: "Booking sheet read", done: Boolean(loadedToday("BOOKINGS")), load: loadedToday("BOOKINGS") },
        { key: "STOCK", label: "Stock report read", done: Boolean(loadedToday("STOCK")), load: loadedToday("STOCK") },
        { key: "RECONCILIATION", label: "Reconciliation run", done: Boolean(lastRun && lastRun.business_date === today && (!loads[0] || lastRun.started_at >= loads[0].at)), run: lastRun ? { id: lastRun.id, business_date: lastRun.business_date, started_at: lastRun.started_at, by: lastRun.trigger === "SCHEDULED" ? "Scheduled" : lastRun.trigger === "EOD" ? "End-of-day feed" : "A user", open_items: lastRun.open_items, items: safeJson<any>(lastRun.summary_json, {}).items ?? null } : null },
      ],
      loads_today: loads.map((l) => ({ ...l, uploaded_by_name: l.uploaded_by === "EOD" ? "End-of-day feed" : l.uploaded_by_name })),
      feed: { key_set_at: key?.eod_key_set_at ?? null, stock_url: `${new URL(c.req.url).origin}/api/eod/${ctx.tenant.slug}/stock`, bookings_url: `${new URL(c.req.url).origin}/api/eod/${ctx.tenant.slug}/bookings`, run_url: `${new URL(c.req.url).origin}/api/eod/${ctx.tenant.slug}/run` },
    });
  });

  /** Creates (or replaces) the end-of-day key. It is shown once, here, and never again. */
  app.post("/api/eod/key", async (c) => {
    need(c, "admin.users");
    const ctx = c.get("ctx");
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    const key = `vne_${hex(bytes)}`;
    await run(ctx.db, `UPDATE tenants SET eod_key_hash = ?, eod_key_set_at = ? WHERE id = ?`, await sha256(key), iso(ctx.now), ctx.tenantId);
    await audit(ctx, "EOD_KEY_CREATED", "tenant", ctx.tenantId, {});
    return c.json({ key, set_at: iso(ctx.now) }, 201);
  });

  app.delete("/api/eod/key", async (c) => {
    need(c, "admin.users");
    const ctx = c.get("ctx");
    await run(ctx.db, `UPDATE tenants SET eod_key_hash = NULL, eod_key_set_at = NULL WHERE id = ?`, ctx.tenantId);
    await audit(ctx, "EOD_KEY_REMOVED", "tenant", ctx.tenantId, {});
    return c.json({ ok: true });
  });
}

export type { Env };
