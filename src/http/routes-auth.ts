import type { Env, Role, TenantRow } from "../env";
import { hashPassword, signSession, timingSafeEqual, verifyPassword, verifySession } from "../lib/crypto";
import { alertStmt, all, audit, auditStmt, first, run, stmt } from "../lib/db";
import { PERMISSION_LABELS, permissionsFor, ROLE_LABELS, ROLE_PURPOSE, roleMatrix, TENANT_WIDE_ROLES } from "../lib/permissions";
import { ALLOCATION_RULE_KEYS, CAR_CRITERIA, DEFAULT_SETTINGS, mergeSettings, parseSettings, QUEUE_CRITERIA, type TenantSettings } from "../lib/settings";
import { employeeTemplate, importEmployees, otpAvailable, requestOtp, resetPassword, resetWithOtp } from "../domain/onboarding";
import { previewRules } from "../domain/preview";
import { oemAdapter } from "../oem";
import { XLSX_MIME } from "../lib/xlsx";
import { bad, conflict, forbidden, HttpError, iso, newId, norm, normMobile, notFound } from "../lib/util";
import { ensureWaDefaults } from "../whatsapp/outbox";
import { authenticate, buildCtx, clock, describeUser, getCookie, jsonBody, need, outletScope, sessionCookie, type App } from "./app";

const ROLES = Object.keys(ROLE_LABELS) as Role[];
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

function checkPassword(pw: unknown): string {
  const s = String(pw ?? "");
  if (s.length < 8) throw bad("Password must be at least 8 characters");
  if (!/[A-Za-z]/.test(s) || !/\d/.test(s)) throw bad("Password must contain a letter and a number");
  return s;
}

/** Creates a dealership with its outlets, first administrator and WhatsApp defaults. */
export async function createTenant(
  env: Env,
  input: { slug: string; name: string; oem: string; timezone?: string; settings?: Record<string, unknown>; outlets?: { code: string; name: string; city?: string }[]; admin: { name: string; mobile: string; password: string } },
  now: Date,
) {
  const slug = String(input.slug ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug)) throw bad("Dealer code must be 3-40 characters: lowercase letters, digits and hyphens");
  if (!input.name?.trim() || !input.oem?.trim()) throw bad("Dealership name and OEM are required");
  // Outlets may be left out: the first DMS file loaded creates them from its Dealer Location Codes.
  if (input.outlets !== undefined && !Array.isArray(input.outlets)) throw bad("Outlets must be a list");
  const mobile = normMobile(input.admin?.mobile);
  if (!mobile || !input.admin?.name?.trim()) throw bad("Administrator name and mobile number are required");
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
    stmt(env.DB, `INSERT INTO users (id, tenant_id, name, mobile, role, password_hash, must_change_password, all_outlets, created_at) VALUES (?,?,?,?,'ADMIN',?,1,1,?)`, userId, tenantId, input.admin.name.trim(), mobile, await hashPassword(password), at),
  );
  await env.DB.batch(stmts);
  await ensureWaDefaults(env.DB, tenantId, now);
  return { tenant_id: tenantId, slug, admin_user_id: userId };
}

/**
 * The dealership a sign-in is for. The mobile number is the person's ID; the dealer code is only needed
 * when the same number is registered at more than one dealership on this deployment.
 */
