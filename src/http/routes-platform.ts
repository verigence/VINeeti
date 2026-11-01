// The platform console: the few things the people who run the deployment do, as against the people who
// work at a dealership. A platform administrator ("super admin") can list the dealerships on this
// deployment, create one, switch one off, and give a dealership's administrator a new temporary
// password. That is all: no dealership's customers, bookings, stock or messages are reachable from here,
// and a platform session is not a sign-in to any dealership.
//
// The first account is created by the deployment itself (scripts/deploy.mjs, from the repository secrets
// SUPERADMIN_MOBILE and SUPERADMIN_PASSWORD) through POST /api/platform/bootstrap, which is proved by the
// deployment's own PLATFORM_ADMIN_TOKEN. Every act is written to platform_audit, which cannot be changed.

import type { Env } from "../env";
import { hashPassword, signSession, timingSafeEqual, verifyPassword, verifySession } from "../lib/crypto";
import { all, first, run, stmt } from "../lib/db";
import { ROLE_LABELS } from "../lib/permissions";
import { temporaryPassword } from "../domain/onboarding";
import { platformHealth } from "../domain/platform-health";
import { KEPT, resetTenant } from "../domain/reset";
import { bad, conflict, HttpError, iso, newId, normMobile, notFound } from "../lib/util";
import { clock, getCookie, jsonBody, type App, type C } from "./app";
import { createTenant } from "./routes-auth";

/** The platform session's own cookie, so it can never be mistaken for a dealership sign-in. */
const COOKIE = "platform_session";
const PLATFORM = "PLATFORM"; // stands where a tenant id stands in an ordinary session, and matches no tenant
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const SESSION_HOURS = 12;

export interface PlatformAdmin {
  id: string;
  name: string;
  mobile: string;
  password_hash: string;
  must_change_password: number;
  token_version: number;
  failed_logins: number;
  locked_until: string | null;
  is_active: number;
}

function cookie(req: Request, token: string | null): string {
  const url = new URL(req.url);
  const local = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
  const base = `${COOKIE}=${token ?? ""}; Path=/; HttpOnly; SameSite=Lax${local ? "" : "; Secure"}`;
  return token ? `${base}; Max-Age=${SESSION_HOURS * 3600}` : `${base}; Max-Age=0`;
}

function checkPassword(pw: unknown): string {
  const s = String(pw ?? "");
  if (s.length < 10) throw bad("A platform password must be at least 10 characters");
  if (!/[A-Za-z]/.test(s) || !/\d/.test(s)) throw bad("A platform password must contain a letter and a number");
  return s;
}

const auditStmt = (env: Env, actor: string, action: string, entity: string | null, detail: Record<string, unknown>, now: Date) =>
  stmt(env.DB, `INSERT INTO platform_audit (id, actor, action, entity, detail_json, at) VALUES (?,?,?,?,?,?)`, newId("pau"), actor, action, entity, JSON.stringify(detail), iso(now));

/** The deployment's own token, used only to create or replace the first platform administrator. */
function deployToken(c: C): void {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!c.env.PLATFORM_ADMIN_TOKEN || !token || !timingSafeEqual(token, c.env.PLATFORM_ADMIN_TOKEN)) throw new HttpError(401, "Not authorised", "UNAUTHENTICATED");
}

/** The platform administrator this request is signed in as. */
async function signedIn(c: C): Promise<PlatformAdmin> {
  const token = getCookie(c.req.raw, COOKIE);
  const claims = token ? await verifySession(token, c.env.SESSION_SECRET, clock.now()) : null;
  if (!claims || claims.tid !== PLATFORM) throw new HttpError(401, "Please sign in", "UNAUTHENTICATED");
  const admin = await first<PlatformAdmin>(c.env.DB, `SELECT * FROM platform_admins WHERE id = ? AND is_active = 1`, claims.uid);
  if (!admin || admin.token_version !== claims.tv) throw new HttpError(401, "Please sign in again", "UNAUTHENTICATED");
  return admin;
}
/** As above, and refuses everything until a first (or reset) password has been replaced. */
async function working(c: C): Promise<PlatformAdmin> {
  const admin = await signedIn(c);
  if (admin.must_change_password) throw new HttpError(403, "Set a new password before continuing", "PASSWORD_CHANGE_REQUIRED");
  return admin;
}

