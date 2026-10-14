import { decryptSecret, encryptSecret } from "../lib/crypto";
import { all, audit, first, run } from "../lib/db";
import { can } from "../lib/permissions";
import { addDays, bad, conflict, forbidden, iso, likeText, localDayBounds, localParts, normMobile, notFound, parseDate, safeJson, toCsv } from "../lib/util";
import { ALARM_KINDS } from "../domain/alarms";
import { ageingByModel, allocationsByDay, defaultSalesPeriod, notPickedUp, salesRanking, stockByDay } from "../domain/analytics";
import { allocationDashboard, delayedDashboard, measures, monthPace, nearMatches, orderQueueDashboard, outOfTurn, overview, ownerView } from "../domain/dashboards";
import { dailyMovement, holdingCars, modelPicture, myWork, waitingLine } from "../domain/role-views";
import { RECON_CATEGORIES, resolveItem, runReconciliation } from "../domain/reconciliation";
import { dispatchQueued, ensureWaDefaults, loadCredentials, messageStmt, type WaConfigRow } from "../whatsapp/outbox";
import { createOtpTemplateMeta, createTemplateMeta, listTemplatesMeta, verifyNumberMeta } from "../whatsapp/provider";
import { DEFAULT_TEMPLATES, paramNames, validateTemplateBody, type EventKey } from "../whatsapp/templates";
import { handleWebhookEvent, recentInbound, verifyWebhook } from "../whatsapp/webhook";
import { clock, jsonBody, need, outletScope, type App, type C } from "./app";

function publicConfig(c: C, cfg: WaConfigRow | null) {
  const origin = new URL(c.req.url).origin;
  return {
    provider: cfg?.provider ?? "TEST",
    enabled: Boolean(cfg?.enabled ?? 1),
    display_number: cfg?.display_number ?? null,
    phone_number_id: cfg?.phone_number_id ?? null,
    waba_id: cfg?.waba_id ?? null,
    graph_version: cfg?.graph_version ?? null,
    default_graph_version: c.env.WA_GRAPH_VERSION ?? "v23.0",
    verify_token: cfg?.verify_token ?? null,
    // Secrets are write-only: the screen can replace them but never read them back.
    has_access_token: Boolean(cfg?.access_token_enc),
    has_app_secret: Boolean(cfg?.app_secret_enc),
    webhook_url: `${origin}/api/wa/webhook`,
    connected: cfg?.provider === "META" && Boolean(cfg.phone_number_id && cfg.access_token_enc),
    updated_at: cfg?.updated_at ?? null,
  };
}

