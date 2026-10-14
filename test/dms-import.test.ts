// The two DMS files, loaded as the dealership will load them. The fixtures are anonymised copies of the
// real exports (stock report as on 5 Oct 2026, booking sheet for September 2026), so the figures asserted
// here are the real figures: the same ones the dealership's own inventory engine reports for these files
// (742 cars, 550 unallocated of which 313 received and 237 in transit, 192 allocated, 124 links to the
// booking sheet, 68 allotted orders that are not in it, 348 open bookings with no car).
import { beforeAll, describe, expect, it } from "vitest";
import { bookingSheet, loadFile, makeMahindraDealer, makeWorld, meter, stockReport, STOCK_FILE, type Dealer, type World } from "./harness";

const by = (w: World, sql: string, ...p: unknown[]) => w.db.q<{ k: string; n: number }>(sql, ...p).reduce((o, r) => ({ ...o, [r.k]: r.n }), {} as Record<string, number>);
const one = (w: World, sql: string, ...p: unknown[]) => w.db.q<{ n: number }>(sql, ...p)[0].n;
const reservations = (w: World) => w.db.q<{ booking_no: string; vin: string }>(`SELECT b.booking_no, v.vin FROM allocations a JOIN bookings b ON b.id = a.booking_id JOIN vehicles v ON v.id = a.vehicle_id WHERE a.status = 'ACTIVE' ORDER BY 1`);
/** Runs the scheduled job until it has nothing left to allocate. */
async function settle(w: World) {
  for (let i = 0; i < 40; i++) if (!(await w.tick())[0].allocated) return;
  throw new Error("allocation did not settle");
}

