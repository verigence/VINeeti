// People. A person signs in with their mobile number: that number is their ID. The administrator adds
// people one at a time, or loads the whole employee list from an Excel sheet (name, mobile, role,
// outlets, DMS ID). A new person gets a temporary password, shown once to the administrator, and must
// replace it at first sign-in; once the dealership's WhatsApp number is live, anyone can instead set or
// reset their own password with a one-time code sent to their mobile on WhatsApp.

import type { Ctx, Env, Role, TenantRow } from "../env";
import { hashPassword, hex, timingSafeEqual } from "../lib/crypto";
import { alertStmt, all, auditStmt, chunk, first, run, stmt } from "../lib/db";
import { MailError, mailer } from "../lib/mailer";
import { introMail, resetMail, welcomeMail } from "./mail-templates";
import { ROLE_LABELS, ROLE_TO_YOU, TENANT_WIDE_ROLES } from "../lib/permissions";
import { HttpError, bad, iso, newId, norm, normMobile } from "../lib/util";
import { buildXlsx, readExport, tableWith } from "../lib/xlsx";
import { loadCredentials, type WaConfigRow } from "../whatsapp/outbox";
import { sendOtpMeta } from "../whatsapp/provider";
import { DEFAULT_TEMPLATES } from "../whatsapp/templates";

const ROLES = Object.keys(ROLE_LABELS) as Role[];

/** What people write in the Role column -> the role. Matching ignores case, spaces and punctuation. */
const ROLE_WORDS: Record<string, Role> = {
  ADMIN: "ADMIN", ADMINISTRATOR: "ADMIN", SYSTEMADMIN: "ADMIN", SYSTEMADMINISTRATOR: "ADMIN", SYSADMIN: "ADMIN",
  DEALERPRINCIPAL: "DEALER_PRINCIPAL", DP: "DEALER_PRINCIPAL", OWNER: "DEALER_PRINCIPAL",
  CEO: "CEO_VP", VP: "CEO_VP", CEOVP: "CEO_VP", VICEPRESIDENT: "CEO_VP", SRVICEPRESIDENT: "CEO_VP", SENIORVICEPRESIDENT: "CEO_VP", BUSINESSHEAD: "CEO_VP", BH: "CEO_VP",
  GM: "GM_SALES", GMSALES: "GM_SALES", GENERALMANAGER: "GM_SALES", GENERALMANAGERSALES: "GM_SALES",
  AGM: "AGM_SALES", AGMSALES: "AGM_SALES", ASSISTANTGENERALMANAGER: "AGM_SALES", BDM: "AGM_SALES", BDMSALES: "AGM_SALES",
  SALESLEAD: "SALES_LEAD", SALESMANAGER: "SALES_LEAD", TEAMLEAD: "SALES_LEAD", TEAMLEADER: "SALES_LEAD", SM: "SALES_LEAD",
  SALESCONSULTANT: "SALES_CONSULTANT", SALESEXECUTIVE: "SALES_CONSULTANT", SALESEXEC: "SALES_CONSULTANT", SC: "SALES_CONSULTANT", SE: "SALES_CONSULTANT",
  EDP: "EDP_MANAGER", EDPMANAGER: "EDP_MANAGER", STOCKINCHARGE: "EDP_MANAGER", STOCK: "EDP_MANAGER", STOCKYARD: "EDP_MANAGER", ORDERING: "EDP_MANAGER", ORDERINGDESK: "EDP_MANAGER", CRM: "EDP_MANAGER", CRMTEAM: "EDP_MANAGER",
  FINANCE: "FINANCE", ACCOUNTS: "FINANCE", FINANCETEAM: "FINANCE", ACCOUNTANT: "FINANCE",
  AUDITOR: "AUDITOR", AUDIT: "AUDITOR",
};
export function roleFromText(raw: unknown): Role | null {
  const key = norm(raw).replace(/[^A-Z]/g, "");
  return ROLE_WORDS[key] ?? (ROLES.includes(norm(raw).replace(/\s+/g, "_") as Role) ? (norm(raw).replace(/\s+/g, "_") as Role) : null);
}

