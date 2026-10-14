#!/usr/bin/env node
// Fills a deployment with a demonstration dealership so every screen has something to show: one user of
// each persona, and the two sample DMS files in samples/ (anonymised copies of a real stock report and
// booking sheet: no real customer, employee, vehicle or price data). For a local or trial environment,
// never for a dealership's live data.
//
//   npm run dev                      (in one terminal)
//   node scripts/seed-demo.mjs       (in another; defaults to http://127.0.0.1:8787 and the token in .dev.vars)
//
//   BASE_URL=https://... PLATFORM_ADMIN_TOKEN=... DEALER_CODE=sample-mahindra node scripts/seed-demo.mjs

import { existsSync, readFileSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8787";
const SLUG = process.env.DEALER_CODE ?? "sample-mahindra";
const PASSWORD = process.env.DEMO_PASSWORD ?? "Demo@2026";
const FIRST = "Welcome@123";
let TOKEN = process.env.PLATFORM_ADMIN_TOKEN;
if (!TOKEN && existsSync(".dev.vars")) TOKEN = /^PLATFORM_ADMIN_TOKEN=(.+)$/m.exec(readFileSync(".dev.vars", "utf8"))?.[1]?.trim();
if (!TOKEN) throw new Error("Set PLATFORM_ADMIN_TOKEN");

async function call(method, path, body, session, headers = {}) {
  const h = { ...headers };
  if (session) h.Cookie = session.cookie;
  let payload;
  if (body instanceof Uint8Array) { payload = body; h["Content-Type"] = "application/octet-stream"; }
  else { payload = JSON.stringify(body ?? {}); h["Content-Type"] = "application/json"; }
  const res = await fetch(BASE + path, { method, headers: h, body: method === "GET" ? undefined : payload });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${json?.error?.message ?? text.slice(0, 200)}`);
  return { json, cookie: (res.headers.get("Set-Cookie") ?? "").split(";")[0] };
}
const get = (path, s) => call("GET", path, undefined, s).then((r) => r.json);
const post = (path, body, s) => call("POST", path, body, s).then((r) => r.json);

async function signIn(mobile, firstTime) {
  let s = { cookie: (await call("POST", "/api/auth/login", { dealer: SLUG, mobile, password: firstTime ? FIRST : PASSWORD })).cookie };
  if (firstTime) s = { cookie: (await call("POST", "/api/auth/change-password", { current: FIRST, next: PASSWORD }, s)).cookie };
  return s;
}

/** Sends a DMS file, again while the answer says there is more to apply. */
async function load(kind, file, session, query = "") {
  const bytes = new Uint8Array(readFileSync(file));
  const name = encodeURIComponent(file.split("/").pop());
  let out = await post(`/api/uploads/${kind}?filename=${name}${query}`, bytes, session);
  while (out.more) out = await post(`/api/uploads/${kind}?filename=${name}${query}&continue=${out.upload_id}`, bytes, session);
  return out;
}

console.log(`Seeding ${BASE} as dealer code "${SLUG}"`);
// The minimum booking amount is what a Mahindra dealership actually collects to confirm a booking, so
// the demonstration shows the queue rule doing its job: the customers who have paid it are in the queue,
// and the ones who have not are listed apart for collection rather than quietly disappearing.
await call("POST", "/api/platform/tenants", { slug: SLUG, name: "Sample Motors", oem: "Mahindra", admin: { name: "Asha Mohanty", mobile: "9000000001", password: FIRST }, settings: { min_booking_amount: 21000 } }, undefined, { Authorization: `Bearer ${TOKEN}` });
const admin = await signIn("9000000001", true);

// The stock report is loaded as on today so the demonstration does not open with an "out of date" warning.
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
const inDays = (n) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(Date.now() + n * 86_400_000));
const stock = await load("stock", "samples/stock report as on 05.10.2026 (sample).xlsx", admin, `&report_date=${today}`);
console.log(`Stock report: ${stock.summary.cars} cars (${stock.summary.unallocated} unallocated, ${stock.summary.allocated} allocated), ${stock.summary.outlets_created.length} outlets created`);
const book = await load("bookings", "samples/Booking-Sept26 (sample).xlsx", admin);
console.log(`Booking sheet: ${book.summary.bookings} bookings (${book.summary.booked} booked, ${book.summary.invoiced + book.summary.delivered} invoiced, ${book.summary.cancelled} cancelled); ${book.allocations} cars allocated so far`);

const outlets = Object.fromEntries((await get("/api/outlets", admin)).map((o) => [o.code, o.id]));
// One sales consultant from the booking sheet becomes the demonstration's sales executive, so "my bookings" has bookings in it.
const consultant = (await get("/api/bookings?view=waiting", admin)).find((b) => b.sc_name);
const detail = consultant ? await get(`/api/bookings/${consultant.id}`, admin) : null;
const people = [
  ["Dealer Principal", "Dinesh Patnaik", "9000000002", "DEALER_PRINCIPAL", null],
  ["Business Head / CEO", "Bikram Das", "9000000003", "BUSINESS_HEAD", null],
  ["Sales Lead", "Sunita Dash", "9000000004", "SALES_MANAGER", Object.keys(outlets).slice(0, 2)],
  ["Sales Executive", detail?.booking?.sc_name ?? "Ravi Sahoo", "9000000005", "SALES_EXEC", detail ? [Object.keys(outlets).find((c) => outlets[c] === detail.booking.outlet_id)] : Object.keys(outlets).slice(0, 1), detail?.booking?.sc_code],
  ["Finance", "Anita Rath", "9000000006", "ACCOUNTS", null],
  ["CRM", "Charu Nayak", "9000000007", "CRM", null],
  ["Stock In-charge", "Gopal Sethi", "9000000008", "STOCK_INCHARGE", null],
  ["Ordering Desk", "Omkar Jena", "9000000009", "ORDERING", null],
  ["Auditor", "Alok Mishra", "9000000010", "AUDITOR", null],
];
const session = {};
for (const [label, name, mobile, role, codes, dms] of people) {
  await post("/api/users", { name, mobile, role, password: FIRST, all_outlets: !codes, outlet_ids: (codes ?? []).map((c) => outlets[c]), dms_code: dms ?? undefined }, admin);
  session[role] = await signIn(mobile, true);
  console.log(`  ${label.padEnd(20)} ${mobile}`);
}

// A little of each kind of work, so the queues and dashboards are not empty.
const holding = (await get("/api/payments", session.ACCOUNTS)).filter((p) => p.state === "AWAITING_PAYMENT" && p.vehicle_status === "RECEIVED");
if (holding[0]) await post(`/api/bookings/${holding[0].booking_id}/payment-reported`, { amount: 250000, reference: "UTR SAMPLE0001", note: "NEFT, customer shared the screenshot" }, session.SALES_MANAGER);
if (holding[1]) {
  await post(`/api/bookings/${holding[1].booking_id}/payment-reported`, { amount: 400000, reference: "UTR SAMPLE0002" }, session.SALES_MANAGER);
  await post(`/api/bookings/${holding[1].booking_id}/payment-received`, {}, session.ACCOUNTS);
}
const waiting = await get("/api/bookings?view=waiting", session.SALES_MANAGER);
if (waiting[0]) await post("/api/exceptions", { type: "DEFER_DELIVERY", booking_id: waiting[0].id, reason: "Customer asked for delivery after the festival", payload: { until: inDays(14) } }, session.SALES_MANAGER).catch((e) => console.log("  (exception not raised:", e.message, ")"));
await post("/api/recon/run", {}, session.BUSINESS_HEAD);

console.log(`\nDone. Sign in at ${BASE} with a mobile number above and the password ${PASSWORD} (dealer code ${SLUG}; administrator 9000000001).`);
