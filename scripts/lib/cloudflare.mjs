// What the deployment scripts need from Cloudflare: the REST API for look-ups, and Wrangler (the project's
// own copy) for everything that changes the account. Credentials come from the environment only:
//   CLOUDFLARE_API_TOKEN   an API token with Workers Scripts: Edit and D1: Edit on the account
//   CLOUDFLARE_ACCOUNT_ID  the account to deploy to
// Nothing here prints or stores a secret.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

export const ROOT = new URL("../../", import.meta.url).pathname;
// Wrangler reads the same variable, so a test or a proxy can stand in for the Cloudflare API in both.
const API = (process.env.CLOUDFLARE_API_BASE_URL ?? "https://api.cloudflare.com/client/v4").replace(/\/$/, "");

export function credentials() {
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  const account = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (!token || !account) throw new Stop("Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (in GitHub: repository secrets with those names).");
  if (!/^[0-9a-f]{32}$/.test(account)) throw new Stop("CLOUDFLARE_ACCOUNT_ID should be the 32-character account ID shown in the Cloudflare dashboard.");
  return { token, account };
}

/** An error whose message is for the person running the script: printed without a stack trace. */
export class Stop extends Error {}

/** Calls the Cloudflare API. Returns `{ ok, status, result, errors }`; never throws for an API-level refusal. */
export async function cf(method, path, body) {
  const { token } = credentials();
  let res;
  try {
    res = await fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    throw new Stop(`Could not reach the Cloudflare API: ${e.message}`);
  }
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok && json.success !== false, status: res.status, result: json.result, errors: json.errors ?? [] };
}
const why = (r) => r.errors.map((e) => `${e.message} (${e.code})`).join("; ") || `HTTP ${r.status}`;

/** Confirms the token is live. Account-owned tokens and user-owned tokens are verified at different addresses. */
export async function verifyToken() {
  const { account } = credentials();
  for (const path of [`/accounts/${account}/tokens/verify`, `/user/tokens/verify`]) {
    const r = await cf("GET", path);
    if (r.ok && r.result?.status === "active") return;
  }
  throw new Stop("Cloudflare did not accept the API token. Check that CLOUDFLARE_API_TOKEN is the whole token, that it has not been revoked, and that CLOUDFLARE_ACCOUNT_ID is the account it belongs to.");
}

/** The D1 database with this name, created if it does not exist (unless `create` is false: then null). */
export async function ensureDatabase(name, location, { create = true } = {}) {
  const { account } = credentials();
  const list = await cf("GET", `/accounts/${account}/d1/database?name=${encodeURIComponent(name)}&per_page=100`);
  if (!list.ok) throw new Stop(`The API token cannot read D1 databases: ${why(list)}. The token needs the permission "D1: Edit" on this account.`);
  const found = (list.result ?? []).find((d) => d.name === name);
  if (found) return { id: found.uuid, created: false };
  if (!create) return null;
  const made = await cf("POST", `/accounts/${account}/d1/database`, { name, ...(location ? { primary_location_hint: location } : {}) });
  if (!made.ok) throw new Stop(`The D1 database "${name}" could not be created: ${why(made)}. The token needs the permission "D1: Edit" on this account.`);
  return { id: made.result.uuid, created: true };
}

/** Names of the secrets the Worker already has; null when the Worker has not been deployed yet. */
export async function workerSecrets(worker) {
  const { account } = credentials();
  const r = await cf("GET", `/accounts/${account}/workers/scripts/${worker}/secrets`);
  if (r.ok) return (r.result ?? []).map((s) => s.name);
  if (r.status === 404 || r.errors.some((e) => e.code === 10007)) return null;
  throw new Stop(`The API token cannot read the Worker "${worker}": ${why(r)}. The token needs the permission "Workers Scripts: Edit" on this account.`);
}

/** The Worker's address on workers.dev. */
export async function workerUrl(worker) {
  const { account } = credentials();
  const r = await cf("GET", `/accounts/${account}/workers/subdomain`);
  if (!r.ok || !r.result?.subdomain) throw new Stop("This Cloudflare account has no workers.dev subdomain yet. Open Workers & Pages in the Cloudflare dashboard once (it asks you to choose the subdomain), then run this again.");
  return `https://${worker}.${r.result.subdomain}.workers.dev`;
}

/** Reads wrangler.jsonc (JSON with comments). */
export function readConfig(file = `${ROOT}wrangler.jsonc`) {
  const text = readFileSync(file, "utf8");
  let out = "", inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i];
      else if (c === '"') inString = false;
    } else if (c === '"') { inString = true; out += c; }
    else if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; }
    else if (c === "/" && text[i + 1] === "*") { i = text.indexOf("*/", i + 2) + 1; }
    else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** Runs the project's Wrangler. Output goes to the terminal; `input` is written to its standard input (for a secret's value). */
export function wrangler(args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["--no-install", "wrangler", ...args], { cwd: ROOT, stdio: [input === undefined ? "ignore" : "pipe", "inherit", "inherit"], env: { ...process.env, CI: process.env.CI ?? "true", WRANGLER_SEND_METRICS: "false" } });
    if (input !== undefined) child.stdin.end(input);
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Stop(`wrangler ${args[0]} ${args[1] ?? ""} failed (exit ${code}). The lines above say why.`))));
  });
}

/** Runs any command of the project (npm scripts). */
export function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Stop(`${cmd} ${args.join(" ")} failed (exit ${code}).`))));
  });
}

export const randomSecret = (bytes = 32) => randomBytes(bytes).toString("base64url");

/** Waits until the address answers its health check. */
export async function waitHealthy(base, seconds = 120) {
  const until = Date.now() + seconds * 1000;
  let last = "no answer";
  while (Date.now() < until) {
    try {
      const res = await fetch(new URL("/api/health", base), { signal: AbortSignal.timeout(10_000) });
      if (res.ok && (await res.json()).ok === true) return;
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = e.message;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Stop(`${base}/api/health did not answer within ${seconds} seconds (${last}). The Worker is deployed; check its logs in the Cloudflare dashboard.`);
}

/** Runs a script's main function, printing a Stop as one plain line. */
export function main(fn) {
  fn().catch((e) => {
    if (e instanceof Stop) console.error(`\nStopped: ${e.message}`);
    else console.error(e);
    process.exit(1);
  });
}
