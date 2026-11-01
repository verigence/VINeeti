import type { Env, Role, TenantRow } from "../env";
import { hashPassword, signSession, timingSafeEqual, verifyPassword, verifySession } from "../lib/crypto";
import { alertStmt, all, audit, auditStmt, first, run, stmt } from "../lib/db";
import { PERMISSION_LABELS, permissionsFor, ROLE_LABELS, ROLE_PURPOSE, roleMatrix, TENANT_WIDE_ROLES } from "../lib/permissions";
import { ALLOCATION_RULE_KEYS, CAR_CRITERIA, DEFAULT_SETTINGS, mergeSettings, parseSettings, QUEUE_CRITERIA, type TenantSettings } from "../lib/settings";
import { emailMark, emailPossible, employeeTemplate, importEmployees, otpAvailable, requestOtp, resetPassword, resetWithOtp, sendIntro, sendSignIn, sendSignInAfter, sendSignInOrAlert, temporaryPassword } from "../domain/onboarding";
import { testMail } from "../domain/mail-templates";
import { ATTACHMENT_LIMIT, checkAttachment, myTickets, notifySupport, raiseTicket, supportAddress, type Attachment } from "../domain/support";
import { MailError, mailer } from "../lib/mailer";
import { previewRules } from "../domain/preview";
import { recordSignIn, signIns, type Outcome } from "../domain/sign-ins";
import { oemAdapter } from "../oem";
import { XLSX_MIME } from "../lib/xlsx";
import { bad, conflict, forbidden, HttpError, iso, localParts, newId, norm, normMobile, notFound } from "../lib/util";
import { ensureWaDefaults } from "../whatsapp/outbox";
import { authenticate, buildCtx, clock, describeUser, getCookie, jsonBody, need, outletScope, sessionCookie, type App, type C } from "./app";

const ROLES = Object.keys(ROLE_LABELS) as Role[];
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

/** Hands work to the runtime to finish after the answer has gone back. */
function after(c: C, p: Promise<unknown>) {
  c.executionCtx.waitUntil(p.catch(() => undefined));
}

function checkPassword(pw: unknown): string {
  const s = String(pw ?? "");
  if (s.length < 8) throw bad("Password must be at least 8 characters");
  if (!/[A-Za-z]/.test(s) || !/\d/.test(s)) throw bad("Password must contain a letter and a number");
  return s;
}

/** Creates a dealership with its outlets, first administrator and WhatsApp defaults. */
export async function createTenant(
  env: Env,
  input: { slug: string; name: string; oem: string; timezone?: string; settings?: Record<string, unknown>; outlets?: { code: string; name: string; city?: string }[]; admin: { name: string; mobile: string; email?: string; password: string } },
  now: Date,
) {
  const slug = String(input.slug ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug)) throw bad("Dealer code must be 3-40 characters: lowercase letters, digits and hyphens");
  if (!input.name?.trim() || !input.oem?.trim()) throw bad("Dealership name and OEM are required");
  // Outlets may be left out: the first DMS file loaded creates them from its Dealer Location Codes.
  if (input.outlets !== undefined && !Array.isArray(input.outlets)) throw bad("Outlets must be a list");
  const mobile = normMobile(input.admin?.mobile);
  if (!mobile || !input.admin?.name?.trim()) throw bad("Administrator name and mobile number are required");
  // Required, because a password reset is sent by email and nothing else can let this person back in:
  // an administrator with no address is one locked out the first time they forget their password.
  const adminEmail = String(input.admin.email ?? "").trim();
  if (!adminEmail || !/^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(adminEmail)) throw bad("A valid email address is required for the administrator: a password reset is sent to it");
  const password = checkPassword(input.admin.password);
  if (await first(env.DB, `SELECT id FROM tenants WHERE slug = ?`, slug)) throw conflict(`Dealer code "${slug}" is already in use`);
  const settings = mergeSettings(DEFAULT_SETTINGS, input.settings ?? {});
  const at = iso(now);
  const tenantId = newId("ten");
  const userId = newId("usr");
  const codes = new Set<string>();
  const stmts = [
    stmt(env.DB, `INSERT INTO tenants (id, slug, name, oem, timezone, settings_json, created_at) VALUES (?,?,?,?,?,?,?)`, tenantId, slug, input.name.trim(), input.oem.trim(), input.timezone ?? "Asia/Kolkata", JSON.stringify(settings), at),
  ];
  for (const o of input.outlets ?? []) {
    const code = norm(o.code);
    if (!code || !o.name?.trim()) throw bad("Every outlet needs a code and a name");
    if (codes.has(code)) throw bad(`Outlet code ${code} is repeated`);
    codes.add(code);
    stmts.push(stmt(env.DB, `INSERT INTO outlets (id, tenant_id, code, name, city, created_at) VALUES (?,?,?,?,?,?)`, newId("out"), tenantId, code, o.name.trim(), o.city?.trim() ?? null, at));
  }
  stmts.push(
    stmt(env.DB, `INSERT INTO users (id, tenant_id, name, mobile, email, role, password_hash, must_change_password, all_outlets, created_at) VALUES (?,?,?,?,?,'ADMIN',?,1,1,?)`, userId, tenantId, input.admin.name.trim(), mobile, adminEmail, await hashPassword(password), at),
  );
  await env.DB.batch(stmts);
  await ensureWaDefaults(env.DB, tenantId, now);
  return { tenant_id: tenantId, slug, admin_user_id: userId };
}

/** The dealership this address belongs to, if the address is one of theirs. */
export async function tenantForHost(db: D1Database, host: string | null | undefined): Promise<TenantRow | null> {
  const name = String(host ?? "").trim().toLowerCase().split(":")[0];
  if (!name) return null;
  return first<TenantRow>(db, `SELECT * FROM tenants WHERE hostname = ? AND is_active = 1`, name);
}