/** A password a person can read out and type on a phone: 10 characters, letters and digits, none that look alike. */
/**
 * Sends a person their way in, and says whether it went. Making an account must not fail because the
 * mail server is down, so a failure comes back as a reason and the temporary password is still shown
 * on screen, which is what happened before there was any email at all.
 */
/**
 * Whether this deployment can send at all. Answered from configuration alone, so a caller can tell at
 * once whether to expect an email or to fall back to showing the password on screen.
 */
export function emailPossible(env: Env): boolean {
  return mailer(env) !== null;
}

/**
 * Schedules the message to go out after the answer has already reached the browser. Talking to a mail
 * server takes seconds — connect, STARTTLS, sign in, then a message carrying the two logos — and
 * nobody should watch a spinner for that: the account exists the moment it is written, and the telling
 * of the person can follow.
 */
export function sendSignInAfter(ctx: Ctx, after: (p: Promise<unknown>) => void, kind: "WELCOME" | "RESET", to: string | null | undefined, w: Told, userId: string): void {
  after(sendSignInOrAlert(ctx, kind, to, w, userId));
}

/**
 * One message, with its outcome recorded either way. Sent after the answer, there is no screen left to
 * report to, so the audit trail is the only place the result can live: without a line for a message
 * that went out, "it never arrived" cannot be told apart from "it was never sent", which is exactly the
 * question somebody asks first. A failure also raises an alert, because an account whose owner was
 * never told how to get in needs acting on; a deployment with no mail account at all does not, since
 * the password is handed to the screen instead.
 */
export async function sendSignInOrAlert(ctx: Ctx, kind: "WELCOME" | "RESET", to: string | null | undefined, w: Told, userId: string): Promise<{ emailed: boolean; email_error?: string }> {
  const sent = await sendSignIn(ctx, kind, to, w).catch((e) => ({ emailed: false, email_error: e instanceof MailError ? e.code : "MAIL_UNAVAILABLE", stage: e instanceof MailError ? e.stage : "", detail: String((e as Error)?.message ?? "").slice(0, 200) }));
  const what = kind === "WELCOME" ? "welcome email" : "new password";
  const writes = [
    auditStmt(ctx, sent.emailed ? "SIGNIN_EMAIL_SENT" : "SIGNIN_EMAIL_FAILED", "user", userId, {
      kind,
      email: to ?? null,
      account: (ctx.env.SMTP_FROM ?? ctx.env.SMTP_USER ?? "").trim() || null,
      ...(sent.emailed ? {} : { error: sent.email_error, stage: "stage" in sent ? sent.stage : "", detail: "detail" in sent ? sent.detail : "" }),
    }),
  ];
  if (!sent.emailed && sent.email_error !== "MAIL_NOT_CONFIGURED") {
    writes.unshift(
      alertStmt(ctx, {
        targetUser: ctx.actor.startsWith("usr") ? ctx.actor : null,
        targetRole: ctx.actor.startsWith("usr") ? null : "ADMIN",
        kind: "MAIL_FAILED",
        title: `The ${what} for ${w.name} could not be sent`,
        body: `${w.name} (${to ?? "no address"}) has an account but has not been told how to sign in. Use Reset password on their row to try again, or give them the password yourself.`,
        entityType: "user",
        entityId: userId,
      }),
    );
  }
  await ctx.db.batch(writes).catch(() => undefined);
  return sent;
}

/** What a person is told so they can get in for the first time. */
export type Told = { name: string; roleLabel: string; mobile: string; password: string };

