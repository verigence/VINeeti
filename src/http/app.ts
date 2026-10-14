import { Hono, type Context } from "hono";
import type { Ctx, Env, Role, SessionUser, TenantRow } from "../env";
import { verifySession } from "../lib/crypto";
import { all, first } from "../lib/db";
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
  const user: SessionUser = { id: u.id, name: u.name, mobile: u.mobile, role: u.role, allOutlets: Boolean(u.all_outlets), outletIds, mustChangePassword: Boolean(u.must_change_password) };
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
