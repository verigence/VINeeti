// The Android app, handed out from inside the dealership's own site.
//
// The app is not on the Play Store, so it has to be downloaded as a file. Putting that file on a
// public address would mean anybody who guessed the address could take a copy of the dealership's
// app, so it lives behind the same sign-in as everything else: the file is served by the Worker from
// a private bucket, to somebody who is already signed in, and the bucket is never public.
//
// The build workflow puts two things in the bucket: the APK itself, and a small record saying which
// version is current. The record is what every screen reads; the APK is only ever fetched by the
// download route, one person at a time.

import type { Env } from "../env";

/** Where the current build's record lives. One per deployment, not per dealership. */
const RECORD = "app/latest.json";

export interface AppBuild {
  /** Shown to people: "1.2.0". */
  version: string;
  /** Android's own counter. Higher means newer; the phone refuses to install an older one over a newer. */
  version_code: number;
  /** The key of the APK in the bucket. */
  key: string;
  size: number;
  /** Hex SHA-256 of the file, so somebody can check what they downloaded is what was built. */
  sha256: string;
  /** The address the app opens, which is the one it was built for. */
  host: string;
  built_at: string;
}

function parse(text: string): AppBuild | null {
  try {
    const r = JSON.parse(text) as Partial<AppBuild>;
    if (!r || typeof r.version !== "string" || typeof r.key !== "string" || typeof r.size !== "number") return null;
    return {
      version: r.version,
      version_code: Number(r.version_code) || 0,
      key: r.key,
      size: r.size,
      sha256: typeof r.sha256 === "string" ? r.sha256 : "",
      host: typeof r.host === "string" ? r.host : "",
      built_at: typeof r.built_at === "string" ? r.built_at : "",
    };
  } catch {
    return null;
  }
}

/** The build on offer, or null where none has been published yet. */
export async function currentBuild(env: Env): Promise<AppBuild | null> {
  if (!env.FILES) return null;
  const obj = await env.FILES.get(RECORD);
  if (!obj) return null;
  return parse(await obj.text());
}

/**
 * The APK itself. Returned as a stream rather than read into memory: the Worker has little of it, and
 * the file is handed straight to the phone.
 */
export async function buildFile(env: Env, build: AppBuild): Promise<{ body: ReadableStream; name: string; size: number } | null> {
  if (!env.FILES) return null;
  const obj = await env.FILES.get(build.key);
  if (!obj) return null;
  return { body: obj.body, name: `vineeti-${build.version}.apk`, size: obj.size };
}