export async function sendSignIn(
  ctx: Ctx,
  kind: "WELCOME" | "RESET",
  to: string | null | undefined,
  w: Told,
): Promise<{ emailed: boolean; email_error?: string; stage?: string; detail?: string }> {
  const address = (to ?? "").trim();
  if (!address) return { emailed: false, email_error: "NO_EMAIL" };
  const post = mailer(ctx.env, () => ctx.now);
  if (!post) return { emailed: false, email_error: "MAIL_NOT_CONFIGURED" };
  const base = {
    name: w.name,
    dealership: ctx.tenant.name,
    roleLabel: w.roleLabel,
    mobile: w.mobile,
    password: w.password,
    signInUrl: ctx.env.APP_URL || "the VINeeti address your dealership uses",
    logo: await emailMark(ctx.env, "email-logo.png"),
    jbr: await emailMark(ctx.env, "email-jbr.png"),
  };
  const message = kind === "WELCOME" ? welcomeMail(base) : resetMail(base);
  try {
    await post.send({ ...message, to: address });
    return { emailed: true };
  } catch (e) {
    // The person is still created or reset; only the telling of them failed.
    return { emailed: false, email_error: e instanceof MailError ? e.code : "MAIL_UNAVAILABLE", stage: e instanceof MailError ? e.stage : "", detail: String((e as Error)?.message ?? "").slice(0, 200) };
  }
}

/**
 * The mark at the top of a message, read from the web app's own files so there is one picture and not
 * a copy of it in the Worker. It rides inside the message, so nothing is fetched when it is opened and
 * no "show pictures" bar stands between the person and their password. Unreadable, the message simply
 * carries the product's name as text instead.
 */
const marks = new Map<string, Uint8Array | null>();
export async function emailMark(env: Env, file: string): Promise<Uint8Array | undefined> {
  if (!marks.has(file)) {
    try {
      const res = await env.ASSETS?.fetch(new Request(`https://assets.invalid/brand/${file}`));
      marks.set(file, res?.ok ? new Uint8Array(await res.arrayBuffer()) : null);
    } catch {
      marks.set(file, null);
    }
  }
  return marks.get(file) ?? undefined;
}

export function temporaryPassword(): string {
  const letters = "abcdefghjkmnpqrstuvwxyz", digits = "23456789";
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let s = "";
  for (let i = 0; i < 10; i++) s += i % 3 === 2 ? digits[bytes[i] % digits.length] : letters[bytes[i] % letters.length];
  return s;
}

export const EMPLOYEE_HEADINGS = ["Name", "Mobile", "Role", "Outlets", "DMS ID", "Email"];

/**
 * The employee sheet to fill in: the headings, the roles that can be written, and one row for every
 * sales consultant the DMS booking sheet names who is not a user yet (name, outlet and DMS ID filled in;
 * the mobile number is for the dealership to add).
 */
export async function employeeTemplate(ctx: Ctx): Promise<Uint8Array> {
  const consultants = await all<{ sc_name: string; sc_code: string; outlets: string }>(
    ctx.db,
    `SELECT b.sc_name, b.sc_code, GROUP_CONCAT(DISTINCT o.code) AS outlets FROM bookings b JOIN outlets o ON o.id = b.outlet_id
     WHERE b.tenant_id = ?1 AND b.sc_code IS NOT NULL AND b.sc_code <> '' AND NOT EXISTS (SELECT 1 FROM users u WHERE u.tenant_id = ?1 AND u.dms_code = b.sc_code)
     GROUP BY b.sc_code ORDER BY b.sc_name LIMIT 2000`,
    ctx.tenantId,
  );
  const rows: (string | number)[][] = [EMPLOYEE_HEADINGS, ...consultants.map((c) => [c.sc_name ?? "", "", "Sales Consultant", c.outlets ?? "", c.sc_code, ""])];
  if (!consultants.length) rows.push(["(example) Ravi Kumar", "9876543210", "Sales Consultant", "AD01", "", ""], ["(example) Anita Das", "9876500000", "Finance", "ALL", "", ""]);
  return buildXlsx("Employees", rows, [28, 16, 20, 18, 14, 28]);
}

export interface EmployeeImportResult {
  row_count: number;
  created: { name: string; mobile: string; role: Role; role_label: string; outlets: string; temporary_password: string; email: string | null; emailed?: boolean; emailing?: boolean; email_error?: string }[];
  updated: { name: string; mobile: string; role_label: string; changes: string[] }[];
  unchanged: number;
  errors: { row: number; key: string; message: string }[];
  /** True when the dealership's WhatsApp number is live, so people can set their own password with a one-time code instead of the temporary one. */
  otp_available: boolean;
}

