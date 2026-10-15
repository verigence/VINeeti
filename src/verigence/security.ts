// Tokens for the Verigence platform. VINeeti is a registered machine identity there, and the platform
// issues two different kinds of token from two different endpoints. Which one a service accepts is a
// property of that service, so this module mints both and the callers pick.
//
//   /oauth/token                  — client_credentials, bound to one tenant, carries `tenant_id` and a
//                                   `permissions[]` array. Document Intelligence authorises off those
//                                   claims, so this is the token DI needs.
//   /security/v1/service/token    — bound to an audience instead of a tenant, and deliberately carries
//                                   neither tenant nor permissions. Audit Core's machine endpoints
//                                   reject any token that does carry them, so this is the one they need.
//
// Both are minted with HTTP Basic on the same client id and secret. Neither has a refresh token: when
// one expires another is minted. Minting is not free at the other end — the platform writes a session
// row, an evaluation row and a credential touch for every token — so they are cached here until shortly
// before they expire, and a burst of requests shares one mint rather than starting a stampede.

import type { Env } from "../env";
import { HttpError } from "../lib/util";

/** Seconds knocked off every lifetime: no clock-skew allowance is documented at the other end. */
const EARLY = 60;

interface Cached {
  token: string;
  /** Epoch milliseconds after which this token is treated as spent. */
  until: number;
}

/** Cached tokens, and the mints currently in flight, by cache key. Lives as long as the isolate. */
const held = new Map<string, Cached>();
const inFlight = new Map<string, Promise<string>>();

/** Visible for tests: forget everything held, so one test's token does not leak into the next. */
export function forgetTokens(): void {
  held.clear();
  inFlight.clear();
}

function config(env: Env): { base: string; id: string; secret: string } {
  const base = (env.SECURITY_BASE_URL ?? "").replace(/\/+$/, "");
  const id = env.VERIGENCE_CLIENT_ID ?? "";
  const secret = env.VERIGENCE_CLIENT_SECRET ?? "";
  if (!base || !id || !secret) {
    throw new HttpError(503, "This dealership is not set up to read documents yet: the platform credentials are missing.", "VERIGENCE_NOT_CONFIGURED");
  }
  return { base, id, secret };
}

const basic = (id: string, secret: string) => `Basic ${btoa(`${id}:${secret}`)}`;

/**
 * Mints through the cache. One mint per key at a time: a dozen receipts uploaded together ask for the
 * same token at the same moment, and without this they would each start their own.
 */
async function cached(key: string, now: number, mint: () => Promise<{ token: string; seconds: number }>): Promise<string> {
  const have = held.get(key);
  if (have && have.until > now) return have.token;
  const already = inFlight.get(key);
  if (already) return already;
  const run = (async () => {
    try {
      const { token, seconds } = await mint();
      held.set(key, { token, until: now + Math.max(1, seconds - EARLY) * 1000 });
      return token;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, run);
  return run;
}

async function form(url: string, auth: string, body: Record<string, string>, correlationId?: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": "application/x-www-form-urlencoded",
        ...(correlationId ? { "X-Correlation-ID": correlationId } : {}),
      },
      body: new URLSearchParams(body).toString(),
    });
  } catch (e) {
    // The platform could not be reached at all. Worth retrying later, so it is a 503 rather than a 502.
    throw new HttpError(503, "The Verigence platform could not be reached.", "VERIGENCE_UNAVAILABLE");
  }
  const text = await res.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    payload = {};
  }
  if (!res.ok) {
    // The token endpoints answer in OAuth's shape ({error, error_description}); everything else in the
    // platform's problem shape ({code, title, detail}). Read whichever arrived.
    const code = String(payload.error ?? payload.code ?? `HTTP_${res.status}`);
    const detail = String(payload.error_description ?? payload.detail ?? payload.title ?? "");
    // 401 and 403 mean the credential or the grant is wrong: nothing is gained by trying again.
    const status = res.status === 401 || res.status === 403 ? 502 : res.status >= 500 ? 503 : 502;
    throw new HttpError(status, `The Verigence platform refused the credentials (${code}).${detail ? ` ${detail}` : ""}`, `VERIGENCE_${code.toUpperCase()}`);
  }
  return payload;
}

/**
 * A tenant-bound token carrying permissions, for Document Intelligence.
 *
 * `tenantId` is the dealership's identifier **on the platform**, not VINeeti's own tenant id, and the
 * permissions asked for must be a subset of what the platform has granted: asking for one that is not
 * granted fails the whole request rather than quietly returning less.
 */
export async function diToken(env: Env, tenantId: string, scopes: string[], correlationId?: string): Promise<string> {
  const { base, id, secret } = config(env);
  if (!tenantId) throw new HttpError(503, "This dealership has no Verigence tenant id set.", "VERIGENCE_NO_TENANT");
  const scope = [...scopes].sort().join(" ");
  return cached(`di|${tenantId}|${scope}`, Date.now(), async () => {
    const body = await form(`${base}/oauth/token`, basic(id, secret), { grant_type: "client_credentials", tenant_id: tenantId, scope }, correlationId);
    const token = String(body.access_token ?? "");
    const seconds = Number(body.expires_in ?? 0);
    if (!token || !Number.isFinite(seconds) || seconds <= 0) throw new HttpError(502, "The Verigence platform returned a token that could not be read.", "VERIGENCE_BAD_TOKEN");
    return { token, seconds };
  });
}

/**
 * An audience-bound token with no tenant and no permissions, for Audit Core's machine endpoints. Those
 * endpoints reject a token that carries tenant or permission claims, so this is not interchangeable
 * with the one above even though both identify the same client.
 */
export async function serviceToken(env: Env, audience: string, correlationId?: string): Promise<string> {
  const { base, id, secret } = config(env);
  if (!audience) throw new HttpError(500, "An audience is required for a service token.", "VERIGENCE_NO_AUDIENCE");
  return cached(`svc|${audience}`, Date.now(), async () => {
    const body = await form(`${base}/security/v1/service/token`, basic(id, secret), { audience }, correlationId);
    // This endpoint answers in camelCase; /oauth/token answers in snake_case. Same platform, two shapes.
    const token = String(body.accessToken ?? "");
    const seconds = Number(body.expiresIn ?? 0);
    if (!token || !Number.isFinite(seconds) || seconds <= 0) throw new HttpError(502, "The Verigence platform returned a token that could not be read.", "VERIGENCE_BAD_TOKEN");
    return { token, seconds };
  });
}

/** The permissions VINeeti asks for on a DI token: the whole round trip and nothing beyond it. */
export const DI_SCOPES = ["di.subject.create", "di.subject.read", "di.document.upload", "di.document.read", "di.document.fields.read"];
