#!/usr/bin/env node
// Deploys Verigence VINeeti to Cloudflare. This is what the pipeline runs (.github/workflows/deploy.yml,
// on every push to main); the same command also works by hand with the same two environment variables.
// Everything goes through the project's Wrangler, so the API token needs nothing beyond what Wrangler
// itself needs. Each step is safe to repeat and nothing has to be done in the dashboard:
//
//   1. finds the D1 database, or creates it the first time (D1_LOCATION, default "apac")
//   2. builds the web app
//   3. applies any database migrations not yet applied
//   4. deploys the Worker; secrets the Worker does not have yet are created with it
//      (SESSION_SECRET, DATA_KEY, PLATFORM_ADMIN_TOKEN: random values, never changed by later deployments)
//   5. waits for the health check to answer
//
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/deploy.mjs
//
// Options:  --skip-build   use the dist/ folder as it is
//           --dry-run      do step 1 only and say what a deployment would do
//
// DATA_KEY protects each dealership's WhatsApp credentials in the database. It is created once and must
// never be replaced: a different key cannot read what the old one wrote.

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The checked-out commit, when there is a repository to ask. */
function gitSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}
import { ROOT, Stop, credentials, ensureDatabase, main, note, randomSecret, readConfig, run, urlFromDeployOutput, waitHealthy, workerSecrets, workerUrl, wrangler } from "./lib/cloudflare.mjs";

const flags = new Set(process.argv.slice(2));
const APP_SECRETS = ["SESSION_SECRET", "DATA_KEY", "PLATFORM_ADMIN_TOKEN"];
// Set when given in the environment; the Worker runs without them.
const OPTIONAL_SECRETS = ["ANDROID_CERT_SHA256", "WA_APP_SECRET", "WA_VERIFY_TOKEN"];
const CONFIG = "wrangler.deploy.json"; // written beside wrangler.jsonc so its relative paths still hold; not committed
const step = (n, text) => console.log(`\n[${n}/5] ${text}`);

