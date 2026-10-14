// WhatsApp Cloud API (Meta) client. Request and response shapes follow Meta's documentation for
// template messages with named parameters and for creating utility templates.

export interface WaCredentials {
  phoneNumberId: string;
  wabaId: string | null;
  accessToken: string;
  graphVersion: string;
}

export interface SendResult {
  ok: boolean;
  providerMessageId?: string;
  error?: string;
  /** False when retrying cannot help (bad template, bad number, expired token). */
  retryable?: boolean;
}

export interface TemplateMessage {
  to: string; // digits with country code
  templateName: string;
  language: string;
  params: Record<string, string>;
  paramOrder: string[];
}

const GRAPH = "https://graph.facebook.com";

export function buildSendPayload(m: TemplateMessage) {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: m.to,
    type: "template",
    template: {
      name: m.templateName,
      language: { code: m.language },
      components: m.paramOrder.length
        ? [
            {
              type: "body",
              parameters: m.paramOrder.map((name) => ({ type: "text", parameter_name: name, text: m.params[name] ?? "" })),
            },
          ]
        : [],
    },
  };
}

async function graph(creds: WaCredentials, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${GRAPH}/${creds.graphVersion}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${creds.accessToken}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

function describeError(status: number, json: any): string {
  const e = json?.error;
  if (!e) return `HTTP ${status}`;
  const detail = e.error_data?.details ? ` (${e.error_data.details})` : "";
  return `${e.message ?? "Error"}${detail} [code ${e.code ?? status}]`;
}

export async function sendTemplateMeta(creds: WaCredentials, m: TemplateMessage): Promise<SendResult> {
  try {
    const { status, json } = await graph(creds, "POST", `${creds.phoneNumberId}/messages`, buildSendPayload(m));
    if (status >= 200 && status < 300 && json?.messages?.[0]?.id) return { ok: true, providerMessageId: json.messages[0].id };
    return { ok: false, error: describeError(status, json), retryable: status === 429 || status >= 500 };
  } catch (e) {
    return { ok: false, error: `Network error: ${(e as Error).message}`, retryable: true };
  }
}

/**
 * Sends a one-time code with an authentication template (Meta's fixed "<code> is your verification code"
 * wording with a copy-code button). The code goes in the body and in the button, as Meta requires.
 */
export async function sendOtpMeta(creds: WaCredentials, m: { to: string; templateName: string; language: string; code: string }): Promise<SendResult> {
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: m.to,
    type: "template",
    template: {
      name: m.templateName,
      language: { code: m.language },
      components: [
        { type: "body", parameters: [{ type: "text", text: m.code }] },
        { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: m.code }] },
      ],
    },
  };
  try {
    const { status, json } = await graph(creds, "POST", `${creds.phoneNumberId}/messages`, payload);
    if (status >= 200 && status < 300 && json?.messages?.[0]?.id) return { ok: true, providerMessageId: json.messages[0].id };
    return { ok: false, error: describeError(status, json), retryable: false };
  } catch (e) {
    return { ok: false, error: `Network error: ${(e as Error).message}`, retryable: false };
  }
}

/** Submits the one-time-code template (category AUTHENTICATION) for Meta's approval. */
export async function createOtpTemplateMeta(creds: WaCredentials, t: { name: string; language: string }): Promise<{ ok: boolean; status?: string; id?: string; error?: string }> {
  if (!creds.wabaId) return { ok: false, error: "WhatsApp Business Account ID is not set" };
  const payload = {
    name: t.name,
    language: t.language,
    category: "authentication",
    components: [
      { type: "body", add_security_recommendation: true },
      { type: "footer", code_expiration_minutes: 10 },
      { type: "buttons", buttons: [{ type: "otp", otp_type: "copy_code" }] },
    ],
  };
  try {
    const { status, json } = await graph(creds, "POST", `${creds.wabaId}/message_templates`, payload);
    if (status >= 200 && status < 300 && json?.id) return { ok: true, status: json.status, id: json.id };
    return { ok: false, error: describeError(status, json) };
  } catch (e) {
    return { ok: false, error: `Network error: ${(e as Error).message}` };
  }
}

/** Asks Meta whether this access token can see this phone number ID; returns the number Meta holds for it. */
export async function verifyNumberMeta(creds: WaCredentials): Promise<{ ok: boolean; displayNumber?: string; verifiedName?: string; error?: string }> {
  try {
    const { status, json } = await graph(creds, "GET", `${creds.phoneNumberId}?fields=display_phone_number,verified_name`);
    if (status >= 200 && status < 300 && json?.id) return { ok: true, displayNumber: json.display_phone_number, verifiedName: json.verified_name };
    return { ok: false, error: describeError(status, json) };
  } catch (e) {
    return { ok: false, error: `could not reach Meta (${(e as Error).message})` };
  }
}

/** Submits a utility template for Meta's approval. */
export async function createTemplateMeta(
  creds: WaCredentials,
  t: { name: string; language: string; body: string; examples: Record<string, string>; paramOrder: string[] },
): Promise<{ ok: boolean; status?: string; id?: string; error?: string }> {
  if (!creds.wabaId) return { ok: false, error: "WhatsApp Business Account ID is not set" };
  const payload = {
    name: t.name,
    language: t.language,
    category: "utility",
    parameter_format: "named",
    components: [
      {
        type: "body",
        text: t.body,
        ...(t.paramOrder.length
          ? { example: { body_text_named_params: t.paramOrder.map((p) => ({ param_name: p, example: t.examples[p] ?? p })) } }
          : {}),
      },
    ],
  };
  try {
    const { status, json } = await graph(creds, "POST", `${creds.wabaId}/message_templates`, payload);
    if (status >= 200 && status < 300 && json?.id) return { ok: true, status: json.status, id: json.id };
    return { ok: false, error: describeError(status, json) };
  } catch (e) {
    return { ok: false, error: `Network error: ${(e as Error).message}` };
  }
}

/** Reads the approval status of the account's templates. */
export async function listTemplatesMeta(creds: WaCredentials): Promise<{ ok: boolean; templates?: { name: string; language: string; status: string }[]; error?: string }> {
  if (!creds.wabaId) return { ok: false, error: "WhatsApp Business Account ID is not set" };
  try {
    const { status, json } = await graph(creds, "GET", `${creds.wabaId}/message_templates?fields=name,status,language&limit=200`);
    if (status >= 200 && status < 300 && Array.isArray(json?.data)) return { ok: true, templates: json.data };
    return { ok: false, error: describeError(status, json) };
  } catch (e) {
    return { ok: false, error: `Network error: ${(e as Error).message}` };
  }
}
