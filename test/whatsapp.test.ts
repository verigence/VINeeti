// The WhatsApp module: each dealership connects its own number from the settings screen; messages are
// recorded in an outbox, sent through Meta's Cloud API, retried on failure, and their delivery receipts
// come back through one webhook.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { hmacSha256Hex } from "../src/lib/crypto";
import { addCar, approvedBooking, CRETA, makeDealer, makeWorld, VENUE, type Dealer, type World } from "./harness";

let w: World;
let a: Dealer;
let b: Dealer;

const LIVE = { provider: "META", display_number: "+91 674 555 0100", phone_number_id: "106540352242922", waba_id: "102290129340398", access_token: "EAAG-secret-token", app_secret: "app-secret-123", verify_token: "verify-me-123" };
const lastMessage = (tenantId: string) => w.db.q<any>(`SELECT * FROM wa_messages WHERE tenant_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`, tenantId)[0];

function mockMeta(handler: (url: string, init: RequestInit) => { status: number; json: unknown }) {
  const calls: { url: string; init: RequestInit; body: any }[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit = {}) => {
    const u = String(url);
    calls.push({ url: u, init, body: init.body ? JSON.parse(String(init.body)) : null });
    const r = handler(u, init);
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { "Content-Type": "application/json" } });
  });
  return calls;
}

async function signed(secret: string, payload: unknown) {
  const raw = JSON.stringify(payload);
  return w.api("POST", "/api/wa/webhook", raw, undefined, { "Content-Type": "application/json", "X-Hub-Signature-256": "sha256=" + (await hmacSha256Hex(secret, raw)) });
}
const statusEvent = (phoneId: string, id: string, status: string, extra: Record<string, unknown> = {}) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "WABA", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "916745550100", phone_number_id: phoneId }, statuses: [{ id, status, timestamp: "1792000000", recipient_id: "919876500001", ...extra }] } }] }],
});

beforeAll(async () => {
  w = makeWorld("2026-10-13 10:00");
  a = await makeDealer(w, "northstar-hyundai");
  b = await makeDealer(w, "sai-tata");
});
afterEach(() => vi.unstubAllGlobals());

describe("test mode (before a number is connected)", () => {
  it("records every message and marks it sent without calling Meta", async () => {
    const calls = mockMeta(() => ({ status: 500, json: {} }));
    await addCar(w, a, "MALC841CLRM400001", CRETA, "PATIA", "RECEIVED");
    const bk = await approvedBooking(w, a, "se1", CRETA, "PATIA", "Rahul Sharma", "9876500001");
    const m = lastMessage(a.tenantId);
    expect(m).toMatchObject({ booking_id: bk.id, event_key: "ALLOC_FREE_STOCK", status: "SENT", provider: "TEST", template_name: "allocation_free_stock" });
    expect(calls).toHaveLength(0);
  });

  it("a customer who has not agreed to WhatsApp is not messaged, and the reason is recorded", async () => {
    await addCar(w, a, "MALC841CLRM400002", CRETA, "PATIA", "RECEIVED");
    const bk = await approvedBooking(w, a, "se1", CRETA, "PATIA", "No Consent", "9876500007", { wa_opt_in: false });
    expect(bk.approval.allocations).toHaveLength(1);
    const skipped = lastMessage(a.tenantId);
    expect(skipped).toMatchObject({ booking_id: bk.id, status: "SKIPPED", error: "Customer has not agreed to WhatsApp messages" });
    // "Send again" in the log is for failures; it cannot be used to message someone who did not consent.
    expect((await w.api("POST", `/api/wa/messages/${skipped.id}/retry`, undefined, a.users.admin.session)).status).toBe(409);
    expect(lastMessage(a.tenantId).status).toBe("SKIPPED");
  });
});

