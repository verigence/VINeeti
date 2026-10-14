#!/usr/bin/env node
// Deploys Verigence VINeeti to a Cloudflare account, first time or any later time, in one command:
//
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/deploy.mjs
//
// It is the same command the GitHub Actions workflow runs (.github/workflows/deploy.yml). Each step is
// safe to repeat:
//   1. checks the API token
//   2. finds the D1 database, or creates it the first time (D1_LOCATION, default "apac")
//   3. builds the web app
//   4. applies any database migrations not yet applied
//   5. deploys the Worker; secrets the Worker does not have yet are created with it
//      (SESSION_SECRET, DATA_KEY, PLATFORM_ADMIN_TOKEN: random values, never changed by later deployments)
//   6. waits for the health check to answer
//
// Options:  --skip-build   use the dist/ folder as it is
//           --check        do steps 1 and 2 only and say what a deployment would do
//
// DATA_KEY protects each dealership's WhatsApp credentials in the database. It is created once and must
// never be replaced: a different key cannot read what the old one wrote.

import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, Stop, credentials, ensureDatabase, main, randomSecret, readConfig, run, verifyToken, waitHealthy, workerSecrets, workerUrl, wrangler } from "./lib/cloudflare.mjs";

const flags = new Set(process.argv.slice(2));
const APP_SECRETS = ["SESSION_SECRET", "DATA_KEY", "PLATFORM_ADMIN_TOKEN"];
const CONFIG = "wrangler.deploy.json"; // written beside wrangler.jsonc so its relative paths still hold; not committed
const step = (n, text) => console.log(`\n[${n}/6] ${text}`);

main(async () => {
  credentials();
  const config = readConfig();
  const worker = config.name;
  const db = config.d1_databases?.[0];
  if (!worker || !db) throw new Stop("wrangler.jsonc must name the Worker and one D1 database.");

  step(1, "Checking the Cloudflare API token");
  await verifyToken();
  const url = await workerUrl(worker);

  step(2, `Database "${db.database_name}"`);
  const check = flags.has("--check");
  const database = process.env.D1_DATABASE_ID ? { id: process.env.D1_DATABASE_ID, created: false } : await ensureDatabase(db.database_name, process.env.D1_LOCATION ?? "apac", { create: !check });
  console.log(!database ? "Not there yet." : database.created ? `Created (${database.id}).` : `Found (${database.id}).`);
  const have = await workerSecrets(worker);
  const missing = APP_SECRETS.filter((name) => !(have ?? []).includes(name));
  if (have?.includes("DATA_KEY") && process.env.DATA_KEY) throw new Stop("DATA_KEY is already set on the Worker and must not be replaced: the WhatsApp credentials stored in the database could no longer be read. Remove DATA_KEY from the environment and run again.");
  if (check) {
    console.log(`\nA deployment would: ${database ? "" : `create the database "${db.database_name}", `}${have === null ? "create" : "update"} the Worker "${worker}" at ${url}, apply pending migrations${missing.length ? `, and create the secrets ${missing.join(", ")}` : ""}.`);
    return;
  }
  db.database_id = database.id;
  writeFileSync(join(ROOT, CONFIG), JSON.stringify(config, null, 2));

  step(3, "Building the web app");
  if (flags.has("--skip-build")) console.log("Skipped.");
  else await run("npm", ["run", "build:web"]);

  step(4, "Applying database migrations");
  await wrangler(["d1", "migrations", "apply", "DB", "--remote", "--config", CONFIG]);

  step(5, `Deploying the Worker "${worker}"`);
  // A value given in the environment is set as given; otherwise a secret the Worker lacks gets a random value.
  const secrets = {};
  for (const name of APP_SECRETS) {
    if (process.env[name]) secrets[name] = process.env[name];
    else if (missing.includes(name)) secrets[name] = randomSecret();
  }
  const names = Object.keys(secrets);
  if (names.length) {
    const dir = mkdtempSync(join(tmpdir(), "vineeti-"));
    const file = join(dir, "secrets.json");
    try {
      writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
      await wrangler(["deploy", "--config", CONFIG, "--secrets-file", file]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } else {
    await wrangler(["deploy", "--config", CONFIG]);
  }

  step(6, "Health check");
  await waitHealthy(url);
  console.log(`Healthy: ${url}`);

  const created = names.filter((n) => missing.includes(n) && !process.env[n]);
  const lines = [
    `Verigence VINeeti is deployed at ${url}`,
    `Database: ${db.database_name} (${database.id})${database.created ? ", created in this run" : ""}`,
    created.length ? `Secrets created in this run: ${created.join(", ")}` : "Secrets: unchanged",
    have === null ? "Next: create the dealership (GitHub: run the workflow \"Onboard a dealership\"; or scripts/onboard.mjs)." : "",
  ].filter(Boolean);
  console.log(`\n${lines.join("\n")}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Deployment\n\n${lines.map((l) => `- ${l}`).join("\n")}\n`);
  // Run by hand, the platform token is shown this once so a dealership can be onboarded. In CI it is never printed:
  // the onboarding workflow sets a fresh one each time it runs.
  if (created.includes("PLATFORM_ADMIN_TOKEN") && !process.env.CI && process.stdout.isTTY) {
    console.log(`\nPLATFORM_ADMIN_TOKEN (shown once; needed by scripts/onboard.mjs): ${secrets.PLATFORM_ADMIN_TOKEN}`);
  }
});