/**
 * The dealership a sign-in is for. Its own address settles it outright: somebody at
 * adityamotors.mh.jbrconsulting.in is signing in to Aditya Motors and nowhere else, whatever is typed.
 * Failing that, the mobile number is the person's ID and the dealer code is needed only when the same
 * number is registered at more than one dealership on this deployment.
 */
async function tenantFor(db: D1Database, dealer: unknown, mobile: string | null, host?: string | null): Promise<TenantRow | null> {
  const byHost = await tenantForHost(db, host);
  if (byHost) {
    // A dealer code that names somebody else is a mistake worth refusing rather than quietly ignoring.
    const slug = String(dealer ?? "").trim().toLowerCase();
    return !slug || slug === byHost.slug ? byHost : null;
  }
  const slug = String(dealer ?? "").trim().toLowerCase();
  if (slug) return first<TenantRow>(db, `SELECT * FROM tenants WHERE slug = ? AND is_active = 1`, slug);
  if (!mobile) return null;
  const hits = await all<TenantRow>(db, `SELECT t.* FROM tenants t JOIN users u ON u.tenant_id = t.id WHERE u.mobile = ? AND u.is_active = 1 AND t.is_active = 1 LIMIT 2`, mobile);
  return hits.length === 1 ? hits[0] : null;
}