describe("connecting a dealership's number", () => {
  it("only an administrator can change the connection", async () => {
    expect((await w.api("PUT", "/api/wa/config", LIVE, a.users.head.session)).status).toBe(403);
    expect((await w.api("PUT", "/api/wa/config", LIVE, a.users.sm.session)).status).toBe(403);
    expect((await w.api("GET", "/api/wa/config", undefined, a.users.se1.session)).status).toBe(403);
  });

  it("checks the values before going live", async () => {
    const s = a.users.admin.session;
    expect((await w.api("PUT", "/api/wa/config", { provider: "META" }, s)).status).toBe(400);
    const wrongId = await w.api("PUT", "/api/wa/config", { ...LIVE, phone_number_id: "+91 674 555 0100" }, s);
    expect(wrongId.status).toBe(400);
    expect(wrongId.body.error.message).toContain("not the phone number");
    expect((await w.api("PUT", "/api/wa/config", { ...LIVE, graph_version: "23" }, s)).status).toBe(400);
  });

  it("goes live only when Meta confirms that the access token controls the number", async () => {
    const calls = mockMeta(() => ({ status: 400, json: { error: { message: "Unsupported get request. Object with ID '106540352242922' does not exist or you lack permission", code: 100 } } }));
    const res = await w.api("PUT", "/api/wa/config", LIVE, a.users.admin.session);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("Meta did not confirm");
    expect(calls[0].url).toBe(`https://graph.facebook.com/v23.0/${LIVE.phone_number_id}?fields=display_phone_number,verified_name`);
    expect((await w.api("GET", "/api/wa/config", undefined, a.users.admin.session)).body).toMatchObject({ provider: "TEST", connected: false, phone_number_id: null });
  });

  it("saves the connection, keeps the secrets encrypted and never returns them", async () => {
    mockMeta(() => ({ status: 200, json: { id: LIVE.phone_number_id, display_phone_number: "+91 674 555 0100", verified_name: "Northstar Motors" } }));
    const res = await w.api("PUT", "/api/wa/config", LIVE, a.users.admin.session);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ provider: "META", connected: true, phone_number_id: LIVE.phone_number_id, waba_id: LIVE.waba_id, display_number: "916745550100", has_access_token: true, has_app_secret: true, webhook_url: "https://app.test/api/wa/webhook" });
    const read = await w.api("GET", "/api/wa/config", undefined, a.users.auditor.session);
    expect(JSON.stringify(read.body)).not.toContain(LIVE.access_token);
    expect(JSON.stringify(read.body)).not.toContain(LIVE.app_secret);
    const row = w.db.q<any>(`SELECT * FROM wa_config WHERE tenant_id = ?`, a.tenantId)[0];
    expect(row.access_token_enc).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain(LIVE.access_token);
    expect(JSON.stringify(row)).not.toContain(LIVE.app_secret);
    // The change is on the audit trail, without the secret values.
    const audit = w.db.q<any>(`SELECT detail_json FROM audit_log WHERE tenant_id = ? AND action = 'WA_CONFIG_CHANGED' ORDER BY at DESC`, a.tenantId)[0];
    expect(audit.detail_json).toContain('"token_changed":true');
    expect(audit.detail_json).not.toContain(LIVE.access_token);
  });

  it("saving other fields later keeps the stored token", async () => {
    const res = await w.api("PUT", "/api/wa/config", { display_number: "9876512345" }, a.users.admin.session);
    expect(res.body).toMatchObject({ display_number: "919876512345", has_access_token: true, connected: true });
  });

  it("one number cannot be connected to two dealerships", async () => {
    const res = await w.api("PUT", "/api/wa/config", { ...LIVE, verify_token: "other" }, b.users.admin.session);
    expect(res.status).toBe(409);
  });
});

