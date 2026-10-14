import type { Ctx, Env } from "../env";
import { decryptSecret } from "../lib/crypto";
import { all, first, run, stmt } from "../lib/db";
import { iso, newId, normMobile } from "../lib/util";
import { sendTemplateMeta, type WaCredentials } from "./provider";
import { DEFAULT_TEMPLATES, paramNames, render, type EventKey } from "./templates";

export interface WaConfigRow {
  tenant_id: string;
  provider: "TEST" | "META";
  enabled: number;
  display_number: string | null;
  phone_number_id: string | null;
  waba_id: string | null;
  access_token_enc: string | null;
  app_secret_enc: string | null;
  verify_token: string | null;
  graph_version: string | null;
  updated_at: string;
}

interface TemplateRow {
  event_key: string;
  audience: string;
  template_name: string;
  language: string;
  body: string;
  enabled: number;
}

/** Gives a new dealership its WhatsApp settings (test mode) and the default message templates. */
export async function ensureWaDefaults(db: D1Database, tenantId: string, now: Date): Promise<void> {
  const at = iso(now);
  const stmts = [stmt(db, `INSERT OR IGNORE INTO wa_config (tenant_id, provider, enabled, updated_at) VALUES (?, 'TEST', 1, ?)`, tenantId, at)];
  for (const t of DEFAULT_TEMPLATES) {
    stmts.push(
      stmt(
        db,
        `INSERT OR IGNORE INTO wa_templates (id, tenant_id, event_key, audience, template_name, language, body, enabled, updated_at) VALUES (?,?,?,?,?,?,?,1,?)`,
        newId("wat"),
        tenantId,
        t.event_key,
        t.audience,
        t.template_name,
        t.language,
        t.body,
        at,
      ),
    );
  }
  await db.batch(stmts);
}

export interface OutgoingMessage {
  eventKey: EventKey;
  toMobile: string | null;
  toName?: string | null;
  bookingId?: string | null;
  params: Record<string, string>;
  /** Customer consent captured on the booking. Staff messages do not need it. */
  optIn?: boolean;
}

/**
 * Builds the insert for one outgoing message so it can be committed in the same transaction as the
 * business change that caused it. Nothing is sent here; `dispatchQueued` does the sending.
 */
export async function messageStmt(ctx: Ctx, m: OutgoingMessage): Promise<D1PreparedStatement> {
  // The dealership's WhatsApp settings and wording are read once per request, however many messages it queues.
  let setup = ctx.cache.get("wa") as { cfg: WaConfigRow | null; templates: TemplateRow[] } | undefined;
  if (!setup) {
    setup = {
      cfg: await first<WaConfigRow>(ctx.db, `SELECT * FROM wa_config WHERE tenant_id = ?`, ctx.tenantId),
      templates: await all<TemplateRow>(ctx.db, `SELECT event_key, audience, template_name, language, body, enabled FROM wa_templates WHERE tenant_id = ?`, ctx.tenantId),
    };
    ctx.cache.set("wa", setup);
  }
  const tpl = setup.templates.find((t) => t.event_key === m.eventKey);
  const cfg = setup.cfg;
  ctx.flags.dispatch = true;
  const fallback = DEFAULT_TEMPLATES.find((t) => t.event_key === m.eventKey)!;
  const body = tpl?.body ?? fallback.body;
  const mobile = normMobile(m.toMobile);

  let status: "QUEUED" | "SKIPPED" = "QUEUED";
  let error: string | null = null;
  if (!cfg || !cfg.enabled) [status, error] = ["SKIPPED", "WhatsApp messaging is switched off"];
  else if (tpl && !tpl.enabled) [status, error] = ["SKIPPED", "This message is switched off"];
  else if (m.optIn === false) [status, error] = ["SKIPPED", "Customer has not agreed to WhatsApp messages"];
  else if (!mobile) [status, error] = ["SKIPPED", "Mobile number is missing or not valid"];

  return stmt(
    ctx.db,
    `INSERT INTO wa_messages (id, tenant_id, event_key, audience, to_mobile, to_name, booking_id, template_name, language, params_json, rendered_text, status, provider, error, attempts, next_attempt_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`,
    newId("wam"),
    ctx.tenantId,
    m.eventKey,
    tpl?.audience ?? fallback.audience,
    mobile ?? String(m.toMobile ?? ""),
    m.toName ?? null,
    m.bookingId ?? null,
    tpl?.template_name ?? fallback.template_name,
    tpl?.language ?? fallback.language,
    JSON.stringify(m.params),
    render(body, m.params),
    status,
    cfg?.provider ?? "TEST",
    error,
    status === "QUEUED" ? iso(ctx.now) : null,
    iso(ctx.now),
  );
}

export async function loadCredentials(env: Env, cfg: WaConfigRow): Promise<WaCredentials | null> {
  if (!cfg.phone_number_id || !cfg.access_token_enc) return null;
  return {
    phoneNumberId: cfg.phone_number_id,
    wabaId: cfg.waba_id,
    accessToken: await decryptSecret(cfg.access_token_enc, env.DATA_KEY),
    graphVersion: cfg.graph_version || env.WA_GRAPH_VERSION || "v23.0",
  };
}