export function authRoutes(app: App) {
  // Creating a dealership lives in the platform console (routes-platform.ts).

  // ------------------------------------------------------------ sign in / out
  app.post("/api/auth/login", async (c) => {
    const body = await jsonBody<{ dealer?: string; mobile?: string; password?: string }>(c);
    const now = clock.now();
    // One answer for every failure, including a locked account, so the sign-in page cannot be used to find out which accounts exist.
    const invalid = new HttpError(401, `Dealer code, mobile number or password is not correct. After ${MAX_FAILED} wrong attempts an account is locked for ${LOCK_MINUTES} minutes.`, "INVALID_LOGIN");
    const mobile = normMobile(body.mobile);
    const tenant = await tenantFor(c.env.DB, body.dealer, mobile, new URL(c.req.url).hostname);
    if (!tenant || !mobile) throw invalid;
    const u = await first<{ id: string; name: string; role: Role; password_hash: string; token_version: number; failed_logins: number; locked_until: string | null; is_active: number }>(
      c.env.DB, `SELECT id, name, role, password_hash, token_version, failed_logins, locked_until, is_active FROM users WHERE tenant_id = ? AND mobile = ?`, tenant.id, mobile);
    // Every attempt is logged, refused ones included: a log of successes answers "was that me?", and
    // the question a dealership actually asks after something has gone wrong is "is somebody trying?".
    // The answer to the caller never varies, so the log says nothing the sign-in page does not.
    const log = (outcome: Outcome) =>
      after(c, recordSignIn(c.env, c.req.raw, { tenantId: tenant.id, userId: u?.id ?? null, mobile, name: u?.name ?? null, role: u?.role ?? null, outcome }, now));
    if (!u || !u.is_active) { log("REFUSED"); throw invalid; }
    if (u.locked_until && u.locked_until > iso(now)) { log("LOCKED"); throw invalid; }
    if (!(await verifyPassword(String(body.password ?? ""), u.password_hash))) {
      const fails = u.failed_logins + 1;
      const lock = fails >= MAX_FAILED ? new Date(now.getTime() + LOCK_MINUTES * 60_000).toISOString() : null;
      await run(c.env.DB, `UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?`, lock ? 0 : fails, lock, u.id);
      log(lock ? "LOCKED" : "REFUSED");
      throw invalid;
    }
    await run(c.env.DB, `UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?`, u.id);
    log("IN");
    const token = await signSession({ tid: tenant.id, uid: u.id, tv: u.token_version, exp: Math.floor(now.getTime() / 1000) + 43200 }, c.env.SESSION_SECRET);
    c.header("Set-Cookie", sessionCookie(c.req.raw, token));
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------ setting a password with a one-time code on WhatsApp
  /** Whether a dealership's people can set their own password with a WhatsApp code (its WhatsApp number is live). */
  app.get("/api/auth/options", async (c) => {
    const tenant = await tenantFor(c.env.DB, c.req.query("dealer"), normMobile(c.req.query("mobile")), new URL(c.req.url).hostname);
    return c.json({ otp: tenant ? await otpAvailable(c.env, c.env.DB, tenant.id) : false });
  });

  app.post("/api/auth/otp/request", async (c) => {
    const body = await jsonBody<{ dealer?: string; mobile?: string }>(c);
    const tenant = await tenantFor(c.env.DB, body.dealer, normMobile(body.mobile), new URL(c.req.url).hostname);
    // The same answer whether or not the number is registered.
    if (tenant) await requestOtp(c.env, tenant, body.mobile, clock.now());
    return c.json({ ok: true, message: "If this mobile number is registered, a 6-digit code has been sent to it on WhatsApp. It is valid for 10 minutes." });
  });

  app.post("/api/auth/otp/reset", async (c) => {
    const body = await jsonBody<{ dealer?: string; mobile?: string; code?: string; password?: string }>(c);
    const now = clock.now();
    const password = checkPassword(body.password);
    const tenant = await tenantFor(c.env.DB, body.dealer, normMobile(body.mobile));
    const u = tenant ? await resetWithOtp(c.env, tenant, body.mobile, body.code, await hashPassword(password), now) : null;
    if (!tenant || !u) throw new HttpError(400, "The code is not correct or has expired. Ask for a new code.", "INVALID_CODE");
    // Setting a password with the code signs the person in, so it is a way in and belongs in the log.
    after(c, recordSignIn(c.env, c.req.raw, { tenantId: tenant.id, userId: u.id, mobile: normMobile(body.mobile) ?? String(body.mobile ?? ""), name: u.name ?? null, role: u.role ?? null, outcome: "IN" }, now));
    const token = await signSession({ tid: tenant.id, uid: u.id, tv: u.token_version, exp: Math.floor(now.getTime() / 1000) + 43200 }, c.env.SESSION_SECRET);
    c.header("Set-Cookie", sessionCookie(c.req.raw, token));
    return c.json({ ok: true });
  });

  app.post("/api/auth/logout", async (c) => {
    // Signing out ends the session on the server as well, so a copied cookie stops working.
    const token = getCookie(c.req.raw, "session");
    const claims = token ? await verifySession(token, c.env.SESSION_SECRET, clock.now()) : null;
    if (claims) await run(c.env.DB, `UPDATE users SET token_version = token_version + 1 WHERE id = ? AND tenant_id = ? AND token_version = ?`, claims.uid, claims.tid, claims.tv);
    c.header("Set-Cookie", sessionCookie(c.req.raw, null));
    return c.json({ ok: true });
  });

  /**
   * What this address is, before anybody has signed in: the dealership it belongs to, if any. Only the
   * name and code, which whoever opens the address already knows — it is their own dealership's.
   */
  app.get("/api/site", async (c) => {
    const tenant = await tenantForHost(c.env.DB, new URL(c.req.url).hostname);
    c.header("Cache-Control", "private, no-store");
    return c.json({ app_name: c.env.APP_NAME ?? "VINeeti", dealership: tenant ? { name: tenant.name, slug: tenant.slug, oem: tenant.oem } : null });
  });

  app.use("/api/*", async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (path === "/api/site" || path === "/api/health" || path.startsWith("/api/wa/webhook") || path.startsWith("/api/platform/") || path.startsWith("/api/auth/login") || path.startsWith("/api/auth/logout") || path.startsWith("/api/auth/otp/") || path === "/api/auth/options") return next();
    if (/^\/api\/eod\/[^/]+\/(stock|bookings|retail|run)$/.test(path)) return next(); // answered by the end-of-day feed routes, registered before this guard
    return authenticate(c, next);
  });

  app.get("/api/auth/me", async (c) => {
    const ctx = c.get("ctx");
    const scope = outletScope(c);
    const outlets = await all<{ id: string; code: string; name: string; city: string | null; is_active: number }>(ctx.db, `SELECT id, code, name, city, is_active FROM outlets WHERE tenant_id = ? ORDER BY name`, ctx.tenantId);
    return c.json({
      user: describeUser(c),
      tenant: { id: ctx.tenant.id, slug: ctx.tenant.slug, name: ctx.tenant.name, oem: ctx.tenant.oem, timezone: ctx.tenant.timezone, dms_files: oemAdapter(ctx.tenant.oem) ? { oem: oemAdapter(ctx.tenant.oem)!.label, stock_file: oemAdapter(ctx.tenant.oem)!.stock_file, booking_file: oemAdapter(ctx.tenant.oem)!.booking_file } : null },
      settings: ctx.settings,
      outlets: scope ? outlets.filter((o) => scope.includes(o.id)) : outlets,
      all_outlets: outlets.map((o) => ({ id: o.id, code: o.code, name: o.name })),
      role_labels: ROLE_LABELS,
      // The manufacturer's vehicle segments, for the Users screen and for saying which a person works with.
      segments: oemAdapter(ctx.tenant.oem)?.segments ?? [],
      receives_alarms: ctx.settings.alarm_roles.includes(c.get("user").role),
      app_name: c.env.APP_NAME ?? "VINeeti",
    });
  });

  app.post("/api/auth/change-password", async (c) => {
    const ctx = c.get("ctx");
    const user = c.get("user");
    const body = await jsonBody<{ current?: string; next?: string }>(c);
    const row = await first<{ password_hash: string; token_version: number }>(ctx.db, `SELECT password_hash, token_version FROM users WHERE id = ? AND tenant_id = ?`, user.id, ctx.tenantId);
    if (!row || !(await verifyPassword(String(body.current ?? ""), row.password_hash))) throw bad("Current password is not correct");
    const next = checkPassword(body.next);
    if (next === body.current) throw bad("The new password must be different");
    await run(ctx.db, `UPDATE users SET password_hash = ?, must_change_password = 0, token_version = token_version + 1 WHERE id = ? AND tenant_id = ?`, await hashPassword(next), user.id, ctx.tenantId);
    await audit(ctx, "PASSWORD_CHANGED", "user", user.id);
    // The temporary one has just been replaced, which is the moment this person is properly in: the
    // introduction to the system goes now rather than with the password, because nobody reads an
    // explanation of something they cannot open yet. Only the first time, not on every later change.
    if (user.mustChangePassword) after(c, sendIntro(ctx, user.id));
    const token = await signSession({ tid: ctx.tenantId, uid: user.id, tv: row.token_version + 1, exp: Math.floor(ctx.now.getTime() / 1000) + 43200 }, c.env.SESSION_SECRET);
    c.header("Set-Cookie", sessionCookie(c.req.raw, token));
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------ outlets
  app.get("/api/outlets", async (c) => {
    const ctx = c.get("ctx");
    return c.json(await all(ctx.db, `SELECT id, code, name, city, address, is_active FROM outlets WHERE tenant_id = ? ORDER BY name`, ctx.tenantId));
  });
  app.post("/api/outlets", async (c) => {
    need(c, "admin.users");
    const ctx = c.get("ctx");
    const b = await jsonBody<{ code?: string; name?: string; city?: string; address?: string }>(c);
    const code = norm(b.code);
    if (!code || !b.name?.trim()) throw bad("Outlet code and name are required");
    if (await first(ctx.db, `SELECT id FROM outlets WHERE tenant_id = ? AND code = ?`, ctx.tenantId, code)) throw conflict(`Outlet code ${code} already exists`);
    const id = newId("out");
    await run(ctx.db, `INSERT INTO outlets (id, tenant_id, code, name, city, address, created_at) VALUES (?,?,?,?,?,?,?)`, id, ctx.tenantId, code, b.name.trim(), b.city?.trim() || null, b.address?.trim() || null, iso(ctx.now));
    await audit(ctx, "OUTLET_CREATED", "outlet", id, { code, name: b.name.trim() });
    return c.json({ id }, 201);
  });
  app.patch("/api/outlets/:id", async (c) => {
    need(c, "admin.users");
    const ctx = c.get("ctx");
    const b = await jsonBody<{ name?: string; city?: string; address?: string; is_active?: boolean }>(c);
    const o = await first<{ id: string; name: string; city: string | null; address: string | null; is_active: number }>(ctx.db, `SELECT * FROM outlets WHERE id = ? AND tenant_id = ?`, c.req.param("id"), ctx.tenantId);
    if (!o) throw notFound("Outlet");
    await run(
      ctx.db,
      `UPDATE outlets SET name = ?, city = ?, address = ?, is_active = ? WHERE id = ? AND tenant_id = ?`,
      b.name?.trim() || o.name,
      b.city === undefined ? o.city : b.city?.trim() || null,
      b.address === undefined ? o.address : b.address?.trim() || null,
      b.is_active === undefined ? o.is_active : b.is_active ? 1 : 0,
      o.id,
      ctx.tenantId,
    );
    await audit(ctx, "OUTLET_UPDATED", "outlet", o.id, b);
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------ users
  app.get("/api/users", async (c) => {
    need(c, "admin.users");
    const ctx = c.get("ctx");
    const users = await all<any>(ctx.db, `SELECT id, name, mobile, email, role, all_outlets, is_active, must_change_password, dms_code, left_on, created_at FROM users WHERE tenant_id = ? ORDER BY name`, ctx.tenantId);
    const links = await all<{ user_id: string; outlet_id: string }>(ctx.db, `SELECT user_id, outlet_id FROM user_outlets WHERE tenant_id = ?`, ctx.tenantId);
    const segs = await all<{ user_id: string; segment: string }>(ctx.db, `SELECT user_id, segment FROM user_segments WHERE tenant_id = ? ORDER BY segment`, ctx.tenantId);
    return c.json(users.map((u) => ({ ...u, outlet_ids: links.filter((l) => l.user_id === u.id).map((l) => l.outlet_id), segments: segs.filter((l) => l.user_id === u.id).map((l) => l.segment) })));
  });

  /** Names only, for pickers such as "sales executive" on a booking. */
  app.get("/api/users/directory", async (c) => {
    const ctx = c.get("ctx");
    return c.json(await all(ctx.db, `SELECT id, name, role FROM users WHERE tenant_id = ? AND is_active = 1 ORDER BY name`, ctx.tenantId));
  });

  async function setOutlets(ctx: ReturnType<typeof buildCtx>, userId: string, outletIds: string[]) {
    const valid = new Set((await all<{ id: string }>(ctx.db, `SELECT id FROM outlets WHERE tenant_id = ?`, ctx.tenantId)).map((o) => o.id));
    for (const id of outletIds) if (!valid.has(id)) throw bad("An outlet in the list does not exist");
    await ctx.db.batch([
      stmt(ctx.db, `DELETE FROM user_outlets WHERE user_id = ? AND tenant_id = ?`, userId, ctx.tenantId),
      ...outletIds.map((id) => stmt(ctx.db, `INSERT INTO user_outlets (user_id, outlet_id, tenant_id) VALUES (?,?,?)`, userId, id, ctx.tenantId)),
    ]);
  }

  /** The segments a person works with: the manufacturer's categories; an empty list means every segment. */
  async function setSegments(ctx: ReturnType<typeof buildCtx>, userId: string, segments: unknown): Promise<string[]> {
    const known = new Set((oemAdapter(ctx.tenant.oem)?.segments ?? []).map((s) => s.key));
    const list = [...new Set((Array.isArray(segments) ? segments : []).map((x) => String(x).trim().toUpperCase()).filter(Boolean))];
    for (const key of list) if (!known.has(key)) throw bad(`${key} is not a vehicle segment of this manufacturer`);
    await ctx.db.batch([
      stmt(ctx.db, `DELETE FROM user_segments WHERE user_id = ? AND tenant_id = ?`, userId, ctx.tenantId),
      ...list.map((key) => stmt(ctx.db, `INSERT INTO user_segments (tenant_id, user_id, segment) VALUES (?,?,?)`, ctx.tenantId, userId, key)),
      // Narrowing or widening what a person may act on takes effect at their next request; sessions are untouched.
    ]);
    return list;
  }

  /** The person's ID in the DMS (the booking sheet's SC Mile Id). One person per ID. */
  async function checkDmsCode(ctx: ReturnType<typeof buildCtx>, raw: unknown, userId: string | null): Promise<string | null> {
    const code = norm(raw);
    if (!code) return null;
    if (code.length > 40) throw bad("The DMS ID is too long");
    // A DMS ID belongs to the desk, not to the person sitting at it. Somebody still here holding it is
    // a clash and has to be sorted out by hand; somebody who has left is not, and their replacement
    // takes the ID and, with it, the bookings the manufacturer's system has under it.
    const other = await first<{ id: string; name: string; left_on: string | null; is_active: number }>(
      ctx.db, `SELECT id, name, left_on, is_active FROM users WHERE tenant_id = ? AND dms_code = ? AND id <> ?`, ctx.tenantId, code, userId ?? "");
    if (other && !other.left_on && other.is_active) throw conflict(`DMS ID ${code} is already given to ${other.name}`);
    if (other) await run(ctx.db, `UPDATE users SET dms_code = NULL WHERE id = ? AND tenant_id = ?`, other.id, ctx.tenantId);
    return code;
  }
  /** Bookings the DMS has under this person become theirs in the system, so they see them and are told about them. */
  async function linkBookingsTo(ctx: ReturnType<typeof buildCtx>, userId: string, dmsCode: string) {
    await run(ctx.db, `UPDATE bookings SET sales_exec_id = ? WHERE tenant_id = ? AND sc_code = ? AND (sales_exec_id IS NULL OR sales_exec_id <> ?)`, userId, ctx.tenantId, dmsCode, userId);
  }

  // ------------------------------------------------------------ the employee sheet
  /** The sheet to fill in (.xlsx): headings, and a row for every sales consultant the DMS names who is not a user yet. */
  app.get("/api/users/template", async (c) => {
    need(c, "admin.users");
    return new Response(await employeeTemplate(c.get("ctx")), { headers: { "Content-Type": XLSX_MIME, "Content-Disposition": `attachment; filename="employees.xlsx"`, "Cache-Control": "private, no-store" } });
  });

  /** Loads the employee list. New people come back with a temporary password each, shown this once. */
  app.post("/api/users/import", async (c) => {
    need(c, "admin.users");
    if (Number(c.req.header("Content-Length") ?? "0") > 6 * 1024 * 1024) throw bad("The file is larger than 5 MB");
    const type = c.req.header("Content-Type") ?? "";
    let bytes: Uint8Array, filename: string | undefined;
    if (type.includes("multipart/form-data")) {
      const form = await c.req.formData().catch(() => null);
      const file = form?.get("file") as unknown;
      if (!file || typeof file === "string") throw bad("Attach the Excel file in the field named file");
      bytes = new Uint8Array(await (file as File).arrayBuffer());
      filename = (file as File).name;
    } else {
      bytes = new Uint8Array(await c.req.arrayBuffer());
      filename = c.req.query("filename") ?? undefined;
    }
    c.header("Cache-Control", "private, no-store");
    return c.json(await importEmployees(c.get("ctx"), bytes, filename, c.get("user").id, (p) => after(c, p)));
  });

  /** A new temporary password for one person, shown this once. */
  app.post("/api/users/:id/reset-password", async (c) => {
    need(c, "admin.users");
    if (c.req.param("id") === c.get("user").id) throw bad("Change your own password from your profile");
    c.header("Cache-Control", "private, no-store");
    return c.json(await resetPassword(c.get("ctx"), c.req.param("id"), (p) => after(c, p)));
  });

  /** Roles and controls: what each persona may do under the dealership's current settings. */
  app.get("/api/roles", (c) => {
    const ctx = c.get("ctx");
    return c.json({ roles: roleMatrix(ctx.settings), permission_labels: PERMISSION_LABELS, booking_approver_roles: ctx.settings.booking_approver_roles, exception_approver_roles: ctx.settings.exception_approver_roles, alarm_roles: ctx.settings.alarm_roles });
  });

  app.post("/api/users", async (c) => {
    need(c, "admin.users");
    const ctx = c.get("ctx");
    const b = await jsonBody<{ name?: string; mobile?: string; email?: string; role?: Role; password?: string; all_outlets?: boolean; outlet_ids?: string[]; dms_code?: string; segments?: string[] }>(c);
    const mobile = normMobile(b.mobile);
    const dmsCode = await checkDmsCode(ctx, b.dms_code, null);
    if (!b.name?.trim() || !mobile) throw bad("Name and a valid mobile number are required");
    // The temporary password goes to the person by email, so an account cannot be made without one.
    const email = (b.email ?? "").trim();
    if (!email || !/^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(email)) throw bad("A valid email address is required: the temporary password is sent to it");
    if (!b.role || !ROLES.includes(b.role)) throw bad("Role is not valid");
    // Nobody chooses this. The system makes one, emails it to the person, and shows it to the
    // administrator only when it could not be sent: a password an administrator typed is a password
    // an administrator knows, and the point of sending it is that only the person ever reads it.
    const password = temporaryPassword();
    if (await first(ctx.db, `SELECT id FROM users WHERE tenant_id = ? AND mobile = ?`, ctx.tenantId, mobile)) throw conflict("A user with this mobile number already exists");
    const allOutlets = b.all_outlets ?? TENANT_WIDE_ROLES.includes(b.role);
    if (!allOutlets && !(b.outlet_ids ?? []).length) throw bad("Choose at least one outlet for this user");
    const id = newId("usr");
    await run(ctx.db, `INSERT INTO users (id, tenant_id, name, mobile, email, role, password_hash, must_change_password, all_outlets, dms_code, created_at) VALUES (?,?,?,?,?,?,?,1,?,?,?)`, id, ctx.tenantId, b.name.trim(), mobile, b.email?.trim() || null, b.role, await hashPassword(password), allOutlets ? 1 : 0, dmsCode, iso(ctx.now));
    if (!allOutlets) await setOutlets(ctx, id, b.outlet_ids ?? []);
    const segments = b.segments?.length ? await setSegments(ctx, id, b.segments) : [];
    if (dmsCode) await linkBookingsTo(ctx, id, dmsCode);
    await audit(ctx, "USER_CREATED", "user", id, { name: b.name.trim(), role: b.role, all_outlets: allOutlets, outlet_ids: b.outlet_ids ?? [], segments });
    c.header("Cache-Control", "private, no-store");
    const told = { name: b.name.trim(), roleLabel: ROLE_LABELS[b.role], mobile, password };
    // With a mail account the message follows the answer, so the screen comes back at once; a failure
    // becomes an alert for whoever made the account. With no mail account there is nothing to wait for
    // and the password is shown once, exactly as it was before email existed.
    if (emailPossible(ctx.env)) {
      sendSignInAfter(ctx, (p) => after(c, p), "WELCOME", email, told, id);
      return c.json({ id, email, emailing: true }, 201);
    }
    const sent = await sendSignInOrAlert(ctx, "WELCOME", email, told, id);
    return c.json({ id, email, temporary_password: password, ...sent }, 201);
  });

  /**
   * Removes a person who should not have been added. Only one who has done nothing: the moment
   * somebody has a booking, a request, a file or an entry against their name, deleting them would
   * leave the dealership's own record unreadable, so they are switched off instead and the trail
   * stays whole. A mistake made five minutes ago can simply go.
   */
  app.delete("/api/users/:id", async (c) => {
    need(c, "admin.users");
    const ctx = c.get("ctx");
    if (c.req.param("id") === c.get("user").id) throw bad("You cannot remove your own account");
    const u = await first<{ id: string; name: string; mobile: string; role: Role; dms_code: string | null }>(ctx.db, `SELECT id, name, mobile, role, dms_code FROM users WHERE id = ? AND tenant_id = ?`, c.req.param("id"), ctx.tenantId);
    if (!u) throw notFound("User");
    const history = await first<{ n: number }>(
      ctx.db,
      `SELECT (SELECT COUNT(*) FROM bookings WHERE tenant_id = ?1 AND (sales_exec_id = ?2 OR created_by = ?2 OR approved_by = ?2))
            + (SELECT COUNT(*) FROM allocations WHERE tenant_id = ?1 AND allocated_by = ?2)
            + (SELECT COUNT(*) FROM exceptions WHERE tenant_id = ?1 AND (requested_by = ?2 OR decided_by = ?2))
            + (SELECT COUNT(*) FROM uploads WHERE tenant_id = ?1 AND uploaded_by = ?2)
            + (SELECT COUNT(*) FROM recon_items WHERE tenant_id = ?1 AND resolved_by = ?2)
            + (SELECT COUNT(*) FROM audit_log WHERE tenant_id = ?1 AND actor = ?2) AS n`,
      ctx.tenantId, u.id,
    );
    if ((history?.n ?? 0) > 0) {
      // Their name is in the record of what they did and has to stay there, so the account is not
      // deleted — but the departure is not something to argue with either. It is recorded as a
      // leaving date, every session ends, and the DMS ID goes back to the desk for whoever replaces
      // them. The bookings stay where they are and move across when the replacement takes that ID.
      const today = localParts(ctx.now, ctx.tenant.timezone).date;
      await ctx.db.batch([
        stmt(ctx.db, `UPDATE users SET is_active = 0, left_on = ?, dms_code = NULL, token_version = token_version + 1, failed_logins = 0, locked_until = NULL WHERE id = ? AND tenant_id = ?`, today, u.id, ctx.tenantId),
        stmt(ctx.db, `DELETE FROM password_otps WHERE user_id = ? AND tenant_id = ?`, u.id, ctx.tenantId),
        auditStmt(ctx, "USER_LEFT", "user", u.id, { name: u.name, mobile: u.mobile, role: u.role, left_on: today, dms_code_freed: u.dms_code ?? null }),
      ]);
      return c.json({
        ok: true,
        left: true,
        name: u.name,
        left_on: today,
        dms_code_freed: u.dms_code ?? null,
        message: `${u.name} has been recorded as having left on ${today} and can no longer sign in. Their name stays on the work they did. ${u.dms_code ? `Their DMS ID ${u.dms_code} is free for whoever takes over, and the bookings under it move with it.` : "Whoever takes over the role picks up the work."}`,
      });
    }
    await ctx.db.batch([
      stmt(ctx.db, `DELETE FROM user_outlets WHERE user_id = ? AND tenant_id = ?`, u.id, ctx.tenantId),
      stmt(ctx.db, `DELETE FROM user_segments WHERE user_id = ? AND tenant_id = ?`, u.id, ctx.tenantId),
      stmt(ctx.db, `DELETE FROM password_otps WHERE user_id = ? AND tenant_id = ?`, u.id, ctx.tenantId),
      stmt(ctx.db, `UPDATE bookings SET sales_exec_id = NULL WHERE tenant_id = ? AND sales_exec_id = ?`, ctx.tenantId, u.id),
      stmt(ctx.db, `DELETE FROM users WHERE id = ? AND tenant_id = ?`, u.id, ctx.tenantId),
      // The removal itself is recorded, so a name that disappears can still be accounted for.
      auditStmt(ctx, "USER_DELETED", "user", u.id, { name: u.name, mobile: u.mobile, role: u.role }),
    ]);
    return c.json({ ok: true, removed: u.name });
  });

  app.patch("/api/users/:id", async (c) => {
    need(c, "admin.users");
    const ctx = c.get("ctx");
    const me = c.get("user");
    const b = await jsonBody<{ name?: string; mobile?: string; email?: string; role?: Role; all_outlets?: boolean; outlet_ids?: string[]; is_active?: boolean; dms_code?: string | null; segments?: string[] }>(c);
    const u = await first<any>(ctx.db, `SELECT * FROM users WHERE id = ? AND tenant_id = ?`, c.req.param("id"), ctx.tenantId);
    if (!u) throw notFound("User");
    const dmsCode = b.dms_code === undefined ? u.dms_code : await checkDmsCode(ctx, b.dms_code, u.id);
    if (b.role && !ROLES.includes(b.role)) throw bad("Role is not valid");
    // The number can be corrected. It is how the person signs in, so it was held still at first — but a
    // number typed wrongly leaves an account that cannot be used and, once its owner has worked, cannot
    // be removed either; and people change their number in any case. Making a second account for the
    // same person splits their history in two, which is worse than the problem it avoids.
    let mobile = u.mobile;
    if (b.mobile !== undefined) {
      const next = normMobile(b.mobile);
      if (!next) throw bad("Enter a valid mobile number");
      if (next !== u.mobile) {
        if (await first(ctx.db, `SELECT id FROM users WHERE tenant_id = ? AND mobile = ? AND id <> ?`, ctx.tenantId, next, u.id)) throw conflict("Another user at this dealership already signs in with that mobile number");
        mobile = next;
      }
    }
    // A changed sign-in number ends every session: whoever is signed in was signed in as the old one.
    const movedNumber = mobile !== u.mobile;
    if (u.id === me.id && (b.is_active === false || (b.role && b.role !== "ADMIN"))) throw forbidden("You cannot remove your own administrator access");
    const role = b.role ?? u.role;
    const allOutlets = b.all_outlets === undefined ? Boolean(u.all_outlets) : b.all_outlets;
    let bump = 0;
    // A password is never typed in on somebody's behalf: Reset password makes one and emails it.
    if (b.is_active === false || movedNumber) bump = 1;
    // Switching an account off is a suspension, not a departure, so it sets no leaving date. Switching
    // one back on is the other way round: somebody who is working here again has not left, and a date
    // left sitting beside a working account would be read as if they had.
    const leftOn = b.is_active === true ? null : u.left_on;
    await run(
      ctx.db,
      `UPDATE users SET name = ?, mobile = ?, email = ?, role = ?, all_outlets = ?, is_active = ?, password_hash = ?, must_change_password = ?, dms_code = ?, left_on = ?, token_version = token_version + ?, failed_logins = 0, locked_until = NULL WHERE id = ? AND tenant_id = ?`,
      b.name?.trim() || u.name, mobile, b.email === undefined ? u.email : b.email?.trim() || null, role, allOutlets ? 1 : 0, b.is_active === undefined ? u.is_active : b.is_active ? 1 : 0, u.password_hash, u.must_change_password, dmsCode, leftOn, bump, u.id, ctx.tenantId,
    );
    if (dmsCode && dmsCode !== u.dms_code) await linkBookingsTo(ctx, u.id, dmsCode);
    if (b.outlet_ids || b.all_outlets !== undefined) await setOutlets(ctx, u.id, allOutlets ? [] : b.outlet_ids ?? []);
    if (b.segments !== undefined) await setSegments(ctx, u.id, b.segments);
    await audit(ctx, "USER_UPDATED", "user", u.id, { ...b, ...(movedNumber ? { mobile_was: u.mobile, mobile_now: mobile } : {}) });
    return c.json({ ok: true });
  });

  /**
   * Sends one test message to the person asking, and waits for the answer. Email is the only way a new
   * user learns how to sign in, so whether it works has to be answerable without making an account to
   * find out — and when it does not work, the reason has to be the mail server's own words rather than
   * a shrug. This is the one place a send is waited for: somebody is sitting there watching for it.
   */
  app.post("/api/mail/test", async (c) => {
    need(c, "admin.settings");
    const ctx = c.get("ctx");
    const me = c.get("user");
    const b = await jsonBody<{ to?: string }>(c);
    const mine = await first<{ email: string | null }>(ctx.db, `SELECT email FROM users WHERE id = ? AND tenant_id = ?`, me.id, ctx.tenantId);
    const to = ((b.to ?? "").trim() || (mine?.email ?? "").trim()).trim();
    const account = (ctx.env.SMTP_FROM ?? "").trim() || (ctx.env.SMTP_USER ?? "").trim();
    const where = { host: (ctx.env.SMTP_HOST ?? "").trim() || "smtp.gmail.com", port: Number(ctx.env.SMTP_PORT ?? "") || 587, account: account || null };
    c.header("Cache-Control", "private, no-store");
    // Three different answers, and the screen says which: no account set up, nowhere to send, or a send.
    if (!emailPossible(ctx.env)) return c.json({ configured: false, sent: false, reason: "MAIL_NOT_CONFIGURED", to: to || null, ...where });
    if (!/^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(to)) return c.json({ configured: true, sent: false, reason: "NO_EMAIL", to: to || null, ...where }, 400);
    const post = mailer(ctx.env, () => ctx.now);
    const message = testMail({
      name: me.name,
      dealership: ctx.tenant.name,
      roleLabel: ROLE_LABELS[me.role],
      mobile: me.mobile,
      password: "",
      signInUrl: ctx.env.APP_URL || "the VINeeti address your dealership uses",
      account: account || "the configured account",
      at: ctx.now.toISOString(),
      logo: await emailMark(ctx.env, "email-logo.png"),
      jbr: await emailMark(ctx.env, "email-jbr.png"),
    });
    let reason: string | null = null;
    let stage: string | null = null;
    let detail: string | null = null;
    try {
      await post!.send({ ...message, to });
    } catch (e) {
      reason = e instanceof MailError ? e.code : "MAIL_UNAVAILABLE";
      stage = e instanceof MailError ? e.stage || null : null;
      // The server's own words, which say more than any code: a refusal explains itself.
      detail = String((e as Error)?.message ?? "").slice(0, 200) || null;
    }
    await audit(ctx, reason ? "MAIL_TEST_FAILED" : "MAIL_TEST_SENT", "tenant", ctx.tenantId, { to, account: account || null, ...(reason ? { error: reason, stage, detail } : {}) });
    return c.json({ configured: true, sent: !reason, reason, stage, detail, to, ...where });
  });

  // ------------------------------------------------------------ support tickets
  /**
   * Anybody signed in may raise one: a person who cannot get a screen to work is exactly the person who
   * needs to be heard, whatever their role, so this is behind no permission. Support is told afterwards,
   * so a mail server never holds up the answer.
   */
  app.post("/api/support/tickets", async (c) => {
    const ctx = c.get("ctx");
    const user = c.get("user");
    if (Number(c.req.header("Content-Length") ?? "0") > ATTACHMENT_LIMIT + 512 * 1024) throw bad(`The attachment is larger than ${Math.round(ATTACHMENT_LIMIT / (1024 * 1024))} MB`);
    let subject = "", body = "", attachment: Attachment | null = null;
    if ((c.req.header("Content-Type") ?? "").includes("multipart/form-data")) {
      const form = await c.req.formData().catch(() => null);
      if (!form) throw bad("The ticket could not be read");
      subject = String(form.get("subject") ?? "");
      body = String(form.get("body") ?? "");
      const file = form.get("file") as unknown;
      if (file && typeof file !== "string") {
        const f = file as File;
        checkAttachment({ name: f.name, type: f.type, size: f.size });
        attachment = { name: f.name, type: (f.type || "application/octet-stream").split(";")[0], bytes: new Uint8Array(await f.arrayBuffer()) };
      }
    } else {
      const b = await jsonBody<{ subject?: string; body?: string }>(c);
      subject = String(b.subject ?? "");
      body = String(b.body ?? "");
    }
    const made = await raiseTicket(ctx, user, { subject, body }, attachment);
    after(c, notifySupport(ctx, made.id));
    return c.json({ ...made, support_email: supportAddress(ctx.env) }, 201);
  });

  /** The tickets this person raised, and what has become of them. */
  app.get("/api/support/tickets", async (c) => {
    const ctx = c.get("ctx");
    return c.json({ tickets: await myTickets(ctx, c.get("user").id), support_email: supportAddress(ctx.env), attachment_limit: ATTACHMENT_LIMIT });
  });

  /** The file somebody attached. Theirs to fetch; the platform console has its own route for the rest. */
  app.get("/api/support/tickets/:id/attachment", async (c) => {
    const ctx = c.get("ctx");
    const t = await first<{ attachment_key: string | null; attachment_name: string | null; attachment_type: string | null }>(
      ctx.db,
      `SELECT attachment_key, attachment_name, attachment_type FROM support_tickets WHERE id = ? AND tenant_id = ? AND raised_by = ?`,
      c.req.param("id"), ctx.tenantId, c.get("user").id,
    );
    if (!t?.attachment_key) throw notFound("Attachment");
    const file = await ctx.env.FILES?.get(t.attachment_key);
    if (!file) throw notFound("Attachment");
    c.header("Content-Type", t.attachment_type || "application/octet-stream");
    c.header("Content-Disposition", `attachment; filename="${(t.attachment_name ?? "attachment").replace(/[^A-Za-z0-9._-]/g, "_")}"`);
    c.header("Cache-Control", "private, no-store");
    return c.body(file.body as ReadableStream);
  });

  // ------------------------------------------------------------ dealership settings
  app.get("/api/settings", (c) => {
    const ctx = c.get("ctx");
    return c.json({ settings: ctx.settings, defaults: DEFAULT_SETTINGS, queue_criteria: QUEUE_CRITERIA, car_criteria: CAR_CRITERIA, role_labels: ROLE_LABELS, role_purpose: ROLE_PURPOSE, permissions: Object.fromEntries(ROLES.map((r) => [r, permissionsFor(r, ctx.settings)])) });
  });
  app.put("/api/settings", async (c) => {
    need(c, "admin.settings");
    const ctx = c.get("ctx");
    const patch = await jsonBody(c);
    // The dealership's own rules (allocation, payment window, approvers, alarms) are set by its management or the
    // administrator. What ties the system to the DMS is the administrator's alone.
    if (c.get("user").role !== "ADMIN" && patch.dms_dealer_name !== undefined) throw forbidden("Only the system administrator can change the DMS dealer name");
    const outletIds = (await all<{ id: string }>(ctx.db, `SELECT id FROM outlets WHERE tenant_id = ?`, ctx.tenantId)).map((o) => o.id);
    let next: TenantSettings;
    try {
      next = mergeSettings(parseSettings(ctx.tenant.settings_json), patch, outletIds);
    } catch (e) {
      throw bad((e as Error).message);
    }
    // A change to who gets which car is announced to the Business Head and listed at day end, not only logged.
    const changed = ALLOCATION_RULE_KEYS.filter((k) => JSON.stringify(ctx.settings[k]) !== JSON.stringify(next[k]));
    const labels: Record<string, string> = { queue_order: "queue order", car_order: "car order", outlet_scope: "outlet reach", nearby_outlets: "nearby outlets", allocate_in_transit: "allocation of cars in transit", hold_after_timeout: "what happens after a payment timeout", reminder_days: "reminder day", escalation_days: "escalation day", reallocate_days: "re-allocation day", import_bookings_as_approved: "whether DMS bookings enter the queue without approval" };
    await ctx.db.batch([
      stmt(ctx.db, `UPDATE tenants SET settings_json = ? WHERE id = ?`, JSON.stringify(next), ctx.tenantId),
      auditStmt(ctx, "SETTINGS_CHANGED", "tenant", ctx.tenantId, { before: ctx.settings, after: next }),
      ...(changed.length
        ? [
            auditStmt(ctx, "ALLOCATION_RULES_CHANGED", "tenant", ctx.tenantId, { changed: changed.map((k) => labels[k]), before: Object.fromEntries(changed.map((k) => [k, ctx.settings[k]])), after: Object.fromEntries(changed.map((k) => [k, next[k]])) }),
            // Everyone who receives alarms is told who changed the rules and what, whoever made the change.
            ...[...new Set<Role>(["CEO_VP", "DEALER_PRINCIPAL", ...next.alarm_roles])].map((role) => alertStmt(ctx, { targetRole: role, kind: "RULES_CHANGED", title: "Allocation rules changed", body: `${c.get("user").name} changed: ${changed.map((k) => labels[k]).join(", ")}. The new rules apply to allocations made from now on; cars already allocated are not affected.`, entityType: "tenant", entityId: ctx.tenantId })),
          ]
        : []),
    ]);
    return c.json({ settings: next, rules_changed: changed });
  });

  /**
   * What a change of rules would do, before it is saved: for the cars with the most customers waiting,
   * the queue as it stands and as it would be, and which free car each booking would be given.
   */
  app.post("/api/settings/preview", async (c) => {
    need(c, "admin.settings");
    const ctx = c.get("ctx");
    const outlets = await all<{ id: string; name: string }>(ctx.db, `SELECT id, name FROM outlets WHERE tenant_id = ?`, ctx.tenantId);
    let proposed: TenantSettings;
    try {
      proposed = mergeSettings(ctx.settings, await jsonBody(c), outlets.map((o) => o.id));
    } catch (e) {
      throw bad((e as Error).message);
    }
    return c.json(await previewRules(ctx, proposed, new Map(outlets.map((o) => [o.id, o.name]))));
  });
}