describe("sending through the WhatsApp Cloud API", () => {
  it("sends the approved template with named parameters and stores Meta's message id", async () => {
    const calls = mockMeta(() => ({ status: 200, json: { messaging_product: "whatsapp", contacts: [{ input: "919876500010", wa_id: "919876500010" }], messages: [{ id: "wamid.HBgM001" }] } }));
    await addCar(w, a, "MALC841CLRM400010", VENUE, "PATIA", "IN_TRANSIT", { expected_arrival_date: "2026-10-25" });
    const bk = await approvedBooking(w, a, "se1", VENUE, "PATIA", "Live Customer", "9876500010");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://graph.facebook.com/v23.0/${LIVE.phone_number_id}/messages`);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${LIVE.access_token}`);
    expect(calls[0].body).toMatchObject({ messaging_product: "whatsapp", to: "919876500010", type: "template", template: { name: "allocation_in_transit", language: { code: "en" } } });
    const params = calls[0].body.template.components[0].parameters;
    expect(calls[0].body.template.components[0].type).toBe("body");
    expect(params.map((p: any) => p.parameter_name)).toEqual(["customer_name", "vehicle", "booking_no", "eta", "dealership"]);
    expect(params.find((p: any) => p.parameter_name === "eta")).toEqual({ type: "text", parameter_name: "eta", text: "by 25 Oct 2026" });
    expect(lastMessage(a.tenantId)).toMatchObject({ booking_id: bk.id, status: "SENT", provider: "META", provider_message_id: "wamid.HBgM001" });
  });

  it("a temporary failure is retried later; the business action is not held up", async () => {
    let fail = true;
    const calls = mockMeta(() => (fail ? { status: 503, json: { error: { message: "Service temporarily unavailable", code: 2 } } } : { status: 200, json: { messages: [{ id: "wamid.RETRY" }] } }));
    await addCar(w, a, "MALC841CLRM400011", VENUE, "PATIA", "RECEIVED");
    const bk = await approvedBooking(w, a, "se1", VENUE, "PATIA", "Retry Customer", "9876500011");
    expect(bk.approval.allocations).toHaveLength(1); // allocation went through although WhatsApp was down
    let m = lastMessage(a.tenantId);
    expect(m).toMatchObject({ status: "QUEUED", attempts: 1 });
    expect(m.error).toContain("Service temporarily unavailable");
    // Not retried before the back-off time.
    w.at("2026-10-13 10:03");
    await w.tick();
    expect(calls).toHaveLength(1);
    fail = false;
    w.at("2026-10-13 10:06");
    await w.tick();
    m = lastMessage(a.tenantId);
    expect(m).toMatchObject({ status: "SENT", provider_message_id: "wamid.RETRY", attempts: 2, error: null });
  });

  it("a permanent failure is recorded with Meta's reason and can be re-sent from the log", async () => {
    let ok = false;
    mockMeta(() => (ok ? { status: 200, json: { messages: [{ id: "wamid.RESEND" }] } } : { status: 400, json: { error: { message: "(#132001) Template name does not exist in the translation", code: 132001, error_data: { details: "template name (allocation_free_stock) does not exist in en" } } } }));
    await addCar(w, a, "MALC841CLRM400012", VENUE, "PATIA", "RECEIVED");
    await approvedBooking(w, a, "se1", VENUE, "PATIA", "Failed Customer", "9876500012");
    const m = lastMessage(a.tenantId);
    expect(m.status).toBe("FAILED");
    expect(m.error).toContain("does not exist in en");
    expect(m.error).toContain("132001");
    const log = await w.api("GET", "/api/wa/messages?status=FAILED", undefined, a.users.admin.session);
    expect(log.body.messages.map((x: any) => x.id)).toContain(m.id);
    ok = true;
    expect((await w.api("POST", `/api/wa/messages/${m.id}/retry`, undefined, a.users.sm.session)).status).toBe(403);
    const again = await w.api("POST", `/api/wa/messages/${m.id}/retry`, undefined, a.users.admin.session);
    expect(again.body).toMatchObject({ status: "SENT" });
  });

  it("the test-send button proves the connection end to end", async () => {
    const calls = mockMeta(() => ({ status: 200, json: { messages: [{ id: "wamid.TEST" }] } }));
    const res = await w.api("POST", "/api/wa/test", { to: "98765 43210", event_key: "PAYMENT_REMINDER" }, a.users.admin.session);
    expect(res.body).toMatchObject({ status: "SENT", provider: "META", to_mobile: "919876543210" });
    expect(calls[0].body.template.name).toBe("payment_reminder");
    expect((await w.api("POST", "/api/wa/test", { to: "12" }, a.users.admin.session)).status).toBe(400);
  });
});

