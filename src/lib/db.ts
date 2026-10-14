import type { Ctx } from "../env";
import { iso, newId } from "./util";

export async function all<T = Record<string, unknown>>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  const res = await db
    .prepare(sql)
    .bind(...params)
    .all<T>();
  return res.results ?? [];
}

export async function first<T = Record<string, unknown>>(db: D1Database, sql: string, ...params: unknown[]): Promise<T | null> {
  return (await db
    .prepare(sql)
    .bind(...params)
    .first<T>()) as T | null;
}

export async function run(db: D1Database, sql: string, ...params: unknown[]): Promise<number> {
  const res = await db
    .prepare(sql)
    .bind(...params)
    .run();
  return res.meta?.changes ?? 0;
}

export const stmt = (db: D1Database, sql: string, ...params: unknown[]) => db.prepare(sql).bind(...params);

export function isUniqueViolation(e: unknown): boolean {
  return /UNIQUE constraint failed/i.test(String((e as Error)?.message ?? e));
}

/**
 * A condition that must hold for a batch to go through. D1 has no interactive transactions: a batch is
 * the only atomic unit, and a statement that fails rolls the whole batch back. A guarded insert writes
 * NULL into a NOT NULL column when its condition is false, so the batch aborts and nothing is half done.
 */
export interface Guard {
  sql: string; // a SELECT used inside EXISTS (...)
  params: unknown[];
}

export function isGuardFailure(e: unknown): boolean {
  return /NOT NULL constraint failed: (audit_log|vehicle_events|allocations)\.(tenant_id|booking_id)/i.test(String((e as Error)?.message ?? e));
}

/** Splits a list into pieces of at most `n`. */
export function chunk<T>(rows: T[], n = 200): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += n) out.push(rows.slice(i, i + n));
  return out;
}

/**
 * A field of the current row of `json_each(?) AS j`. Bulk writes pass their rows as one JSON text and
 * let SQLite unpack it, so a 700-row file is a handful of statements instead of thousands.
 */
export const J = (field: string) => `json_extract(j.value, '$.${field}')`;

/** `?,?,?` for IN lists. */
export const marks = (n: number) => Array.from({ length: n }, () => "?").join(",");

export function auditStmt(ctx: Ctx, action: string, entityType: string, entityId: string, detail: unknown = {}, guard?: Guard) {
  return stmt(
    ctx.db,
    guard
      ? `INSERT INTO audit_log (id, tenant_id, actor, action, entity_type, entity_id, detail_json, at) SELECT ?, CASE WHEN EXISTS (${guard.sql}) THEN ? ELSE NULL END, ?,?,?,?,?,?`
      : `INSERT INTO audit_log (id, tenant_id, actor, action, entity_type, entity_id, detail_json, at) VALUES (?,?,?,?,?,?,?,?)`,
    newId("aud"),
    ...(guard?.params ?? []),
    ctx.tenantId,
    ctx.actor,
    action,
    entityType,
    entityId,
    JSON.stringify(detail ?? {}),
    iso(ctx.now),
  );
}

export async function audit(ctx: Ctx, action: string, entityType: string, entityId: string, detail: unknown = {}) {
  await auditStmt(ctx, action, entityType, entityId, detail).run();
}

/** A "waiting for your decision" alert is closed for everyone once the decision has been made. */
export function doneAlertStmt(ctx: Ctx, kind: string, entityId: string) {
  return stmt(ctx.db, `UPDATE alerts SET read_at = ? WHERE tenant_id = ? AND kind = ? AND entity_id = ? AND read_at IS NULL`, iso(ctx.now), ctx.tenantId, kind, entityId);
}

export function alertStmt(
  ctx: Ctx,
  a: { targetRole?: string | null; targetUser?: string | null; outletId?: string | null; kind: string; title: string; body: string; entityType?: string; entityId?: string; isAlarm?: boolean },
) {
  return stmt(
    ctx.db,
    `INSERT INTO alerts (id, tenant_id, is_alarm, target_role, target_user, outlet_id, kind, title, body, entity_type, entity_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    newId("alr"),
    ctx.tenantId,
    a.isAlarm ? 1 : 0,
    a.targetRole ?? null,
    a.targetUser ?? null,
    a.outletId ?? null,
    a.kind,
    a.title,
    a.body,
    a.entityType ?? null,
    a.entityId ?? null,
    iso(ctx.now),
  );
}
