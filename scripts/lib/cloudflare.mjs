// What the deployment scripts need from Cloudflare. Everything goes through the project's own Wrangler,
// never the REST API, so a token with the permissions Wrangler itself needs ("Edit Cloudflare Workers"
// plus D1: Edit) is enough — the same token the other Verigence deployments use.
//
//   CLOUDFLARE_API_TOKEN   API token with Workers Scripts: Edit and D1: Edit on the account
//   CLOUDFLARE_ACCOUNT_ID  the account to deploy to
//
// Nothing here prints or stores a secret.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";

export const ROOT = new URL("../../", import.meta.url).pathname;

/** An error whose message is for the person reading the pipeline log: printed without a stack trace. */
export class Stop extends Error {}

/** A fact worth seeing on the run itself, not only in a step log that may not be reachable. */
export function note(message, title = "Deployment") {
  console.log(message);
  if (process.env.GITHUB_ACTIONS !== "true") return;
  console.log(`::notice title=${title}::${String(message).replace(/\r?\n/g, "%0A")}`);
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) {
    try {
      appendFileSync(file, `\n**${title}.** ${message}\n`);
    } catch {
      /* the summary is a convenience, never the only copy */
    }
  }
}

export function credentials() {
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  const account = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (!token || !account) throw new Stop("Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (in GitHub: repository or organization secrets with those names).");
  if (!/^[0-9a-f]{32}$/.test(account)) throw new Stop("CLOUDFLARE_ACCOUNT_ID should be the 32-character account ID shown in the Cloudflare dashboard.");
  return { token, account };
}

/**
 * Runs the project's Wrangler. By default its output goes straight to the log; with `capture` it is
 * collected and returned as well (and still shown), so a step can read what Wrangler printed.
 */
export function wrangler(args, { input, capture = false, quiet = false, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["--no-install", "wrangler", ...args], {
      cwd: ROOT,
      stdio: [input === undefined ? "ignore" : "pipe", capture ? "pipe" : "inherit", capture ? "pipe" : "inherit"],
      env: { ...process.env, CI: process.env.CI ?? "true", WRANGLER_SEND_METRICS: "false" },
    });
    let out = "", err = "";
    if (capture) {
      // `quiet` keeps a look-up's output out of the log; it is printed only if the command fails unexpectedly.
      child.stdout.on("data", (d) => ((out += d), quiet || process.stdout.write(d)));
      child.stderr.on("data", (d) => ((err += d), quiet || process.stderr.write(d)));
    }
    if (input !== undefined) child.stdin.end(input);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || allowFailure) resolve({ code, out, err });
      else reject(new Stop(`wrangler ${args.filter((a) => !a.startsWith("--secrets-file")).slice(0, 3).join(" ")} failed (exit ${code}). The lines above say why.`));
    });
  });
}

/** Runs a command of the project (an npm script). */
export function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Stop(`${cmd} ${args.join(" ")} failed (exit ${code}).`))));
  });
}

/** The first JSON value in Wrangler's output (it prints a banner first). */
function jsonFrom(text) {
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  for (let end = text.length; end > start; end--) {
    try {
      return JSON.parse(text.slice(start, end));
    } catch {
      /* keep trimming */
    }
  }
  return null;
}

/**
 * The D1 database with this name, created if it does not exist (unless `create` is false: then null).
 * Both steps go through Wrangler, so they need no permission beyond the deployment's own.
 */
export async function ensureDatabase(name, location, { create = true } = {}) {
  const find = async () => {
    const { code, out, err } = await wrangler(["d1", "list", "--json"], { capture: true, quiet: true, allowFailure: true });
    const list = code === 0 ? jsonFrom(out) : null;
    if (!Array.isArray(list)) {
      process.stderr.write(`${out}${err}`);
      throw new Stop('Could not read the list of D1 databases (see above). The API token needs the permission "D1: Edit" on this account.');
    }
    return list.find((d) => d.name === name) ?? null;
  };
  const found = await find();
  if (found) return { id: found.uuid, created: false };
  if (!create) return null;
  await wrangler(["d1", "create", name, ...(location ? ["--location", location] : [])]);
  const made = await find();
  if (!made) throw new Stop(`The D1 database "${name}" was created but could not be read back. Run the workflow again.`);
  return { id: made.uuid, created: true };
}

