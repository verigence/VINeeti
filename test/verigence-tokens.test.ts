// Tokens for the Verigence platform. Two endpoints, two shapes, two sets of claims — and a cache that
// has to hold them apart, because handing Audit Core a tenant-bound token (or DI an audience-bound one)
// fails at the far end for reasons that are hard to read from a 401.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DI_SCOPES, diToken, forgetTokens, serviceToken } from "../src/verigence/security";
import { HttpError } from "../src/lib/util";
import type { Env } from "../src/env";

const ENV = {
  SECURITY_BASE_URL: "https://security.example/",
  VERIGENCE_CLIENT_ID: "vineeti",
  VERIGENCE_CLIENT_SECRET: "s3cret",
} as unknown as Env;

interface Call {
  url: string;
  auth: string;
  body: Record<string, string>;
  correlation: string | null;
}

/** Stands in for the platform. `reply` decides what each call gets back. */
function platform(reply: (call: Call, n: number) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers as HeadersInit);
    const call: Call = {
      url: String(url),
      auth: headers.get("Authorization") ?? "",
      body: Object.fromEntries(new URLSearchParams(String(init.body ?? ""))),
      correlation: headers.get("X-Correlation-ID"),
    };
    calls.push(call);
    const { status = 200, body } = reply(call, calls.length);
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  });
  return calls;
}

const oauthOk = (expires = 300) => ({ body: { access_token: "di-token", issued_token_type: "urn:ietf:params:oauth:token-type:access_token", token_type: "Bearer", expires_in: expires, scope: DI_SCOPES.join(" ") } });
const serviceOk = (expires = 14400) => ({ body: { accessToken: "svc-token", expiresIn: expires, audience: "audit-core" } });

beforeEach(() => forgetTokens());
afterEach(() => vi.unstubAllGlobals());

