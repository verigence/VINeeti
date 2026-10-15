// Audit Core: the platform's own Booking rules, asked rather than copied.
//
// Two questions it is the authority on, and that VINeeti therefore does not answer for itself:
//
//   sku-resolution    which SKU the text on a booking form names, against the OEM price masters
//   minimum-payment   whether a set of receipts reaches the dealership's minimum booking amount
//
// Both are read-only and stateless there: nothing is pinned, no finding is raised and no journey is
// created. The booking stays VINeeti's; only the question travels.
//
// These take the audience-bound service token, not the tenant-bound one Document Intelligence needs —
// Audit Core rejects any token carrying tenant or permission claims. Hence two token kinds for one
// client identity, which is why `security.ts` mints both.

import type { Env } from "../env";
import { HttpError } from "../lib/util";
import { serviceToken } from "./security";

/** The audience Audit Core's machine endpoints are registered under. */
const AUDIENCE = "audit";

export interface SkuCandidate {
  product_sku_id: string;
  sku_code: string;
  model: string;
  variant: string | null;
  colour: string | null;
  ex_showroom_price: number | null;
  total_price: number | null;
}

export interface SkuResolution {
  /** RESOLVED one; AMBIGUOUS several, listed; NONE not in the masters; UNAVAILABLE no price list. */
  outcome: "RESOLVED" | "AMBIGUOUS" | "NONE" | "UNAVAILABLE";
  /** Which rung of the ladder decided it — TOTAL, ATTRIBUTE_DECOMPOSITION, CATALOGUE_SEARCH and so on. */
  match_stage: string | null;
  reason: string | null;
  sku: SkuCandidate | null;
  candidates: SkuCandidate[];
}

export interface ReceiptIn {
  /** VINeeti's own id for the receipt, echoed back so each one can be traced to its verdict. */
  reference: string;
  amount: number;
  receipt_date?: string | null;
  receipt_number?: string | null;
}

export interface PaymentVerdict {
  met: boolean;
  minimum: number;
  total_counted: number;
  /** The receipt that took the running total over the line, and its date. */
  confirming_reference: string | null;
  confirming_date: string | null;
  counted: string[];
  /** Set aside as the same money reaching us twice, so it is counted once. */
  duplicates: string[];
}

function base(env: Env): string {
  const url = (env.AUDIT_CORE_BASE_URL ?? "").replace(/\/+$/, "");
  if (!url) throw new HttpError(503, "This dealership is not connected to the platform's booking rules.", "AUDIT_NOT_CONFIGURED");
  return url;
}

async function post<T>(env: Env, path: string, body: unknown, correlationId?: string): Promise<T> {
  // The address is checked before a token is minted: a dealership that is simply not connected should
  // be told so, not spend a mint and then look like the platform is down.
  const url = `${base(env)}${path}`;
  const token = await serviceToken(env, AUDIENCE, correlationId);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(correlationId ? { "X-Correlation-ID": correlationId } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new HttpError(503, "The platform's booking rules could not be reached.", "AUDIT_UNAVAILABLE");
  }
  const text = await res.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    payload = {};
  }
  if (!res.ok) {
    // Audit Core answers failures as a problem document carrying its own stable code.
    const code = String(payload.errorCode ?? payload.code ?? `AUDIT_HTTP_${res.status}`);
    const retryable = res.status >= 500;
    throw new HttpError(retryable ? 503 : 502, String(payload.title ?? "The platform refused the request."), code);
  }
  return payload as T;
}

/**
 * Resolve the vehicle text a booking form carried to a SKU in the OEM price masters.
 *
 * `on` is the business date the masters are read on — a booking taken last month is resolved against
 * the list that stood last month, not today's. Several matches is an answer, not a failure: the text
 * did not say which, and the caller is given the candidates rather than a guess.
 */
export async function resolveSku(
  env: Env,
  input: { tenantId: string; model: string; variant?: string | null; colour?: string | null; on?: string; totalPrice?: number | null; exShowroomPrice?: number | null },
  correlationId?: string,
): Promise<SkuResolution> {
  const body = await post<{
    outcome: SkuResolution["outcome"];
    matchStage: string | null;
    reason: string | null;
    sku: Record<string, unknown> | null;
    candidates: Record<string, unknown>[];
  }>(
    env,
    "/v1/internal/booking/sku-resolution",
    {
      tenantId: input.tenantId,
      model: input.model,
      variant: input.variant ?? null,
      colour: input.colour ?? null,
      ...(input.on ? { on: input.on } : {}),
      ...(input.totalPrice != null ? { totalPrice: String(input.totalPrice) } : {}),
      ...(input.exShowroomPrice != null ? { exShowroomPrice: String(input.exShowroomPrice) } : {}),
    },
    correlationId,
  );
  return {
    outcome: body.outcome,
    match_stage: body.matchStage ?? null,
    reason: body.reason ?? null,
    sku: body.sku ? candidate(body.sku) : null,
    candidates: (body.candidates ?? []).map(candidate),
  };
}

const candidate = (r: Record<string, unknown>): SkuCandidate => ({
  product_sku_id: String(r.productSkuId),
  sku_code: String(r.skuCode),
  model: String(r.modelName),
  variant: (r.variantName as string) ?? null,
  colour: (r.colourName as string) ?? null,
  ex_showroom_price: r.exShowroomPrice == null ? null : Number(r.exShowroomPrice),
  total_price: r.totalPrice == null ? null : Number(r.totalPrice),
});

/**
 * Whether these receipts reach the minimum. The platform counts the same receipt once however many
 * times it was photographed, and confirms on whichever receipt took the running total over the line,
 * in receipt-date order — so the date VINeeti records is the date the rule says it is.
 *
 * `minimum` is passed explicitly: the dealership's figure lives in VINeeti's own settings, and leaving
 * the platform to fall back on its own would silently apply a different number.
 */
export async function checkMinimumPayment(
  env: Env,
  input: { tenantId: string; receipts: ReceiptIn[]; minimum: number },
  correlationId?: string,
): Promise<PaymentVerdict> {
  if (!input.receipts.length) throw new HttpError(400, "There are no receipts to check.", "NO_RECEIPTS");
  const body = await post<{
    met: boolean;
    minimumAmount: string | number;
    totalCounted: string | number;
    confirmingReference: string | null;
    confirmingDate: string | null;
    countedReferences: string[];
    duplicateReferences: string[];
  }>(
    env,
    "/v1/internal/booking/minimum-payment",
    {
      tenantId: input.tenantId,
      minimumAmount: String(input.minimum),
      // Amounts go as strings: the platform reads them as exact decimals, and a float would round.
      receipts: input.receipts.map((r) => ({
        reference: r.reference,
        amount: String(r.amount),
        receiptDate: r.receipt_date ?? null,
        receiptNumber: r.receipt_number ?? null,
      })),
    },
    correlationId,
  );
  return {
    met: body.met,
    minimum: Number(body.minimumAmount),
    total_counted: Number(body.totalCounted),
    confirming_reference: body.confirmingReference ?? null,
    confirming_date: body.confirmingDate ?? null,
    counted: body.countedReferences ?? [],
    duplicates: body.duplicateReferences ?? [],
  };
}