/**
 * Loads the employee list (.xlsx or .csv) with the headings Name, Mobile, Role, Outlets, and optionally
 * DMS ID and Email. Outlets is a list of outlet codes separated by commas, or ALL. A mobile number already
 * in the system is updated (name, role, outlets, DMS ID), never given a new password. Nobody is removed
 * or switched off by a sheet.
 */
export async function importEmployees(ctx: Ctx, bytes: Uint8Array, filename: string | undefined, actorId: string, after?: (p: Promise<unknown>) => void): Promise<EmployeeImportResult> {
  const t = tableWith(await readExport(bytes, filename), ["Name", "Mobile", "Role"]);
  if (!t) throw bad("This is not the employee sheet: it needs the headings Name, Mobile and Role (and optionally Outlets, DMS ID, Email)");
  if (t.records.length > 2000) throw bad("The sheet has more than 2,000 people");
  const outlets = new Map((await all<{ id: string; code: string }>(ctx.db, `SELECT id, code FROM outlets WHERE tenant_id = ?`, ctx.tenantId)).map((o) => [norm(o.code), o.id]));
  const outletCode = new Map([...outlets].map(([code, id]) => [id, code]));
  const users = await all<{ id: string; name: string; mobile: string; email: string | null; role: Role; all_outlets: number; dms_code: string | null }>(ctx.db, `SELECT id, name, mobile, email, role, all_outlets, dms_code FROM users WHERE tenant_id = ?`, ctx.tenantId);
  const byMobile = new Map(users.map((u) => [u.mobile, u]));
  const links = await all<{ user_id: string; outlet_id: string }>(ctx.db, `SELECT user_id, outlet_id FROM user_outlets WHERE tenant_id = ?`, ctx.tenantId);
  const dmsOwner = new Map(users.filter((u) => u.dms_code).map((u) => [u.dms_code!, u.id]));
  const result: EmployeeImportResult = { row_count: t.records.length, created: [], updated: [], unchanged: 0, errors: [], otp_available: await otpAvailable(ctx.env, ctx.db, ctx.tenantId) };
  const stmts: D1PreparedStatement[] = [];
  const welcomes: (Told & { id: string; email: string | null })[] = [];
  const seen = new Set<string>();
  const at = iso(ctx.now);
  for (const r of t.records) {
    const row = Number(r._row);
    const name = (r["name"] ?? "").replace(/\s+/g, " ").trim();
    if (!name && !r["mobile"] && !r["role"]) continue;
    if (/^\(example\)/i.test(name)) continue;
    const fail = (message: string) => result.errors.push({ row, key: name || r["mobile"] || "(blank)", message });
    const mobile = normMobile(r["mobile"]);
    if (!name) { fail("Name is blank"); continue; }
    if (!mobile) { fail(`Mobile number "${r["mobile"] ?? ""}" is not valid`); continue; }
    if (seen.has(mobile)) { fail("This mobile number appears more than once in the sheet"); continue; }
    seen.add(mobile);
    const role = roleFromText(r["role"]);
    if (!role) { fail(`Role "${r["role"] ?? ""}" is not recognised. Use one of: ${ROLES.map((x) => ROLE_LABELS[x]).join(", ")}`); continue; }
    const cur = byMobile.get(mobile);
    // Changing who is an administrator, or one's own access, is done on the Users screen, one person at a time.
    if (cur && (cur.id === actorId || (cur.role === "ADMIN") !== (role === "ADMIN"))) { if (cur.role !== role) { fail("An administrator's role (and your own) is changed on the Users screen, not by a sheet"); continue; } }
    if (!cur && role === "ADMIN") { fail("An administrator is added on the Users screen, not by a sheet"); continue; }
    const cell = norm(r["outlets"] ?? r["outlet"] ?? "");
    const all_ = cell === "ALL" || (!cell && TENANT_WIDE_ROLES.includes(role));
    const codes = all_ ? [] : cell.split(/[,;/|]+/).map((x) => norm(x)).filter(Boolean);
    const unknown = codes.filter((c) => !outlets.has(c));
    if (unknown.length) { fail(`Outlet ${unknown.join(", ")} is not set up. Outlets here: ${[...outlets.keys()].join(", ")}`); continue; }
    if (!all_ && !codes.length) { fail("Give the outlet codes this person works at, or ALL"); continue; }
    const outletIds = codes.map((c) => outlets.get(c)!);
    const dms = norm(r["dms id"] ?? r["dms code"] ?? r["sc mile id"] ?? "") || null;
    if (dms && dmsOwner.has(dms) && dmsOwner.get(dms) !== cur?.id) { fail(`DMS ID ${dms} is already given to another person`); continue; }
    const email = (r["email"] ?? "").trim() || null;
    const outletText = all_ ? "All outlets" : codes.join(", ");
    const setOutlets = (userId: string) => [
      stmt(ctx.db, `DELETE FROM user_outlets WHERE user_id = ? AND tenant_id = ?`, userId, ctx.tenantId),
      ...outletIds.map((id) => stmt(ctx.db, `INSERT INTO user_outlets (user_id, outlet_id, tenant_id) VALUES (?,?,?)`, userId, id, ctx.tenantId)),
    ];
    const linkBookings = (userId: string) => (dms ? [stmt(ctx.db, `UPDATE bookings SET sales_exec_id = ? WHERE tenant_id = ? AND sc_code = ?`, userId, ctx.tenantId, dms)] : []);
    if (!cur) {
      const id = newId("usr");
      const password = temporaryPassword();
      stmts.push(
        stmt(ctx.db, `INSERT INTO users (id, tenant_id, name, mobile, email, role, password_hash, must_change_password, all_outlets, dms_code, created_at) VALUES (?,?,?,?,?,?,?,1,?,?,?)`, id, ctx.tenantId, name.slice(0, 120), mobile, email, role, await hashPassword(password), all_ ? 1 : 0, dms, at),
        ...setOutlets(id),
        ...linkBookings(id),
        auditStmt(ctx, "USER_CREATED", "user", id, { name, role, all_outlets: all_, outlets: codes, source: "Employee sheet" }),
      );
      if (dms) dmsOwner.set(dms, id);
      result.created.push({ name, mobile, role, role_label: ROLE_LABELS[role], outlets: outletText, temporary_password: password, email });
      // Sent after the sheet is written, so one unreachable address never costs the rest their accounts.
      welcomes.push({ id, email, name, roleLabel: ROLE_LABELS[role], mobile, password });
      continue;
    }
    const had = links.filter((l) => l.user_id === cur.id).map((l) => outletCode.get(l.outlet_id) ?? "").sort().join(",");
    const changes: string[] = [];
    if (cur.name !== name) changes.push("name");
    if (cur.role !== role) changes.push(`role: ${ROLE_LABELS[cur.role]} to ${ROLE_LABELS[role]}`);
    if (Boolean(cur.all_outlets) !== all_ || (!all_ && had !== [...codes].sort().join(","))) changes.push(`outlets: ${outletText}`);
    if (dms && cur.dms_code !== dms) changes.push(`DMS ID: ${dms}`);
    if (email && cur.email !== email) changes.push("email");
    if (!changes.length) { result.unchanged++; continue; }
    stmts.push(
      stmt(ctx.db, `UPDATE users SET name = ?, role = ?, all_outlets = ?, dms_code = COALESCE(?, dms_code), email = COALESCE(?, email) WHERE id = ? AND tenant_id = ?`, name.slice(0, 120), role, all_ ? 1 : 0, dms, email, cur.id, ctx.tenantId),
      ...setOutlets(cur.id),
      ...linkBookings(cur.id),
      auditStmt(ctx, "USER_UPDATED", "user", cur.id, { changes, source: "Employee sheet" }),
    );
    if (dms) dmsOwner.set(dms, cur.id);
    result.updated.push({ name, mobile, role_label: ROLE_LABELS[role], changes });
  }
  for (const part of chunk(stmts, 40)) await ctx.db.batch(part);
  // Everybody is created first, then told. A mail account that is down, or a row with no address,
  // leaves that person's temporary password on the screen and the rest of the sheet untouched.
  // A sheet of thirty joiners means thirty conversations with a mail server, which inside the request
  // would outlast the request. They go out one after another once the answer has been given.
  if (after && emailPossible(ctx.env)) {
    for (const row of result.created) {
      row.emailing = true;
      row.temporary_password = ""; // each person is written to; nobody else needs to see theirs
    }
    after(
      (async () => {
        for (const w of welcomes) await sendSignInOrAlert(ctx, "WELCOME", w.email, w, w.id);
      })(),
    );
  } else {
    for (const w of welcomes) {
      const sent = await sendSignIn(ctx, "WELCOME", w.email, w);
      const row = result.created.find((c) => c.mobile === w.mobile);
      if (row) Object.assign(row, sent);
    }
  }
  return result;
}