describe("the token Document Intelligence needs", () => {
  it("is minted with Basic auth, the dealership's platform tenant and the permissions asked for", async () => {
    const calls = platform(() => oauthOk());
    expect(await diToken(ENV, "aditya-motors", DI_SCOPES, "corr-1")).toBe("di-token");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://security.example/oauth/token");
    expect(atob(calls[0].auth.replace("Basic ", ""))).toBe("vineeti:s3cret");
    expect(calls[0].correlation).toBe("corr-1");
    expect(calls[0].body).toEqual({
      grant_type: "client_credentials",
      tenant_id: "aditya-motors",
      // Sorted, so the same set of permissions is one cache entry however the caller ordered them.
      scope: "di.document.fields.read di.document.read di.document.upload di.subject.create di.subject.read",
    });
  });

  it("is held and reused rather than minted for every document", async () => {
    const calls = platform(() => oauthOk());
    for (let i = 0; i < 5; i++) expect(await diToken(ENV, "aditya-motors", DI_SCOPES)).toBe("di-token");
    expect(calls).toHaveLength(1);
  });

  // A token is bound to one dealership. Reusing one across dealerships would send Aditya's documents
  // up under someone else's tenant, which the platform would either refuse or — worse — accept.
  it("is held separately for each dealership", async () => {
    const calls = platform((c) => ({ body: { access_token: `token-for-${c.body.tenant_id}`, expires_in: 300, token_type: "Bearer" } }));
    expect(await diToken(ENV, "aditya-motors", DI_SCOPES)).toBe("token-for-aditya-motors");
    expect(await diToken(ENV, "demo-motors", DI_SCOPES)).toBe("token-for-demo-motors");
    expect(await diToken(ENV, "aditya-motors", DI_SCOPES)).toBe("token-for-aditya-motors");
    expect(calls).toHaveLength(2);
  });

  // Held tokens are given up a minute before the platform would expire them: there is no documented
  // clock-skew allowance at the far end, and a token that expires mid-upload costs the whole upload.
  it("is minted again a minute before the platform would expire it", async () => {
    vi.useFakeTimers();
    try {
      const calls = platform((_c, n) => ({ body: { access_token: `token-${n}`, expires_in: 300, token_type: "Bearer" } }));
      expect(await diToken(ENV, "aditya-motors", DI_SCOPES)).toBe("token-1");
      vi.advanceTimersByTime(239_000); // 4 minutes less a second: still inside the margin
      expect(await diToken(ENV, "aditya-motors", DI_SCOPES)).toBe("token-1");
      expect(calls).toHaveLength(1);
      vi.advanceTimersByTime(2_000); // past it, with a minute of the platform's life still unspent
      expect(await diToken(ENV, "aditya-motors", DI_SCOPES)).toBe("token-2");
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // A platform that hands back a token shorter-lived than that margin still has to be usable: the call
  // it was minted for is about to be made. It is held for a moment rather than thrown away unused.
  it("still uses a token whose whole life is shorter than the margin", async () => {
    const calls = platform((_c, n) => ({ body: { access_token: `token-${n}`, expires_in: 30, token_type: "Bearer" } }));
    expect(await diToken(ENV, "aditya-motors", DI_SCOPES)).toBe("token-1");
    expect(calls).toHaveLength(1);
  });

  // A consultant uploads a booking form and four receipts at once. Each wants a token at the same
  // instant; without sharing the mint in flight, that is five sessions written at the platform for one
  // customer's paperwork.
  it("mints once when several uploads ask for a token at the same moment", async () => {
    const calls = platform(() => oauthOk());
    const tokens = await Promise.all([1, 2, 3, 4, 5].map(() => diToken(ENV, "aditya-motors", DI_SCOPES)));
    expect(tokens).toEqual(["di-token", "di-token", "di-token", "di-token", "di-token"]);
    expect(calls).toHaveLength(1);
  });
});

describe("the token Audit Core needs", () => {
  // Audit Core's machine endpoints refuse a token carrying a tenant or permissions, so this is a
  // different endpoint with a different answer shape — camelCase where the other is snake_case.
  it("is minted against the service endpoint with an audience and read out of camelCase", async () => {
    const calls = platform(() => serviceOk());
    expect(await serviceToken(ENV, "audit-core")).toBe("svc-token");
    expect(calls[0].url).toBe("https://security.example/security/v1/service/token");
    expect(calls[0].body).toEqual({ audience: "audit-core" });
  });

  it("is held apart from the Document Intelligence token", async () => {
    const calls = platform((c) => (c.url.endsWith("/oauth/token") ? oauthOk() : serviceOk()));
    expect(await diToken(ENV, "aditya-motors", DI_SCOPES)).toBe("di-token");
    expect(await serviceToken(ENV, "audit-core")).toBe("svc-token");
    expect(await diToken(ENV, "aditya-motors", DI_SCOPES)).toBe("di-token");
    expect(await serviceToken(ENV, "audit-core")).toBe("svc-token");
    expect(calls).toHaveLength(2);
  });

  it("is held separately for each audience", async () => {
    const calls = platform((c) => ({ body: { accessToken: `svc-${c.body.audience}`, expiresIn: 14400, audience: c.body.audience } }));
    expect(await serviceToken(ENV, "audit-core")).toBe("svc-audit-core");
    expect(await serviceToken(ENV, "di")).toBe("svc-di");
    expect(calls).toHaveLength(2);
  });
});

describe("when the platform will not issue a token", () => {
  it("says which dealership is not set up rather than failing deep inside an upload", async () => {
    platform(() => oauthOk());
    await expect(diToken({} as Env, "aditya-motors", DI_SCOPES)).rejects.toMatchObject({ status: 503, code: "VERIGENCE_NOT_CONFIGURED" });
    await expect(diToken(ENV, "", DI_SCOPES)).rejects.toMatchObject({ status: 503, code: "VERIGENCE_NO_TENANT" });
  });

  it("does not hold on to a refusal, so a corrected credential works without waiting", async () => {
    const calls = platform((_c, n) => (n === 1 ? { status: 401, body: { error: "invalid_client", error_description: "bad secret" } } : oauthOk()));
    await expect(diToken(ENV, "aditya-motors", DI_SCOPES)).rejects.toBeInstanceOf(HttpError);
    expect(await diToken(ENV, "aditya-motors", DI_SCOPES)).toBe("di-token");
    expect(calls).toHaveLength(2);
  });

  // A wrong credential is not worth retrying; the platform being down is. The two are told apart so a
  // caller's retry logic does not hammer a 401.
  it("tells a refused credential apart from a platform that is down", async () => {
    platform(() => ({ status: 401, body: { error: "invalid_client" } }));
    await expect(diToken(ENV, "aditya-motors", DI_SCOPES)).rejects.toMatchObject({ status: 502, code: "VERIGENCE_INVALID_CLIENT" });
    forgetTokens();
    vi.unstubAllGlobals();
    platform(() => ({ status: 503, body: { code: "SIGNING_KEY_UNAVAILABLE" } }));
    await expect(diToken(ENV, "aditya-motors", DI_SCOPES)).rejects.toMatchObject({ status: 503 });
  });

  it("reports an unreachable platform rather than throwing a network error at the consultant", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("network error");
    });
    await expect(serviceToken(ENV, "audit-core")).rejects.toMatchObject({ status: 503, code: "VERIGENCE_UNAVAILABLE" });
  });

  it("refuses a token it cannot read rather than sending an empty bearer", async () => {
    platform(() => ({ body: { token_type: "Bearer" } }));
    await expect(diToken(ENV, "aditya-motors", DI_SCOPES)).rejects.toMatchObject({ status: 502, code: "VERIGENCE_BAD_TOKEN" });
  });
});
