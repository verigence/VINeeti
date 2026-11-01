#!/usr/bin/env node
// Creates one dealership on a deployment: its dealer code, name, and first System Admin (whose mobile
// number is their sign-in ID). Outlets, cars and bookings come from the first DMS files loaded.
//
// With the platform token of the deployment:
//   PLATFORM_ADMIN_TOKEN=... node scripts/onboard.mjs https://<address> scripts/dealer.example.json
//
// With Cloudflare credentials instead (what the GitHub workflow "Onboard a dealership" does): a fresh
// platform token is set on the Worker for this run, so nobody has to keep one.
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/onboard.mjs --rotate-token [https://<address>] dealer.json
//
// The JSON file looks like scripts/dealer.example.json. The administrator signs in with the mobile number
// and first password in it, and is asked to set a new password straight away.

import { readFileSync } from "node:fs";
import { Stop, main, randomSecret, readConfig, waitHealthy, workerUrl, wrangler } from "./lib/cloudflare.mjs";

main(async () => {
  const args = process.argv.slice(2);
  const rotate = args[0] === "--rotate-token";
  if (rotate) args.shift();
  const file = args.pop();
  let base = args.pop();
  let token = process.env.PLATFORM_ADMIN_TOKEN;
  if (!file || (!rotate && (!base || !token))) {
    throw new Stop("Usage: PLATFORM_ADMIN_TOKEN=... node scripts/onboard.mjs <address> <dealer.json>\n   or: CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/onboard.mjs --rotate-token [<address>] <dealer.json>");
  }
  const dealer = JSON.parse(readFileSync(file, "utf8"));
  if (!dealer.slug || !dealer.name || !dealer.admin?.mobile || !dealer.admin?.email || !dealer.admin?.password) throw new Stop(`${file} needs slug, name, oem and admin (name, mobile, email, password).`);

  if (rotate) {
    const worker = readConfig().name;
    base ??= workerUrl(worker);
    token = randomSecret();
    console.log(`Setting a fresh platform token on the Worker "${worker}"`);
    await wrangler(["secret", "put", "PLATFORM_ADMIN_TOKEN", "--name", worker], { input: token });
  }
  await waitHealthy(base, 60);

  // A secret just set takes a few seconds to reach every location; "not authorised" is retried for a minute.
  const until = Date.now() + 60_000;
  for (;;) {
    const res = await fetch(new URL("/api/platform/tenants", base), { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(dealer) });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      console.log(`\nDealership created: ${dealer.name}\nSign in at ${base} with the mobile number ${dealer.admin.mobile} and the first password. Dealer code (only needed if the same mobile number is used at another dealership): ${body.slug}`);
      return;
    }
    if (res.status === 401 && rotate && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    throw new Stop(`Not created (${res.status}): ${body?.error?.message ?? "unknown error"}`);
  }
});