/** The administrator gives a person a new temporary password. It is shown once; the person must replace it at sign-in, and is signed out everywhere. */
export async function resetPassword(ctx: Ctx, userId: string, after?: (p: Promise<unknown>) => void): Promise<{ temporary_password: string; emailed?: boolean; emailing?: boolean; email_error?: string; email?: string | null }> {
  const u = await first<{ id: string; name: string; email: string | null; mobile: string; role: Role }>(ctx.db, `SELECT id, name, email, mobile, role FROM users WHERE id = ? AND tenant_id = ?`, userId, ctx.tenantId);
  if (!u) throw new HttpError(404, "User not found", "NOT_FOUND");
  const password = temporaryPassword();
  await ctx.db.batch([
    stmt(ctx.db, `UPDATE users SET password_hash = ?, must_change_password = 1, token_version = token_version + 1, failed_logins = 0, locked_until = NULL WHERE id = ? AND tenant_id = ?`, await hashPassword(password), u.id, ctx.tenantId),
    stmt(ctx.db, `UPDATE password_otps SET used_at = ? WHERE tenant_id = ? AND user_id = ? AND used_at IS NULL`, iso(ctx.now), ctx.tenantId, u.id),
    auditStmt(ctx, "PASSWORD_RESET_BY_ADMIN", "user", u.id, {}),
  ]);
  const w = { name: u.name, roleLabel: ROLE_LABELS[u.role], mobile: u.mobile, password };
  // The password is on the screen either way, so there is nothing to be gained by waiting for the mail.
  if (after && emailPossible(ctx.env)) {
    sendSignInAfter(ctx, after, "RESET", u.email, w, u.id);
    return { temporary_password: password, email: u.email, emailing: true };
  }
  const sent = await sendSignIn(ctx, "RESET", u.email, w);
  return { temporary_password: password, email: u.email, ...sent };
}

