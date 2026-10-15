// Document Intelligence: the platform reads a booking form and a payment receipt so VINeeti does not
// have to. A booking becomes a Subject there; the form and each receipt become Documents on it.
//
// Four calls, in this order, because extraction is asynchronous and there is no callback:
//
//   createSubject   once per booking, the id kept against the booking here
//   uploadDocument  one per file; answers ACCEPTED or REJECTED straight away
//   getDocument     polled until processing reaches PROCESSED or FAILED
//   getFields       the extracted values, readable only once the document is CONFIRMED
//
// Two shapes of answer come back and both have to be read. A business outcome arrives as HTTP 2xx
// carrying an envelope whose errorCode says what happened — a rejected upload is a 201. A transport
// failure arrives as 4xx/5xx carrying a problem document with its own `retryable` flag, which is
// trusted over the status code.

import type { Env } from "../env";
import { HttpError } from "../lib/util";
import { DI_SCOPES, diToken } from "./security";

/** Extraction is driven by the document type, so a wrong key here is a document that never extracts. */
export const DOC_BOOKING_FORM = "booking_form";
export const DOC_PAYMENT_RECEIPT = "payment_receipt";

export interface DiDocument {
  document_id: string;
  /** What the platform classified it as, which need not be what we asked for. */
  document_type_key: string | null;
  upload_status: "ACCEPTED" | "REJECTED" | "PENDING";
  processing_status: "PENDING" | "PROCESSING" | "PROCESSED" | "FAILED" | null;
  confirmation_status: string | null;
  confidence: number | null;
}

export interface DiField {
  key: string;
  value: unknown;
  /** 0-100. The platform reports four levels, not a continuum: roughly 40, 70, 92, 100. */
  confidence: number | null;
  /** MACHINE unless a person has corrected it at the platform. */
  source: string | null;
}

/** An upload the platform would not take: the file itself is the problem, so a person must re-send it. */
export class DiRejected extends HttpError {
  constructor(public documentId: string | null, public reason: string, message: string) {
    super(422, message, `DI_${reason}`);
  }
}

const REJECTION: Record<string, string> = {
  E001: "The photo was not clear enough to read. Take it again in better light, straight on, with the whole page in frame.",
  E002: "That file could not be opened. Send the original photo or PDF rather than a screenshot of it.",
  E006: "That kind of file cannot be read. Send a PDF or a JPEG, PNG or WEBP photo.",
  E007: "That file is too big. The limit is 30 MB.",
};

interface Envelope<T> {
  errorCode: string;
  errorMessage: string;
  data: T | null;
}

function base(env: Env): string {
  const url = (env.DI_BASE_URL ?? "").replace(/\/+$/, "");
  if (!url) throw new HttpError(503, "This dealership is not set up to read documents yet.", "DI_NOT_CONFIGURED");
  return url;
}

/**
 * One call to the platform. `body` is either JSON or a FormData; the token is minted (or taken from the
 * cache) for the dealership the call is for.
 */