main(async () => {
  credentials();
  const config = readConfig();
  const worker = config.name;
  const db = config.d1_databases?.[0];
  if (!worker || !db) throw new Stop("wrangler.jsonc must name the Worker and one D1 database.");
  const check = flags.has("--dry-run") || flags.has("--check");

  step(1, `Database "${db.database_name}"`);
  const database = process.env.D1_DATABASE_ID ? { id: process.env.D1_DATABASE_ID, created: false } : await ensureDatabase(db.database_name, process.env.D1_LOCATION ?? "apac", { create: !check });
  console.log(!database ? "Not there yet; a deployment would create it." : database.created ? `Created (${database.id}).` : `Found (${database.id}).`);
  const have = await workerSecrets(worker);
  const missing = APP_SECRETS.filter((name) => !(have ?? []).includes(name));
  if (have?.includes("DATA_KEY") && process.env.DATA_KEY) throw new Stop("DATA_KEY is already set on the Worker and must not be replaced: the WhatsApp credentials stored in the database could no longer be read. Remove DATA_KEY from the environment and run again.");
  if (check) {
    console.log(`\nA deployment would: ${database ? "" : `create the database "${db.database_name}", `}${have === null ? "create" : "update"} the Worker "${worker}", apply pending migrations${missing.length ? `, and create the secrets ${missing.join(", ")}` : ""}.`);
    return;
  }
  db.database_id = database.id;
  // The version deployed and when, shown on the platform console's System health page. From the
  // pipeline's own commit when run there; from git when run by hand.
  const sha = process.env.GITHUB_SHA ?? gitSha();
  config.vars = { ...(config.vars ?? {}), APP_VERSION: sha ? sha.slice(0, 12) : "unknown", APP_DEPLOYED_AT: new Date().toISOString(), APP_URL: process.env.VINEETI_URL || workerUrl(worker) };
  writeFileSync(join(ROOT, CONFIG), JSON.stringify(config, null, 2));

  step(2, "Building the web app");
  if (flags.has("--skip-build")) console.log("Skipped.");
  else await run("npm", ["run", "build:web"]);

  step(3, "Applying database migrations");
  await wrangler(["d1", "migrations", "apply", db.database_name, "--remote", "--config", CONFIG]);

  step(4, `Deploying the Worker "${worker}"`);
  // A value given in the environment is set as given; otherwise a secret the Worker lacks gets a random value.
  const secrets = {};
  for (const name of APP_SECRETS) {
    if (process.env[name]) secrets[name] = process.env[name];
    else if (missing.includes(name)) secrets[name] = randomSecret();
  }
  for (const name of OPTIONAL_SECRETS) if (process.env[name]) secrets[name] = process.env[name];
  // The platform's own administrator ("super admin"): created, or its password brought up to date, on every
  // deployment from the repository secrets. A fresh deployment token goes out with this deployment and is
  // used once, right after it, to set the account up; it is never printed and never stored anywhere.
  const superMobile = process.env.SUPERADMIN_MOBILE?.trim();
  const superPassword = process.env.SUPERADMIN_PASSWORD;
  const superName = process.env.SUPERADMIN_NAME?.trim() || "Super Admin";
  if (superMobile && !superPassword) throw new Stop("SUPERADMIN_MOBILE is set but SUPERADMIN_PASSWORD is not. Set both (the password is at least 10 characters with a letter and a digit), or neither.");
  const bootstrapToken = superMobile && superPassword ? randomSecret() : null;
  if (bootstrapToken) secrets.PLATFORM_ADMIN_TOKEN = bootstrapToken;
  const names = Object.keys(secrets);
  let output = "";
  if (names.length) {
    const dir = mkdtempSync(join(tmpdir(), "vineeti-"));
    const file = join(dir, "secrets.json");
    try {
      writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
      output = (await wrangler(["deploy", "--config", CONFIG, "--secrets-file", file], { capture: true })).out;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } else {
    output = (await wrangler(["deploy", "--config", CONFIG], { capture: true })).out;
  }
  const url = process.env.VINEETI_URL || urlFromDeployOutput(output, worker) || workerUrl(worker);

  step(5, "Health check");
  await waitHealthy(url);
  console.log(`Healthy: ${url}`);

  if (bootstrapToken) {
    // A secret set with this deployment takes a few seconds to reach every location, so a refusal is retried.
    const until = Date.now() + 90_000;
    for (;;) {
      const res = await fetch(new URL("/api/platform/bootstrap", url), { method: "POST", headers: { Authorization: `Bearer ${bootstrapToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ mobile: superMobile, name: superName, password: superPassword }) }).catch((e) => ({ ok: false, status: 0, text: async () => e.message }));
      if (res.ok) {
        const body = await res.json();
        const what = body.created ? "created" : body.changed ? "password brought up to date" : "already set up";
        console.log(`Super admin ${body.mobile}: ${what}.`);
        // Said on the run itself, because "can I sign in to the platform console, and as whom" is not a
        // question anybody should have to read a step log to answer.
        note(`Platform console: sign in at ${url}/platform with the mobile number ${body.mobile} (${what}).`, "Super admin");
        break;
      }
      if (res.status === 401 && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      throw new Stop(`The super admin could not be set up (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
    }
  } else {
    console.log("No SUPERADMIN_MOBILE / SUPERADMIN_PASSWORD secret: the platform console has no account yet.");
    note(
      `There is no platform administrator on this deployment: neither SUPERADMIN_MOBILE nor SUPERADMIN_PASSWORD is set as a repository secret, so ${url}/platform cannot be signed in to by anybody. Set both secrets and deploy again to create one. The dealership sign-in at ${url} is separate and is unaffected.`,
      "No super admin",
    );
  }

  const created = names.filter((n) => missing.includes(n) && !process.env[n]);
  const lines = [
    `Verigence VINeeti is deployed at ${url}`,
    `Database: ${db.database_name} (${database.id})${database.created ? ", created in this run" : ""}`,
    created.length ? `Secrets created in this run: ${created.join(", ")}` : "Application secrets: unchanged",
    bootstrapToken ? `Platform console: sign in at ${url}/platform with ${superMobile}` : "",
    names.filter((n) => OPTIONAL_SECRETS.includes(n)).length ? `Also set from the environment: ${names.filter((n) => OPTIONAL_SECRETS.includes(n)).join(", ")}` : "",
    have === null ? 'Next: create the dealership — run the workflow "Onboard a dealership".' : "",
  ].filter(Boolean);
  console.log(`\n${lines.join("\n")}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Deployment\n\n${lines.map((l) => `- ${l}`).join("\n")}\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `url=${url}\n`);
  // Run by hand, the platform token is shown this once so a dealership can be onboarded. In CI it is never printed:
  // the onboarding workflow sets a fresh one each time it runs.
  if (created.includes("PLATFORM_ADMIN_TOKEN") && !process.env.CI && process.stdout.isTTY) {
    console.log(`\nPLATFORM_ADMIN_TOKEN (shown once; needed by scripts/onboard.mjs): ${secrets.PLATFORM_ADMIN_TOKEN}`);
  }
});