describe("first load: stock report, then booking sheet", () => {
  let w: World, d: Dealer, stock: any, book: any;
  beforeAll(async () => {
    w = makeWorld("2026-10-06 09:00");
    d = await makeMahindraDealer(w);
    stock = await loadFile(w, "stock", stockReport(), d.users.stock.session);
  }, 120_000);

  it("reads the report date from the file name and says what the report contains", () => {
    expect(stock.status).toBe(200);
    expect(stock.body.report_date).toBe("2026-10-05");
    expect(stock.body.summary).toMatchObject({ dealer_name: "SAMPLE MOTORS", cars: 742, unallocated: 550, unallocated_received: 313, unallocated_in_transit: 237, allocated: 192, alloted: 4, ibnd: 188, demo: 4, not_recognised: 0 });
    // The two cars whose Ageing column is a day off from the OEM invoice date, as the dealership's own engine found.
    expect(stock.body.summary.issues).toEqual({ source_ageing_mismatch: 2 });
    expect(stock.body.errors).toEqual([]);
    expect(stock.body.more).toBe(false);
  });

  it("puts every car in the stock master: where it is, and allocated or unallocated as the DMS says", () => {
    expect(stock.body).toMatchObject({ created: 742, updated: 0, unchanged: 0 });
    expect(one(w, `SELECT COUNT(DISTINCT vin) AS n FROM vehicles`)).toBe(742);
    expect(by(w, `SELECT dms_stock_type AS k, COUNT(*) AS n FROM vehicles GROUP BY 1`)).toEqual({ UNALLOTED: 550, ALLOTED: 4, IBND: 188 });
    // IBND is invoiced, not delivered: 188. The rest: 237 in transit, 313 + 4 received.
    expect(by(w, `SELECT status AS k, COUNT(*) AS n FROM vehicles GROUP BY 1`)).toEqual({ IN_TRANSIT: 237, RECEIVED: 317, INVOICED: 188 });
    // Free stock = unallotted and not a demo car: 549 (one of the four demo cars is unallotted).
    expect(one(w, `SELECT COUNT(*) AS n FROM vehicles v WHERE status IN ('RECEIVED','IN_TRANSIT') AND is_blocked = 0 AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.vehicle_id = v.id AND a.status = 'ACTIVE')`)).toBe(549);
    expect(one(w, `SELECT COUNT(*) AS n FROM vehicles WHERE is_demo = 1 AND is_blocked = 1 AND block_reason = 'Demo vehicle'`)).toBe(4);
    // Outlets are the report's Dealer Location Codes. SM01 was set up with the dealership; the other four are created by the file.
    expect(stock.body.summary.outlets_created.sort()).toEqual(["SM02 JAJPUR", "SM09 KENDRAPARA_SZS", "SM15 BHUBANESHWAR_SH", "SM17 KHORDHA_SZS"]);
    expect(by(w, `SELECT o.code AS k, COUNT(*) AS n FROM vehicles v JOIN outlets o ON o.id = v.outlet_id GROUP BY 1`)).toEqual({ SM01: 597, SM02: 127, SM09: 5, SM15: 6, SM17: 7 });
  });

  it("identifies each car by category, model, trim, transmission, fuel, drive, seater and variant, and leaves blank what the DMS does not state", () => {
    const car = w.db.q<any>(`SELECT v.model, v.variant, v.colour, v.oem_model_code, v.oem_colour_code, v.paint_alias, v.seating, m.category, m.trim_level, m.transmission, m.fuel, m.drive, m.seater, m.origin FROM vehicles v JOIN vehicle_variants m ON m.id = v.variant_id WHERE v.description = 'XUV3XO REVX M(O) PM MT ZX(A3EVRSTOBK)(M1049)' LIMIT 1`)[0];
    expect(car).toEqual({ model: "XUV 3XO", variant: "REVX M(O) PM MT (M1049)", colour: "EVEREST WHITE BLACK", oem_model_code: "M1049", oem_colour_code: "A3EVRSTOBK", paint_alias: "ZX", seating: "5", category: "PERSONAL", trim_level: "REVX M(O)", transmission: "Manual", fuel: "Petrol", drive: "", seater: "5", origin: "DMS" });
    // A pick-up: the description gives neither transmission, fuel nor drive, and nothing is assumed.
    const pickup = w.db.q<any>(`SELECT m.category, m.model, m.trim_level, m.transmission, m.fuel, m.drive, m.seater FROM vehicle_variants m WHERE m.variant = '1.7 LX (M0246)'`)[0];
    expect(pickup).toEqual({ category: "PROSPER", model: "BOL MAXX PUP HD", trim_level: "LX", transmission: "", fuel: "", drive: "", seater: "3" });
    expect(one(w, `SELECT COUNT(*) AS n FROM vehicles WHERE variant_id IS NULL`)).toBe(0);
    // One master variant per OEM variant and model code in the report.
    expect(stock.body.summary.variants_added).toBe(one(w, `SELECT COUNT(DISTINCT variant) AS n FROM vehicles`));
  });

  it("ties every allotted car to its order: 192 cars, none of them free", () => {
    expect(stock.body.summary.orders).toMatchObject({ total: 192, recorded: 192, known_only_from_stock: 192, in_booking_data: 0, bypassed: 0, out_of_turn: 0 });
    expect(by(w, `SELECT source || '/' || status AS k, COUNT(*) AS n FROM allocations GROUP BY 1`)).toEqual({ "DMS/ACTIVE": 192 });
    // Until a booking sheet names them, the orders are known only from the stock report: no mobile, no messages.
    expect(by(w, `SELECT status || '/' || source AS k, COUNT(*) AS n FROM bookings GROUP BY 1`)).toEqual({ "ALLOCATED/DMS_STOCK": 4, "INVOICED/DMS_STOCK": 188 });
    expect(one(w, `SELECT COUNT(*) AS n FROM wa_messages`)).toBe(0);
    expect(stock.body.allocations).toBe(0);
  });

  it("booking sheet: every booking is loaded and reconciled with the stock master by Order ID = DMS Booking Number", async () => {
    book = await loadFile(w, "bookings", bookingSheet(), d.users.crm.session);
    expect(book.status).toBe(200);
    expect(book.body.errors).toEqual([]);
    expect(book.body.summary).toMatchObject({ bookings: 636, booked: 368, invoiced: 129, delivered: 123, cancelled: 16, not_recognised: 0 });
    // 124 of the sheet's bookings are orders the stock report had already tied to a car; 512 are new to the system.
    expect(book.body.summary).toMatchObject({ details_completed: 124, new_bookings: 512, entered_queue: 348 });
    expect(one(w, `SELECT COUNT(*) AS n FROM bookings`)).toBe(636 + 68);
    expect(one(w, `SELECT COUNT(*) AS n FROM bookings WHERE source = 'DMS_STOCK'`)).toBe(68);
    // The 124 linked bookings keep the car the DMS gave them. Where the stock report shows the retail invoice
    // (IBND) the booking is invoiced, even if the older booking sheet still says Booked (19 of them).
    expect(by(w, `SELECT b.dms_stage || ' > ' || b.status AS k, COUNT(*) AS n FROM allocations a JOIN bookings b ON b.id = a.booking_id WHERE a.source = 'DMS' AND b.source = 'DMS' GROUP BY 1`)).toEqual({ "Booked > ALLOCATED": 1, "Booked > INVOICED": 19, "Invoiced > INVOICED": 104 });
    expect(by(w, `SELECT status AS k, COUNT(*) AS n FROM bookings WHERE source = 'DMS' AND dms_stage = 'Cancellation Initiated' GROUP BY 1`)).toEqual({ CANCELLED: 16 });
    expect(by(w, `SELECT status AS k, COUNT(*) AS n FROM bookings WHERE source = 'DMS' AND dms_enquiry_stage = 'Delivered' GROUP BY 1`)).toEqual({ DELIVERED: 123 });
  });

  it("queues the open bookings by their DMS date and gives free cars to them in that order", async () => {
    // 368 Booked, 20 of them already hold a car in the DMS: 348 enter the queue.
    expect(book.body.allocations).toBe(40); // a first batch straight after the load; the scheduled run continues
    await settle(w);
    const system = one(w, `SELECT COUNT(*) AS n FROM allocations WHERE source = 'SYSTEM' AND status = 'ACTIVE'`);
    expect(system).toBe(151);
    expect(one(w, `SELECT COUNT(*) AS n FROM bookings WHERE status = 'APPROVED'`)).toBe(348 - 151);
    // Every car given matches its booking exactly: same model, same OEM variant and model code, same colour.
    expect(one(w, `SELECT COUNT(*) AS n FROM allocations a JOIN bookings b ON b.id = a.booking_id JOIN vehicles v ON v.id = a.vehicle_id WHERE a.source = 'SYSTEM' AND (b.model <> v.model OR b.variant <> v.variant OR b.colour <> v.colour OR b.oem_model_code <> v.oem_model_code)`)).toBe(0);
    // No car is given twice, no demo car is given, and no car the DMS has allotted is given to anyone else.
    expect(one(w, `SELECT COUNT(*) AS n FROM (SELECT vehicle_id FROM allocations WHERE status = 'ACTIVE' GROUP BY 1 HAVING COUNT(*) > 1)`)).toBe(0);
    expect(one(w, `SELECT COUNT(*) AS n FROM allocations a JOIN vehicles v ON v.id = a.vehicle_id WHERE a.source = 'SYSTEM' AND (v.is_demo = 1 OR v.dms_stock_type <> 'UNALLOTED')`)).toBe(0);
    // First booked, first served: within one model, variant, colour and outlet, nobody waiting booked before somebody who holds a car from the system.
    expect(one(w, `SELECT COUNT(*) AS n FROM bookings waiting JOIN bookings served ON served.model = waiting.model AND served.variant = waiting.variant AND served.colour = waiting.colour AND served.outlet_id = waiting.outlet_id
                   JOIN allocations a ON a.booking_id = served.id AND a.status = 'ACTIVE' AND a.source = 'SYSTEM' AND json_extract(a.rule_trace_json, '$.rule') = 'SAME_OUTLET'
                   WHERE waiting.status = 'APPROVED' AND waiting.on_hold = 0 AND waiting.priority_ts < served.priority_ts`)).toBe(0);
    // WhatsApp is in test mode until the dealership connects its number: messages are recorded, none leaves.
    expect(by(w, `SELECT provider AS k, COUNT(*) AS n FROM wa_messages GROUP BY 1`)).toEqual({ TEST: 151 });
  });

  it("takes fuel from the booking sheet's own Fuel Type column where the description does not state it", () => {
    const pickup = w.db.q<any>(`SELECT fuel, fuel_source FROM vehicle_variants WHERE variant = '1.7 LX (M0246)'`)[0];
    expect(pickup).toEqual({ fuel: "Diesel", fuel_source: "Booking sheet (Fuel Type)" });
    // Variants no booking names keep a blank fuel: 8 of them in these files.
    expect(one(w, `SELECT COUNT(*) AS n FROM vehicle_variants WHERE fuel = ''`)).toBe(8);
    expect(one(w, `SELECT COUNT(*) AS n FROM vehicle_variants WHERE fuel <> '' AND fuel_source IS NULL`)).toBe(0);
  });

  it("loading the same files again changes nothing", async () => {
    const before = { res: reservations(w), audit: one(w, `SELECT COUNT(*) AS n FROM audit_log`), events: one(w, `SELECT COUNT(*) AS n FROM vehicle_events`), messages: one(w, `SELECT COUNT(*) AS n FROM wa_messages`) };
    const s2 = await loadFile(w, "stock", stockReport(), d.users.stock.session);
    expect(s2.body).toMatchObject({ created: 0, updated: 0, unchanged: 742, allocations: 0, errors: [] });
    expect(s2.body.summary.orders).toMatchObject({ recorded: 0, confirmed: 0, bypassed: 0 });
    const b2 = await loadFile(w, "bookings", bookingSheet(), d.users.crm.session);
    expect(b2.body).toMatchObject({ created: 0, updated: 0, unchanged: 636, allocations: 0, errors: [] });
    expect(reservations(w)).toEqual(before.res);
    expect(one(w, `SELECT COUNT(*) AS n FROM audit_log`)).toBe(before.audit);
    expect(one(w, `SELECT COUNT(*) AS n FROM vehicle_events`)).toBe(before.events);
    expect(one(w, `SELECT COUNT(*) AS n FROM wa_messages`)).toBe(before.messages);
  });

  it("every screen can say which files it is showing", async () => {
    const st = (await w.api("GET", "/api/data-status", undefined, d.users.exec.session)).body;
    expect(st.stock).toMatchObject({ report_date: "2026-10-05", loaded_by: "Gopal Stock", age_days: 1 });
    expect(st.bookings).toMatchObject({ report_date: "2026-10-06", loaded_by: "Charu CRM", age_days: 0 });
    expect(st).toMatchObject({ stale: false, stale_files: [], expected_every_days: 3 });
    const list = (await w.api("GET", "/api/uploads", undefined, d.users.crm.session)).body;
    expect(list.uploads.map((u: any) => `${u.kind} ${u.status} ${u.row_count} ${u.uploaded_by_name}`).sort()).toEqual(["BOOKINGS DONE 636 Charu CRM", "BOOKINGS DONE 636 Charu CRM", "STOCK DONE 742 Gopal Stock", "STOCK DONE 742 Gopal Stock"]);
    expect(list.uploads.find((u: any) => u.kind === "STOCK").summary.cars).toBe(742);
  });
});