describe("delivery receipts and replies (webhook)", () => {
  it("answers Meta's verification with the dealership's verify token only", async () => {
    const ok = await w.api("GET", "/api/wa/webhook?hub.mode=subscribe&hub.verify_token=verify-me-123&hub.challenge=1158201444");
    expect(ok.status).toBe(200);
    expect(String(ok.body)).toBe("1158201444");
    expect((await w.api("GET", "/api/wa/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1")).status).toBe(403);
    expect((await w.api("GET", "/api/wa/webhook?hub.mode=subscribe&hub.challenge=1")).status).toBe(403);
  });

  it("refuses events that are not signed with the app secret", async () => {
    const payload = statusEvent(LIVE.phone_number_id, "wamid.HBgM001", "delivered");
    expect((await w.api("POST", "/api/wa/webhook", JSON.stringify(payload), undefined, { "Content-Type": "application/json" })).status).toBe(401);
    expect((await signed("some-other-secret", payload)).status).toBe(401);
    expect(w.db.q<any>(`SELECT status FROM wa_messages WHERE provider_message_id = 'wamid.HBgM001'`)[0].status).toBe("SENT");
  });

  it("moves a message to delivered, then read, and never backwards", async () => {
    const get = () => w.db.q<any>(`SELECT status, delivered_at, read_at FROM wa_messages WHERE provider_message_id = 'wamid.HBgM001'`)[0];
    expect((await signed(LIVE.app_secret, statusEvent(LIVE.phone_number_id, "wamid.HBgM001", "delivered"))).status).toBe(200);
    expect(get().status).toBe("DELIVERED");
    await signed(LIVE.app_secret, statusEvent(LIVE.phone_number_id, "wamid.HBgM001", "read"));
    expect(get().status).toBe("READ");
    await signed(LIVE.app_secret, statusEvent(LIVE.phone_number_id, "wamid.HBgM001", "delivered"));
    await signed(LIVE.app_secret, statusEvent(LIVE.phone_number_id, "wamid.HBgM001", "sent"));
    const row = get();
    expect(row.status).toBe("READ");
    expect(row.delivered_at && row.read_at).toBeTruthy();
  });

  it("records a failure reported after sending, with the reason", async () => {
    await signed(LIVE.app_secret, statusEvent(LIVE.phone_number_id, "wamid.RETRY", "failed", { errors: [{ code: 131026, title: "Message undeliverable", error_data: { details: "Recipient is not a WhatsApp user" } }] }));
    const row = w.db.q<any>(`SELECT status, error FROM wa_messages WHERE provider_message_id = 'wamid.RETRY'`)[0];
    expect(row.status).toBe("FAILED");
    expect(row.error).toContain("not a WhatsApp user");
  });

  it("keeps customer replies, once each, for the dealership that owns the number", async () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [{ id: "WABA", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: LIVE.phone_number_id }, contacts: [{ wa_id: "919876500010", profile: { name: "Live Customer" } }], messages: [{ from: "919876500010", id: "wamid.IN1", timestamp: "1792000100", type: "text", text: { body: "I will pay on Monday" } }] } }] }],
    };
    await signed(LIVE.app_secret, payload);
    await signed(LIVE.app_secret, payload); // Meta may deliver the same event twice
    const inbox = await w.api("GET", "/api/wa/inbound", undefined, a.users.sm.session);
    expect(inbox.body).toHaveLength(1);
    expect(inbox.body[0]).toMatchObject({ from_mobile: "919876500010", from_name: "Live Customer", text: "I will pay on Monday" });
    expect((await w.api("GET", "/api/wa/inbound", undefined, b.users.admin.session)).body).toHaveLength(0);
  });

  it("an event for one dealership's number cannot touch another dealership's messages", async () => {
    // Dealer B connects its own number and happens to hold a message with the same provider id.
    mockMeta((url) => (url.includes("/messages") ? { status: 200, json: { messages: [{ id: "wamid.SHARED" }] } } : { status: 200, json: { id: "222222222222", display_phone_number: "+91 98765 00000" } }));
    const connected = await w.api("PUT", "/api/wa/config", { provider: "META", phone_number_id: "222222222222", access_token: "tok-b", app_secret: "secret-b", verify_token: "verify-b" }, b.users.admin.session);
    expect(connected.body).toMatchObject({ connected: true, display_number: "919876500000" }); // the number Meta holds is filled in
    await w.api("POST", "/api/wa/test", { to: "9876500020" }, a.users.admin.session);
    await w.api("POST", "/api/wa/test", { to: "9876500021" }, b.users.admin.session);
    await signed("secret-b", statusEvent("222222222222", "wamid.SHARED", "read"));
    const rows = w.db.q<any>(`SELECT tenant_id, status FROM wa_messages WHERE provider_message_id = 'wamid.SHARED'`);
    expect(rows.find((r) => r.tenant_id === b.tenantId).status).toBe("READ");
    expect(rows.find((r) => r.tenant_id === a.tenantId).status).toBe("SENT");
    // B's secret does not validate an event for A's number.
    expect((await signed("secret-b", statusEvent(LIVE.phone_number_id, "wamid.SHARED", "read"))).status).toBe(401);
    // Nor when the forged event is packed together with a genuine-looking one for B's own number.
    const mixed = statusEvent("222222222222", "wamid.NONE", "read");
    mixed.entry[0].changes.push({ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "x", phone_number_id: LIVE.phone_number_id }, statuses: [{ id: "wamid.SHARED", status: "read", timestamp: "1792000000", recipient_id: "919876500020" }], messages: [{ from: "919999900000", id: "wamid.FORGED", timestamp: "1792000100", type: "text", text: { body: "forged reply" } }] } as any });
    expect((await signed("secret-b", mixed)).status).toBe(200);
    expect(w.db.q<any>(`SELECT status FROM wa_messages WHERE provider_message_id = 'wamid.SHARED' AND tenant_id = ?`, a.tenantId)[0].status).toBe("SENT");
    expect(w.db.q(`SELECT id FROM wa_inbound WHERE provider_message_id = 'wamid.FORGED'`)).toHaveLength(0);
  });
});

