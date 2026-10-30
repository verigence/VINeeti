import { Hono, type Context } from "hono";
import type { Ctx, Env, Role, SessionUser, TenantRow } from "../env";
import { verifySession } from "../lib/crypto";
import { all, first, marks } from "../lib/db";
import { segmentLabel } from "../oem";
import { can, permissionsFor, type Permission } from "../lib/permissions";
import { parseSettings } from "../lib/settings";
import { forbidden, HttpError } from "../lib/util";
import { dispatchQueued } from "../whatsapp/outbox";

export type Vars = { ctx: Ctx; user: SessionUser };
export type App = Hono<{ Bindings: Env; Variables: Vars }>;
export type C = Context<{ Bindings: Env; Variables: Vars }>;

/** Tests replace this to control time. */
export const clock = { now: () => new Date() };

export function getCookie(req: Request, name: string): string | null {
  const header = req.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function sessionCookie(req: Request, token: string | null): string {
  const url = new URL(req.url);
  const local = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
  const base = `session=${token ?? ""}; Path=/; HttpOnly; SameSite=Lax${local ? "" : "; Secure"}`;
  return token ? `${base}; Max-Age=43200` : `${base}; Max-Age=0`;
}

export function buildCtx(env: Env, tenant: TenantRow, actor: string, now = clock.now()): Ctx {
  return { db: env.DB, env, tenant, tenantId: tenant.id, settings: parseSettings(tenant.settings_json), now, actor, cache: new Map(), flags: { dispatch: false } };
}

/** Resolves the signed-in user and binds the request to that user's tenant. Every protected route runs this. */
export async function authenticate(c: C, next: () => Promise<void>) {
  const token = getCookie(c.req.raw, "session");
  const now = clock.now();
  const claims = token ? await verifySession(token, c.env.SESSION_SECRET, now) : null;
  if (!claims) throw new HttpError(401, "Please sign in", "UNAUTHENTICATED");
  const tenant = await first<TenantRow>(c.env.DB, `SELECT * FROM tenants WHERE id = ? AND is_active = 1`, claims.tid);
  const u = await first<{ id: string; name: string; mobile: string; role: Role; all_outlets: number; must_change_password: number; token_version: number }>(
    c.env.DB,
    `SELECT id, name, mobile, role, all_outlets, must_change_password, token_version FROM users WHERE id = ? AND tenant_id = ? AND is_active = 1`,
    claims.uid,
    claims.tid,
  );
  if (!tenant || !u || u.token_version !== claims.tv) throw new HttpError(401, "Please sign in again", "UNAUTHENTICATED");
  const outletIds = u.all_outlets ? [] : (await all<{ outlet_id: string }>(c.env.DB, `SELECT outlet_id FROM user_outlets WHERE user_id = ? AND tenant_id = ?`, u.id, tenant.id)).map((r) => r.outlet_id);
  const segments = (await all<{ segment: string }>(c.env.DB, `SELECT segment FROM user_segments WHERE user_id = ? AND tenant_id = ? ORDER BY segment`, u.id, tenant.id)).map((r) => r.segment);
  const user: SessionUser = { id: u.id, name: u.name, mobile: u.mobile, role: u.role, allOutlets: Boolean(u.all_outlets), outletIds, segments, mustChangePassword: Boolean(u.must_change_password) };
  c.set("user", user);
  const ctx = buildCtx(c.env, tenant, user.id, now);
  c.set("ctx", ctx);
  // A password set by an administrator is temporary: nothing else works until the user replaces it.
  if (user.mustChangePassword && !["/api/auth/me", "/api/auth/change-password"].includes(new URL(c.req.url).pathname)) {
    throw new HttpError(403, "Set a new password before continuing", "PASSWORD_CHANGE_REQUIRED");
  }
  await next();
  // Messages queued by this request are sent once, after the response, however many were queued.
  if (ctx.flags.dispatch) c.executionCtx.waitUntil(dispatchQueued(c.env, c.env.DB, now, { tenantId: tenant.id, limit: 25 }).catch(() => undefined));
}

export function need(c: C, p: Permission) {
  const user = c.get("user");
  if (!can(user, c.get("ctx").settings, p)) throw forbidden();
}

/** Outlets the user may see: null means every outlet of the tenant. */
export function outletScope(c: C): string[] | null {
  const user = c.get("user");
  return user.allOutlets ? null : user.outletIds;
}

export function needOutlet(c: C, outletId: string) {
  const user = c.get("user");
  if (!user.allOutlets && !user.outletIds.includes(outletId)) throw forbidden("This record belongs to an outlet you do not have access to");
}

/**
 * The models a person's segments cover: null for a person who works with every segment. A model whose
 * category the master does not know yet belongs to no segment, so a restricted person does not see it
 * until the administrator sets it on the Vehicle master screen.
 */
export async function segmentModels(ctx: Ctx, user: SessionUser): Promise<string[] | null> {
  if (!user.segments.length) return null;
  const key = `segment_models:${user.id}`;
  const cached = ctx.cache.get(key) as string[] | undefined;
  if (cached) return cached;
  const rows = await all<{ model: string }>(ctx.db, `SELECT DISTINCT model FROM vehicle_variants WHERE tenant_id = ? AND category IN (${marks(user.segments.length)})`, ctx.tenantId, ...user.segments);
  const models = rows.map((r) => r.model);
  ctx.cache.set(key, models);
  return models;
}

/** Models the signed-in person may see and act on: null means every model. */
export async function modelScope(c: C): Promise<string[] | null> {
  return segmentModels(c.get("ctx"), c.get("user"));
}

/** The model of the car a form names, by variant id or by model name, checked against the person's segments. */
export async function needSegmentOfCar(c: C, body: { variant_id?: unknown; model?: unknown }) {
  if (!c.get("user").segments.length) return;
  const ctx = c.get("ctx");
  let model = String(body.model ?? "").trim().toUpperCase().replace(/\s+/g, " ");
  if (body.variant_id) model = (await first<{ model: string }>(ctx.db, `SELECT model FROM vehicle_variants WHERE id = ? AND tenant_id = ?`, String(body.variant_id), ctx.tenantId))?.model ?? model;
  if (model) await needSegment(c, model);
}

/** Refuses a booking or a car of a model outside the person's segments. */
export async function needSegment(c: C, model: string) {
  const user = c.get("user");
  const ctx = c.get("ctx");
  if (!user.segments.length) return;
  const models = (await segmentModels(ctx, user)) ?? [];
  if (!models.includes(model)) {
    const known = await first<{ category: string }>(ctx.db, `SELECT category FROM vehicle_variants WHERE tenant_id = ? AND model = ? AND category <> '' LIMIT 1`, ctx.tenantId, model);
    if (!known) throw forbidden(`${model} has no segment on the Vehicle master yet. Ask the administrator to set its category; until then only people who work with every segment can act on it.`);
    throw forbidden(`${model} is ${segmentLabel(ctx.tenant.oem, known.category)}, which is outside the segments you work with`);
  }
}

export async function jsonBody<T = Record<string, any>>(c: C): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HttpError(400, "The request body is not valid JSON", "BAD_REQUEST");
  }
}

export function describeUser(c: C) {
  const user = c.get("user");
  const ctx = c.get("ctx");
  return { ...user, permissions: permissionsFor(user.role, ctx.settings) };
}
