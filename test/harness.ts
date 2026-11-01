// Test harness: runs the real Worker code in Node against an in-memory SQLite database that behaves
// like D1 (prepared statements, transactional batch).

import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/index";
import type { Env } from "../src/env";
import { clock } from "../src/http/app";
import { hashPassword } from "../src/lib/crypto";
import { runScheduled } from "../src/scheduled";

const MIGRATIONS = fileURLToPath(import.meta.resolve("../migrations/"));

function toSql(v: unknown): unknown {
  if (v === undefined) throw new Error("D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'");
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

class FakeStatement {
  constructor(private db: DatabaseSync, public sql: string, public params: unknown[] = []) {}
  bind(...params: unknown[]) {
    return new FakeStatement(this.db, this.sql, params.map(toSql));
  }
  exec() {
    const s = this.db.prepare(this.sql);
    if (/^\s*(SELECT|WITH|PRAGMA)/i.test(this.sql)) return { results: s.all(...(this.params as any[])) as unknown[], changes: 0 };
    const r = s.run(...(this.params as any[]));
    return { results: [], changes: Number(r.changes) };
  }
  async all<T>() {
    const r = this.exec();
    return { results: r.results as T[], success: true, meta: { changes: r.changes } };
  }
  async first<T>() {
    return (this.exec().results[0] as T) ?? null;
  }
  async run() {
    const r = this.exec();
    return { results: r.results, success: true, meta: { changes: r.changes } };
  }
}

export class FakeD1 {
  raw = new DatabaseSync(":memory:");
  constructor() {
    for (const f of readdirSync(MIGRATIONS).sort()) this.raw.exec(readFileSync(MIGRATIONS + f, "utf8"));
  }
  prepare(sql: string) {
    return new FakeStatement(this.raw, sql);
  }
  /** Like D1: the statements run in one transaction and roll back together. */
  async batch(stmts: FakeStatement[]) {
    this.raw.exec("BEGIN");
    try {
      const out = stmts.map((s) => {
        const r = s.exec();
        return { results: r.results, success: true, meta: { changes: r.changes } };
      });
      this.raw.exec("COMMIT");
      return out;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    }
  }
  /** Direct query for assertions. */
  q<T = any>(sql: string, ...params: unknown[]): T[] {
    return this.raw.prepare(sql).all(...(params as any[])) as T[];
  }
}

export interface World {
  env: Env;
  /** The in-memory bucket this world's attachments are written to. */
  files: FakeR2;
  db: FakeD1;
  /** Sets the clock. Accepts local India time such as "2026-10-13 10:00". */
  at(local: string): Date;
  now(): Date;
  /** Runs the scheduled job at the current clock time and waits for background work. */
  tick(): ReturnType<typeof runScheduled>;
  /** `host` pretends the request arrived at a dealership's own address. */
  api(method: string, path: string, body?: unknown, session?: Session, headers?: Record<string, string>, host?: string): Promise<{ status: number; body: any; headers: Headers }>;
  upload(path: string, form: FormData, session: Session): Promise<{ status: number; body: any }>;
  /** Sends a file as the request body, as the Uploads screen does. */
  send(path: string, bytes: Uint8Array, session: Session): Promise<{ status: number; body: any }>;
  login(dealer: string, mobile: string, password: string): Promise<Session>;
}

export interface Session {
  cookie: string;
  /** Kept so the harness can sign in again when a test moves the clock past the 12-hour session life. */
  creds?: { dealer: string; mobile: string; password: string };
  issuedAt?: number;
}

/** India has a fixed +05:30 offset, so local test times convert directly. */
export function ist(local: string): Date {
  return new Date(local.replace(" ", "T") + ":00+05:30");
}

/**
 * Object storage, in memory: enough of R2 for a support ticket's attachment to be written, read back and
 * served. It keeps the bytes and the content type, which is all the product asks of it.
 */
export class FakeR2 {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  async put(key: string, value: ArrayBuffer | Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) {
    this.objects.set(key, { bytes: value instanceof Uint8Array ? value : new Uint8Array(value), contentType: opts?.httpMetadata?.contentType });
    return { key };
  }
  async get(key: string) {
    const o = this.objects.get(key);
    if (!o) return null;
    return { key, body: new Blob([o.bytes]).stream(), httpMetadata: { contentType: o.contentType }, arrayBuffer: async () => o.bytes.buffer };
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

export function makeWorld(start = "2026-10-13 10:00"): World {
  const db = new FakeD1();
  const files = new FakeR2();
  const env = {
    DB: db as unknown as D1Database,
    SESSION_SECRET: "test-session-secret-0123456789abcdef",
    DATA_KEY: "test-data-key-0123456789abcdef0123456789",
    PLATFORM_ADMIN_TOKEN: "platform-token",
    APP_NAME: "VINeeti",
    WA_GRAPH_VERSION: "v23.0",
    FILES: files as unknown as R2Bucket,
  } as Env;
  const app = createApp();
  let current = ist(start);
  clock.now = () => current;

  const call = async (req: Request) => {
    clock.now = () => current; // several worlds may exist in one test file
    const pending: Promise<unknown>[] = [];
    const res = await app.fetch(req, env, { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext);
    await Promise.all(pending);
    const text = await res.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, body, headers: res.headers };
  };

  const world: World = {
    env,
    db,
    files,
    at(local) {
      current = ist(local);
      return current;
    },
    now: () => current,
    async tick() {
      clock.now = () => current;
      return runScheduled(env, current);
    },
    async api(method, path, body, session, headers = {}, host) {
      if (session) await fresh(session);
      const h: Record<string, string> = { ...headers };
      if (session) h.Cookie = session.cookie;
      let payload: BodyInit | undefined;
      if (body !== undefined) {
        payload = typeof body === "string" ? body : JSON.stringify(body);
        h["Content-Type"] ??= typeof body === "string" ? "text/csv" : "application/json";
      } else if (method !== "GET") {
        payload = "{}";
        h["Content-Type"] ??= "application/json";
      }
      return call(new Request(`https://${host ?? "app.test"}${path}`, { method, headers: h, body: payload }));
    },
    async upload(path, form, session) {
      await fresh(session);
      return call(new Request(`https://app.test${path}`, { method: "POST", headers: { Cookie: session.cookie }, body: form }));
    },
    async send(path, bytes, session) {
      await fresh(session);
      return call(new Request(`https://app.test${path}`, { method: "POST", headers: { Cookie: session.cookie, "Content-Type": "application/octet-stream" }, body: bytes }));
    },
    async login(dealer, mobile, password) {
      const res = await world.api("POST", "/api/auth/login", { dealer, mobile, password });
      if (res.status !== 200) throw new Error(`login failed for ${mobile}: ${JSON.stringify(res.body)}`);
      const cookie = (res.headers.get("Set-Cookie") ?? "").split(";")[0];
      return { cookie, creds: { dealer, mobile, password }, issuedAt: current.getTime() };
    },
  };
  async function fresh(s: Session) {
    if (!s.creds || s.issuedAt === undefined || Math.abs(current.getTime() - s.issuedAt) < 11 * 3_600_000) return;
    const next = await world.login(s.creds.dealer, s.creds.mobile, s.creds.password);
    Object.assign(s, next);
  }
  return world;
}

// ---------------------------------------------------------------- a ready-made dealership

export const PASSWORD = "Passw0rd!";
export const PLATFORM = { Authorization: "Bearer platform-token" };

export interface Dealer {
  slug: string;
  tenantId: string;
  outlets: Record<string, string>; // code -> id
  users: Record<string, { id: string; mobile: string; session: Session }>;
}

/**
 * Creates a dealership with two outlets and one user of each persona:
 * admin, head (Business Head), sm (Sales Manager, Patia), sm2 (Sales Manager, Cuttack), se1 / se2 (Sales
 * Executives, Patia), se3 (Sales Executive, Cuttack), stock (Stock In-charge, both outlets), accounts, ordering, auditor.
 */
export async function makeDealer(w: World, slug = "northstar-hyundai", mobilePrefix = "90000000"): Promise<Dealer> {
  const created = await w.api(
    "POST",
    "/api/platform/tenants",
    {
      slug,
      name: "Northstar Motors",
      oem: "Mahindra",
      // The fixtures have WhatsApp on: the suite has plenty to say about it, and a dealership with a
      // number is a real case. That it is off until a dealership switches it on is tested on its own.
      settings: { whatsapp_enabled: true },
      outlets: [
        { code: "PATIA", name: "Patia", city: "Bhubaneswar" },
        { code: "CUTTACK", name: "Cuttack", city: "Cuttack" },
      ],
      admin: { name: "Asha Admin", mobile: `${mobilePrefix}01`, email: "dealer.admin@test.example", password: PASSWORD },
    },
    undefined,
    PLATFORM,
  );
  if (created.status !== 201) throw new Error(`tenant not created: ${JSON.stringify(created.body)}`);
  // New accounts must replace their first password before doing anything else (covered in auth.test.ts).
  // The fixtures skip that step so each test can start straight at the work.
  // Given an id, also puts the shared test password on that one account, salted on its own: the server
  // makes and emails every temporary password now, which the fixtures neither see nor need to test.
  const settle = async (id?: string) =>
    w.db.raw.exec(
      id
        ? `UPDATE users SET must_change_password = 0, password_hash = '${await hashPassword(PASSWORD)}' WHERE id = '${id}'`
        : `UPDATE users SET must_change_password = 0 WHERE tenant_id = '${created.body.tenant_id}'`,
    );
  await settle();
  const admin = await w.login(slug, `${mobilePrefix}01`, PASSWORD);
  const outletRows = (await w.api("GET", "/api/outlets", undefined, admin)).body as { id: string; code: string }[];
  const outlets = Object.fromEntries(outletRows.map((o) => [o.code, o.id]));
  const dealer: Dealer = { slug, tenantId: created.body.tenant_id, outlets, users: { admin: { id: created.body.admin_user_id, mobile: `${mobilePrefix}01`, session: admin } } };
  const people: [string, string, string, string[] | "ALL"][] = [
    ["head", "Bikram Head", "CEO_VP", "ALL"],
    ["gm", "Girish GM", "GM_SALES", "ALL"],
    ["agm", "Arun AGM", "AGM_SALES", "ALL"],
    ["agm2", "Asha AGM", "AGM_SALES", ["CUTTACK"]],
    ["sm", "Sunita Manager", "SALES_LEAD", ["PATIA"]],
    ["sm2", "Manoj Manager", "SALES_LEAD", ["CUTTACK"]],
    ["se1", "Ravi Exec", "SALES_CONSULTANT", ["PATIA"]],
    ["se2", "Priya Exec", "SALES_CONSULTANT", ["PATIA"]],
    ["se3", "Deepak Exec", "SALES_CONSULTANT", ["CUTTACK"]],
    ["stock", "Gopal Stock", "EDP_MANAGER", ["PATIA", "CUTTACK"]],
    ["accounts", "Anita Accounts", "FINANCE", ["PATIA", "CUTTACK"]],
    ["ordering", "Omkar Ordering", "EDP_MANAGER", "ALL"],
    ["auditor", "Alok Auditor", "AUDITOR", "ALL"],
  ];
  let n = 2;
  for (const [key, name, role, scope] of people) {
    const mobile = `${mobilePrefix}${String(n++).padStart(2, "0")}`;
    const res = await w.api("POST", "/api/users", { name, mobile, email: `${mobile}@test.example`, role, all_outlets: scope === "ALL", outlet_ids: scope === "ALL" ? [] : scope.map((c) => outlets[c]) }, admin);
    if (res.status !== 201) throw new Error(`user ${key} not created: ${JSON.stringify(res.body)}`);
    await settle(res.body.id);
    dealer.users[key] = { id: res.body.id, mobile, session: await w.login(slug, mobile, PASSWORD) };
  }
  return dealer;
}

export const CRETA = { model: "CRETA", variant: "SX(O) 1.5 PETROL IVT", colour: "ABYSS BLACK" };
export const VENUE = { model: "VENUE", variant: "S 1.2 PETROL", colour: "ATLAS WHITE" };

/** Creates a booking as the given user, ticks the submission checklist and submits it. */
export async function submittedBooking(w: World, d: Dealer, by: string, cfg: Record<string, unknown>, outletCode: string, customer: string, mobile: string, extra: Record<string, unknown> = {}) {
  const s = d.users[by].session;
  const created = await w.api("POST", "/api/bookings", { outlet_id: d.outlets[outletCode], customer_name: customer, customer_mobile: mobile, booking_amount: 25000, ...cfg, ...extra }, s);
  if (created.status !== 201) throw new Error(`booking not created: ${JSON.stringify(created.body)}`);
  const ticked = await w.api("PUT", `/api/bookings/${created.body.id}/checklist`, { DOCKET: true, KYC: true, PAN_AADHAAR: true, PAYMENT_PROOF: true }, s);
  if (ticked.status !== 200) throw new Error(`checklist not saved: ${JSON.stringify(ticked.body)}`);
  const sub = await w.api("POST", `/api/bookings/${created.body.id}/submit`, undefined, s);
  if (sub.status !== 200) throw new Error(`booking not submitted: ${JSON.stringify(sub.body)}`);
  return created.body as { id: string; booking_no: string };
}

/** Booking created, documented, submitted and approved by the outlet's Sales Manager. Returns the approval response too. */
export async function approvedBooking(w: World, d: Dealer, by: string, cfg: Record<string, unknown>, outletCode: string, customer: string, mobile: string, extra: Record<string, unknown> = {}) {
  const b = await submittedBooking(w, d, by, cfg, outletCode, customer, mobile, extra);
  const approver = outletCode === "PATIA" ? "sm" : "sm2";
  const res = await w.api("POST", `/api/bookings/${b.id}/approve`, { remarks: "Documents checked" }, d.users[approver].session);
  if (res.status !== 200) throw new Error(`booking not approved: ${JSON.stringify(res.body)}`);
  return { ...b, approval: res.body as { booking: any; allocations: any[] } };
}

export async function addCar(w: World, d: Dealer, vin: string, cfg: Record<string, unknown>, outletCode: string, status: "IN_TRANSIT" | "RECEIVED", extra: Record<string, unknown> = {}) {
  const res = await w.api("POST", "/api/vehicles", { vin, ...cfg, outlet_id: d.outlets[outletCode], status, ...extra }, d.users.stock.session);
  if (res.status !== 201) throw new Error(`car not added: ${JSON.stringify(res.body)}`);
  return res.body as { id: string; allocations: any[] };
}

export async function booking(w: World, d: Dealer, id: string, as = "head") {
  const res = await w.api("GET", `/api/bookings/${id}`, undefined, d.users[as].session);
  if (res.status !== 200) throw new Error(`booking not readable: ${JSON.stringify(res.body)}`);
  return res.body;
}

// ---------------------------------------------------------------- instruments for resilience tests

/** Counts database round trips (each query and each batch is one), and can cut a request off after a limit, as the platform does. */
export function meter(w: World) {
  const m = { calls: 0, limit: Infinity };
  const stmtProto = Object.getPrototypeOf(w.db.prepare("SELECT 1"));
  const dbProto = Object.getPrototypeOf(w.db);
  const saved = { all: stmtProto.all, first: stmtProto.first, run: stmtProto.run, batch: dbProto.batch };
  const tick = () => {
    m.calls++;
    if (m.calls > m.limit) throw new Error("Too many API requests by single worker invocation");
  };
  for (const k of ["all", "first", "run"] as const) {
    stmtProto[k] = async function (this: unknown) {
      tick();
      return saved[k].call(this);
    };
  }
  dbProto.batch = async function (this: unknown, stmts: unknown[]) {
    tick();
    return saved.batch.call(this, stmts);
  };
  return {
    m,
    reset: () => ((m.calls = 0), (m.limit = Infinity)),
    restore: () => Object.assign(stmtProto, { all: saved.all, first: saved.first, run: saved.run }) && (dbProto.batch = saved.batch),
  };
}

/** Makes the next batch that contains a statement matching `pattern` fail, as a dropped connection would. */
export function failNextBatch(w: World, pattern: RegExp) {
  const dbProto = Object.getPrototypeOf(w.db);
  const orig = dbProto.batch;
  const state = { fired: false };
  dbProto.batch = async function (this: unknown, stmts: { sql: string }[]) {
    if (!state.fired && stmts.some((s) => pattern.test(s.sql))) {
      state.fired = true;
      dbProto.batch = orig;
      throw new Error("D1_ERROR: Network connection lost.");
    }
    return orig.call(this, stmts);
  };
  return { state, restore: () => (dbProto.batch = orig) };
}

/**
 * Forces two requests to overlap: the first time a batch containing a statement matching `pattern` is
 * about to be written, `competitor` runs to completion first. This is the worst-case interleaving of
 * two people (or two scheduled runs) acting on the same thing at once.
 */
export function overlap(w: World, pattern: RegExp, competitor: () => Promise<unknown>) {
  const dbProto = Object.getPrototypeOf(w.db);
  const orig = dbProto.batch;
  const state = { fired: false };
  dbProto.batch = async function (this: unknown, stmts: { sql: string }[]) {
    if (!state.fired && stmts.some((s) => pattern.test(s.sql))) {
      state.fired = true;
      dbProto.batch = orig;
      await competitor();
    }
    return orig.call(this, stmts);
  };
  return { state, restore: () => (dbProto.batch = orig) };
}

// ---------------------------------------------------------------- a Mahindra dealership fed by the two DMS files

export const fixture = (name: string) => new Uint8Array(readFileSync(fileURLToPath(import.meta.resolve(`./fixtures/${name}`))));
/**
 * Anonymised copies of the dealership's real exports: the stock report as on 5 Oct 2026, the September
 * 2026 booking sheet, and the retail invoice export for August 2026 to date. Identifiers are synthetic
 * but consistent across the three, so a car or a booking in two files is the same car or booking.
 */
export const STOCK_FILE = "stock report as on 05.10.2026.xlsx";
export const RETAIL_FILE = "Retail_Aug26_till_Date.xlsx";
export const stockReport = () => fixture("stock_report.sample.xlsx");
export const bookingSheet = () => fixture("booking_sheet.sample.xlsx");
export const retailExport = () => fixture("retail_export.sample.xlsx");
/** The dealership's other booking export: its live order book, from a different DMS screen. */
export const liveBookings = () => fixture("live_bookings.sample.xlsx");

/**
 * A dealership as it is on day one: no outlets, cars or bookings yet (the DMS files bring them), an
 * administrator, and one user of each persona. The outlets named are created by the first file loaded.
 */
export async function makeMahindraDealer(w: World, slug = "sample-mahindra", mobilePrefix = "91000000"): Promise<Dealer> {
  const created = await w.api("POST", "/api/platform/tenants", { slug, name: "Sample Motors", oem: "Mahindra", settings: { whatsapp_enabled: true }, outlets: [{ code: "SM01", name: "CUTTACK", city: "Cuttack" }], admin: { name: "Asha Admin", mobile: `${mobilePrefix}01`, email: "dealer.admin@test.example", password: PASSWORD } }, undefined, PLATFORM);
  if (created.status !== 201) throw new Error(`tenant not created: ${JSON.stringify(created.body)}`);
  // Given an id, also puts the shared test password on that one account, salted on its own: the server
  // makes and emails every temporary password now, which the fixtures neither see nor need to test.
  const settle = async (id?: string) =>
    w.db.raw.exec(
      id
        ? `UPDATE users SET must_change_password = 0, password_hash = '${await hashPassword(PASSWORD)}' WHERE id = '${id}'`
        : `UPDATE users SET must_change_password = 0 WHERE tenant_id = '${created.body.tenant_id}'`,
    );
  await settle();
  const admin = await w.login(slug, `${mobilePrefix}01`, PASSWORD);
  const dealer: Dealer = { slug, tenantId: created.body.tenant_id, outlets: {}, users: { admin: { id: created.body.admin_user_id, mobile: `${mobilePrefix}01`, session: admin } } };
  const people: [string, string, string][] = [
    ["dp", "Dinesh Principal", "DEALER_PRINCIPAL"],
    ["head", "Bikram Head", "CEO_VP"],
    ["gm", "Girish GM", "GM_SALES"],
    ["agm", "Arun AGM", "AGM_SALES"],
    ["lead", "Sunita Lead", "SALES_LEAD"],
    ["exec", "Ravi Exec", "SALES_CONSULTANT"],
    ["finance", "Anita Finance", "FINANCE"],
    ["crm", "Charu CRM", "EDP_MANAGER"],
    ["stock", "Gopal Stock", "EDP_MANAGER"],
    ["auditor", "Alok Auditor", "AUDITOR"],
  ];
  let n = 2;
  for (const [key, name, role] of people) {
    const mobile = `${mobilePrefix}${String(n++).padStart(2, "0")}`;
    const res = await w.api("POST", "/api/users", { name, mobile, email: `${mobile}@test.example`, role, all_outlets: true, outlet_ids: [] }, admin);
    if (res.status !== 201) throw new Error(`user ${key} not created: ${JSON.stringify(res.body)}`);
    await settle(res.body.id);
    dealer.users[key] = { id: res.body.id, mobile, session: await w.login(slug, mobile, PASSWORD) };
  }
  return dealer;
}

/** Loads a file until it is fully applied (a large first load is applied in steps) and returns the last answer with everything that happened. */
export async function loadFile(w: World, kind: "stock" | "bookings" | "retail", bytes: Uint8Array, session: Session, query = "") {
  // A file name that carries a date ("... as on 05.10.2026") dates the report; an explicit report_date in the query wins.
  const name = encodeURIComponent(kind === "stock" ? (query.includes("report_date=") ? "stock report.xlsx" : STOCK_FILE) : kind === "retail" ? RETAIL_FILE : "Booking-Sept26.xlsx");
  let res = await w.send(`/api/uploads/${kind}?filename=${name}${query}`, bytes, session);
  let rounds = 1;
  while (res.status === 200 && res.body.more) {
    if (rounds++ > 30) throw new Error("the load did not finish");
    res = await w.send(`/api/uploads/${kind}?filename=${name}${query}&continue=${res.body.upload_id}`, bytes, session);
  }
  return { ...res, rounds };
}

// ---------------------------------------------------------------- small DMS files for tests
// The same headings as the real exports, as CSV. Descriptions are real Mahindra descriptions, so the
// parser reads them exactly as it reads the dealership's files.

/** A few real cars: the stock description, how the same car reads in a booking, and what the system calls it. */
export const CARS = {
  THAR_WHITE: { desc: "THAR LXT D MT 2WD 4S HT WQ(A3EVRSTWHT)(M0877)", text: "THAR LXT D MT 2WD 4S HT WQ", modelCode: "THARM087717000001", family: "NEW THAR", stockModel: "NEW THAR", colour: "EVEREST WHITE", seating: "4", fuel: "DIESEL", segment: "PERSONAL", is: { model: "THAR", variant: "LXT D MT 2WD 4S HT (M0877)", colour: "EVEREST WHITE" } },
  THAR_BLACK: { desc: "THAR LXT D MT 2WD 4S HT XJ(A3STLTHBLK)(M0877)", text: "THAR LXT D MT 2WD 4S HT XJ", modelCode: "THARM087717000001", family: "NEW THAR", stockModel: "NEW THAR", colour: "STEALTH BLACK", seating: "4", fuel: "DIESEL", segment: "PERSONAL", is: { model: "THAR", variant: "LXT D MT 2WD 4S HT (M0877)", colour: "STEALTH BLACK" } },
  XUV3XO_WHITE: { desc: "XUV3XO AX5 PM MT WQ(A3EVRSTWHT)(M1024)", text: "XUV3XO AX5 PM MT WQ", modelCode: "X3XOM102418000001", family: "XUV3XO", stockModel: "XUV3XO", colour: "EVEREST WHITE", seating: "5", fuel: "PETROL", segment: "PERSONAL", is: { model: "XUV 3XO", variant: "AX5 PM MT (M1024)", colour: "EVEREST WHITE" } },
  SCORPIO_N: { desc: "SCORPIO-N D MT 2WD Z8L 7S WQ(C1EVRTWHT)(M0980)", text: "SCORPIO-N D MT 2WD Z8L 7S WQ", modelCode: "SCNM098017000001", family: "SCORPIO-N", stockModel: "SCORPIO-N", colour: "EVEREST WHITE", seating: "7", fuel: "DIESEL", segment: "PERSONAL", is: { model: "SCORPIO-N", variant: "D MT 2WD Z8L 7S (M0980)", colour: "EVEREST WHITE" } },
  // A pick-up: the description states neither fuel, transmission nor drive, and carries no paint alias.
  MAXX_WHITE: { desc: "BOL MAXX PUP HD 1.7 LX(A2WHITE)(M0246)", text: "BOL MAXX PUP HD 1.7 LX", modelCode: "MXHDM024617111596", family: "MAXX HD", stockModel: "MAXX HD", colour: "WHITE", seating: "3", fuel: "DIESEL", segment: "PROSPER", is: { model: "BOL MAXX PUP HD", variant: "1.7 LX (M0246)", colour: "WHITE" } },
  MAXX_DIAMOND: { desc: "BOL MAXX PUP HD 1.7 LX(C1DMNDWHIT)(M0246)", text: "BOL MAXX PUP HD 1.7 LX", modelCode: "MXHDM024617111596", family: "MAXX HD", stockModel: "MAXX HD", colour: "DIAMOND WHITE", seating: "3", fuel: "DIESEL", segment: "PROSPER", is: { model: "BOL MAXX PUP HD", variant: "1.7 LX (M0246)", colour: "DIAMOND WHITE" } },
} as const;
export type CarKey = keyof typeof CARS;

export interface StockLine {
  vin: string;
  car: CarKey;
  /** Dealer Location Code; the name defaults to the code. */
  loc?: string;
  locName?: string;
  status?: "Received" | "In Transit";
  type?: "Unalloted" | "Alloted" | "IBND";
  /** Order ID: the DMS Booking Number the car is allotted to. */
  order?: string;
  customer?: string;
  invoiceId?: string;
  /** Allotment Date: the day the DMS says this car was allotted to its order. */
  allotDate?: string; // YYYY-MM-DD
  invoiceDate?: string; // YYYY-MM-DD
  oemInvoiceDate?: string; // YYYY-MM-DD
  grnDate?: string; // YYYY-MM-DD
  demo?: boolean;
  price?: number;
  sc?: string;
  /** Overrides, for rows that are deliberately wrong. */
  raw?: Record<string, string>;
}

const csvCell = (v: unknown) => (/[",\n]/.test(String(v ?? "")) ? `"${String(v ?? "").replace(/"/g, '""')}"` : String(v ?? ""));
const csvBytes = (header: string[], rows: Record<string, unknown>[]) => new TextEncoder().encode([header, ...rows.map((r) => header.map((h) => r[h] ?? ""))].map((r) => r.map(csvCell).join(",")).join("\n") + "\n");

const STOCK_HEADER = ["Dealer Name", "Dealer Location Code", "Dealer Location Name", "Model", "Model Description", " Seating", "Color", "Segment Code", "Emission", " OEM Invoice Number", " OEM Invoice Date", "Net Dealer Price", "VIN", " Engine Number", "GRN No.", "GRN Date", " Demo Vehicle", " Vehicle Status", "Order ID", " Order Date", "Customer Name", "Stock Type", "Allotment Id", "Allotment Date", "Invoice ID", "Invoice Date", "SC Name"];

/** A stock report with these cars, in the DMS's own headings (stray spaces included). */
export function stockFile(lines: StockLine[], dealer = "SAMPLE MOTORS"): Uint8Array {
  return csvBytes(
    STOCK_HEADER,
    lines.map((l, i) => {
      const c = CARS[l.car];
      const received = (l.status ?? "Received") === "Received";
      const type = l.type ?? (l.order ? (l.invoiceId ? "IBND" : "Alloted") : "Unalloted");
      return {
        "Dealer Name": dealer, "Dealer Location Code": l.loc ?? "SM01", "Dealer Location Name": l.locName ?? (l.loc === "SM02" ? "JAJPUR" : l.loc && l.loc !== "SM01" ? l.loc : "CUTTACK"), Model: c.stockModel, "Model Description": c.desc, " Seating": c.seating, Color: c.colour, "Segment Code": c.segment, Emission: "BS6",
        " OEM Invoice Number": `OEM${String(i + 1).padStart(6, "0")}`, " OEM Invoice Date": l.oemInvoiceDate ?? "2026-09-20", "Net Dealer Price": l.price ?? 1000000, VIN: l.vin, " Engine Number": `ENG${l.vin.slice(-6)}`,
        "GRN No.": received ? `GRN${l.vin.slice(-6)}` : "", "GRN Date": received ? l.grnDate ?? "2026-09-25" : "", " Demo Vehicle": l.demo ? "YES" : "NO", " Vehicle Status": l.status ?? "Received",
        "Order ID": l.order ?? "", " Order Date": l.order ? "2026-09-10" : "", "Customer Name": l.order ? l.customer ?? "CUSTOMER" : "", "Stock Type": type, "Allotment Id": l.order ? `ALT${l.vin.slice(-6)}` : "", "Allotment Date": l.order ? l.allotDate ?? "2026-10-01" : "",
        "Invoice ID": l.invoiceId ?? "", "Invoice Date": l.invoiceId ? l.invoiceDate ?? "2026-10-02" : "", "SC Name": l.order ? l.sc ?? "CONSULTANT 001" : "",
        ...(l.raw ?? {}),
      };
    }),
  );
}

export interface BookingLine {
  /** DMS Booking Number. */
  no: string;
  car: CarKey;
  loc?: string;
  locName?: string;
  stage?: "Booked" | "Invoiced" | "Cancellation Initiated";
  /** "Delivered" with stage Invoiced means delivered. */
  enquiryStage?: string;
  /** Created Date as the DMS writes it, e.g. "26-Sep-2026 06:15 PM". */
  created: string;
  customer?: string;
  mobile?: string;
  /** Colour name as the booking sheet writes it; defaults to the car's. */
  colour?: string;
  amount?: number;
  sc?: string;
  scId?: string;
  raw?: Record<string, string>;
}

const BOOKING_HEADER = ["Dealer Name", "Dealer Location", "Sales Consultant", "SC MIle Id", "Sales Manager", "Enquiry Number", "Booking Number", "DMS Booking Number", "Booking Stage", "Created Date", "Booking Amount", "Customer Name", "Customer Mobile Phone", "Product Family", "Variant Description", "Color", "Fuel Type", "Seating Capacity", "Enquiry Stage", "Location Code", "Model Code", "Model Description"];

/** A booking sheet with these bookings, in the DMS's own headings. */
export function bookingFile(lines: BookingLine[], dealer = "SAMPLE MOTORS"): Uint8Array {
  return csvBytes(
    BOOKING_HEADER,
    lines.map((l, i) => {
      const c = CARS[l.car];
      const stage = l.stage ?? "Booked";
      return {
        "Dealer Name": dealer, "Dealer Location": l.locName ?? (l.loc === "SM02" ? "JAJPUR" : l.loc && l.loc !== "SM01" ? l.loc : "CUTTACK"), "Sales Consultant": l.sc ?? "CONSULTANT 001", "SC MIle Id": l.scId ?? "99ZZ0001", "Sales Manager": "MANAGER 01",
        "Enquiry Number": `ENQ${String(i + 1).padStart(6, "0")}`, "Booking Number": `B-${String(i + 1).padStart(8, "0")}`, "DMS Booking Number": l.no, "Booking Stage": stage, "Created Date": l.created, "Booking Amount": l.amount ?? 21000,
        "Customer Name": l.customer ?? `CUSTOMER ${l.no.slice(-4)}`, "Customer Mobile Phone": l.mobile ?? `10000${String(10000 + i).slice(-5)}`, "Product Family": c.family, "Variant Description": c.text, Color: l.colour ?? c.colour, "Fuel Type": c.fuel, "Seating Capacity": c.seating,
        "Enquiry Stage": l.enquiryStage ?? (stage === "Booked" ? "Booking" : stage === "Invoiced" ? "Booking" : "Dropped"), "Location Code": l.loc ?? "SM01", "Model Code": c.modelCode, "Model Description": c.text,
        ...(l.raw ?? {}),
      };
    }),
  );
}

export interface RetailLine {
  /** Invoice Number. */
  no: string;
  car: CarKey;
  /** Booking No.: the dealer-side booking number, which the booking sheet calls "Booking Number". */
  booking?: string;
  vin?: string;
  loc?: string;
  locName?: string;
  date?: string; // YYYY-MM-DD
  customer?: string;
  amount?: number;
  selling?: number;
  dealerDiscount?: number;
  oemDiscount?: number;
  /** BNDP credit note: what the dealership claims the manufacturer's discount back with. */
  oemClaim?: string;
  loyaltyDiscount?: number;
  loyaltyClaim?: string;
  financier?: string;
  financeBy?: "Dealer" | "Self" | "DSA";
  insurance?: number;
  exchange?: boolean;
  deliveryNote?: string;
  deliveryDate?: string;
  raw?: Record<string, string>;
}

const RETAIL_HEADER = ["Invoice Number", "Invoice Date and Time", "Invoice Amount", "Invoice Status", "Dealer Parent Name", "Dealer Location Code", "Dealer Location Name", "SC Name", "Delivery Note Number", "Delivery Note Date", "OEM Model Code", "Chassis Number", "Vehicle Identification Number", "Model Group", "Model Description", "Model Variant", "Color", "Customer Type", "Customer Name", "Customer GSTIN No.", "Booking No.", "Allotment No", "Selling Price", "Dealer Discount", "OEM Scheme Discount", "Total Corporate Discount", "Corporate Discount Amount", "Loyalty Discount Amount", "Exchange Discount Amount", "TCS Amount", "GST Tax Rate", "GST Tax Amount", "Financier", "Finance Arrange By", "Finance Amount", "Insurance Company Name", "Insurance Amount", "Exchange Indicator", "IRN Generated Date", "BNDP Credit Note Number", "Loyalty Credit Note Number", "Exchange Credit Note Number"];

/** A retail invoice export with these invoices, in the DMS's own headings. */
export function retailFile(lines: RetailLine[], dealer = "SAMPLE MOTORS"): Uint8Array {
  return csvBytes(
    RETAIL_HEADER,
    lines.map((l) => {
      const c = CARS[l.car];
      const selling = l.selling ?? 1000000;
      const gst = Math.round(selling * 0.28);
      return {
        "Invoice Number": l.no, "Invoice Date and Time": `${l.date ?? "2026-10-02"} 11:30:00`, "Invoice Amount": l.amount ?? selling + gst, "Invoice Status": "Invoiced",
        "Dealer Parent Name": dealer, "Dealer Location Code": l.loc ?? "SM01", "Dealer Location Name": l.locName ?? (l.loc === "SM02" ? "JAJPUR" : l.loc && l.loc !== "SM01" ? l.loc : "CUTTACK"), "SC Name": "CONSULTANT 001",
        "Delivery Note Number": l.deliveryNote ?? "", "Delivery Note Date": l.deliveryNote ? l.deliveryDate ?? l.date ?? "2026-10-02" : "",
        "OEM Model Code": c.modelCode.slice(-5), "Chassis Number": (l.vin ?? "").slice(-6), "Vehicle Identification Number": l.vin ?? "", "Model Group": c.stockModel, "Model Description": c.desc, "Model Variant": c.text, Color: c.colour,
        "Customer Type": "INDIVIDUAL", "Customer Name": l.customer ?? "CUSTOMER 0001", "Customer GSTIN No.": "", "Booking No.": l.booking ?? "", "Allotment No": l.vin ? `ALT${l.vin.slice(-6)}` : "",
        "Selling Price": selling, "Dealer Discount": l.dealerDiscount ?? 0, "OEM Scheme Discount": l.oemDiscount ?? 0, "Total Corporate Discount": 0, "Corporate Discount Amount": 0,
        "Loyalty Discount Amount": l.loyaltyDiscount ?? 0, "Exchange Discount Amount": 0, "TCS Amount": 0, "GST Tax Rate": 28, "GST Tax Amount": gst,
        Financier: l.financier ?? "CASH", "Finance Arrange By": l.financeBy ?? "Self", "Finance Amount": l.financier && l.financier !== "CASH" ? Math.round(selling * 0.8) : 0,
        "Insurance Company Name": "SAMPLE GENERAL INSURANCE", "Insurance Amount": l.insurance ?? 0, "Exchange Indicator": l.exchange ? "YES" : "NO", "IRN Generated Date": "",
        "BNDP Credit Note Number": l.oemClaim ?? "", "Loyalty Credit Note Number": l.loyaltyClaim ?? "", "Exchange Credit Note Number": "",
        ...(l.raw ?? {}),
      };
    }),
  );
}

/** Loads a small stock file as on the given date (default: the world's today). */
export async function loadStock(w: World, session: Session, lines: StockLine[], opts: { asOn?: string; mode?: "COMPLETE" | "PARTIAL"; confirm?: boolean } = {}) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(w.now());
  return loadFile(w, "stock", stockFile(lines), session, `&report_date=${opts.asOn ?? today}${opts.mode ? `&mode=${opts.mode}` : ""}${opts.confirm ? "&confirm_missing=1" : ""}`);
}
export async function loadBookings(w: World, session: Session, lines: BookingLine[]) {
  return loadFile(w, "bookings", bookingFile(lines), session);
}
/** Loads a small retail export as on the given date (default: the world's today). */
export async function loadRetail(w: World, session: Session, lines: RetailLine[], opts: { asOn?: string } = {}) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(w.now());
  return loadFile(w, "retail", retailFile(lines), session, `&report_date=${opts.asOn ?? today}`);
}
