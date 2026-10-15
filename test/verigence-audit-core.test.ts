// The platform's booking rules, asked over HTTP. What matters here is that VINeeti sends the question
// faithfully and reads the answer faithfully — the rule itself is Audit Core's and is tested there.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkMinimumPayment, resolveSku } from "../src/verigence/audit-core";
import { forgetTokens } from "../src/verigence/security";
import type { Env } from "../src/env";

const ENV = {
  SECURITY_BASE_URL: "https://security.example",
  AUDIT_CORE_BASE_URL: "https://audit.example",
  VERIGENCE_CLIENT_ID: "vineeti",
  VERIGENCE_CLIENT_SECRET: "s3cret",
} as unknown as Env;

interface Seen {
  url: string;
  auth: string;
  body: Record<string, unknown>;
}

/** Answers the token mint, then whatever the test says for the Audit Core call. */
function platform(reply: (seen: Seen) => { status?: number; body: unknown }) {
  const seen: Seen[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit = {}) => {
    const u = String(url);
    if (u.includes("/service/token")) {
      return new Response(JSON.stringify({ accessToken: "svc-token", expiresIn: 14400, audience: "audit" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const headers = new Headers(init.headers as HeadersInit);
    const call: Seen = { url: u, auth: headers.get("Authorization") ?? "", body: JSON.parse(String(init.body ?? "{}")) };
    seen.push(call);
    const { status = 200, body } = reply(call);
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  });
  return seen;
}

beforeEach(() => forgetTokens());
afterEach(() => vi.unstubAllGlobals());

describe("asking which SKU the booking form named", () => {
  const SKU = { productSkuId: "11111111-1111-1111-1111-111111111111", skuCode: "SKU-1", modelName: "SCORPIO N", variantName: "Z8L", colourName: "EVEREST WHITE", exShowroomPrice: "1800000", totalPrice: "2100000" };

  it("sends the text as the form had it, with the audience-bound token", async () => {
    const seen = platform(() => ({ body: { outcome: "RESOLVED", matchStage: "TOTAL", reason: null, sku: SKU, candidates: [SKU] } }));
    const r = await resolveSku(ENV, { tenantId: "aditya", model: "SCORPIO N", variant: "Z8L", colour: "EVEREST WHITE", on: "2026-09-10" });
    expect(seen[0].url).toBe("https://audit.example/v1/internal/booking/sku-resolution");
    // The service token, not the tenant-bound one — Audit Core rejects that one.
    expect(seen[0].auth).toBe("Bearer svc-token");
    expect(seen[0].body).toEqual({ tenantId: "aditya", model: "SCORPIO N", variant: "Z8L", colour: "EVEREST WHITE", on: "2026-09-10" });
    expect(r.outcome).toBe("RESOLVED");
    expect(r.sku).toMatchObject({ sku_code: "SKU-1", model: "SCORPIO N", colour: "EVEREST WHITE", total_price: 2100000 });
  });

  // Several matches is an answer. VINeeti must keep every candidate rather than take the first, or it
  // allocates a car the booking form never named.
  it("keeps every candidate when the masters hold more than one", async () => {
    platform(() => ({ body: { outcome: "AMBIGUOUS", matchStage: "VARIANT_COLOUR", reason: null, sku: null, candidates: [SKU, { ...SKU, skuCode: "SKU-2", colourName: "STEALTH BLACK" }] } }));
    const r = await resolveSku(ENV, { tenantId: "aditya", model: "SCORPIO N" });
    expect(r.outcome).toBe("AMBIGUOUS");
    expect(r.sku).toBeNull();
    expect(r.candidates.map((c) => c.sku_code)).toEqual(["SKU-1", "SKU-2"]);
  });

  it("passes on that the masters do not hold the vehicle", async () => {
    platform(() => ({ body: { outcome: "NONE", matchStage: "NONE", reason: null, sku: null, candidates: [] } }));
    expect((await resolveSku(ENV, { tenantId: "aditya", model: "NOT A CAR" })).outcome).toBe("NONE");
  });

  // A dealership whose price master has not been loaded centrally. Distinct from "no such vehicle":
  // one is a missing catalogue, the other is a wrong reading, and they need different handling.
  it("passes on that there is no price list to resolve against, with the reason", async () => {
    platform(() => ({ body: { outcome: "UNAVAILABLE", matchStage: null, reason: "no_effective_price_list", sku: null, candidates: [] } }));
    const r = await resolveSku(ENV, { tenantId: "aditya", model: "SCORPIO N" });
    expect(r.outcome).toBe("UNAVAILABLE");
    expect(r.reason).toBe("no_effective_price_list");
  });

  it("leaves out a price it does not have rather than sending a null the platform would read as zero", async () => {
    const seen = platform(() => ({ body: { outcome: "NONE", matchStage: "NONE", reason: null, sku: null, candidates: [] } }));
    await resolveSku(ENV, { tenantId: "aditya", model: "SCORPIO N", totalPrice: null, exShowroomPrice: 1800000 });
    expect(seen[0].body).not.toHaveProperty("totalPrice");
    expect(seen[0].body.exShowroomPrice).toBe("1800000");
  });
});

describe("asking whether the receipts reach the minimum", () => {
  it("sends the dealership's own minimum and the receipts, amounts as exact decimals", async () => {
    const seen = platform(() => ({ body: { met: true, minimumAmount: "21000", totalCounted: "21000", confirmingReference: "doc_1", confirmingDate: "2026-10-01", countedReferences: ["doc_1"], duplicateReferences: [] } }));
    const r = await checkMinimumPayment(ENV, {
      tenantId: "aditya",
      minimum: 21000,
      receipts: [{ reference: "doc_1", amount: 21000, receipt_date: "2026-10-01", receipt_number: "RC-1" }],
    });
    expect(seen[0].url).toBe("https://audit.example/v1/internal/booking/minimum-payment");
    expect(seen[0].body).toEqual({
      tenantId: "aditya",
      // VINeeti's own setting travels with the question: left out, the platform would quietly apply its
      // own default instead of this dealership's figure.
      minimumAmount: "21000",
      receipts: [{ reference: "doc_1", amount: "21000", receiptDate: "2026-10-01", receiptNumber: "RC-1" }],
    });
    expect(r).toMatchObject({ met: true, minimum: 21000, total_counted: 21000, confirming_reference: "doc_1", confirming_date: "2026-10-01" });
  });

  it("reads back which receipts were counted and which were the same money twice", async () => {
    platform(() => ({ body: { met: false, minimumAmount: "21000", totalCounted: "11000", confirmingReference: null, confirmingDate: null, countedReferences: ["doc_1"], duplicateReferences: ["doc_2"] } }));
    const r = await checkMinimumPayment(ENV, {
      tenantId: "aditya",
      minimum: 21000,
      receipts: [
        { reference: "doc_1", amount: 11000, receipt_date: "2026-10-01", receipt_number: "RC-9" },
        { reference: "doc_2", amount: 11000, receipt_date: "2026-10-01", receipt_number: "RC-9" },
      ],
    });
    expect(r.met).toBe(false);
    expect(r.counted).toEqual(["doc_1"]);
    expect(r.duplicates).toEqual(["doc_2"]);
  });

  it("does not ask about nothing", async () => {
    platform(() => ({ body: {} }));
    await expect(checkMinimumPayment(ENV, { tenantId: "aditya", minimum: 21000, receipts: [] })).rejects.toMatchObject({ code: "NO_RECEIPTS" });
  });
});

describe("when the platform will not answer", () => {
  it("tells a refusal apart from an outage, so a retry does not hammer a rejection", async () => {
    platform(() => ({ status: 400, body: { errorCode: "VAC-VAL-001", title: "Validation failed" } }));
    await expect(resolveSku(ENV, { tenantId: "aditya", model: "X" })).rejects.toMatchObject({ status: 502, code: "VAC-VAL-001" });
    vi.unstubAllGlobals();
    forgetTokens();
    platform(() => ({ status: 503, body: { errorCode: "VAC-DI-001", title: "Dependency unavailable" } }));
    await expect(resolveSku(ENV, { tenantId: "aditya", model: "X" })).rejects.toMatchObject({ status: 503 });
  });

  it("says the dealership is not connected rather than failing on an empty address", async () => {
    platform(() => ({ body: {} }));
    await expect(resolveSku({ ...ENV, AUDIT_CORE_BASE_URL: "" } as Env, { tenantId: "aditya", model: "X" })).rejects.toMatchObject({ code: "AUDIT_NOT_CONFIGURED" });
  });
});