export function opsRoutes(app: App) {
  app.get("/api/health", (c) => c.json({ ok: true, at: iso(clock.now()) }));

  // ------------------------------------------------------------ dashboards
  app.get("/api/dashboards/overview", async (c) => {
    need(c, "dashboards.view");
    const ctx = c.get("ctx");
    const user = c.get("user");
    return c.json(await overview(ctx, outletScope(c), can(user, ctx.settings, "booking.view_all") ? null : user.id));
  });
  app.get("/api/dashboards/allocation", async (c) => {
    need(c, "dashboards.view");
    const ctx = c.get("ctx");
    const user = c.get("user");
    let rows = await allocationDashboard(ctx, outletScope(c));
    if (!can(user, ctx.settings, "booking.view_all")) {
      const mine = new Set((await all<{ id: string }>(ctx.db, `SELECT id FROM bookings WHERE tenant_id = ? AND (sales_exec_id = ? OR created_by = ?)`, ctx.tenantId, user.id, user.id)).map((b) => b.id));
      rows = rows.filter((r) => mine.has(r.booking_id));
    }
    return c.json(rows);
  });
  // ------------------------------------------------------------ analytics: fixed rules over the two DMS files
  /** A period from the query (from, to as YYYY-MM-DD), default the last `days` days to today. */
  const periodOf = (c: C, days: number) => {
    const ctx = c.get("ctx");
    const today = localParts(ctx.now, ctx.tenant.timezone).date;
    const from = c.req.query("from") ? parseDate(c.req.query("from")) : addDays(today, -(days - 1));
    const to = c.req.query("to") ? parseDate(c.req.query("to")) : today;
    if (!from || !to || from > to) throw bad("The period is not valid");
    if (to > today) throw bad("The period cannot end in the future");
    return { from, to };
  };
  /** Allocations and releases by day and outlet (default: the last 14 days). */
  app.get("/api/analytics/allocations", async (c) => {
    need(c, "dashboards.view");
    return c.json(await allocationsByDay(c.get("ctx"), outletScope(c), periodOf(c, 14)));
  });
  /** The stock position of each outlet, day by day (default: the last 30 days). */
  app.get("/api/analytics/stock-days", async (c) => {
    need(c, "stock.view");
    const ctx = c.get("ctx");
    return c.json(await stockByDay(ctx, outletScope(c), periodOf(c, 30), can(c.get("user"), ctx.settings, "stock.value")));
  });
  app.get("/api/analytics/ageing", async (c) => {
    need(c, "dashboards.view");
    const ctx = c.get("ctx");
    return c.json(await ageingByModel(ctx, outletScope(c), can(c.get("user"), ctx.settings, "stock.value")));
  });
  /** Customers whose car has waited for them at the dealership for more than `days` days (default 10). */
  app.get("/api/analytics/not-picked-up", async (c) => {
    need(c, "booking.view_all");
    const days = c.req.query("days") === undefined ? 10 : Number(c.req.query("days"));
    if (!Number.isInteger(days) || days < 0 || days > 365) throw bad("Days must be a whole number up to 365");
    return c.json(await notPickedUp(c.get("ctx"), outletScope(c), days));
  });
  /** Most and least selling model and car for a period (from, to as YYYY-MM-DD; default: the last 90 days). */
  app.get("/api/analytics/sales", async (c) => {
    need(c, "dashboards.view");
    const ctx = c.get("ctx");
    const def = defaultSalesPeriod(ctx);
    const from = c.req.query("from") ? parseDate(c.req.query("from")) : def.from;
    const to = c.req.query("to") ? parseDate(c.req.query("to")) : def.to;
    if (!from || !to || from > to) throw bad("The period is not valid");
    if (to > def.to) throw bad("The period cannot end in the future");
    return c.json(await salesRanking(ctx, outletScope(c), { from, to }));
  });

  app.get("/api/dashboards/order-queue", async (c) => {
    need(c, "dashboards.view");
    return c.json(await orderQueueDashboard(c.get("ctx")));
  });
  app.get("/api/dashboards/delayed", async (c) => {
    need(c, "dashboards.view");
    const ctx = c.get("ctx");
    const user = c.get("user");
    let rows = await delayedDashboard(ctx, outletScope(c));
    if (!can(user, ctx.settings, "booking.view_all")) {
      const mine = new Set((await all<{ id: string }>(ctx.db, `SELECT id FROM bookings WHERE tenant_id = ? AND (sales_exec_id = ? OR created_by = ?)`, ctx.tenantId, user.id, user.id)).map((b) => b.id));
      rows = rows.filter((r) => mine.has(r.booking_id));
    }
    return c.json(rows);
  });

  // ------------------------------------------------------------ the owner's view, measures, out-of-turn allocations, matches
  app.get("/api/dashboards/owner", async (c) => {
    need(c, "owner.view");
    const ctx = c.get("ctx");
    return c.json(await ownerView(ctx, outletScope(c), can(c.get("user"), ctx.settings, "stock.value")));
  });

  // ---- what each role answers for. One dataset per question; several screens read each one.
  /** What each model is doing: standing, moving, selling, on order, and what it ties up. */
  app.get("/api/views/models", async (c) => {
    need(c, "stock.view");
    const ctx = c.get("ctx");
    return c.json(await modelPicture(ctx, outletScope(c), can(c.get("user"), ctx.settings, "stock.value")));
  });

  /** Cars a booking is holding: how long, paid or not, invoiced or not. */
  app.get("/api/views/holding", async (c) => {
    need(c, "dashboards.view");
    return c.json(await holdingCars(c.get("ctx"), outletScope(c)));
  });

  /** Customers with no car yet, oldest first. */
  app.get("/api/views/waiting", async (c) => {
    need(c, "dashboards.view");
    return c.json(await waitingLine(c.get("ctx"), outletScope(c)));
  });

  /** What moved each day: allocated, released, invoiced, delivered. */
  app.get("/api/views/daily", async (c) => {
    need(c, "dashboards.view");
    const ctx = c.get("ctx");
    const today = localParts(ctx.now, ctx.tenant.timezone).date;
    const from = c.req.query("from") ? parseDate(c.req.query("from")) : addDays(today, -29);
    const to = c.req.query("to") ? parseDate(c.req.query("to")) : today;
    if (!from || !to || from > to) throw bad("The period is not valid");
    return c.json(await dailyMovement(ctx, from, to, outletScope(c)));
  });

  /** A sales executive's own picture. */
  app.get("/api/views/mine", async (c) => {
    need(c, "booking.view");
    return c.json(await myWork(c.get("ctx"), c.get("user").id));
  });

  /** How the month is going: retails so far, the month before to the same day, the target and the pace. */
  app.get("/api/dashboards/month", async (c) => {
    need(c, "owner.view");
    const ctx = c.get("ctx");
    return c.json(await monthPace(ctx, outletScope(c), can(c.get("user"), ctx.settings, "stock.value")));
  });

  /** The agreed measures for a period (from, to as YYYY-MM-DD; default: this month to date) against the period before it. */
  app.get("/api/dashboards/measures", async (c) => {
    need(c, "owner.view");
    const ctx = c.get("ctx");
    const today = localParts(ctx.now, ctx.tenant.timezone).date;
    const from = c.req.query("from") ? parseDate(c.req.query("from")) : `${today.slice(0, 7)}-01`;
    const to = c.req.query("to") ? parseDate(c.req.query("to")) : today;
    if (!from || !to || from > to) throw bad("The period is not valid");
    if (to > today) throw bad("The period cannot end in the future");
    return c.json(await measures(ctx, { from, to }, can(c.get("user"), ctx.settings, "stock.value")));
  });

  app.get("/api/dashboards/out-of-turn", async (c) => {
    need(c, "owner.view");
    const ctx = c.get("ctx");
    const today = localParts(ctx.now, ctx.tenant.timezone).date;
    const from = c.req.query("from") ? parseDate(c.req.query("from")) : addDays(today, -90);
    if (!from) throw bad("The date is not valid");
    return c.json(await outOfTurn(ctx, outletScope(c), localDayBounds(from, ctx.tenant.timezone).start, 500));
  });

  /** The Dealer Principal or Business Head records that an out-of-turn allocation nobody approved beforehand has been looked at, and what was found. */
  app.post("/api/out-of-turn/:id/review", async (c) => {
    need(c, "owner.review");
    const ctx = c.get("ctx");
    const note = String((await jsonBody(c)).note ?? "").trim().slice(0, 1000);
    if (!note) throw bad("Say what was found");
    const a = await first<{ id: string; booking_id: string; exception_id: string | null; reviewed_at: string | null; out_of_turn: number; trace: string }>(ctx.db, `SELECT id, booking_id, exception_id, reviewed_at, out_of_turn, rule_trace_json AS trace FROM allocations WHERE id = ? AND tenant_id = ?`, c.req.param("id"), ctx.tenantId);
    if (!a || !a.out_of_turn) throw notFound("Out-of-turn allocation");
    if (a.exception_id || safeJson<Record<string, unknown>>(a.trace, {}).priority_exception_id) throw conflict("This allocation was approved beforehand; there is nothing to review");
    if (a.reviewed_at) throw conflict("This allocation has already been reviewed");
    await run(ctx.db, `UPDATE allocations SET reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ? AND tenant_id = ? AND reviewed_at IS NULL`, ctx.actor, iso(ctx.now), note, a.id, ctx.tenantId);
    await audit(ctx, "OUT_OF_TURN_REVIEWED", "booking", a.booking_id, { allocation_id: a.id, note });
    return c.json({ ok: true });
  });

  /** Waiting customers who could be offered a car of the same model and variant in another colour. */
  app.get("/api/dashboards/matches", async (c) => {
    need(c, "dashboards.view");
    const ctx = c.get("ctx");
    const user = c.get("user");
    return c.json(await nearMatches(ctx, outletScope(c), can(user, ctx.settings, "booking.view_all") ? null : user.id));
  });

  // ------------------------------------------------------------ alerts and alarms for the signed-in persona
  app.get("/api/alerts", async (c) => {
    const ctx = c.get("ctx");
    const user = c.get("user");
    const scope = outletScope(c);
    // An alert is addressed either to one named user or to a role (limited to the user's outlets). `alarms=1` gives only the alarms.
    const inScope = scope ? `AND (outlet_id IS NULL OR outlet_id IN (${scope.map(() => "?").join(",") || "''"}))` : "";
    const rows = await all<any>(
      ctx.db,
      `SELECT * FROM alerts WHERE tenant_id = ? AND (target_user = ? OR (target_user IS NULL AND (target_role = ? OR target_role IS NULL) ${inScope})) ${c.req.query("alarms") === "1" ? "AND is_alarm = 1" : ""} ORDER BY created_at DESC LIMIT 100`,
      ctx.tenantId, user.id, user.role, ...(scope ?? []),
    );
    return c.json(rows.map((r) => ({ ...r, is_alarm: Boolean(r.is_alarm), kind_label: r.is_alarm ? ALARM_KINDS[r.kind] ?? null : null })));
  });
  app.post("/api/alerts/:id/read", async (c) => {
    const ctx = c.get("ctx");
    const user = c.get("user");
    await run(ctx.db, `UPDATE alerts SET read_at = ? WHERE id = ? AND tenant_id = ? AND (target_user = ? OR (target_user IS NULL AND (target_role = ? OR target_role IS NULL))) AND read_at IS NULL`, iso(ctx.now), c.req.param("id"), ctx.tenantId, user.id, user.role);
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------ audit trail
  app.get("/api/audit", async (c) => {
    need(c, "audit.view");
    const ctx = c.get("ctx");
    // The trail covers the whole dealership, so it is for people who work across all outlets.
    if (outletScope(c)) throw forbidden("The audit trail covers every outlet. Ask the administrator for access to all outlets.");
    const q = c.req.query();
    const where = ["a.tenant_id = ?"];
    const p: unknown[] = [ctx.tenantId];
    if (q.entity_type) (where.push("a.entity_type = ?"), p.push(q.entity_type));
    if (q.entity_id) (where.push("a.entity_id = ?"), p.push(q.entity_id));
    if (q.action) (where.push("a.action = ?"), p.push(q.action));
    if (q.from) (where.push("a.at >= ?"), p.push(q.from));
    const rows = await all<any>(ctx.db, `SELECT a.*, u.name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor WHERE ${where.join(" AND ")} ORDER BY a.at DESC LIMIT ?`, ...p, Math.min(Number(q.limit) || 200, 1000));
    return c.json(rows.map((r) => ({ ...r, detail: safeJson(r.detail_json, {}), detail_json: undefined })));
  });

  // ------------------------------------------------------------ day-end reconciliation
  app.post("/api/recon/run", async (c) => {
    need(c, "recon.manage");
    const ctx = c.get("ctx");
    return c.json(await runReconciliation(ctx, ctx.actor), 201);
  });
  app.get("/api/recon/runs", async (c) => {
    need(c, "recon.view");
    const ctx = c.get("ctx");
    const rows = await all<any>(
      ctx.db,
      `SELECT r.id, r.business_date, r.trigger, r.started_at, r.summary_json, u.name AS run_by,
              (SELECT COUNT(*) FROM recon_items i WHERE i.run_id = r.id AND i.status = 'OPEN') AS open_items
       FROM recon_runs r LEFT JOIN users u ON u.id = r.trigger WHERE r.tenant_id = ? ORDER BY r.business_date DESC, r.started_at DESC LIMIT 60`,
      ctx.tenantId,
    );
    return c.json(rows.map((r) => ({ id: r.id, business_date: r.business_date, trigger: r.trigger === "SCHEDULED" ? "SCHEDULED" : "MANUAL", run_by: r.run_by, started_at: r.started_at, open_items: r.open_items, items: safeJson<any>(r.summary_json, {}).items ?? null })));
  });
  app.get("/api/recon/runs/:id", async (c) => {
    need(c, "recon.view");
    const ctx = c.get("ctx");
    const r = await first<any>(ctx.db, `SELECT r.*, u.name AS run_by FROM recon_runs r LEFT JOIN users u ON u.id = r.trigger WHERE r.id = ? AND r.tenant_id = ?`, c.req.param("id"), ctx.tenantId);
    if (!r) throw notFound("Reconciliation run");
    const scope = outletScope(c);
    let items = await all<any>(ctx.db, `SELECT i.*, o.name AS outlet, u.name AS resolved_by_name FROM recon_items i LEFT JOIN outlets o ON o.id = i.outlet_id LEFT JOIN users u ON u.id = i.resolved_by WHERE i.tenant_id = ? AND i.run_id = ? ORDER BY CASE i.severity WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END, i.category`, ctx.tenantId, r.id);
    if (scope) items = items.filter((i) => !i.outlet_id || scope.includes(i.outlet_id));
    if (c.req.query("format") === "csv") {
      const csv = toCsv([["Severity", "Category", "Outlet", "Finding", "Status", "Resolution"], ...items.map((i) => [i.severity, RECON_CATEGORIES[i.category] ?? i.category, i.outlet ?? "", i.message, i.status, i.resolution_note ?? ""])]);
      return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="reconciliation-${r.business_date}.csv"` } });
    }
    return c.json({ id: r.id, business_date: r.business_date, trigger: r.trigger === "SCHEDULED" ? "SCHEDULED" : "MANUAL", run_by: r.run_by, started_at: r.started_at, summary: safeJson(r.summary_json, {}), categories: RECON_CATEGORIES, items: items.map((i) => ({ ...i, detail: safeJson(i.detail_json, {}), detail_json: undefined })) });
  });
  app.post("/api/recon/items/:id/resolve", async (c) => {
    need(c, "recon.manage");
    const ctx = c.get("ctx");
    const note = String((await jsonBody(c)).note ?? "").slice(0, 1000);
    if (!note.trim()) throw bad("A note is required to close an item");
    const item = await first<{ severity: string; outlet_id: string | null }>(ctx.db, `SELECT severity, outlet_id FROM recon_items WHERE id = ? AND tenant_id = ?`, c.req.param("id"), ctx.tenantId);
    if (!item) throw notFound("Finding");
    const scope = outletScope(c);
    if (scope && item.outlet_id && !scope.includes(item.outlet_id)) throw forbidden("This finding belongs to an outlet you do not have access to");
    // Serious findings (a bypassed allocation, a broken queue order, a stock count that does not add up) are
    // closed by the Business Head or the administrator, not by the people whose work they question.
    if (item.severity === "HIGH" && !["BUSINESS_HEAD", "DEALER_PRINCIPAL", "ADMIN"].includes(c.get("user").role)) throw forbidden("A high-severity finding can be closed only by the Business Head / CEO, the Dealer Principal or the administrator");
    await resolveItem(ctx, c.req.param("id"), note);
    await audit(ctx, "RECON_ITEM_RESOLVED", "recon_item", c.req.param("id"), { note: note.trim() });
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------ WhatsApp: webhook (public, called by Meta)
  app.get("/api/wa/webhook", (c) => verifyWebhook(c.env, c.env.DB, new URL(c.req.url)));
  app.post("/api/wa/webhook", async (c) => handleWebhookEvent(c.env, c.env.DB, await c.req.text(), c.req.header("X-Hub-Signature-256") ?? null, clock.now()));

  // ------------------------------------------------------------ WhatsApp: number and credentials
  app.get("/api/wa/config", async (c) => {
    need(c, "wa.view");
    const ctx = c.get("ctx");
    await ensureWaDefaults(ctx.db, ctx.tenantId, ctx.now);
    return c.json(publicConfig(c, await first<WaConfigRow>(ctx.db, `SELECT * FROM wa_config WHERE tenant_id = ?`, ctx.tenantId)));
  });

  app.put("/api/wa/config", async (c) => {
    need(c, "wa.manage");
    const ctx = c.get("ctx");
    await ensureWaDefaults(ctx.db, ctx.tenantId, ctx.now);
    const cur = (await first<WaConfigRow>(ctx.db, `SELECT * FROM wa_config WHERE tenant_id = ?`, ctx.tenantId))!;
    const b = await jsonBody(c);
    const provider = b.provider === undefined ? cur.provider : b.provider;
    if (!["TEST", "META"].includes(provider)) throw bad("Provider must be TEST or META");
    const str = (v: unknown, old: string | null) => (v === undefined ? old : String(v).trim() || null);
    const phoneNumberId = str(b.phone_number_id, cur.phone_number_id);
    const wabaId = str(b.waba_id, cur.waba_id);
    if (phoneNumberId && !/^\d{5,25}$/.test(phoneNumberId)) throw bad("Phone number ID should be the numeric ID shown in WhatsApp Manager, not the phone number");
    if (wabaId && !/^\d{5,25}$/.test(wabaId)) throw bad("WhatsApp Business Account ID should be numeric");
    const graphVersion = str(b.graph_version, cur.graph_version);
    if (graphVersion && !/^v\d{1,2}\.\d$/.test(graphVersion)) throw bad("Graph API version looks like v23.0");
    let displayNumber = cur.display_number;
    if (b.display_number !== undefined) {
      displayNumber = b.display_number ? normMobile(b.display_number) : null;
      if (b.display_number && !displayNumber) throw bad("Display number is not a valid phone number");
    }
    const token = b.access_token ? await encryptSecret(String(b.access_token).trim(), c.env.DATA_KEY) : cur.access_token_enc;
    const appSecret = b.app_secret ? await encryptSecret(String(b.app_secret).trim(), c.env.DATA_KEY) : cur.app_secret_enc;
    const verifyToken = str(b.verify_token, cur.verify_token);
    if (provider === "META" && (!phoneNumberId || !token)) throw bad("To go live, the phone number ID and access token are both required");
    if (phoneNumberId) {
      // A WhatsApp number belongs to exactly one dealership: delivery receipts are routed by it.
      const other = await first(ctx.db, `SELECT tenant_id FROM wa_config WHERE phone_number_id = ? AND tenant_id <> ?`, phoneNumberId, ctx.tenantId);
      if (other) throw conflict("This WhatsApp number is already connected to another dealership");
    }
    const identityChanged = phoneNumberId !== cur.phone_number_id || Boolean(b.access_token) || provider !== cur.provider || graphVersion !== cur.graph_version;
    if (provider === "META" && identityChanged) {
      // Going live is allowed only when Meta confirms that this access token really controls this number.
      const check = await verifyNumberMeta({ phoneNumberId: phoneNumberId!, wabaId, accessToken: b.access_token ? String(b.access_token).trim() : await decryptSecret(cur.access_token_enc!, c.env.DATA_KEY), graphVersion: graphVersion || c.env.WA_GRAPH_VERSION || "v23.0" });
      if (!check.ok) throw bad(`Meta did not confirm this phone number ID with this access token: ${check.error}`);
      if (b.display_number === undefined && check.displayNumber) displayNumber = normMobile(check.displayNumber) ?? displayNumber;
    }
    await run(
      ctx.db,
      `UPDATE wa_config SET provider = ?, enabled = ?, display_number = ?, phone_number_id = ?, waba_id = ?, access_token_enc = ?, app_secret_enc = ?, verify_token = ?, graph_version = ?, updated_by = ?, updated_at = ? WHERE tenant_id = ?`,
      provider, b.enabled === undefined ? cur.enabled : b.enabled ? 1 : 0, displayNumber, phoneNumberId, wabaId, token, appSecret, verifyToken, graphVersion, ctx.actor, iso(ctx.now), ctx.tenantId,
    );
    await audit(ctx, "WA_CONFIG_CHANGED", "tenant", ctx.tenantId, { provider, enabled: b.enabled, phone_number_id: phoneNumberId, waba_id: wabaId, display_number: displayNumber, token_changed: Boolean(b.access_token), app_secret_changed: Boolean(b.app_secret) });
    return c.json(publicConfig(c, await first<WaConfigRow>(ctx.db, `SELECT * FROM wa_config WHERE tenant_id = ?`, ctx.tenantId)));
  });

  // ------------------------------------------------------------ WhatsApp: message templates
  app.get("/api/wa/templates", async (c) => {
    need(c, "wa.view");
    const ctx = c.get("ctx");
    await ensureWaDefaults(ctx.db, ctx.tenantId, ctx.now);
    const rows = await all<any>(ctx.db, `SELECT event_key, audience, template_name, language, body, enabled, meta_status, updated_at FROM wa_templates WHERE tenant_id = ?`, ctx.tenantId);
    return c.json(
      DEFAULT_TEMPLATES.map((d) => {
        const r = rows.find((x) => x.event_key === d.event_key);
        return { event_key: d.event_key, title: d.title, when: d.when, audience: d.audience, category: d.category ?? "UTILITY", fixed_wording: d.category === "AUTHENTICATION", template_name: r?.template_name ?? d.template_name, language: r?.language ?? d.language, body: r?.body ?? d.body, default_body: d.body, enabled: Boolean(r?.enabled ?? 1), meta_status: r?.meta_status ?? null, params: paramNames(r?.body ?? d.body), available_params: Object.keys(d.examples), examples: d.examples };
      }),
    );
  });

  app.put("/api/wa/templates/:key", async (c) => {
    need(c, "wa.manage");
    const ctx = c.get("ctx");
    const def = DEFAULT_TEMPLATES.find((d) => d.event_key === c.req.param("key"));
    if (!def) throw notFound("Message");
    await ensureWaDefaults(ctx.db, ctx.tenantId, ctx.now);
    const cur = (await first<any>(ctx.db, `SELECT * FROM wa_templates WHERE tenant_id = ? AND event_key = ?`, ctx.tenantId, def.event_key))!;
    const b = await jsonBody(c);
    const body = b.body === undefined ? cur.body : String(b.body).trim();
    if (def.category === "AUTHENTICATION" && body !== def.body) throw bad("WhatsApp fixes the wording of a one-time code message; only its template name and language can be changed");
    const problem = def.category === "AUTHENTICATION" ? null : validateTemplateBody(body);
    if (problem) throw bad(problem);
    const unknown = paramNames(body).filter((p) => !(p in def.examples));
    if (unknown.length) throw bad(`Unknown parameter(s): ${unknown.join(", ")}. Available: ${Object.keys(def.examples).join(", ")}`);
    const name = b.template_name === undefined ? cur.template_name : String(b.template_name).trim();
    if (!/^[a-z0-9_]{1,512}$/.test(name)) throw bad("Template name may contain only lowercase letters, digits and underscores");
    const language = b.language === undefined ? cur.language : String(b.language).trim();
    if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(language)) throw bad("Language code looks like en or en_US");
    const changedWording = body !== cur.body || name !== cur.template_name || language !== cur.language;
    await run(ctx.db, `UPDATE wa_templates SET template_name = ?, language = ?, body = ?, enabled = ?, meta_status = ?, updated_at = ? WHERE tenant_id = ? AND event_key = ?`, name, language, body, b.enabled === undefined ? cur.enabled : b.enabled ? 1 : 0, changedWording ? null : cur.meta_status, iso(ctx.now), ctx.tenantId, def.event_key);
    await audit(ctx, "WA_TEMPLATE_CHANGED", "wa_template", def.event_key, { template_name: name, language, enabled: b.enabled, wording_changed: changedWording });
    return c.json({ ok: true });
  });

  /** Sends one template to Meta for approval, with example values. */
  app.post("/api/wa/templates/:key/submit", async (c) => {
    need(c, "wa.manage");
    const ctx = c.get("ctx");
    const def = DEFAULT_TEMPLATES.find((d) => d.event_key === c.req.param("key"));
    if (!def) throw notFound("Message");
    const cfg = await first<WaConfigRow>(ctx.db, `SELECT * FROM wa_config WHERE tenant_id = ?`, ctx.tenantId);
    const creds = cfg ? await loadCredentials(c.env, cfg) : null;
    if (!creds) throw bad("Connect the WhatsApp number first (phone number ID and access token)");
    const t = (await first<any>(ctx.db, `SELECT * FROM wa_templates WHERE tenant_id = ? AND event_key = ?`, ctx.tenantId, def.event_key))!;
    const res = def.category === "AUTHENTICATION" ? await createOtpTemplateMeta(creds, { name: t.template_name, language: t.language }) : await createTemplateMeta(creds, { name: t.template_name, language: t.language, body: t.body, examples: def.examples, paramOrder: paramNames(t.body) });
    if (!res.ok) throw bad(`Meta did not accept the template: ${res.error}`);
    await run(ctx.db, `UPDATE wa_templates SET meta_status = ?, updated_at = ? WHERE tenant_id = ? AND event_key = ?`, res.status ?? "PENDING", iso(ctx.now), ctx.tenantId, def.event_key);
    await audit(ctx, "WA_TEMPLATE_SUBMITTED", "wa_template", def.event_key, { template_name: t.template_name, status: res.status });
    return c.json({ status: res.status ?? "PENDING" });
  });

  /** Reads approval status back from Meta for every template. */
  app.post("/api/wa/templates/refresh", async (c) => {
    need(c, "wa.manage");
    const ctx = c.get("ctx");
    const cfg = await first<WaConfigRow>(ctx.db, `SELECT * FROM wa_config WHERE tenant_id = ?`, ctx.tenantId);
    const creds = cfg ? await loadCredentials(c.env, cfg) : null;
    if (!creds) throw bad("Connect the WhatsApp number first (phone number ID and access token)");
    const res = await listTemplatesMeta(creds);
    if (!res.ok) throw bad(`Could not read templates from Meta: ${res.error}`);
    const mine = await all<{ event_key: string; template_name: string; language: string }>(ctx.db, `SELECT event_key, template_name, language FROM wa_templates WHERE tenant_id = ?`, ctx.tenantId);
    const out: Record<string, string> = {};
    for (const t of mine) {
      const m = res.templates!.find((x) => x.name === t.template_name && x.language === t.language);
      const status = m?.status ?? "NOT_FOUND";
      out[t.event_key] = status;
      await run(ctx.db, `UPDATE wa_templates SET meta_status = ? WHERE tenant_id = ? AND event_key = ?`, status, ctx.tenantId, t.event_key);
    }
    return c.json(out);
  });

  /** Sends one message with example values to a number you choose, to prove the connection end to end. */
  app.post("/api/wa/test", async (c) => {
    need(c, "wa.manage");
    const ctx = c.get("ctx");
    const b = await jsonBody(c);
    const to = normMobile(b.to);
    if (!to) throw bad("Enter a valid mobile number to send the test to");
    const def = DEFAULT_TEMPLATES.find((d) => d.event_key === (b.event_key ?? "ALLOC_FREE_STOCK"));
    if (!def) throw bad("Unknown message");
    if (def.category === "AUTHENTICATION") throw bad("The one-time code message is tested from the sign-in page (Set or reset password)");
    await ensureWaDefaults(ctx.db, ctx.tenantId, ctx.now);
    await (await messageStmt(ctx, { eventKey: def.event_key as EventKey, toMobile: to, toName: "Test", params: def.examples })).run();
    await dispatchQueued(c.env, ctx.db, ctx.now, { tenantId: ctx.tenantId });
    const msg = await first(ctx.db, `SELECT id, status, error, provider, provider_message_id, rendered_text, to_mobile FROM wa_messages WHERE tenant_id = ? AND to_mobile = ? ORDER BY created_at DESC LIMIT 1`, ctx.tenantId, to);
    await audit(ctx, "WA_TEST_SENT", "tenant", ctx.tenantId, { to, event_key: def.event_key });
    return c.json(msg);
  });

  // ------------------------------------------------------------ WhatsApp: message log
  app.get("/api/wa/messages", async (c) => {
    need(c, "wa.view");
    const ctx = c.get("ctx");
    const q = c.req.query();
    const where = ["m.tenant_id = ?"];
    const p: unknown[] = [ctx.tenantId];
    if (q.status) (where.push("m.status = ?"), p.push(q.status));
    if (q.event_key) (where.push("m.event_key = ?"), p.push(q.event_key));
    if (q.q) (where.push("(m.to_mobile LIKE ? OR b.booking_no LIKE ? OR m.to_name LIKE ?)"), p.push(`%${likeText(q.q.replace(/\D/g, "")) || "~"}%`, `%${likeText(q.q.toUpperCase())}%`, `%${likeText(q.q)}%`));
    // Someone who works in certain outlets sees the messages of those outlets' bookings only.
    const scope = outletScope(c);
    const scoped = scope ? `AND b.outlet_id IN (${scope.map(() => "?").join(",") || "''"})` : "";
    const from = `FROM wa_messages m LEFT JOIN bookings b ON b.id = m.booking_id AND b.tenant_id = m.tenant_id`;
    const rows = await all(ctx.db, `SELECT m.id, m.event_key, m.audience, m.to_mobile, m.to_name, m.booking_id, b.booking_no, m.template_name, m.rendered_text, m.status, m.provider, m.error, m.attempts, m.created_at, m.sent_at, m.delivered_at, m.read_at ${from} WHERE ${where.join(" AND ")} ${scoped} ORDER BY m.created_at DESC LIMIT 300`, ...p, ...(scope ?? []));
    const counts = await all(ctx.db, `SELECT m.status, COUNT(*) AS n ${from} WHERE m.tenant_id = ? ${scoped} GROUP BY m.status`, ctx.tenantId, ...(scope ?? []));
    return c.json({ messages: rows, counts });
  });

  app.post("/api/wa/messages/:id/retry", async (c) => {
    if (!can(c.get("user"), c.get("ctx").settings, "wa.resend")) need(c, "wa.manage");
    const ctx = c.get("ctx");
    // Only a failed send can be repeated. A message that was skipped (no customer consent, messaging switched off) stays skipped.
    const n = await run(ctx.db, `UPDATE wa_messages SET status = 'QUEUED', attempts = 0, next_attempt_at = ?, error = NULL WHERE id = ? AND tenant_id = ? AND status = 'FAILED'`, iso(ctx.now), c.req.param("id"), ctx.tenantId);
    if (!n) throw conflict("Only a message that failed can be sent again");
    await dispatchQueued(c.env, ctx.db, ctx.now, { tenantId: ctx.tenantId });
    return c.json(await first(ctx.db, `SELECT id, status, error FROM wa_messages WHERE id = ?`, c.req.param("id")));
  });

  app.get("/api/wa/inbound", async (c) => {
    need(c, "wa.view");
    const ctx = c.get("ctx");
    return c.json(await recentInbound(ctx.db, ctx.tenantId, outletScope(c)));
  });

}
