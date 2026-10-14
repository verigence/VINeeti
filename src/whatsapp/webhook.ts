import type { Env } from "../env";
import { decryptSecret, hmacSha256Hex, timingSafeEqual } from "../lib/crypto";
import { all, first, run } from "../lib/db";
import { iso, newId } from "../lib/util";
import type { WaConfigRow } from "./outbox";

/** Meta's one-time handshake when the webhook URL is saved in the app dashboard. */
export async function verifyWebhook(env: Env, db: D1Database, url: URL): Promise<Response> {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token") ?? "";
  const challenge = url.searchParams.get("hub.challenge") ?? "";
  if (mode !== "subscribe" || !token) return new Response("Forbidden", { status: 403 });
  let ok = Boolean(env.WA_VERIFY_TOKEN) && timingSafeEqual(token, env.WA_VERIFY_TOKEN!);
  if (!ok) ok = Boolean(await first(db, `SELECT tenant_id FROM wa_config WHERE verify_token = ?`, token));
  return ok ? new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } }) : new Response("Forbidden", { status: 403 });
}

const RANK: Record<string, number> = { QUEUED: 0, SENT: 1, DELIVERED: 2, READ: 3 };

/**
 * Delivery receipts and customer replies. One webhook URL serves every dealership: each event names
 * the business phone number it belongs to, and that number maps to exactly one tenant.
 */
export async function handleWebhookEvent(env: Env, db: D1Database, rawBody: string, signature: string | null, now: Date): Promise<Response> {
  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const values: any[] = [];
  for (const entry of payload?.entry ?? []) for (const change of entry?.changes ?? []) if (change?.field === "messages" && change.value) values.push(change.value);

  const phoneIds = [...new Set(values.map((v) => String(v?.metadata?.phone_number_id ?? "")).filter(Boolean))];
  const configs = new Map<string, WaConfigRow>();
  for (const pid of phoneIds) {
    const cfg = await first<WaConfigRow>(db, `SELECT * FROM wa_config WHERE phone_number_id = ?`, pid);
    if (cfg) configs.set(pid, cfg);
  }

  // The payload must be signed with an app secret we know. The deployment's shared secret vouches for
  // every number; a dealership's own secret vouches only for that dealership's number, so one dealer's
  // secret can never be used to write into another dealer's records.
  if (!signature?.startsWith("sha256=")) return new Response("Invalid signature", { status: 401 });
  const matches = async (secret: string | null | undefined) => Boolean(secret) && timingSafeEqual(signature, "sha256=" + (await hmacSha256Hex(secret!, rawBody)));
  const shared = await matches(env.WA_APP_SECRET);
  const trusted = new Set<string>();
  for (const [pid, cfg] of configs) {
    if (shared || (cfg.app_secret_enc && (await matches(await decryptSecret(cfg.app_secret_enc, env.DATA_KEY).catch(() => null))))) trusted.add(pid);
  }
  if (!shared && trusted.size === 0) return new Response("Invalid signature", { status: 401 });

  for (const value of values) {
    const pid = String(value?.metadata?.phone_number_id ?? "");
    const cfg = trusted.has(pid) ? configs.get(pid) : undefined;
    if (!cfg) continue;
    for (const st of value.statuses ?? []) {
      const msg = await first<{ id: string; status: string }>(db, `SELECT id, status FROM wa_messages WHERE tenant_id = ? AND provider_message_id = ?`, cfg.tenant_id, String(st.id));
      if (!msg) continue;
      const at = st.timestamp ? new Date(Number(st.timestamp) * 1000).toISOString() : iso(now);
      const status = String(st.status ?? "").toLowerCase();
      if (status === "failed") {
        const e = st.errors?.[0];
        const text = e ? `${e.title ?? e.message ?? "Failed"}${e.error_data?.details ? ` (${e.error_data.details})` : ""} [code ${e.code}]` : "Delivery failed";
        if (msg.status !== "READ" && msg.status !== "DELIVERED") await run(db, `UPDATE wa_messages SET status = 'FAILED', error = ? WHERE id = ?`, text, msg.id);
      } else if (status === "sent" || status === "delivered" || status === "read") {
        const next = status.toUpperCase();
        const col = status === "sent" ? "sent_at" : status === "delivered" ? "delivered_at" : "read_at";
        if ((RANK[next] ?? 0) > (RANK[msg.status] ?? 0)) await run(db, `UPDATE wa_messages SET status = ?, ${col} = ?, error = NULL WHERE id = ?`, next, at, msg.id);
        else await run(db, `UPDATE wa_messages SET ${col} = COALESCE(${col}, ?) WHERE id = ?`, at, msg.id);
      }
    }
    const names = new Map<string, string>();
    for (const c of value.contacts ?? []) if (c?.wa_id) names.set(String(c.wa_id), String(c.profile?.name ?? ""));
    for (const m of value.messages ?? []) {
      const pid = String(m.id ?? "");
      if (pid && (await first(db, `SELECT id FROM wa_inbound WHERE tenant_id = ? AND provider_message_id = ?`, cfg.tenant_id, pid))) continue;
      await run(
        db,
        `INSERT INTO wa_inbound (id, tenant_id, from_mobile, from_name, message_type, text, provider_message_id, received_at) VALUES (?,?,?,?,?,?,?,?)`,
        newId("wai"),
        cfg.tenant_id,
        String(m.from ?? ""),
        names.get(String(m.from ?? "")) || null,
        String(m.type ?? "unknown"),
        m.type === "text" ? String(m.text?.body ?? "").slice(0, 4000) : m.type === "button" ? String(m.button?.text ?? "") : null,
        pid || null,
        m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : iso(now),
      );
    }
  }
  return new Response("OK", { status: 200 });
}

/** Recent customer replies. With an outlet scope, only replies from customers who have a booking at those outlets. */
export async function recentInbound(db: D1Database, tenantId: string, outletIds: string[] | null = null, limit = 50) {
  const scoped = outletIds ? `AND EXISTS (SELECT 1 FROM bookings b WHERE b.tenant_id = i.tenant_id AND b.customer_mobile = i.from_mobile AND b.outlet_id IN (${outletIds.map(() => "?").join(",") || "''"}))` : "";
  return all(db, `SELECT i.* FROM wa_inbound i WHERE i.tenant_id = ? ${scoped} ORDER BY i.received_at DESC LIMIT ?`, tenantId, ...(outletIds ?? []), limit);
}