async function tenantFor(db: D1Database, dealer: unknown, mobile: string | null): Promise<TenantRow | null> {
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
    const tenant = await tenantFor(c.env.DB, body.dealer, mobile);
    if (!tenant || !mobile) throw invalid;
    const u = await first<{ id: string; password_hash: string; token_version: number; failed_logins: number; locked_until: string | null; is_active: number }>(
      c.env.DB, `SELECT id, password_hash, token_version, failed_logins, locked_until, is_active FROM users WHERE tenant_id = ? AND mobile = ?`, tenant.id, mobile);
    if (!u || !u.is_active) throw invalid;
    if (u.locked_until && u.locked_until > iso(now)) throw invalid;
    if (!(await verifyPassword(String(body.password ?? ""), u.password_hash))) {
      const fails = u.failed_logins + 1;
      const lock = fails >= MAX_FAILED ? new Date(now.getTime() + LOCK_MINUTES * 60_000).toISOString() : null;
      await run(c.env.DB, `UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?`, lock ? 0 : fails, lock, u.id);
      throw invalid;
    }
    await run(c.env.DB, `UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?`, u.id);
    const token = await signSession({ tid: tenant.id, uid: u.id, tv: u.token_version, exp: Math.floor(now.getTime() / 1000) + 43200 }, c.env.SESSION_SECRET);
    c.header("Set-Cookie", sessionCookie(c.req.raw, token));
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------ setting a password with a one-time code on WhatsApp
  /** Whether a dealership's people can set their own password with a WhatsApp code (its WhatsApp number is live). */
  app.get("/api/auth/options", async (c) => {
    const tenant = await tenantFor(c.env.DB, c.req.query("dealer"), normMobile(c.req.query("mobile")));
    return c.json({ otp: tenant ? await otpAvailable(c.env, c.env.DB, tenant.id) : false });
  });

  app.post("/api/auth/otp/request", async (c) => {
    const body = await jsonBody<{ dealer?: string; mobile?: string }>(c);
    const tenant = await tenantFor(c.env.DB, body.dealer, normMobile(body.mobile));
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

  app.use("/api/*", async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (path === "/api/health" || path.startsWith("/api/wa/webhook") || path.startsWith("/api/platform/") || path.startsWith("/api/auth/login") || path.startsWith("/api/auth/logout") || path.startsWith("/api/auth/otp/") || path === "/api/auth/options") return next();
    if (/^\/api\/eod\/[^/]+\/(stock|bookings|run)$/.test(path)) return next(); // answered by the end-of-day feed routes, registered before this guard
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
      receives_alarms: ctx.settings.alarm_roles.includes(c.get("user").role),
      app_name: c.env.APP_NAME ?? "Verigence VINeeti",
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
    const token = await signSession({ tid: ctx.tenantId, uid: user.id, tv: row.token_version + 1, exp: Math.floor(ctx.now.getTime() / 1000) + 43200 }, c.env.SESSION_SECRET);
    c.header("Set-Cookie", sessionCookie(c.req.raw, token));
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------ outlets
  app.get("/api/outlets", async (c) => {
    const ctx = c.get("ctx");
    return c.json(await all(ctx.db, `SELECT id, code, name, city, is_active FROM outlets WHERE tenant_id = ? ORDER BY name`, ctx.tenantId));
  });
  app.post("/api/outlets", async (c) => {
    need(c, "admin.users");
    const ctx = c.get("ctx");
    const b = await jsonBody<{ code?: string; name?: string; city?: string }>(c);
    const code = norm(b.code);
    if (!code || !b.name?.trim()) throw bad("Outlet code and name are required");
    if (await first(ctx.db, `SELECT id FROM outlets WHERE tenant_id = ? AND code = ?`, ctx.tenantId, code)) throw conflict(`Outlet code ${code} already exists`);
    const id = newId("out");
    await run(ctx.db, `INSERT INTO outlets (id, tenant_id, code, name, city, created_at) VALUES (?,?,?,?,?,?)`, id, ctx.tenantId, code, b.name.trim(), b.city?.trim() ?? null, iso(ctx.now));
    await audit(ctx, "OUTLET_CREATED", "outlet", id, { code, name: b.name.trim() });
    return c.json({ id }, 201);
  });
  app.patch("/api/outlets/:id", async (c) => {
    need(c, "admin.users");
    const ctx = c.get("ctx");
    const b = await jsonBody<{ name?: string; city?: string; is_active?: boolean }>(c);
    const o = await first<{ id: string; name: string; city: string | null; is_active: number }>(ctx.db, `SELECT * FROM outlets WHERE id = ? AND tenant_id = ?`, c.req.param("id"), ctx.tenantId);
    if (!o) throw notFound("Outlet");
    await run(ctx.db, `UPDATE outlets SET name = ?, city = ?, is_active = ? WHERE id = ? AND tenant_id = ?`, b.name?.trim() || o.name, b.city === undefined ? o.city : b.city?.trim() || null, b.is_active === undefined ? o.is_active : b.is_active ? 1 : 0, o.id, ctx.tenantId);
    await audit(ctx, "OUTLET_UPDATED", "outlet", o.id, b);
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------ users
  app.get("/api/users", async (c) => {
    need(c, "admin.users");
    const ctx = c.get("ctx");
    const users = await all<any>(ctx.db, `SELECT id, name, mobile, email, role, all_outlets, is_active, must_change_password, dms_code, created_at FROM users WHERE tenant_id = ? ORDER BY name`, ctx.tenantId);
    const links = await all<{ user_id: string; outlet_id: string }>(ctx.db, `SELECT user_id, outlet_id FROM user_outlets WHERE tenant_id = ?`, ctx.tenantId);
    return c.json(users.map((u) => ({ ...u, outlet_ids: links.filter((l) => l.user_id === u.id).map((l) => l.outlet_id) })));
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

  /** The person's ID in the DMS (the booking sheet's SC Mile Id). One person per ID. */
  async function checkDmsCode(ctx: ReturnType<typeof buildCtx>, raw: unknown, userId: string | null): Promise<string | null> {
    const code = norm(raw);
    if (!code) return null;
    if (code.length > 40) throw bad("The DMS ID is too long");
    const other = await first<{ name: string }>(ctx.db, `SELECT name FROM users WHERE tenant_id = ? AND dms_code = ? AND id <> ?`, ctx.tenantId, code, userId ?? "");
    if (other) throw conflict(`DMS ID ${code} is already given to ${other.name}`);
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
    return c.json(await importEmployees(c.get("ctx"), bytes, filename, c.get("user").id));
  });

  /** A new temporary password for one person, shown this once. */
  app.post("/api/users/:id/reset-password", async (c) => {
    need(c, "admin.users");
    if (c.req.param("id") === c.get("user").id) throw bad("Change your own password from your profile");
    c.header("Cache-Control", "private, no-store");
    return c.json(await resetPassword(c.get("ctx"), c.req.param("id")));
  });

  /** Roles and controls: what each persona may do under the dealership's current settings. */
  app.get("/api/roles", (c) => {
    const ctx = c.get("ctx");
    return c.json({ roles: roleMatrix(ctx.settings), permission_labels: PERMISSION_LABELS, booking_approver_roles: ctx.settings.booking_approver_roles, exception_approver_roles: ctx.settings.exception_approver_roles, alarm_roles: ctx.settings.alarm_roles });
  });

  app.post("/api/users", async (c) => {
    need(c, "admin.users");
    const ctx = c.get("ctx");
    const b = await jsonBody<{ name?: string; mobile?: string; email?: string; role?: Role; password?: string; all_outlets?: boolean; outlet_ids?: string[]; dms_code?: string }>(c);
    const mobile = normMobile(b.mobile);
    const dmsCode = await checkDmsCode(ctx, b.dms_code, null);
    if (!b.name?.trim() || !mobile) throw bad("Name and a valid mobile number are required");
    if (!b.role || !ROLES.includes(b.role)) throw bad("Role is not valid");
    const password = checkPassword(b.password);
    if (await first(ctx.db, `SELECT id FROM users WHERE tenant_id = ? AND mobile = ?`, ctx.tenantId, mobile)) throw conflict("A user with this mobile number already exists");
    const allOutlets = b.all_outlets ?? TENANT_WIDE_ROLES.includes(b.role);
    if (!allOutlets && !(b.outlet_ids ?? []).length) throw bad("Choose at least one outlet for this user");
    const id = newId("usr");
    await run(ctx.db, `INSERT INTO users (id, tenant_id, name, mobile, email, role, password_hash, must_change_password, all_outlets, dms_code, created_at) VALUES (?,?,?,?,?,?,?,1,?,?,?)`, id, ctx.tenantId, b.name.trim(), mobile, b.email?.trim() || null, b.role, await hashPassword(password), allOutlets ? 1 : 0, dmsCode, iso(ctx.now));
    if (!allOutlets) await setOutlets(ctx, id, b.outlet_ids ?? []);
    if (dmsCode) await linkBookingsTo(ctx, id, dmsCode);
    await audit(ctx, "USER_CREATED", "user", id, { name: b.name.trim(), role: b.role, all_outlets: allOutlets, outlet_ids: b.outlet_ids ?? [] });
    return c.json({ id }, 201);
  });

  app.patch("/api/users/:id", async (c) => {
    need(c, "admin.users");
    const ctx = c.get("ctx");
    const me = c.get("user");
    const b = await jsonBody<{ name?: string; email?: string; role?: Role; password?: string; all_outlets?: boolean; outlet_ids?: string[]; is_active?: boolean; dms_code?: string | null }>(c);
    const u = await first<any>(ctx.db, `SELECT * FROM users WHERE id = ? AND tenant_id = ?`, c.req.param("id"), ctx.tenantId);
    if (!u) throw notFound("User");
    const dmsCode = b.dms_code === undefined ? u.dms_code : await checkDmsCode(ctx, b.dms_code, u.id);
    if (b.role && !ROLES.includes(b.role)) throw bad("Role is not valid");
    if (u.id === me.id && (b.is_active === false || (b.role && b.role !== "ADMIN"))) throw forbidden("You cannot remove your own administrator access");
    const role = b.role ?? u.role;
    const allOutlets = b.all_outlets === undefined ? Boolean(u.all_outlets) : b.all_outlets;
    let bump = 0;
    let hash = u.password_hash;
    if (b.password) {
      hash = await hashPassword(checkPassword(b.password));
      bump = 1; // signs the user out everywhere
    }
    if (b.is_active === false) bump = 1;
    await run(
      ctx.db,
      `UPDATE users SET name = ?, email = ?, role = ?, all_outlets = ?, is_active = ?, password_hash = ?, must_change_password = ?, dms_code = ?, token_version = token_version + ?, failed_logins = 0, locked_until = NULL WHERE id = ? AND tenant_id = ?`,
      b.name?.trim() || u.name, b.email === undefined ? u.email : b.email?.trim() || null, role, allOutlets ? 1 : 0, b.is_active === undefined ? u.is_active : b.is_active ? 1 : 0, hash, b.password ? 1 : u.must_change_password, dmsCode, bump, u.id, ctx.tenantId,
    );
    if (dmsCode && dmsCode !== u.dms_code) await linkBookingsTo(ctx, u.id, dmsCode);
    if (b.outlet_ids || b.all_outlets !== undefined) await setOutlets(ctx, u.id, allOutlets ? [] : b.outlet_ids ?? []);
    await audit(ctx, "USER_UPDATED", "user", u.id, { ...b, password: b.password ? "(changed)" : undefined });
    return c.json({ ok: true });
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
            ...[...new Set<Role>(["BUSINESS_HEAD", "DEALER_PRINCIPAL", ...next.alarm_roles])].map((role) => alertStmt(ctx, { targetRole: role, kind: "RULES_CHANGED", title: "Allocation rules changed", body: `${c.get("user").name} changed: ${changed.map((k) => labels[k]).join(", ")}. The new rules apply to allocations made from now on; cars already allocated are not affected.`, entityType: "tenant", entityId: ctx.tenantId })),
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