// ---------------------------------------------------------------- one-time code on WhatsApp

const OTP_MINUTES = 10;
const OTP_PER_WINDOW = 3; // codes per person in 15 minutes
const OTP_MAX_ATTEMPTS = 5;

const sha256 = async (s: string) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));

/** A one-time code can only be sent from a live WhatsApp number (not in test mode). */
export async function otpAvailable(env: Env, db: D1Database, tenantId: string): Promise<boolean> {
  const cfg = await first<WaConfigRow>(db, `SELECT * FROM wa_config WHERE tenant_id = ?`, tenantId);
  if (!cfg || !cfg.enabled || cfg.provider !== "META" || !cfg.phone_number_id || !cfg.access_token_enc) return false;
  const tpl = await first<{ enabled: number }>(db, `SELECT enabled FROM wa_templates WHERE tenant_id = ? AND event_key = 'PASSWORD_OTP'`, tenantId);
  return tpl ? Boolean(tpl.enabled) : true;
}

/**
 * Sends a one-time code to the person's own mobile on WhatsApp. The answer is the same whether or not
 * the number is registered, so the sign-in page cannot be used to find out who works at a dealership.
 */
export async function requestOtp(env: Env, tenant: TenantRow, mobileRaw: unknown, now: Date): Promise<void> {
  const db = env.DB;
  if (!(await otpAvailable(env, db, tenant.id))) throw bad("Setting a password with a WhatsApp code is not switched on for this dealership yet. Ask your administrator to reset your password.", "OTP_NOT_AVAILABLE");
  const mobile = normMobile(mobileRaw);
  if (!mobile) return;
  const u = await first<{ id: string; name: string }>(db, `SELECT id, name FROM users WHERE tenant_id = ? AND mobile = ? AND is_active = 1`, tenant.id, mobile);
  if (!u) return;
  const recent = await first<{ n: number; last: string | null }>(db, `SELECT COUNT(*) AS n, MAX(created_at) AS last FROM password_otps WHERE tenant_id = ? AND user_id = ? AND created_at > ?`, tenant.id, u.id, new Date(now.getTime() - 15 * 60_000).toISOString());
  if ((recent?.n ?? 0) >= OTP_PER_WINDOW || (recent?.last && Date.parse(recent.last) > now.getTime() - 60_000)) return; // too many requests: nothing new is sent
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  const code = String(bytes[0] % 1_000_000).padStart(6, "0");
  const id = newId("otp");
  const cfg = (await first<WaConfigRow>(db, `SELECT * FROM wa_config WHERE tenant_id = ?`, tenant.id))!;
  const tpl = await first<{ template_name: string; language: string }>(db, `SELECT template_name, language FROM wa_templates WHERE tenant_id = ? AND event_key = 'PASSWORD_OTP'`, tenant.id);
  const def = DEFAULT_TEMPLATES.find((t) => t.event_key === "PASSWORD_OTP")!;
  const creds = await loadCredentials(env, cfg).catch(() => null);
  const res = creds ? await sendOtpMeta(creds, { to: mobile, templateName: tpl?.template_name ?? def.template_name, language: tpl?.language ?? def.language, code }) : { ok: false as const, error: "WhatsApp number is not connected" };
  await db.batch([
    // Earlier codes for this person stop working.
    stmt(db, `UPDATE password_otps SET used_at = ? WHERE tenant_id = ? AND user_id = ? AND used_at IS NULL`, iso(now), tenant.id, u.id),
    ...(res.ok ? [stmt(db, `INSERT INTO password_otps (id, tenant_id, user_id, code_hash, expires_at, created_at) VALUES (?,?,?,?,?,?)`, id, tenant.id, u.id, await sha256(`${id}:${code}`), new Date(now.getTime() + OTP_MINUTES * 60_000).toISOString(), iso(now))] : []),
    // The message log shows that a code was sent, never the code.
    stmt(
      db,
      `INSERT INTO wa_messages (id, tenant_id, event_key, audience, to_mobile, to_name, template_name, language, params_json, rendered_text, status, provider, provider_message_id, error, attempts, created_at, sent_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
      newId("wam"), tenant.id, "PASSWORD_OTP", "STAFF", mobile, u.name, tpl?.template_name ?? def.template_name, tpl?.language ?? def.language, "{}", "One-time code to set a password (the code itself is not kept)", res.ok ? "SENT" : "FAILED", "META", res.ok ? res.providerMessageId ?? null : null, res.ok ? null : res.error ?? "Send failed", iso(now), res.ok ? iso(now) : null,
    ),
    stmt(db, `INSERT INTO audit_log (id, tenant_id, actor, action, entity_type, entity_id, detail_json, at) VALUES (?,?,?,?,?,?,?,?)`, newId("aud"), tenant.id, u.id, "PASSWORD_CODE_REQUESTED", "user", u.id, JSON.stringify({ sent: res.ok }), iso(now)),
  ]);
}

/** Checks the code and sets the new password. Returns the user to sign in, or null when the code is wrong, used or expired. */
export async function resetWithOtp(env: Env, tenant: TenantRow, mobileRaw: unknown, codeRaw: unknown, newPasswordHash: string, now: Date): Promise<{ id: string; name: string; role: Role; token_version: number } | null> {
  const db = env.DB;
  const mobile = normMobile(mobileRaw);
  const code = String(codeRaw ?? "").replace(/\D/g, "");
  if (!mobile || code.length !== 6) return null;
  const u = await first<{ id: string; name: string; role: Role; token_version: number }>(db, `SELECT id, name, role, token_version FROM users WHERE tenant_id = ? AND mobile = ? AND is_active = 1`, tenant.id, mobile);
  if (!u) return null;
  const otp = await first<{ id: string; code_hash: string; expires_at: string; attempts: number }>(db, `SELECT id, code_hash, expires_at, attempts FROM password_otps WHERE tenant_id = ? AND user_id = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1`, tenant.id, u.id);
  if (!otp || otp.expires_at <= iso(now) || otp.attempts >= OTP_MAX_ATTEMPTS) return null;
  if (!timingSafeEqual(await sha256(`${otp.id}:${code}`), otp.code_hash)) {
    await run(db, `UPDATE password_otps SET attempts = attempts + 1 WHERE id = ?`, otp.id);
    return null;
  }
  // The code is spent and the password set in one step; a code can never be used twice.
  const changed = await db.batch([
    stmt(db, `UPDATE password_otps SET used_at = ? WHERE id = ? AND used_at IS NULL`, iso(now), otp.id),
    stmt(db, `UPDATE users SET password_hash = ?, must_change_password = 0, token_version = token_version + 1, failed_logins = 0, locked_until = NULL WHERE id = ? AND tenant_id = ? AND EXISTS (SELECT 1 FROM password_otps WHERE id = ? AND used_at = ?)`, newPasswordHash, u.id, tenant.id, otp.id, iso(now)),
    stmt(db, `INSERT INTO audit_log (id, tenant_id, actor, action, entity_type, entity_id, detail_json, at) VALUES (?,?,?,?,?,?,?,?)`, newId("aud"), tenant.id, u.id, "PASSWORD_SET_WITH_CODE", "user", u.id, "{}", iso(now)),
  ]);
  if (!(changed[0] as { meta?: { changes?: number } }).meta?.changes) return null;
  return { id: u.id, name: u.name, role: u.role, token_version: u.token_version + 1 };
}

/**
 * The introduction to the system, sent once somebody has replaced the temporary password. It carries no
 * secret, so a failure costs nobody their way in: it is recorded and left at that, with no alert, since
 * there is nothing for an administrator to go and do about it.
 */
export async function sendIntro(ctx: Ctx, userId: string): Promise<void> {
  const u = await first<{ name: string; email: string | null; mobile: string; role: Role }>(ctx.db, `SELECT name, email, mobile, role FROM users WHERE id = ? AND tenant_id = ?`, userId, ctx.tenantId);
  if (!u?.email) return;
  const post = mailer(ctx.env, () => ctx.now);
  if (!post) return;
  const message = introMail({
    name: u.name,
    dealership: ctx.tenant.name,
    roleLabel: ROLE_LABELS[u.role],
    rolePurpose: ROLE_TO_YOU[u.role],
    mobile: u.mobile,
    password: "",
    signInUrl: ctx.env.APP_URL || "the VINeeti address your dealership uses",
    logo: await emailMark(ctx.env, "email-logo.png"),
    jbr: await emailMark(ctx.env, "email-jbr.png"),
  });
  let error: string | null = null;
  try {
    await post.send({ ...message, to: u.email });
  } catch (e) {
    error = e instanceof MailError ? e.code : "MAIL_UNAVAILABLE";
  }
  await ctx.db
    .batch([auditStmt(ctx, error ? "INTRO_EMAIL_FAILED" : "INTRO_EMAIL_SENT", "user", userId, { email: u.email, ...(error ? { error } : {}) })])
    .catch(() => undefined);
}
