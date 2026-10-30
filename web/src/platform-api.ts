// The platform console's own calls: same-origin, with the console's own cookie, never the dealership session.
import { ApiError } from "./api";

export async function platformCall<R>(method: string, path: string, body?: unknown): Promise<R> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) throw new ApiError(res.status, json?.error?.code ?? "ERROR", json?.error?.message ?? `Request failed (${res.status})`);
  return json as R;
}
