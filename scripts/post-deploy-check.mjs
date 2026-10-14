#!/usr/bin/env node
// Checks the live deployment after it is updated. Everything here is unauthenticated, or proves that
// authentication is required, so the pipeline runs it with no credentials.
//
//   node scripts/post-deploy-check.mjs https://<address>
//
// Exit code 0: every check passed. 1: at least one failed, and the line says which.

const BASE = (process.argv[2] || process.env.VINEETI_URL || "").replace(/\/$/, "");
if (!BASE) {
  console.error("Usage: node scripts/post-deploy-check.mjs https://<address>");
  process.exit(1);
}
let passed = 0, failed = 0;
const ok = (label) => (passed++, console.log(`  ok   ${label}`));
const bad = (label, detail) => (failed++, console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`));

async function get(path, init = {}) {
  try {
    const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(15_000), redirect: "manual", ...init });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, text, json, type: res.headers.get("Content-Type") ?? "" };
  } catch (e) {
    return { status: 0, text: "", json: null, type: "", error: e.message };
  }
}

console.log(`Checking ${BASE}`);

// The Worker answers, and says so in the shape the app expects.
const health = await get("/api/health");
health.status === 200 && health.json?.ok === true ? ok("health check answers") : bad("health check answers", health.error ?? `HTTP ${health.status}`);
health.json?.at && !Number.isNaN(Date.parse(health.json.at)) ? ok("health check carries the server time") : bad("health check carries the server time");

// The web app is served.
const home = await get("/");
home.status === 200 && /text\/html/.test(home.type) && /VINeeti/i.test(home.text) ? ok("the web app is served") : bad("the web app is served", `HTTP ${home.status}`);
const manifest = await get("/manifest.webmanifest");
manifest.status === 200 && manifest.json?.name ? ok("the installable app's manifest is served") : bad("the installable app's manifest is served", `HTTP ${manifest.status}`);

// Nothing of a dealership's data is readable without signing in.
for (const path of ["/api/bookings", "/api/vehicles", "/api/users", "/api/analytics/ageing", "/api/eod/status"]) {
  const res = await get(path);
  res.status === 401 ? ok(`${path} needs a sign-in`) : bad(`${path} needs a sign-in`, `HTTP ${res.status}`);
}
// A wrong sign-in is refused, and the answer gives nothing away.
const login = await get("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mobile: "9000000000", password: "not-the-password" }) });
login.status === 401 ? ok("a wrong sign-in is refused") : bad("a wrong sign-in is refused", `HTTP ${login.status}`);
// The end-of-day feed is refused without the dealership's key.
const feed = await get("/api/eod/no-such-dealer/run", { method: "POST" });
feed.status === 401 ? ok("the end-of-day feed needs its key") : bad("the end-of-day feed needs its key", `HTTP ${feed.status}`);
// The platform route is refused without the platform token.
const platform = await get("/api/platform/tenants", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
platform.status === 401 ? ok("onboarding needs the platform token") : bad("onboarding needs the platform token", `HTTP ${platform.status}`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