describe("message wording and Meta approval", () => {
  it("lists the six process messages, the management alarm and the password code, with their parameters", async () => {
    const res = await w.api("GET", "/api/wa/templates", undefined, a.users.admin.session);
    expect(res.body.map((t: any) => t.event_key)).toEqual(["ALLOC_IN_TRANSIT", "ALLOC_FREE_STOCK", "ALLOC_REALLOCATED", "STOCK_RECEIVED", "PAYMENT_REMINDER", "PAYMENT_ESCALATION", "MANAGEMENT_ALARM", "PASSWORD_OTP"]);
    expect(res.body[5]).toMatchObject({ audience: "STAFF", params: ["vehicle", "customer_name", "booking_no", "days", "release_date"] });
    expect(res.body[6]).toMatchObject({ audience: "STAFF", category: "UTILITY", fixed_wording: false, params: ["dealership", "title", "detail"] });
    // The one-time code is an authentication message: WhatsApp fixes its wording, so only the first seven can be reworded.
    expect(res.body[7]).toMatchObject({ audience: "STAFF", category: "AUTHENTICATION", fixed_wording: true, params: ["code"] });
    expect(res.body.filter((t: any) => t.fixed_wording).map((t: any) => t.event_key)).toEqual(["PASSWORD_OTP"]);
  });

  it("checks edited wording against the parameters that exist and Meta's rules", async () => {
    const s = a.users.admin.session;
    expect((await w.api("PUT", "/api/wa/templates/STOCK_RECEIVED", { body: "Dear {{customer_name}}, pay {{amount}} now." }, s)).body.error.message).toContain("amount");
    expect((await w.api("PUT", "/api/wa/templates/STOCK_RECEIVED", { body: "{{customer_name}} your car is here." }, s)).status).toBe(400);
    expect((await w.api("PUT", "/api/wa/templates/STOCK_RECEIVED", { template_name: "Stock Received" }, s)).status).toBe(400);
    expect((await w.api("PUT", "/api/wa/templates/STOCK_RECEIVED", { body: "x" }, a.users.head.session)).status).toBe(403);
    // The password-code message keeps WhatsApp's own wording; its template name and language are the dealership's to set.
    const fixed = await w.api("PUT", "/api/wa/templates/PASSWORD_OTP", { body: "Your code is {{code}}. Keep it to yourself." }, s);
    expect(fixed.status).toBe(400);
    expect(fixed.body.error.message).toContain("WhatsApp fixes the wording of a one-time code message");
    expect((await w.api("PUT", "/api/wa/templates/PASSWORD_OTP", { template_name: "northstar_password_code" }, s)).status).toBe(200);
    expect(w.db.q<any>(`SELECT template_name, body FROM wa_templates WHERE tenant_id = ? AND event_key = 'PASSWORD_OTP'`, a.tenantId)[0]).toEqual({ template_name: "northstar_password_code", body: "{{code}} is your verification code. For your security, do not share this code." });
  });

  it("uses the dealership's own wording, template name and language from then on", async () => {
    const s = a.users.admin.session;
    const body = "Namaskar {{customer_name}}, your {{vehicle}} is now at {{dealership}}. Please complete payment within {{days}} days.";
    expect((await w.api("PUT", "/api/wa/templates/STOCK_RECEIVED", { body, template_name: "northstar_stock_received", language: "en_US" }, s)).status).toBe(200);
    const calls = mockMeta(() => ({ status: 200, json: { messages: [{ id: "wamid.CUSTOM" }] } }));
    const car = w.db.q<{ id: string }>(`SELECT id FROM vehicles WHERE vin = 'MALC841CLRM400010'`)[0];
    await w.api("POST", `/api/vehicles/${car.id}/receive`, undefined, a.users.stock.session);
    expect(calls[0].body.template).toMatchObject({ name: "northstar_stock_received", language: { code: "en_US" } });
    expect(calls[0].body.template.components[0].parameters.map((p: any) => p.parameter_name)).toEqual(["customer_name", "vehicle", "dealership", "days"]);
    expect(lastMessage(a.tenantId).rendered_text).toMatch(/^Namaskar Live Customer, your VENUE .* is now at Northstar Motors, Patia\. Please complete payment within 3 days\.$/);
    // Dealer B still has the default wording.
    expect(w.db.q<any>(`SELECT body FROM wa_templates WHERE tenant_id = ? AND event_key = 'STOCK_RECEIVED'`, b.tenantId)[0].body).toContain("Kindly arrange your finances for invoicing");
  });

  it("submits a template to Meta for approval and reads the status back", async () => {
    const calls = mockMeta((url, init) => {
      if (init.method === "POST") return { status: 200, json: { id: "594425479261596", status: "PENDING", category: "UTILITY" } };
      return { status: 200, json: { data: [{ name: "northstar_stock_received", language: "en_US", status: "APPROVED" }, { name: "payment_reminder", language: "en", status: "REJECTED" }] } };
    });
    const sub = await w.api("POST", "/api/wa/templates/STOCK_RECEIVED/submit", undefined, a.users.admin.session);
    expect(sub.body).toEqual({ status: "PENDING" });
    expect(calls[0].url).toBe(`https://graph.facebook.com/v23.0/${LIVE.waba_id}/message_templates`);
    expect(calls[0].body).toMatchObject({ name: "northstar_stock_received", language: "en_US", category: "utility", parameter_format: "named" });
    expect(calls[0].body.components[0].example.body_text_named_params).toContainEqual({ param_name: "customer_name", example: "Rahul Sharma" });
    const refresh = await w.api("POST", "/api/wa/templates/refresh", undefined, a.users.admin.session);
    expect(refresh.body).toMatchObject({ STOCK_RECEIVED: "APPROVED", PAYMENT_REMINDER: "REJECTED", ALLOC_FREE_STOCK: "NOT_FOUND" });
    const list = await w.api("GET", "/api/wa/templates", undefined, a.users.admin.session);
    expect(list.body.find((t: any) => t.event_key === "STOCK_RECEIVED").meta_status).toBe("APPROVED");
    // Changing the wording afterwards clears the approval, because Meta must approve the new text.
    await w.api("PUT", "/api/wa/templates/STOCK_RECEIVED", { body: "Dear {{customer_name}}, your {{vehicle}} has reached {{dealership}}. Thank you." }, a.users.admin.session);
    expect((await w.api("GET", "/api/wa/templates", undefined, a.users.admin.session)).body.find((t: any) => t.event_key === "STOCK_RECEIVED").meta_status).toBeNull();
  });

  it("one message, or all messaging, can be switched off", async () => {
    const s = a.users.admin.session;
    const calls = mockMeta(() => ({ status: 200, json: { messages: [{ id: "wamid.OFF" }] } }));
    await w.api("PUT", "/api/wa/templates/ALLOC_FREE_STOCK", { enabled: false }, s);
    await addCar(w, a, "MALC841CLRM400030", CRETA, "PATIA", "RECEIVED");
    await approvedBooking(w, a, "se1", CRETA, "PATIA", "Switched Off", "9876500030");
    expect(lastMessage(a.tenantId)).toMatchObject({ status: "SKIPPED", error: "This message is switched off" });
    await w.api("PUT", "/api/wa/templates/ALLOC_FREE_STOCK", { enabled: true }, s);
    await w.api("PUT", "/api/wa/config", { enabled: false }, s);
    await addCar(w, a, "MALC841CLRM400031", CRETA, "PATIA", "RECEIVED");
    await approvedBooking(w, a, "se1", CRETA, "PATIA", "All Off", "9876500031");
    expect(lastMessage(a.tenantId)).toMatchObject({ status: "SKIPPED", error: "WhatsApp messaging is switched off" });
    expect(calls).toHaveLength(0);
  });
});