async function session(c: C, admin: { id: string; token_version: number }) {
  const now = clock.now();
  const token = await signSession({ tid: PLATFORM, uid: admin.id, tv: admin.token_version, exp: Math.floor(now.getTime() / 1000) + SESSION_HOURS * 3600 }, c.env.SESSION_SECRET);
  c.header("Set-Cookie", cookie(c.req.raw, token));
}

export function platformRoutes(app: App) {
  // ------------------------------------------------------------ created by the deployment
  /**
   * Creates the platform administrator, or sets the password of the one with this mobile number. The
   * deployment calls this on every run with the mobile number and password kept as repository secrets,
   * so the account exists from the first deployment and nobody has to be told a password out of band.
   */
  app.post("/api/platform/bootstrap", async (c) => {
    deployToken(c);
    const b = await jsonBody<{ mobile?: string; name?: string; password?: string }>(c);
    const mobile = normMobile(b.mobile);
    if (!mobile) throw bad("A valid mobile number is required");
    const password = checkPassword(b.password);
    const now = clock.now();
    const existing = await first<PlatformAdmin>(c.env.DB, `SELECT * FROM platform_admins WHERE mobile = ?`, mobile);
    const hash = await hashPassword(password);
    if (!existing) {
      const id = newId("pad");
      await c.env.DB.batch([
        stmt(c.env.DB, `INSERT INTO platform_admins (id, name, mobile, password_hash, must_change_password, created_at) VALUES (?,?,?,?,0,?)`, id, (b.name ?? "Super Admin").trim().slice(0, 120), mobile, hash, iso(now)),
        auditStmt(c.env, "DEPLOY", "PLATFORM_ADMIN_CREATED", id, { mobile }, now),
      ]);
      return c.json({ created: true, mobile }, 201);
    }
    // The password follows the secret, so changing the secret and deploying is how it is rotated.
    const same = await verifyPassword(password, existing.password_hash);
    if (!same) {
      await c.env.DB.batch([
        stmt(c.env.DB, `UPDATE platform_admins SET password_hash = ?, must_change_password = 0, token_version = token_version + 1, failed_logins = 0, locked_until = NULL, is_active = 1 WHERE id = ?`, hash, existing.id),
        auditStmt(c.env, "DEPLOY", "PLATFORM_ADMIN_PASSWORD_SET", existing.id, { mobile }, now),
      ]);
    }
    return c.json({ created: false, changed: !same, mobile });
  });

  // ------------------------------------------------------------ sign in and out
  app.post("/api/platform/login", async (c) => {
    const b = await jsonBody<{ mobile?: string; password?: string }>(c);
    const now = clock.now();
    const invalid = new HttpError(401, `Mobile number or password is not correct. After ${MAX_FAILED} wrong attempts the account is locked for ${LOCK_MINUTES} minutes.`, "INVALID_LOGIN");
    const mobile = normMobile(b.mobile);
    if (!mobile) throw invalid;
    const admin = await first<PlatformAdmin>(c.env.DB, `SELECT * FROM platform_admins WHERE mobile = ?`, mobile);
    if (!admin || !admin.is_active) throw invalid;
    if (admin.locked_until && admin.locked_until > iso(now)) throw invalid;
    if (!(await verifyPassword(String(b.password ?? ""), admin.password_hash))) {
      const fails = admin.failed_logins + 1;
      const lock = fails >= MAX_FAILED ? new Date(now.getTime() + LOCK_MINUTES * 60_000).toISOString() : null;
      await run(c.env.DB, `UPDATE platform_admins SET failed_logins = ?, locked_until = ? WHERE id = ?`, lock ? 0 : fails, lock, admin.id);
      throw invalid;
    }
    await run(c.env.DB, `UPDATE platform_admins SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?`, iso(now), admin.id);
    await session(c, admin);
    return c.json({ ok: true, must_change_password: Boolean(admin.must_change_password) });
  });

  app.post("/api/platform/logout", async (c) => {
    const token = getCookie(c.req.raw, COOKIE);
    const claims = token ? await verifySession(token, c.env.SESSION_SECRET, clock.now()) : null;
    if (claims?.tid === PLATFORM) await run(c.env.DB, `UPDATE platform_admins SET token_version = token_version + 1 WHERE id = ? AND token_version = ?`, claims.uid, claims.tv);
    c.header("Set-Cookie", cookie(c.req.raw, null));
    return c.json({ ok: true });
  });

  app.get("/api/platform/me", async (c) => {
    const admin = await signedIn(c);
    return c.json({ id: admin.id, name: admin.name, mobile: admin.mobile, must_change_password: Boolean(admin.must_change_password) });
  });

  app.post("/api/platform/change-password", async (c) => {
    const admin = await signedIn(c);
    const b = await jsonBody<{ current?: string; next?: string }>(c);
    if (!(await verifyPassword(String(b.current ?? ""), admin.password_hash))) throw bad("Current password is not correct");
    const next = checkPassword(b.next);
    if (next === b.current) throw bad("The new password must be different");
    const hash = await hashPassword(next);
    await c.env.DB.batch([
      stmt(c.env.DB, `UPDATE platform_admins SET password_hash = ?, must_change_password = 0, token_version = token_version + 1 WHERE id = ?`, hash, admin.id),
      auditStmt(c.env, admin.id, "PLATFORM_PASSWORD_CHANGED", admin.id, {}, clock.now()),
    ]);
    await session(c, { id: admin.id, token_version: admin.token_version + 1 });
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------ the dealerships on this deployment
  /** Each dealership with its size, never its data. */
  app.get("/api/platform/tenants", async (c) => {
    await working(c);
    const rows = await all<any>(
      c.env.DB,
      `SELECT t.id, t.slug, t.name, t.oem, t.timezone, t.is_active, t.created_at,
         (SELECT COUNT(*) FROM outlets o WHERE o.tenant_id = t.id) AS outlets,
         (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id AND u.is_active = 1) AS users,
         (SELECT COUNT(*) FROM vehicles v WHERE v.tenant_id = t.id AND v.status IN ('IN_TRANSIT','RECEIVED')) AS cars_in_stock,
         (SELECT COUNT(*) FROM bookings b WHERE b.tenant_id = t.id AND b.status IN ('APPROVED','ALLOCATED')) AS open_bookings,
         (SELECT MAX(u2.at) FROM uploads u2 WHERE u2.tenant_id = t.id AND u2.status = 'DONE') AS last_file_at
       FROM tenants t ORDER BY t.name`,
    );
    return c.json(rows.map((r) => ({ ...r, is_active: Boolean(r.is_active) })));
  });

  /** Creates a dealership. A signed-in platform administrator, or the deployment's own token. */
  app.post("/api/platform/tenants", async (c) => {
    let actor = "DEPLOY";
    try {
      actor = (await working(c)).id;
    } catch (e) {
      if (!(e instanceof HttpError) || e.status !== 401) throw e;
      deployToken(c);
    }
    const now = clock.now();
    const made = await createTenant(c.env, await jsonBody(c), now);
    await run(c.env.DB, `INSERT INTO platform_audit (id, actor, action, entity, detail_json, at) VALUES (?,?,?,?,?,?)`, newId("pau"), actor, "TENANT_CREATED", made.tenant_id, JSON.stringify({ slug: made.slug }), iso(now));
    return c.json(made, 201);
  });

  /** Switches a dealership off (nobody can sign in) or on again. Nothing is deleted. */
  app.patch("/api/platform/tenants/:slug", async (c) => {
    const admin = await working(c);
    const b = await jsonBody<{ is_active?: boolean }>(c);
    if (typeof b.is_active !== "boolean") throw bad("Say whether the dealership is to be active");
    const t = await first<{ id: string; slug: string; name: string }>(c.env.DB, `SELECT id, slug, name FROM tenants WHERE slug = ?`, String(c.req.param("slug")).toLowerCase());
    if (!t) throw notFound("Dealership");
    const now = clock.now();
    await c.env.DB.batch([
      stmt(c.env.DB, `UPDATE tenants SET is_active = ? WHERE id = ?`, b.is_active ? 1 : 0, t.id),
      // Switching a dealership off ends every session of its people at once.
      ...(b.is_active ? [] : [stmt(c.env.DB, `UPDATE users SET token_version = token_version + 1 WHERE tenant_id = ?`, t.id)]),
      auditStmt(c.env, admin.id, b.is_active ? "TENANT_ACTIVATED" : "TENANT_DEACTIVATED", t.id, { slug: t.slug }, now),
    ]);
    return c.json({ ok: true, slug: t.slug, is_active: b.is_active });
  });

  /**
   * Gives a dealership's administrator a new temporary password, for the case the dealership has locked
   * itself out. It is shown once, here. The platform administrator cannot sign in as that person: the
   * password must be replaced at their next sign-in, which that person does.
   */
  app.post("/api/platform/tenants/:slug/admin-password", async (c) => {
    const admin = await working(c);
    const t = await first<{ id: string; slug: string }>(c.env.DB, `SELECT id, slug FROM tenants WHERE slug = ?`, String(c.req.param("slug")).toLowerCase());
    if (!t) throw notFound("Dealership");
    const b = await jsonBody<{ user_id?: string }>(c).catch(() => ({}) as { user_id?: string });
    const target = b.user_id
      ? await first<{ id: string; name: string; mobile: string; role: string }>(c.env.DB, `SELECT id, name, mobile, role FROM users WHERE id = ? AND tenant_id = ? AND role = 'ADMIN' AND is_active = 1`, b.user_id, t.id)
      : await first<{ id: string; name: string; mobile: string; role: string }>(c.env.DB, `SELECT id, name, mobile, role FROM users WHERE tenant_id = ? AND role = 'ADMIN' AND is_active = 1 ORDER BY created_at LIMIT 1`, t.id);
    if (!target) throw conflict("This dealership has no active administrator; create one from the dealership's own Users screen.");
    const password = temporaryPassword();
    const now = clock.now();
    await c.env.DB.batch([
      stmt(c.env.DB, `UPDATE users SET password_hash = ?, must_change_password = 1, token_version = token_version + 1, failed_logins = 0, locked_until = NULL WHERE id = ?`, await hashPassword(password), target.id),
      // The dealership's own audit trail records it too, so the dealership can see that it happened.
      stmt(c.env.DB, `INSERT INTO audit_log (id, tenant_id, actor, action, entity_type, entity_id, detail_json, at) VALUES (?,?,?,?,?,?,?,?)`, newId("aud"), t.id, "PLATFORM", "PASSWORD_RESET_BY_PLATFORM", "user", target.id, JSON.stringify({ by: admin.mobile }), iso(now)),
      auditStmt(c.env, admin.id, "TENANT_ADMIN_PASSWORD_RESET", t.id, { slug: t.slug, user_id: target.id, mobile: target.mobile }, now),
    ]);
    c.header("Cache-Control", "private, no-store");
    return c.json({ dealer: t.slug, name: target.name, mobile: target.mobile, role_label: ROLE_LABELS.ADMIN, temporary_password: password });
  });

  /**
   * Empties a dealership's day-to-day record so it can start afresh: bookings, cars, allocations,
   * requests, payments, files, messages, alerts, tickets and the audit trail go; the dealership, its
   * outlets, its people, the vehicle master and the WhatsApp setup stay.
   *
   * There is no undo. The dealership's name has to be typed to confirm, because a slug is easy to
   * mistype into the wrong dealership and a name is not, and what was removed is counted and recorded
   * on both the platform's record and the dealership's own.
   */
  app.post("/api/platform/tenants/:slug/reset", async (c) => {
    const admin = await working(c);
    const t = await first<{ id: string; slug: string; name: string }>(c.env.DB, `SELECT id, slug, name FROM tenants WHERE slug = ?`, String(c.req.param("slug")).toLowerCase());
    if (!t) throw notFound("Dealership");
    const b = await jsonBody<{ confirm?: string }>(c).catch(() => ({}) as { confirm?: string });
    if (String(b.confirm ?? "").trim().toLowerCase() !== t.name.trim().toLowerCase()) {
      throw bad(`Type the dealership's name exactly — ${t.name} — to confirm. Nothing has been removed.`);
    }
    const now = clock.now();
    const result = await resetTenant(c.env, t.id);
    // Written after the wipe, because the dealership's own trail is one of the things emptied.
    await c.env.DB.batch([
      stmt(c.env.DB, `INSERT INTO audit_log (id, tenant_id, actor, action, entity_type, entity_id, detail_json, at) VALUES (?,?,?,?,?,?,?,?)`, newId("aud"), t.id, "PLATFORM", "DEALERSHIP_RESET", "tenant", t.id, JSON.stringify({ by: admin.mobile, removed: result.removed, total: result.total }), iso(now)),
      auditStmt(c.env, admin.id, "TENANT_RESET", t.id, { slug: t.slug, name: t.name, removed: result.removed, total: result.total }, now),
    ]);
    c.header("Cache-Control", "private, no-store");
    return c.json({ dealer: t.slug, name: t.name, ...result, kept: KEPT });
  });

  /**
   * System health: is the deployment up, fast, and running its job, and is each dealership's data
   * flowing. Counts only; no dealership's records are reachable through it.
   */
  app.get("/api/platform/health", async (c) => {
    await working(c);
    c.header("Cache-Control", "private, no-store");
    return c.json(await platformHealth(c.env, clock.now()));
  });

  // ------------------------------------------------------------ support tickets, across every dealership
  /** Every ticket raised on this deployment, newest first: the open ones are the work. */
  app.get("/api/platform/tickets", async (c) => {
    await working(c);
    const status = c.req.query("status");
    const where = status === "OPEN" || status === "CLOSED" ? `WHERE t.status = '${status}'` : "";
    const rows = await all<any>(
      c.env.DB,
      `SELECT t.id, t.tenant_id, n.name AS dealership, n.slug, t.raiser_name, t.raiser_role, t.raiser_email, t.subject, t.body, t.status,
              t.attachment_name, t.attachment_size, t.emailed, t.email_error, t.created_at, t.closed_at, t.closing_note
         FROM support_tickets t JOIN tenants n ON n.id = t.tenant_id ${where} ORDER BY t.created_at DESC LIMIT 300`,
    );
    const counts = await all<{ status: string; n: number }>(c.env.DB, `SELECT status, COUNT(*) AS n FROM support_tickets GROUP BY status`);
    c.header("Cache-Control", "private, no-store");
    return c.json({ tickets: rows, counts: Object.fromEntries(counts.map((r) => [r.status, r.n])) });
  });

  /** The file somebody attached, whichever dealership they raised it at. */
  app.get("/api/platform/tickets/:id/attachment", async (c) => {
    await working(c);
    const t = await first<{ attachment_key: string | null; attachment_name: string | null; attachment_type: string | null }>(
      c.env.DB,
      `SELECT attachment_key, attachment_name, attachment_type FROM support_tickets WHERE id = ?`,
      c.req.param("id"),
    );
    if (!t?.attachment_key) throw new HttpError(404, "Attachment not found", "NOT_FOUND");
    const file = await c.env.FILES?.get(t.attachment_key);
    if (!file) throw new HttpError(404, "Attachment not found", "NOT_FOUND");
    c.header("Content-Type", t.attachment_type || "application/octet-stream");
    c.header("Content-Disposition", `attachment; filename="${(t.attachment_name ?? "attachment").replace(/[^A-Za-z0-9._-]/g, "_")}"`);
    c.header("Cache-Control", "private, no-store");
    return c.body(file.body as ReadableStream);
  });

  /** Closes a ticket, or opens it again. A note can be left, and is shown to whoever raised it. */
  app.post("/api/platform/tickets/:id/status", async (c) => {
    const admin = await working(c);
    const b = await jsonBody<{ status?: string; note?: string }>(c);
    const status = b.status === "OPEN" ? "OPEN" : "CLOSED";
    const note = String(b.note ?? "").trim().slice(0, 2000) || null;
    const t = await first<{ id: string }>(c.env.DB, `SELECT id FROM support_tickets WHERE id = ?`, c.req.param("id"));
    if (!t) throw new HttpError(404, "Ticket not found", "NOT_FOUND");
    const at = iso(clock.now());
    await c.env.DB.batch([
      stmt(c.env.DB, `UPDATE support_tickets SET status = ?, closed_at = ?, closed_by = ?, closing_note = COALESCE(?, closing_note) WHERE id = ?`, status, status === "CLOSED" ? at : null, status === "CLOSED" ? admin.id : null, note, t.id),
      auditStmt(c.env, admin.id, status === "CLOSED" ? "TICKET_CLOSED" : "TICKET_REOPENED", t.id, { note }, clock.now()),
    ]);
    return c.json({ ok: true, status });
  });

  /** What has been done on this deployment, newest first. */
  app.get("/api/platform/audit", async (c) => {
    await working(c);
    const rows = await all<any>(c.env.DB, `SELECT a.id, a.actor, a.action, a.entity, a.detail_json, a.at, p.name AS actor_name, p.mobile AS actor_mobile FROM platform_audit a LEFT JOIN platform_admins p ON p.id = a.actor ORDER BY a.at DESC, a.rowid DESC LIMIT 200`);
    return c.json(rows.map((r) => ({ ...r, detail: JSON.parse(r.detail_json || "{}"), actor_name: r.actor === "DEPLOY" ? "The deployment" : r.actor_name })));
  });
}