describe("the order of the two files does not matter", () => {
  it("booking sheet first, stock report second, ends with the same cars with the same customers", async () => {
    const a = makeWorld("2026-10-06 09:00"), b = makeWorld("2026-10-06 09:00");
    const da = await makeMahindraDealer(a), db = await makeMahindraDealer(b);
    await loadFile(a, "stock", stockReport(), da.users.admin.session);
    await loadFile(a, "bookings", bookingSheet(), da.users.admin.session);
    await settle(a);
    const first = await loadFile(b, "bookings", bookingSheet(), db.users.admin.session);
    expect(first.body.summary).toMatchObject({ new_bookings: 636, entered_queue: 368 });
    expect(first.body.allocations).toBe(0); // no stock yet: nothing to give
    const second = await loadFile(b, "stock", stockReport(), db.users.admin.session);
    expect(second.body.summary.orders).toMatchObject({ total: 192, in_booking_data: 124, known_only_from_stock: 68, recorded: 192 });
    await settle(b);
    expect(reservations(b)).toEqual(reservations(a));
    const states = (w: World) => by(w, `SELECT status || '/' || source AS k, COUNT(*) AS n FROM bookings GROUP BY 1`);
    expect(states(b)).toEqual(states(a));
  }, 120_000);
});

describe("a full load stays inside one request's allowance", () => {
  it("742 cars and 636 bookings on a first load: database calls per request", async () => {
    const w = makeWorld("2026-10-06 09:00");
    const d = await makeMahindraDealer(w);
    const m = meter(w);
    try {
      const calls: Record<string, number> = {};
      for (const [kind, bytes, name] of [["stock", stockReport(), STOCK_FILE], ["bookings", bookingSheet(), "Booking-Sept26.xlsx"]] as const) {
        m.reset();
        m.m.limit = 1000; // what Cloudflare allows one request
        const res = await w.send(`/api/uploads/${kind}?filename=${encodeURIComponent(name)}`, bytes, d.users.admin.session);
        expect(res.status).toBe(200);
        expect(res.body.more).toBe(false);
        calls[kind] = m.m.calls;
      }
      // Measured: the stock report in about 40 calls, the booking sheet (which also allocates the first 40 cars) in about 220.
      expect(calls.stock).toBeLessThan(80);
      expect(calls.bookings).toBeLessThan(400);
    } finally {
      m.restore();
    }
  }, 120_000);
});