async function call<T>(env: Env, tenantId: string, method: string, path: string, opts: { body?: unknown; correlationId?: string } = {}): Promise<Envelope<T>> {
  const token = await diToken(env, tenantId, DI_SCOPES, opts.correlationId);
  const isForm = opts.body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(`${base(env)}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        // A FormData body sets its own content type, boundary and all; setting one here breaks it.
        ...(opts.body !== undefined && !isForm ? { "Content-Type": "application/json" } : {}),
        ...(opts.correlationId ? { "X-Correlation-ID": opts.correlationId } : {}),
      },
      body: opts.body === undefined ? undefined : isForm ? (opts.body as FormData) : JSON.stringify(opts.body),
    });
  } catch {
    throw new HttpError(503, "The document service could not be reached.", "DI_UNAVAILABLE");
  }

  const text = await res.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    payload = {};
  }

  if (!res.ok) {
    // A problem document. Its own `retryable` is more reliable than the status: the service marks a
    // storage write retryable and a rejected file not, whatever the code happens to be.
    const code = String(payload.code ?? `DI_HTTP_${res.status}`);
    const retryable = typeof payload.retryable === "boolean" ? payload.retryable : res.status >= 500;
    throw new HttpError(retryable ? 503 : 502, String(payload.title ?? "The document service refused the request."), code);
  }

  const envelope = payload as unknown as Envelope<T>;
  if (typeof envelope?.errorCode !== "string") throw new HttpError(502, "The document service answered in a shape this version does not understand.", "DI_CONTRACT");
  return envelope;
}

/** Each booking is one Subject at the platform; its documents hang off that. */
export async function createSubject(env: Env, tenantId: string, displayName: string, correlationId?: string): Promise<string> {
  const r = await call<{ subjectId: string }>(env, tenantId, "POST", `/v1/tenants/${encodeURIComponent(tenantId)}/subjects`, {
    body: { subjectType: "PERSON", displayName: displayName.slice(0, 200) },
    correlationId,
  });
  const id = r.data?.subjectId;
  if (r.errorCode !== "000" || !id) throw new HttpError(502, `The document service would not open a record for this booking (${r.errorCode}).`, "DI_SUBJECT");
  return id;
}

/**
 * Sends one file. A refusal is not an error in the transport sense — it comes back 201 with a code
 * saying what was wrong with the file — so it is raised as something a consultant can act on.
 */
export async function uploadDocument(
  env: Env,
  tenantId: string,
  subjectId: string,
  file: { name: string; type: string; bytes: ArrayBuffer },
  documentTypeKey: string,
  correlationId?: string,
): Promise<DiDocument> {
  const form = new FormData();
  form.set("file", new Blob([file.bytes], { type: file.type }), file.name);
  form.set("documentTypeKey", documentTypeKey);
  const r = await call<{ documentId: string; uploadStatus: string; processingStatus: string | null }>(
    env,
    tenantId,
    "POST",
    `/v1/tenants/${encodeURIComponent(tenantId)}/subjects/${encodeURIComponent(subjectId)}/documents`,
    { body: form, correlationId },
  );
  if (r.errorCode !== "000") {
    throw new DiRejected(r.data?.documentId ?? null, r.errorCode, REJECTION[r.errorCode] ?? r.errorMessage ?? "That file could not be read.");
  }
  const d = r.data;
  if (!d?.documentId) throw new HttpError(502, "The document service accepted the file but did not say which record it is.", "DI_CONTRACT");
  return {
    document_id: d.documentId,
    document_type_key: documentTypeKey,
    upload_status: d.uploadStatus as DiDocument["upload_status"],
    processing_status: (d.processingStatus ?? null) as DiDocument["processing_status"],
    confirmation_status: null,
    confidence: null,
  };
}

/** Where a document has got to. Polled; the platform has no way of telling us when it is done. */
export async function getDocument(env: Env, tenantId: string, subjectId: string, documentId: string, correlationId?: string): Promise<DiDocument> {
  const r = await call<{ documentId: string; documentTypeKey: string | null; uploadStatus: string; processingStatus: string | null; confirmationStatus: string | null; confidenceScore: number | string | null }>(
    env,
    tenantId,
    "GET",
    `/v1/tenants/${encodeURIComponent(tenantId)}/subjects/${encodeURIComponent(subjectId)}/documents/${encodeURIComponent(documentId)}`,
    { correlationId },
  );
  const d = r.data;
  if (r.errorCode !== "000" || !d) throw new HttpError(502, `The document service could not say how that document is getting on (${r.errorCode}).`, "DI_STATUS");
  return {
    document_id: d.documentId,
    // What it decided the document is. The key we sent was only a hint, so this is the one to trust.
    document_type_key: d.documentTypeKey ?? null,
    upload_status: d.uploadStatus as DiDocument["upload_status"],
    processing_status: (d.processingStatus ?? null) as DiDocument["processing_status"],
    confirmation_status: d.confirmationStatus ?? null,
    confidence: d.confidenceScore === null || d.confidenceScore === undefined ? null : Number(d.confidenceScore),
  };
}

/**
 * The values read off the document. Only available once it is confirmed; before that the platform
 * answers 200 with E008, which means "ask again later", not "this went wrong".
 */
export async function getFields(env: Env, tenantId: string, subjectId: string, documentId: string, correlationId?: string): Promise<DiField[] | null> {
  const r = await call<{ fields: { fieldKey: string; currentValue: unknown; confidenceScore: number | string | null; valueSource: string | null }[] }>(
    env,
    tenantId,
    "GET",
    `/v1/tenants/${encodeURIComponent(tenantId)}/subjects/${encodeURIComponent(subjectId)}/documents/${encodeURIComponent(documentId)}/fields`,
    { correlationId },
  );
  if (r.errorCode === "E008") return null;
  if (r.errorCode !== "000" || !r.data) throw new HttpError(502, `The document service would not give up the values it read (${r.errorCode}).`, "DI_FIELDS");
  return (r.data.fields ?? []).map((f) => ({
    key: f.fieldKey,
    value: decode(f.currentValue),
    confidence: f.confidenceScore === null || f.confidenceScore === undefined ? null : Number(f.confidenceScore),
    source: f.valueSource ?? null,
  }));
}

/**
 * Values are stored as JSON at the platform and come back as a JSON string rather than a value, so a
 * number arrives as "21000" and a missing one as "null". Anything that is not JSON is taken as the
 * plain string it appears to be.
 */
function decode(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** True once the platform has finished with a document, either way. */
export const isSettled = (d: DiDocument) => d.processing_status === "PROCESSED" || d.processing_status === "FAILED";

/** True once its values can be read. */
export const isReadable = (d: DiDocument) => d.processing_status === "PROCESSED" && d.confirmation_status === "CONFIRMED";