/**
 * The bucket a support ticket's attachment goes into, created if it is not there yet. Creating one is
 * safe to repeat: an existing bucket is left exactly as it is, and nothing is ever deleted here.
 */
export async function ensureBucket(name, { create = true } = {}) {
  const find = async () => {
    const { code, out, err } = await wrangler(["r2", "bucket", "list"], { capture: true, quiet: true, allowFailure: true });
    if (code !== 0) {
      process.stderr.write(`${out}${err}`);
      throw new Stop('Could not read the list of R2 buckets (see above). The API token needs the permission "Workers R2 Storage: Edit" on this account.');
    }
    // `r2 bucket list` prints a table, not JSON, so the name is looked for as a whole word.
    return new RegExp(`(^|\\s)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`, "m").test(out);
  };
  if (await find()) return { created: false };
  if (!create) return null;
  await wrangler(["r2", "bucket", "create", name]);
  return { created: true };
}

/** Names of the secrets the Worker already has; null when the Worker has not been deployed yet. */
export async function workerSecrets(worker) {
  const { code, out, err } = await wrangler(["secret", "list", "--name", worker, "--format", "json"], { capture: true, quiet: true, allowFailure: true });
  if (code !== 0) {
    if (/not found|does not exist|10007|10090/i.test(`${out}${err}`)) return null; // no Worker of that name yet
    process.stderr.write(`${out}${err}`);
    throw new Stop('Could not read the Worker\'s secrets (see above). The API token needs the permission "Workers Scripts: Edit" on this account.');
  }
  const list = jsonFrom(out);
  return Array.isArray(list) ? list.map((s) => s.name) : [];
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

export const randomSecret = (bytes = 32) => randomBytes(bytes).toString("base64url");

/** The workers.dev address in Wrangler's deployment output. */
export function urlFromDeployOutput(text, worker) {
  const m = new RegExp(`https://[\\w.-]*${worker.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}[\\w.-]*\\.workers\\.dev`).exec(text) ?? /https:\/\/[\w.-]+\.workers\.dev/.exec(text);
  return m ? m[0] : null;
}

/**
 * The Worker's address on workers.dev. The account's subdomain is fixed for the account, so it is a
 * setting (WORKERS_SUBDOMAIN) rather than a look-up that would need a wider API token; a custom domain
 * is given to the scripts as an address instead.
 */
export function workerUrl(worker) {
  const sub = (process.env.WORKERS_SUBDOMAIN ?? "jbrconsulting-it").trim();
  return `https://${worker}.${sub}.workers.dev`;
}

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

/**
 * Runs a script's main function, printing a Stop as one plain line.
 *
 * The reason is also raised as a GitHub Actions annotation and written to the run summary, so why a
 * deployment stopped is visible on the run itself rather than only to someone who opens the step log.
 */
export function main(fn) {
  fn().catch((e) => {
    const msg = e instanceof Stop ? e.message : `${e?.stack ?? e}`;
    if (e instanceof Stop) console.error(`\nStopped: ${e.message}`);
    else console.error(e);
    if (process.env.GITHUB_ACTIONS === "true") {
      console.log(`::error title=Deployment stopped::${String(msg).replace(/\r?\n/g, "%0A")}`);
      const file = process.env.GITHUB_STEP_SUMMARY;
      if (file) {
        try {
          appendFileSync(file, `\n### Deployment stopped\n\n\`\`\`\n${msg}\n\`\`\`\n`);
        } catch {
          /* the summary is a convenience; never let it hide the real error */
        }
      }
    }
    process.exit(1);
  });
}
