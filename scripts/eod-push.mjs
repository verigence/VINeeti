#!/usr/bin/env node
// The end-of-day feed, for a scheduled job at the dealership (Windows Task Scheduler, cron): sends the
// day's booking sheet and stock report to Verigence VINeeti with the dealership's end-of-day key, then
// asks for the day-end reconciliation. Needs Node 20 or later and nothing else.
//
//   EOD_KEY=vne_... node eod-push.mjs --url https://<address> --dealer <dealer-code> --dir "D:\DMS exports"
//   EOD_KEY=vne_... node eod-push.mjs --url https://<address> --dealer <dealer-code> --stock "stock report as on 05.10.2026.xlsx" --bookings "Booking-Sept26.xlsx"
//
//   --dir <folder>        take the newest file whose name contains "stock" and the newest whose name contains "booking"
//                         (.xlsx or .csv), if changed in the last --max-age-hours (default 20)
//   --stock / --bookings  name the files instead; either may be left out on a day it is not exported
//   --report-date <date>  the stock report's "as on" date (YYYY-MM-DD) when the file name does not carry one
//   --confirm-missing     the stock file is the complete report even if many cars have gone since the last one
//   --no-run              send the files only; the reconciliation then runs by itself at the day-end time
//
// The key is created on the End of day screen by the System Admin and shown once. Keep it in the job's
// environment (EOD_KEY), not in a script that is shared.
// Exit code 0: everything sent and applied. 1: something was refused; the message says what.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const has = (name) => args.includes(`--${name}`);
const fail = (message) => { console.error(`Stopped: ${message}`); process.exit(1); };

const base = opt("url") ?? process.env.EOD_URL;
const dealer = opt("dealer") ?? process.env.EOD_DEALER;
const key = process.env.EOD_KEY;
if (!base || !dealer) fail("Give --url <address> and --dealer <dealer-code>.");
if (!key) fail("Set the end-of-day key in the environment variable EOD_KEY.");

function newest(dir, word, maxAgeHours) {
  const files = readdirSync(dir)
    .filter((f) => /\.(xlsx|csv)$/i.test(f) && !f.startsWith("~$") && f.toLowerCase().includes(word))
    .map((f) => ({ path: join(dir, f), at: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  if (!files.length) return null;
  if (Date.now() - files[0].at > maxAgeHours * 3_600_000) {
    console.log(`No new ${word} file: the newest (${basename(files[0].path)}) is older than ${maxAgeHours} hours and was not sent again.`);
    return null;
  }
  return files[0].path;
}

let stock = opt("stock"), bookings = opt("bookings");
if (opt("dir")) {
  const age = Number(opt("max-age-hours") ?? 20);
  stock ??= newest(opt("dir"), "stock", age) ?? undefined;
  bookings ??= newest(opt("dir"), "booking", age) ?? undefined;
}
if (!stock && !bookings) fail("There is no file to send. Give --dir <folder>, or --stock and/or --bookings.");

async function post(path, bytes) {
  let res;
  try {
    res = await fetch(new URL(path, base), { method: "POST", headers: { Authorization: `Bearer ${key}`, ...(bytes ? { "Content-Type": "application/octet-stream" } : {}) }, body: bytes, signal: AbortSignal.timeout(120_000) });
  } catch (e) {
    fail(`Could not reach ${base}: ${e.message}`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) fail(`${body?.error?.message ?? `HTTP ${res.status}`}${body?.error?.code ? ` [${body.error.code}]` : ""}`);
  return body;
}

/** Sends one file; a large change is applied in steps, so the same file is sent again while the answer says there is more. */
async function send(kind, file, query = "") {
  const bytes = readFileSync(file);
  if (bytes.length > 12 * 1024 * 1024) fail(`${basename(file)} is larger than 12 MB.`);
  const q = `filename=${encodeURIComponent(basename(file))}${query}`;
  let out = await post(`/api/eod/${dealer}/${kind}?${q}`, bytes);
  for (let round = 1; out.more; round++) {
    if (round > 40) fail(`${basename(file)} was not fully applied after 40 rounds.`);
    out = await post(`/api/eod/${dealer}/${kind}?${q}&continue=${out.upload_id}`, bytes);
  }
  return out;
}

// The booking sheet goes first: a cancelled booking's car is free before the stock report is read.
if (bookings) {
  const b = await send("bookings", bookings);
  console.log(`Booking sheet ${basename(bookings)}: ${b.row_count} rows; ${b.created} new, ${b.updated} changed, ${b.unchanged} unchanged; ${b.summary?.cancelled_now ?? 0} cancelled now, ${b.summary?.cars_released ?? 0} cars released; ${b.allocations} cars allocated; ${b.error_count} rows not applied.`);
  for (const e of b.errors ?? []) console.log(`  row ${e.row} (${e.key}): ${e.message}`);
}
if (stock) {
  const query = `${opt("report-date") ? `&report_date=${opt("report-date")}` : ""}${has("confirm-missing") ? "&confirm_missing=1" : ""}`;
  const s = await send("stock", stock, query);
  console.log(`Stock report ${basename(stock)} as on ${s.report_date}: ${s.row_count} cars; ${s.created} new, ${s.updated} changed, ${s.unchanged} unchanged; ${s.summary?.received ?? 0} arrived; ${s.allocations} cars allocated; ${s.error_count} rows not applied.`);
  for (const e of s.errors ?? []) console.log(`  row ${e.row} (${e.key}): ${e.message}`);
}
if (!has("no-run")) {
  const r = await post(`/api/eod/${dealer}/run`);
  const f = r.findings ?? {};
  console.log(`Reconciliation for ${r.business_date}: ${f.high ?? 0} high, ${f.medium ?? 0} medium, ${f.low ?? 0} low findings.${r.files?.out_of_date?.length ? ` Out of date: ${r.files.out_of_date.join(", ")}.` : ""} Open the End of day screen for the details.`);
}