const BACKOFF_MINUTES = [5, 30, 120, 360];
const MAX_ATTEMPTS = BACKOFF_MINUTES.length + 1;
/** A message being sent is held for this long. If the Worker stops mid-send, it becomes due again afterwards. */
const LEASE_MINUTES = 5;

interface QueuedRow {
  id: string;
  tenant_id: string;
  to_mobile: string;
  template_name: string;
  language: string;
  params_json: string;
  attempts: number;
  event_key: string;
}

/** Sends queued messages. Called once after a request that queued any, and by the scheduled job. */
export async function dispatchQueued(env: Env, db: D1Database, now: Date, opts: { tenantId?: string; limit?: number } = {}) {
  const rows = await all<QueuedRow>(
    db,
    `SELECT id, tenant_id, to_mobile, template_name, language, params_json, attempts, event_key FROM wa_messages
     WHERE status = 'QUEUED' AND next_attempt_at <= ? ${opts.tenantId ? "AND tenant_id = ?" : ""} ORDER BY created_at LIMIT ?`,
    ...(opts.tenantId ? [iso(now), opts.tenantId, opts.limit ?? 50] : [iso(now), opts.limit ?? 50]),
  );
  const result = { sent: 0, failed: 0, retried: 0 };
  const configs = new Map<string, WaConfigRow | null>();
  const bodies = new Map<string, string | null>();
  const lease = iso(new Date(now.getTime() + LEASE_MINUTES * 60_000));
  for (const r of rows) {
    if (!configs.has(r.tenant_id)) configs.set(r.tenant_id, await first<WaConfigRow>(db, `SELECT * FROM wa_config WHERE tenant_id = ?`, r.tenant_id));
    const cfg = configs.get(r.tenant_id);
    if (r.attempts >= MAX_ATTEMPTS) {
      await run(db, `UPDATE wa_messages SET status = 'FAILED', error = COALESCE(error, 'Could not be sent after several attempts') WHERE id = ? AND status = 'QUEUED'`, r.id);
      result.failed++;
      continue;
    }
    // Claim the row first so two overlapping runs cannot send the same message twice. The claim is a
    // lease, not a permanent mark: a message whose send was cut short comes round again.
    const claimed = await run(db, `UPDATE wa_messages SET attempts = attempts + 1, next_attempt_at = ? WHERE id = ? AND status = 'QUEUED' AND attempts = ?`, lease, r.id, r.attempts);
    if (!claimed) continue;
    const attempt = r.attempts + 1;

    if (!cfg || !cfg.enabled) {
      await run(db, `UPDATE wa_messages SET status = 'SKIPPED', error = ? WHERE id = ?`, "WhatsApp messaging is switched off", r.id);
      continue;
    }
    if (cfg.provider === "TEST") {
      await run(db, `UPDATE wa_messages SET status = 'SENT', provider = 'TEST', provider_message_id = ?, sent_at = ?, error = NULL WHERE id = ?`, `test.${r.id}`, iso(now), r.id);
      result.sent++;
      continue;
    }
    const creds = await loadCredentials(env, cfg).catch(() => null);
    if (!creds) {
      await run(db, `UPDATE wa_messages SET status = 'FAILED', provider = 'META', error = ? WHERE id = ?`, "WhatsApp number is not connected: add the phone number ID and access token in settings", r.id);
      result.failed++;
      continue;
    }
    const bodyKey = `${r.tenant_id}|${r.event_key}`;
    if (!bodies.has(bodyKey)) bodies.set(bodyKey, (await first<{ body: string }>(db, `SELECT body FROM wa_templates WHERE tenant_id = ? AND event_key = ?`, r.tenant_id, r.event_key))?.body ?? null);
    const tplBody = bodies.get(bodyKey);
    const params = JSON.parse(r.params_json) as Record<string, string>;
    const order = tplBody ? paramNames(tplBody) : Object.keys(params);
    const res = await sendTemplateMeta(creds, { to: r.to_mobile, templateName: r.template_name, language: r.language, params, paramOrder: order });
    if (res.ok) {
      await run(db, `UPDATE wa_messages SET status = 'SENT', provider = 'META', provider_message_id = ?, sent_at = ?, error = NULL WHERE id = ?`, res.providerMessageId, iso(now), r.id);
      result.sent++;
    } else if (res.retryable && attempt < MAX_ATTEMPTS) {
      const next = new Date(now.getTime() + BACKOFF_MINUTES[attempt - 1] * 60_000);
      await run(db, `UPDATE wa_messages SET provider = 'META', error = ?, next_attempt_at = ? WHERE id = ?`, res.error ?? "Send failed", iso(next), r.id);
      result.retried++;
    } else {
      await run(db, `UPDATE wa_messages SET status = 'FAILED', provider = 'META', error = ? WHERE id = ?`, res.error ?? "Send failed", r.id);
      result.failed++;
    }
  }
  return result;
}
