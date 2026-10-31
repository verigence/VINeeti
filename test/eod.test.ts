// End of day: the dealership's scheduled job sends the booking sheet and the stock report with the
// end-of-day key; the system updates stock and bookings from them and runs the day-end reconciliation.
import { describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { clock } from "../src/http/app";
import { bookingFile, bookingSheet, makeMahindraDealer, makeWorld, stockFile, stockReport, type BookingLine, type Dealer, type StockLine, type World } from "./harness";

const q = <T = any>(w: World, sql: string, ...p: unknown[]) => w.db.q<T>(sql, ...p);
const booking = (w: World, no: string) => q(w, `SELECT b.*, (SELECT v.vin FROM allocations a JOIN vehicles v ON v.id = a.vehicle_id WHERE a.booking_id = b.id AND a.status = 'ACTIVE') AS vin FROM bookings b WHERE b.booking_no = ?`, no)[0];
const today = (w: World) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(w.now());

/** A request from the dealership's scheduled job: no sign-in, only the key. The file is the request body. */
async function feed(w: World, path: string, key: string | null, bytes?: Uint8Array, type = "application/octet-stream") {
  clock.now = () => w.now();
  const headers: Record<string, string> = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  if (bytes) headers["Content-Type"] = type;
  const pending: Promise<unknown>[] = [];
  const res = await createApp().fetch(new Request(`https://app.test${path}`, { method: "POST", headers, body: bytes }), w.env, { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext);
  await Promise.all(pending);
  return { status: res.status, body: (await res.json()) as any };
}
/** Sends a file until it is fully applied, as scripts/eod-push.mjs does. */
async function push(w: World, d: Dealer, kind: "stock" | "bookings", key: string, bytes: Uint8Array, query = "") {
  const name = kind === "stock" ? `stock report as on ${today(w).split("-").reverse().join(".")}.csv` : "Booking.csv";
  let res = await feed(w, `/api/eod/${d.slug}/${kind}?filename=${encodeURIComponent(name)}${query}`, key, bytes);
  let rounds = 1;
  while (res.status === 200 && res.body.more) {
    if (rounds++ > 30) throw new Error("the load did not finish");
    res = await feed(w, `/api/eod/${d.slug}/${kind}?filename=${encodeURIComponent(name)}${query}&continue=${res.body.upload_id}`, key, bytes);
  }
  return { ...res, rounds };
}
async function start(at = "2026-10-06 20:30"): Promise<{ w: World; d: Dealer; key: string }> {
  const w = makeWorld(at);
  const d = await makeMahindraDealer(w);
  const made = await w.api("POST", "/api/eod/key", undefined, d.users.admin.session);
  expect(made.status).toBe(201);
  return { w, d, key: made.body.key };
}

const STOCK: StockLine[] = [{ vin: "MA1THAR0000000001", car: "THAR_WHITE" }, { vin: "MA1SCN00000000001", car: "SCORPIO_N", status: "In Transit" }];
const BOOKINGS: BookingLine[] = [
  { no: "OTF27A000001", car: "THAR_WHITE", created: "01-Sep-2026 10:00 AM", customer: "FIRST CUSTOMER" },
  { no: "OTF27A000002", car: "THAR_WHITE", created: "02-Sep-2026 10:00 AM", customer: "SECOND CUSTOMER" },
];

describe("the end-of-day key", () => {
  it("is created by the System Admin, shown once, and stored only as a hash", async () => {
    const { w, d, key } = await start();
    expect(key).toMatch(/^vne_[0-9a-f]{48}$/);
    expect(JSON.stringify(q(w, `SELECT * FROM tenants`))).not.toContain(key);
    expect(JSON.stringify(q(w, `SELECT * FROM audit_log`))).not.toContain(key);
    const status = (await w.api("GET", "/api/eod/status", undefined, d.users.admin.session)).body;
    expect(JSON.stringify(status)).not.toContain(key);
    expect(status.feed).toMatchObject({ stock_url: "https://app.test/api/eod/sample-mahindra/stock", bookings_url: "https://app.test/api/eod/sample-mahindra/bookings", run_url: "https://app.test/api/eod/sample-mahindra/run" });
    expect(status.feed.key_set_at).toBeTruthy();
    for (const who of ["gm", "agm", "lead", "crm", "stock", "finance"]) {
      expect((await w.api("POST", "/api/eod/key", undefined, d.users[who].session)).status, who).toBe(403);
      expect((await w.api("DELETE", "/api/eod/key", undefined, d.users[who].session)).status, who).toBe(403);
    }
  });

  it("is the only thing that opens the feed, and the feed is the only thing it opens", async () => {
    const { w, d, key } = await start();
    const other = await makeMahindraDealer(w, "other-mahindra", "92000000");
    const file = stockFile(STOCK);
    const denied = { code: "UNAUTHENTICATED", message: "The dealer code or the end-of-day key is not correct" };
    expect((await feed(w, `/api/eod/${d.slug}/stock`, null, file)).body.error).toEqual(denied);
    expect((await feed(w, `/api/eod/${d.slug}/stock`, "vne_" + "0".repeat(48), file)).body.error).toEqual(denied);
    expect((await feed(w, `/api/eod/no-such-dealer/stock`, key, file)).body.error).toEqual(denied);
    // One dealership's key does not open another's feed.
    expect((await feed(w, `/api/eod/${other.slug}/stock`, key, file)).status).toBe(401);
    expect((await feed(w, `/api/eod/${other.slug}/run`, key)).status).toBe(401);
    expect(q(w, `SELECT COUNT(*) AS n FROM vehicles`)[0].n).toBe(0);
    // The key is not a sign-in: it reads nothing.
    for (const path of ["/api/bookings", "/api/vehicles", "/api/eod/status", "/api/users"]) expect((await w.api("GET", path, undefined, undefined, { Authorization: `Bearer ${key}` })).status, path).toBe(401);
    // A new key replaces the old one; removing the key closes the feed.
    const next = (await w.api("POST", "/api/eod/key", undefined, d.users.admin.session)).body.key;
    expect(next).not.toBe(key);
    expect((await feed(w, `/api/eod/${d.slug}/run`, key)).status).toBe(401);
    expect((await feed(w, `/api/eod/${d.slug}/run`, next)).status).toBe(200);
    expect((await w.api("DELETE", "/api/eod/key", undefined, d.users.admin.session)).status).toBe(200);
    expect((await feed(w, `/api/eod/${d.slug}/run`, next)).status).toBe(401);
    expect(q(w, `SELECT action FROM audit_log WHERE action LIKE 'EOD_KEY%' ORDER BY at, action`).map((a) => a.action)).toEqual(["EOD_KEY_CREATED", "EOD_KEY_CREATED", "EOD_KEY_REMOVED"]);
  });
});

describe("the end-of-day run", () => {
  it("reads the booking sheet and the stock report, updates stock and bookings, and reconciles", async () => {
    const { w, d, key } = await start("2026-10-06 20:30");
    const b = await push(w, d, "bookings", key, bookingFile(BOOKINGS));
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ kind: "BOOKINGS", more: false, row_count: 2, created: 2, error_count: 0 });
    const s = await push(w, d, "stock", key, stockFile(STOCK));
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ kind: "STOCK", report_date: "2026-10-06", more: false, row_count: 2, created: 2, error_count: 0, allocations: 1 });
    expect(s.body.summary).toMatchObject({ cars: 2, new_cars: 2, unallocated_received: 1, unallocated_in_transit: 1 });
    // The stock master is current and the car is with the customer who booked first.
    expect(q(w, `SELECT vin, status FROM vehicles ORDER BY vin`)).toEqual([{ vin: "MA1SCN00000000001", status: "IN_TRANSIT" }, { vin: "MA1THAR0000000001", status: "RECEIVED" }]);
    expect(booking(w, "OTF27A000001")).toMatchObject({ status: "ALLOCATED", vin: "MA1THAR0000000001" });
    expect(booking(w, "OTF27A000002")).toMatchObject({ status: "APPROVED", vin: null });
    // The job asks for the reconciliation and gets its totals.
    const run = await feed(w, `/api/eod/${d.slug}/run`, key);
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({ business_date: "2026-10-06", files: { stock_as_on: "2026-10-06", bookings_as_on: "2026-10-06", out_of_date: [] } });
    expect(run.body.run_id).toBeTruthy();
    expect(run.body.findings).toMatchObject({ high: 0 });
    expect(q(w, `SELECT trigger, business_date FROM recon_runs`)).toEqual([{ trigger: "EOD", business_date: "2026-10-06" }]);

    // The Upload DMS files screen shows what was read, who read it, and nothing of the key. The retail
    // export is not part of the feed here, so its step stands open while the day still closes.
    const status = (await w.api("GET", "/api/eod/status", undefined, d.users.head.session)).body;
    expect(status).toMatchObject({ business_date: "2026-10-06", day_end_time: "21:00" });
    expect(status.steps.map((x: any) => [x.key, x.done])).toEqual([["BOOKINGS", true], ["STOCK", true], ["RETAIL", false], ["RECONCILIATION", true]]);
    expect(status.steps[2].optional).toBe(true);
    expect(status.steps[3].run).toMatchObject({ id: run.body.run_id, by: "End-of-day feed" });
    expect(status.loads_today.map((l: any) => [l.kind, l.status, l.uploaded_by_name]).sort()).toEqual([["BOOKINGS", "DONE", "End-of-day feed"], ["STOCK", "DONE", "End-of-day feed"]]);
    expect(status.files).toMatchObject({ stale: false });
    // Uploads made by the feed are listed with the others, and the audit trail names the feed.
    const uploads = (await w.api("GET", "/api/uploads", undefined, d.users.crm.session)).body.uploads;
    expect(uploads.map((u: any) => u.kind).sort()).toEqual(["BOOKINGS", "STOCK"]);
    expect(q(w, `SELECT DISTINCT uploaded_by FROM uploads`)).toEqual([{ uploaded_by: "EOD" }]);
  });

  it("the next day's files release the car of a cancelled booking to the next customer", async () => {
    const { w, d, key } = await start("2026-10-06 20:30");
    await push(w, d, "bookings", key, bookingFile(BOOKINGS));
    await push(w, d, "stock", key, stockFile(STOCK));
    await feed(w, `/api/eod/${d.slug}/run`, key);
    w.at("2026-10-07 20:30");
    const cancelled: BookingLine[] = [{ ...BOOKINGS[0], stage: "Cancellation Initiated" }, BOOKINGS[1]];
    const b = await push(w, d, "bookings", key, bookingFile(cancelled));
    expect(b.body.summary).toMatchObject({ cancelled_now: 1, cars_released: 1 });
    expect(b.body.allocations).toBe(1);
    const s = await push(w, d, "stock", key, stockFile(STOCK));
    expect(s.body).toMatchObject({ report_date: "2026-10-07", created: 0 });
    expect(booking(w, "OTF27A000001")).toMatchObject({ status: "CANCELLED", vin: null });
    expect(booking(w, "OTF27A000002")).toMatchObject({ status: "ALLOCATED", vin: "MA1THAR0000000001" });
    const run = await feed(w, `/api/eod/${d.slug}/run`, key);
    expect(run.body.business_date).toBe("2026-10-07");
    expect(q(w, `SELECT COUNT(*) AS n FROM recon_runs`)[0].n).toBe(2);
  });

  it("sending the same files twice changes nothing", async () => {
    const { w, d, key } = await start();
    await push(w, d, "bookings", key, bookingFile(BOOKINGS));
    await push(w, d, "stock", key, stockFile(STOCK));
    const before = JSON.stringify([q(w, `SELECT id, status, updated_at FROM vehicles ORDER BY id`), q(w, `SELECT id, status, updated_at FROM bookings ORDER BY id`), q(w, `SELECT id, status FROM allocations ORDER BY id`)]);
    const messages = q(w, `SELECT COUNT(*) AS n FROM wa_messages`)[0].n;
    expect((await push(w, d, "bookings", key, bookingFile(BOOKINGS))).body).toMatchObject({ created: 0, updated: 0, unchanged: 2 });
    expect((await push(w, d, "stock", key, stockFile(STOCK))).body).toMatchObject({ created: 0, updated: 0, unchanged: 2, allocations: 0 });
    expect(JSON.stringify([q(w, `SELECT id, status, updated_at FROM vehicles ORDER BY id`), q(w, `SELECT id, status, updated_at FROM bookings ORDER BY id`), q(w, `SELECT id, status FROM allocations ORDER BY id`)])).toBe(before);
    expect(q(w, `SELECT COUNT(*) AS n FROM wa_messages`)[0].n).toBe(messages);
  });

  it("takes the dealership's full Excel exports, applying a large first load in steps", async () => {
    const { w, d, key } = await start("2026-10-06 20:30");
    const s = await push(w, d, "stock", key, stockReport(), "&report_date=2026-10-06");
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ more: false, row_count: 742 });
    expect(s.body.summary).toMatchObject({ cars: 742, unallocated: 550, allocated: 192 });
    const b = await push(w, d, "bookings", key, bookingSheet());
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ more: false, row_count: 636 });
    expect(q(w, `SELECT COUNT(*) AS n FROM vehicles`)[0].n).toBe(742);
    expect(q(w, `SELECT COUNT(*) AS n FROM bookings WHERE source = 'DMS'`)[0].n).toBe(636);
    const run = await feed(w, `/api/eod/${d.slug}/run`, key);
    expect(run.status).toBe(200);
    expect(run.body.files.out_of_date).toEqual([]);
  });

  it("the full exports in the order the job sends them (booking sheet first): sending the sheet again changes no booking", async () => {
    const { w, d, key } = await start("2026-10-06 20:30");
    expect((await push(w, d, "bookings", key, bookingSheet())).body).toMatchObject({ row_count: 636, created: 636 });
    expect((await push(w, d, "stock", key, stockReport(), "&report_date=2026-10-06")).body).toMatchObject({ row_count: 742, created: 742 });
    // Colour names the booking sheet spells differently from the stock report were settled when the stock report came in.
    expect((await push(w, d, "bookings", key, bookingSheet())).body).toMatchObject({ created: 0, updated: 0, unchanged: 636 });
  });

  it("a change too large for one request is applied in steps: the job sends the file again until it is done", async () => {
    const { w, d, key } = await start("2026-10-06 18:00");
    const vins = Array.from({ length: 60 }, (_, i) => `MA1THAR00000002${String(i).padStart(2, "0")}`);
    await push(w, d, "stock", key, stockFile(vins.map((vin) => ({ vin, car: "THAR_WHITE" as const, status: "In Transit" as const }))));
    await push(w, d, "bookings", key, bookingFile(vins.map((_, i) => ({ no: `OTF27A0001${String(i).padStart(2, "0")}`, car: "THAR_WHITE" as const, created: `01-Sep-2026 08:${String(i).padStart(2, "0")} AM` }))));
    for (let i = 0; i < 5; i++) await w.tick();
    expect(q(w, `SELECT COUNT(*) AS n FROM allocations WHERE status = 'ACTIVE'`)[0].n).toBe(60);
    // Next evening all sixty have arrived: each reserved car's customer is told, one at a time.
    w.at("2026-10-07 18:00");
    const arrived = stockFile(vins.map((vin) => ({ vin, car: "THAR_WHITE" as const })));
    const one = await feed(w, `/api/eod/${d.slug}/stock?filename=stock.csv&report_date=2026-10-07`, key, arrived);
    expect(one.body.more).toBe(true);
    const done = await push(w, d, "stock", key, arrived, `&report_date=2026-10-07&continue=${one.body.upload_id}`);
    expect(done.body).toMatchObject({ more: false });
    expect(done.body.summary.received).toBe(60);
    expect(q(w, `SELECT COUNT(*) AS n, COUNT(DISTINCT booking_id) AS customers FROM wa_messages WHERE event_key = 'STOCK_RECEIVED'`)[0]).toEqual({ n: 60, customers: 60 });
  });

  it("refuses a stock report that would remove most of the stock unless the job says the file is complete", async () => {
    const { w, d, key } = await start("2026-10-06 20:30");
    const many: StockLine[] = Array.from({ length: 40 }, (_, i) => ({ vin: `MA1THAR00000001${String(i).padStart(2, "0")}`, car: "THAR_WHITE" as const }));
    await push(w, d, "stock", key, stockFile(many));
    w.at("2026-10-07 20:30");
    // A filtered export by mistake: 2 cars instead of 40.
    const res = await push(w, d, "stock", key, stockFile(many.slice(0, 2)));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFIRM_MISSING");
    expect(q(w, `SELECT COUNT(*) AS n FROM vehicles WHERE status = 'RECEIVED'`)[0].n).toBe(40);
    // An older report is refused too.
    const old = await push(w, d, "stock", key, stockFile(many), "&report_date=2026-10-01");
    expect(old.status).toBe(400);
    expect(old.body.error.code).toBe("OLDER_REPORT");
    // A file from another dealership is refused.
    const wrong = await push(w, d, "stock", key, stockFile(many, "SOME OTHER MOTORS"));
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe("WRONG_DEALER");
    expect(q(w, `SELECT COUNT(*) AS n FROM vehicles WHERE status = 'RECEIVED'`)[0].n).toBe(40);
    // The job states that the short file is the complete report: the missing cars have left stock.
    const confirmed = await push(w, d, "stock", key, stockFile(many.slice(0, 2)), "&confirm_missing=1");
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.summary.left_stock).toMatchObject({ removed: 38 });
    expect(q(w, `SELECT COUNT(*) AS n FROM vehicles WHERE status = 'RECEIVED'`)[0].n).toBe(2);
  });

  it("if the job does not ask for it, the reconciliation runs by itself at the day-end time", async () => {
    const { w, d, key } = await start("2026-10-06 20:30");
    await push(w, d, "bookings", key, bookingFile(BOOKINGS));
    await push(w, d, "stock", key, stockFile(STOCK));
    let status = (await w.api("GET", "/api/eod/status", undefined, d.users.head.session)).body;
    expect(status.steps.map((x: any) => x.done)).toEqual([true, true, false, false]);
    w.at("2026-10-06 21:05");
    const report = (await w.tick())[0];
    expect(report.reconciliation).toBeTruthy();
    status = (await w.api("GET", "/api/eod/status", undefined, d.users.head.session)).body;
    expect(status.steps.map((x: any) => x.done)).toEqual([true, true, false, true]);
    expect(status.steps[3].run).toMatchObject({ id: report.reconciliation, by: "Scheduled" });
    // Once a day: the next firing does not run it again.
    w.at("2026-10-06 21:20");
    expect((await w.tick())[0].reconciliation).toBeUndefined();
  });

  it("a person can do the same three steps on the End of day screen", async () => {
    const { w, d } = await start("2026-10-06 18:00");
    expect((await w.send(`/api/uploads/bookings?filename=Booking.csv`, bookingFile(BOOKINGS), d.users.crm.session)).status).toBe(200);
    expect((await w.send(`/api/uploads/stock?filename=stock.csv&report_date=2026-10-06`, stockFile(STOCK), d.users.crm.session)).status).toBe(200);
    expect((await w.api("POST", "/api/recon/run", undefined, d.users.head.session)).status).toBe(201);
    const status = (await w.api("GET", "/api/eod/status", undefined, d.users.crm.session)).body;
    expect(status.steps.map((x: any) => x.done)).toEqual([true, true, false, true]);
    expect(status.steps[3].run.by).toBe("A user");
    expect(status.loads_today.map((l: any) => l.uploaded_by_name)).toEqual(["Charu CRM", "Charu CRM"]);
    // A sales executive has no End of day screen.
    expect((await w.api("GET", "/api/eod/status", undefined, d.users.exec.session)).status).toBe(403);
  });
});

describe("the Android app's asset links", () => {
  it("are published only once the signing certificate's fingerprint is set on the deployment", async () => {
    const w = makeWorld();
    expect((await w.api("GET", "/.well-known/assetlinks.json")).status).toBe(404);
    w.env.ANDROID_CERT_SHA256 = "aa:bb:cc, dd:ee:ff";
    const res = await w.api("GET", "/.well-known/assetlinks.json");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ relation: ["delegate_permission/common.handle_all_urls"], target: { namespace: "android_app", package_name: "com.jbrconsulting.vineeti", sha256_cert_fingerprints: ["AA:BB:CC", "DD:EE:FF"] } }]);
  });
});
