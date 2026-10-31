// The vehicle master (Category / Model / Trim / Transmission / Fuel / Drive / Seater / Variant) and the
// allocation rules the dealership sets from the screens. The master fills itself from the DMS files; the
// dealership completes it from the OEM catalogue, on the screen or with a sheet.

import { describe, expect, it } from "vitest";
import { carCompare, matchBookings, queueCompare, type QueueBooking, type QueueCar } from "../src/domain/rules";
import { vehicleLabel } from "../src/domain/allocation";
import { DEFAULT_SETTINGS, type TenantSettings } from "../src/lib/settings";
import { addCar, approvedBooking, booking, CARS, loadBookings, loadStock, makeDealer, makeWorld, submittedBooking, type Dealer, type World } from "./harness";

const AX7L = "XUV700 AX7 L Diesel AT 7 STR AWD";
const Z8 = "Scorpio-N Z8 Diesel MT 4WD 7 STR";
const one = <T = any>(w: World, sql: string, ...p: unknown[]) => w.db.q<T>(sql, ...p)[0];
const setRules = (w: World, d: Dealer, patch: Record<string, unknown>) => w.api("PUT", "/api/settings", patch, d.users.admin.session);

// A dealership's own master sheet, as it would be typed from the OEM catalogue: the eight identifying
// columns, the colours each model is sold in, and a price column the system has no use for.
const MASTER_SHEET = [
  "Category,Model,Trim,Transmission,Fuel,Drive,Seater,Variant,Colours,Ex-showroom Price",
  "Passenger,XUV700,AX7 L,Automatic,Diesel,AWD,7,XUV700 AX7 L Diesel AT 7 STR AWD,Napoli Black; Everest White; Midnight Black,2499000",
  "Passenger,XUV700,MX,Manual,Petrol,FWD,5,XUV700 MX Petrol MT 5 STR,,1399000",
  "Passenger,Scorpio-N,Z8,Manual,Diesel,4WD,7,Scorpio-N Z8 Diesel MT 4WD 7 STR,Everest White; Deep Forest,2199000",
  "Passenger,Scorpio-N,Z4,Manual,Diesel,RWD,7,Scorpio-N Z4 Diesel MT 7 STR,,1599000",
  "Passenger,Scorpio Classic,S,Manual,Diesel,RWD,7,Scorpio Classic S Diesel MT 7 STR,,1359000",
  "Passenger,Thar,LX,Automatic,Diesel,4WD,4,Thar LX Diesel AT 4WD Hard Top,,1699000",
  "Passenger,Thar,LX,Automatic,Petrol,4WD,4,Thar LX Petrol AT 4WD Hard Top,,1649000",
  "Passenger,Thar,LX,Manual,Diesel,4WD,4,Thar LX Diesel MT 4WD Hard Top,,1549000",
  "EV,BE 6,Pack Three,Automatic,Electric,RWD,5,BE 6 Pack Three 79 kWh,,2690000",
  "Commercial,Bolero Pik-Up,FB,Manual,Diesel,RWD,2,Bolero Pik-Up FB 1.7T,,999000",
].join("\n");

/** Loads the master sheet as the administrator and returns the result, the catalogue the pickers see, and a lookup by variant name. */
async function loadMasterSheet(w: World, d: Dealer) {
  const upload = (await w.api("POST", "/api/uploads/master?filename=master.csv", MASTER_SHEET, d.users.admin.session)).body;
  const catalog = (await w.api("GET", "/api/catalog", undefined, d.users.se1.session)).body;
  const v = (name: string) => {
    const hit = catalog.variants.find((x: any) => x.variant === name.toUpperCase());
    if (!hit) throw new Error(`no variant ${name} in the catalogue`);
    return hit as { id: string; category: string; model: string; trim: string; transmission: string; fuel: string; drive: string; seater: string; variant: string };
  };
  return { upload, catalog, v };
}

describe("vehicle master", () => {
  it("is loaded from the master sheet: eight identifying columns, other columns ignored, colours per model", async () => {
    const w = makeWorld();
    const d = await makeDealer(w);
    expect((await w.api("POST", "/api/uploads/master", "Category,Model,Variant\nPassenger,XUV700,X", d.users.sm.session)).status).toBe(403);
    const m = await loadMasterSheet(w, d);
    expect(m.upload).toMatchObject({ created: 10, updated: 0, colours_added: 5, errors: [] });
    expect(m.catalog.master).toBe(true);
    expect(m.v(AX7L)).toMatchObject({ category: "Passenger", model: "XUV700", trim: "AX7 L", transmission: "Automatic", fuel: "Diesel", drive: "AWD", seater: "7", variant: "XUV700 AX7 L DIESEL AT 7 STR AWD" });
    expect(m.catalog.colours.XUV700).toContain("NAPOLI BLACK");
    expect(new Set(m.catalog.variants.map((v: any) => v.category))).toEqual(new Set(["Passenger", "EV", "Commercial"]));
    // The same sheet with different spacing and one changed attribute: matched by variant name, nothing duplicated.
    const again = await w.api("POST", "/api/uploads/master", `Category,Model,Trim,Transmission,Fuel,Drive,Seater,Variant,Ex-showroom Price\nPassenger,XUV700,AX7 L,Automatic,Diesel,AWD,7,xuv700  ax7-l diesel AT 7STR awd,2499000\nPassenger,XUV700,MX,Manual,Petrol,FWD,7,XUV700 MX Petrol MT 5 STR,1399000\nPassenger,XUV700,,,,,,,\nPassenger,XUV700,MX,Manual,Petrol,FWD,5,XUV700 MX Petrol MT 5 STR,1`, d.users.admin.session);
    expect(again.body).toMatchObject({ created: 0, updated: 1, unchanged: 1 });
    expect(again.body.errors.map((e: any) => e.message)).toEqual(["Category, model and variant are required", "This variant appears more than once in the file"]);
    expect(one(w, `SELECT COUNT(*) AS n FROM vehicle_variants`).n).toBe(10);
    expect(one(w, `SELECT seater FROM vehicle_variants WHERE variant = 'XUV700 MX PETROL MT 5 STR'`).seater).toBe("7");
  });

  it("the master is downloaded, completed and loaded back: a blank cell leaves what the master has", async () => {
    const w = makeWorld();
    const d = await makeDealer(w);
    // The stock report registers the pick-up; its description states neither transmission, fuel nor drive.
    await loadStock(w, d.users.stock.session, [{ vin: "MA1MAXX0000000001", car: "MAXX_WHITE", loc: "PATIA" }]);
    expect((await w.api("GET", "/api/master/export", undefined, d.users.se1.session)).status).toBe(403);
    const sheet = await w.api("GET", "/api/master/export", undefined, d.users.ordering.session);
    expect(sheet.headers.get("Content-Type")).toContain("text/csv");
    expect(sheet.body).toBe("Category,Model,Trim,Transmission,Fuel,Drive,Seater,Variant,OEM Model Code\nPROSPER,BOL MAXX PUP HD,LX,,,,3,1.7 LX (M0246),M0246");
    // The ordering desk fills in the three blanks from the catalogue and leaves the category cell empty.
    const back = await w.api("POST", "/api/uploads/master", "Category,Model,Trim,Transmission,Fuel,Drive,Seater,Variant\n,BOL MAXX PUP HD,,Manual,Diesel,RWD,,1.7 LX (M0246)", d.users.ordering.session);
    expect(back.body).toMatchObject({ created: 0, updated: 1, unchanged: 0, errors: [] });
    expect(one(w, `SELECT category, trim_level, transmission, fuel, fuel_source, drive, seater, origin FROM vehicle_variants`)).toEqual({ category: "PROSPER", trim_level: "LX", transmission: "Manual", fuel: "Diesel", fuel_source: "Vehicle master sheet", drive: "RWD", seater: "3", origin: "DMS" });
    // A new variant still needs its category; an existing one under another model is not moved by a sheet.
    const bad = await w.api("POST", "/api/uploads/master", "Category,Model,Variant\n,THAR,Thar Earth Edition\nPROSPER,BOLERO,1.7 LX (M0246)", d.users.ordering.session);
    expect(bad.body.errors.map((e: any) => [e.row, e.message])).toEqual([[2, "Category, model and variant are required"], [3, "The master already has this variant under model BOL MAXX PUP HD; change the model on the Vehicle master screen so stock and bookings follow"]]);
    // The next stock report does not undo what the dealership filled in.
    await loadStock(w, d.users.stock.session, [{ vin: "MA1MAXX0000000001", car: "MAXX_WHITE", loc: "PATIA" }, { vin: "MA1MAXX0000000002", car: "MAXX_WHITE", loc: "PATIA" }]);
    expect(one(w, `SELECT transmission, fuel, drive FROM vehicle_variants`)).toEqual({ transmission: "Manual", fuel: "Diesel", drive: "RWD" });
    // The old template download is gone with the old stock format.
    expect((await w.api("GET", "/api/uploads/template/master", undefined, d.users.admin.session)).status).toBe(404);
  });

  it("ties every car and booking to a master variant, however the name is typed", async () => {
    const w = makeWorld();
    const d = await makeDealer(w);
    const m = await loadMasterSheet(w, d);
    // A booking picked on the screen carries the master variant's id.
    const b = await approvedBooking(w, d, "se1", { variant_id: m.v(AX7L).id, colour: "napoli black" }, "PATIA", "Rahul Sharma", "9876500001");
    expect((await booking(w, d, b.id)).booking).toMatchObject({ variant_id: m.v(AX7L).id, model: "XUV700", variant: "XUV700 AX7 L DIESEL AT 7 STR AWD", colour: "NAPOLI BLACK", trim: "AX7 L", fuel: "Diesel", transmission: "Automatic", drive: "AWD", seater: "7", category: "Passenger" });
    // The stock in-charge types the same variant differently, and gives model and variant separately for the next car.
    const typed = await addCar(w, d, "MA1TEST0000000001", { variant: "xuv700 ax7-l Diesel AT 7 str AWD", colour: "Napoli-Black" }, "PATIA", "RECEIVED", { wholesale_invoice_date: "01/10/2026" });
    expect(typed.allocations).toHaveLength(1);
    expect((await booking(w, d, b.id)).allocation.vin).toBe("MA1TEST0000000001");
    await addCar(w, d, "MA1TEST0000000002", { model: "Scorpio N", variant: "Z8 Diesel MT 4WD 7 STR", colour: "Everest White" }, "PATIA", "IN_TRANSIT", { expected_arrival_date: "22/10/2026" });
    expect(one(w, `SELECT model, variant, colour, variant_id FROM vehicles WHERE vin = 'MA1TEST0000000002'`)).toEqual({ model: "SCORPIO-N", variant: "SCORPIO-N Z8 DIESEL MT 4WD 7 STR", colour: "EVEREST WHITE", variant_id: m.v(Z8).id });
    // The customer's message names the car once, not "XUV700 XUV700 ...".
    expect(one(w, `SELECT rendered_text FROM wa_messages WHERE booking_id = ?`, b.id).rendered_text).toContain("your XUV700 AX7 L DIESEL AT 7 STR AWD NAPOLI BLACK has been allocated");
  });

  it("the two DMS files name the same car differently and still meet in one master variant", async () => {
    const w = makeWorld();
    const d = await makeDealer(w);
    // The booking sheet writes "XUV3XO AX5 PM MT WQ" with the model code inside a longer code; the stock report writes
    // "XUV3XO AX5 PM MT WQ(A3EVRSTWHT)(M1024)". Neither is typed by anyone here, and no name has to be mapped.
    const sheet = await loadBookings(w, d.users.stock.session, [{ no: "OTF27A000001", car: "XUV3XO_WHITE", loc: "PATIA", created: "01-Oct-2026 10:00 AM", customer: "WAITING CUSTOMER" }]);
    expect(sheet.body.summary).toMatchObject({ variants_added: 1, not_recognised: 0 });
    const stock = await loadStock(w, d.users.stock.session, [{ vin: "MA1XUV00000000001", car: "XUV3XO_WHITE", loc: "PATIA" }]);
    expect(stock.body).toMatchObject({ created: 1, errors: [], allocations: 1 });
    expect(stock.body.summary.variants_added).toBe(0);
    const master = (await w.api("GET", "/api/master", undefined, d.users.admin.session)).body;
    expect(master.pending_names).toBe(0);
    expect(master.not_tied_to_master).toEqual({ cars: 0, bookings: 0 });
    expect(master.variants).toHaveLength(1);
    expect(master.variants[0]).toMatchObject({ origin: "DMS", category: "PERSONAL", model: "XUV 3XO", variant: "AX5 PM MT (M1024)", trim: "AX5", transmission: "Manual", fuel: "Petrol", seater: "5", oem_model_code: "M1024", cars_in_stock: 1, open_bookings: 1 });
    const car = one(w, `SELECT variant_id, model, variant, colour FROM vehicles`);
    expect(one(w, `SELECT variant_id, model, variant, colour FROM bookings`)).toEqual(car);
    expect(car).toEqual({ variant_id: master.variants[0].id, ...CARS.XUV3XO_WHITE.is });
    // A booking then taken on the screen for that variant joins the same queue.
    const onScreen = await approvedBooking(w, d, "se1", { variant_id: master.variants[0].id, colour: "everest white" }, "PATIA", "Screen Customer", "9876500002");
    expect((await booking(w, d, onScreen.id)).queue).toEqual({ position: 1, waiting: 1 });
  });

  it("accepts the attributes instead of the variant name, and refuses what is not in the master", async () => {
    const w = makeWorld();
    const d = await makeDealer(w);
    const m = await loadMasterSheet(w, d);
    const post = (body: Record<string, unknown>) => w.api("POST", "/api/vehicles", { vin: `MA1ATTR${Math.random().toString().slice(2, 12)}`, outlet_id: d.outlets.PATIA, status: "RECEIVED", colour: "Everest White", ...body }, d.users.stock.session);
    const byAttrs = await post({ model: "Thar", trim: "LX", transmission: "Automatic", fuel: "Diesel", drive: "4WD", seater: "4" });
    expect(byAttrs.status).toBe(201);
    expect(one(w, `SELECT variant FROM vehicles WHERE id = ?`, byAttrs.body.id).variant).toBe("THAR LX DIESEL AT 4WD HARD TOP");
    const ambiguous = await post({ model: "Thar", trim: "LX" });
    expect(ambiguous.status).toBe(400);
    expect(ambiguous.body.error.message).toContain("3 variants in the vehicle master match");
    const unknown = await post({ variant: "Thar LX Diesel CVT" });
    expect(unknown.body.error).toMatchObject({ code: "NOT_IN_MASTER" });
    const colour = await post({ variant_id: m.v(AX7L).id, colour: "Pink" });
    expect(colour.body.error.message).toContain('Colour "Pink" is not in the colour list for XUV700');
    // Free text that happened to work before the master is no longer accepted for a booking either.
    const bk = await w.api("POST", "/api/bookings", { outlet_id: d.outlets.PATIA, customer_name: "X", customer_mobile: "9876500002", model: "CRETA", variant: "SX", colour: "BLACK" }, d.users.se1.session);
    expect(bk.status).toBe(400);
    // Another dealership's variant id means nothing here.
    const other = await makeDealer(w, "other-dealer");
    const cross = await w.api("POST", "/api/bookings", { outlet_id: other.outlets.PATIA, customer_name: "X", customer_mobile: "9876500003", variant_id: m.v(AX7L).id, colour: "Napoli Black" }, other.users.se1.session);
    expect(cross.status).toBe(400); // the id is not looked up outside its own dealership
    await loadMasterSheet(w, other);
    const cross2 = await w.api("POST", "/api/bookings", { outlet_id: other.outlets.PATIA, customer_name: "X", customer_mobile: "9876500003", variant_id: m.v(AX7L).id, colour: "Napoli Black" }, other.users.se1.session);
    expect(cross2.body.error.message).toBe("The variant chosen is not in the vehicle master");
  });

  it("a discontinued variant keeps its stock and bookings but takes no new booking", async () => {
    const w = makeWorld();
    const d = await makeDealer(w);
    const m = await loadMasterSheet(w, d);
    const id = m.v("Scorpio Classic S Diesel MT 7 STR").id;
    expect((await w.api("PATCH", `/api/master/variants/${id}`, { is_active: false }, d.users.admin.session)).body.is_active).toBe(0);
    expect((await addCar(w, d, "MA1DISC0000000001", { variant_id: id, colour: "Everest White" }, "PATIA", "RECEIVED")).id).toBeTruthy();
    const bk = await w.api("POST", "/api/bookings", { outlet_id: d.outlets.PATIA, customer_name: "X", customer_mobile: "9876500002", variant_id: id, colour: "Everest White" }, d.users.se1.session);
    expect(bk.status).toBe(400);
    expect(bk.body.error.message).toContain("discontinued");
    expect((await w.api("GET", "/api/catalog", undefined, d.users.se1.session)).body.variants.some((v: any) => v.id === id)).toBe(false);
  });

  it("a variant the DMS names registers itself; a colour the two files name differently is mapped once, and resolves from then on", async () => {
    const w = makeWorld();
    const d = await makeDealer(w);
    const s = d.users.stock.session;
    // The pick-up's description carries no paint alias, so its colour is only a name: the booking sheet calls the
    // customer's colour DIAMOND WHITE, the stock report calls the car WHITE.
    await loadBookings(w, s, [{ no: "OTF27A000001", car: "MAXX_WHITE", loc: "PATIA", created: "01-Oct-2026 10:00 AM", colour: "DIAMOND WHITE" }]);
    let res = await loadStock(w, s, [{ vin: "MA1MAP00000000001", car: "MAXX_WHITE", loc: "PATIA" }]);
    // Nothing waits to be mapped before the car is in stock: the variant is in the master and the car is loaded...
    expect(res.body).toMatchObject({ created: 1, errors: [], allocations: 0 });
    let master = (await w.api("GET", "/api/master", undefined, d.users.admin.session)).body;
    expect(master.pending_names).toBe(0);
    expect(master.variants.map((v: any) => [v.variant, v.origin, v.cars_in_stock, v.open_bookings])).toEqual([["1.7 LX (M0246)", "DMS", 1, 1]]);
    expect(master.colours["BOL MAXX PUP HD"]).toEqual(["DIAMOND WHITE", "WHITE"]);
    // ...but it is not given to the booking: nothing says the two names are one colour, and the system does not guess.
    const b = one(w, `SELECT id, colour FROM bookings`);
    expect(b.colour).toBe("DIAMOND WHITE");
    expect(one(w, `SELECT colour FROM vehicles`).colour).toBe("WHITE");
    // Saying so is the EDP Manager's or the administrator's job, not the sales team's.
    const map = { kind: "COLOUR", model: "BOL MAXX PUP HD", alias: "WHITE", colour: "Diamond White" };
    expect((await w.api("POST", "/api/master/names", map, d.users.se1.session)).status).toBe(403);
    expect((await w.api("POST", "/api/master/names", { ...map, colour: "Pearl White" }, d.users.admin.session)).status).toBe(400); // not a colour of this model
    const mapped = await w.api("POST", "/api/master/names", map, d.users.admin.session);
    expect(mapped.status).toBe(200);
    expect(mapped.body).toMatchObject({ kind: "COLOUR", colour: "DIAMOND WHITE", recoloured: { cars: 1, bookings: 0 } });
    // The free car now carries the colour the booking waits for, and the next sweep gives it to the customer.
    expect(one(w, `SELECT colour, dms_colour FROM vehicles`)).toEqual({ colour: "DIAMOND WHITE", dms_colour: "WHITE" });
    expect((await w.tick())[0].allocated).toBe(1);
    expect((await booking(w, d, b.id)).allocation.vin).toBe("MA1MAP00000000001");
    // From then on a car the report calls WHITE is loaded as DIAMOND WHITE and matched straight away.
    await loadBookings(w, s, [{ no: "OTF27A000001", car: "MAXX_WHITE", loc: "PATIA", created: "01-Oct-2026 10:00 AM", colour: "DIAMOND WHITE" }, { no: "OTF27A000002", car: "MAXX_WHITE", loc: "PATIA", created: "02-Oct-2026 10:00 AM", colour: "DIAMOND WHITE" }]);
    res = await loadStock(w, s, [{ vin: "MA1MAP00000000001", car: "MAXX_WHITE", loc: "PATIA" }, { vin: "MA1MAP00000000002", car: "MAXX_WHITE", loc: "PATIA" }]);
    expect(res.body).toMatchObject({ created: 1, unchanged: 1, errors: [], allocations: 1 });
    expect(one(w, `SELECT v.vin FROM allocations a JOIN vehicles v ON v.id = a.vehicle_id JOIN bookings b ON b.id = a.booking_id WHERE b.booking_no = 'OTF27A000002'`).vin).toBe("MA1MAP00000000002");
    master = (await w.api("GET", "/api/master", undefined, d.users.admin.session)).body;
    expect(master.names).toMatchObject([{ kind: "COLOUR", model: "BOL MAXX PUP HD", alias: "WHITE", colour: "DIAMOND WHITE", pending: false, mapped_by_name: "Asha Admin" }]);
  });

  it("a description the parser does not recognise never blocks the car or a status change, and shows at day end", async () => {
    const w = makeWorld();
    const d = await makeDealer(w);
    const s = d.users.stock.session;
    await loadStock(w, s, [{ vin: "MA1KNOWN000000001", car: "THAR_WHITE", loc: "PATIA", status: "In Transit" }]);
    await loadBookings(w, s, [{ no: "OTF27A000001", car: "THAR_WHITE", loc: "PATIA", created: "01-Oct-2026 10:00 AM" }]);
    const known = one(w, `SELECT id, variant FROM vehicles WHERE vin = 'MA1KNOWN000000001'`);
    w.at("2026-10-13 17:00");
    // The evening report writes the description of the reserved car in a form nobody has seen, and lists a new car of a new model.
    const odd = { "Model Description": "THR EARTH ED D MT(A3EVRSTWHT)(M0877)" };
    const res = await loadStock(w, s, [
      { vin: "MA1KNOWN000000001", car: "THAR_WHITE", loc: "PATIA", raw: odd },
      { vin: "MA1NEW00000000001", car: "THAR_WHITE", loc: "PATIA", raw: { "Model Description": "NEW MODEL X1 AT(A3EVRSTWHT)(M4321)", Model: "NEW MODEL" } },
    ]);
    expect(res.body).toMatchObject({ created: 1, updated: 1 });
    expect(res.body.summary).toMatchObject({ cars: 2, not_recognised: 2, received: 1, issues: { description_not_recognised: 2 } });
    // The car the system already knows has arrived all the same: the customer is told and keeps the car as it was described.
    expect(one(w, `SELECT status, variant FROM vehicles WHERE id = ?`, known.id)).toEqual({ status: "RECEIVED", variant: known.variant });
    expect(w.db.q(`SELECT event_key FROM wa_messages ORDER BY created_at, rowid`).map((m: any) => m.event_key)).toEqual(["ALLOC_IN_TRANSIT", "STOCK_RECEIVED"]);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0]).toMatchObject({ row: 2, key: "MA1KNOWN000000001" });
    expect(res.body.errors[0].message).toContain("it is reserved for booking OTF27A000001. Its description was not changed");
    // The new car is in stock under the DMS's own model name, with nothing guessed about it.
    expect(one(w, `SELECT v.status, v.model, v.variant, m.trim_level, m.transmission, m.fuel, m.drive FROM vehicles v JOIN vehicle_variants m ON m.id = v.variant_id WHERE v.vin = 'MA1NEW00000000001'`)).toEqual({ status: "RECEIVED", model: "NEW MODEL", variant: "NEW MODEL X1 AT (M4321)", trim_level: "", transmission: "", fuel: "", drive: "" });
    const run = await w.api("POST", "/api/recon/run", {}, d.users.head.session);
    expect(run.body.summary.items.by_category.NOT_RECOGNISED).toBe(1);
    const item = (await w.api("GET", `/api/recon/runs/${run.body.run_id}`, undefined, d.users.head.session)).body.items.find((i: any) => i.category === "NOT_RECOGNISED");
    expect(item).toMatchObject({ severity: "MEDIUM" });
    expect(item.message).toContain("2 car(s) in the stock report as on 13 Oct 2026 have a Model Description the parser does not recognise");
  });

  it("renaming a master variant carries through to stock and bookings, which still match each other", async () => {
    const w = makeWorld();
    const d = await makeDealer(w);
    const m = await loadMasterSheet(w, d);
    const id = m.v(Z8).id;
    const b = await approvedBooking(w, d, "se1", { variant_id: id, colour: "Everest White" }, "PATIA", "Waiting", "9876500001");
    await w.api("PATCH", `/api/master/variants/${id}`, { variant: "Scorpio-N Z8 Diesel MT 4x4 7 Seater" }, d.users.admin.session);
    expect((await booking(w, d, b.id)).booking.variant).toBe("SCORPIO-N Z8 DIESEL MT 4X4 7 SEATER");
    const car = await addCar(w, d, "MA1REN00000000001", { variant: "Scorpio-N Z8 Diesel MT 4x4 7 Seater", colour: "Everest White" }, "PATIA", "RECEIVED");
    expect(car.allocations[0]).toMatchObject({ bookingId: b.id });
    // A name already used by another variant is refused.
    expect((await w.api("PATCH", `/api/master/variants/${id}`, { variant: AX7L }, d.users.admin.session)).status).toBe(409);
  });

  it("a variant that comes from the DMS keeps the DMS's name; its other attributes can be completed on the screen", async () => {
    const w = makeWorld();
    const d = await makeDealer(w);
    await loadStock(w, d.users.stock.session, [{ vin: "MA1MAXX0000000001", car: "MAXX_WHITE", loc: "PATIA" }]);
    const v = one(w, `SELECT id, variant, model FROM vehicle_variants`);
    // Renamed, the next file would not find it and would register the car a second time.
    const renamed = await w.api("PATCH", `/api/master/variants/${v.id}`, { variant: "Bolero Maxx Pik-Up HD 1.7 LX" }, d.users.admin.session);
    expect(renamed.status).toBe(400);
    expect(renamed.body.error.message).toContain("comes from the DMS files");
    expect((await w.api("PATCH", `/api/master/variants/${v.id}`, { model: "Bolero" }, d.users.admin.session)).status).toBe(400);
    const filled = await w.api("PATCH", `/api/master/variants/${v.id}`, { transmission: "Manual", fuel: "Diesel", drive: "RWD" }, d.users.ordering.session);
    expect(filled.status).toBe(200);
    expect(filled.body).toMatchObject({ variant: "1.7 LX (M0246)", model: "BOL MAXX PUP HD", transmission: "Manual", fuel: "Diesel", drive: "RWD", origin: "DMS", fuel_source: "Entered on the Vehicle master screen" });
    expect(one(w, `SELECT model, variant, variant_id FROM vehicles`)).toEqual({ model: v.model, variant: v.variant, variant_id: v.id });
  });

  it("stock and bookings can be filtered by the master's attributes", async () => {
    const w = makeWorld();
    const d = await makeDealer(w);
    const m = await loadMasterSheet(w, d);
    await addCar(w, d, "MA1FILT0000000001", { variant_id: m.v(AX7L).id, colour: "Napoli Black" }, "PATIA", "RECEIVED");
    await addCar(w, d, "MA1FILT0000000002", { variant_id: m.v("BE 6 Pack Three 79 kWh").id, colour: "Tango Red" }, "PATIA", "RECEIVED");
    await addCar(w, d, "MA1FILT0000000003", { variant_id: m.v("Thar LX Petrol AT 4WD Hard Top").id, colour: "Red Rage" }, "CUTTACK", "IN_TRANSIT");
    const cars = (q: string) => w.api("GET", `/api/vehicles?${q}`, undefined, d.users.se1.session).then((r) => r.body.map((v: any) => v.vin));
    expect(await cars("fuel=Electric")).toEqual(["MA1FILT0000000002"]);
    expect(await cars("category=Passenger&transmission=Automatic&drive=4WD")).toEqual(["MA1FILT0000000003"]);
    expect(await cars("model=xuv700")).toEqual(["MA1FILT0000000001"]);
    const summary = (await w.api("GET", "/api/stock/summary?category=EV", undefined, d.users.se1.session)).body;
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({ model: "BE 6", trim: "Pack Three", fuel: "Electric", yard_free: 1 });
    const avail = await w.api("GET", `/api/stock/availability?variant_id=${m.v(AX7L).id}&colour=Napoli%20Black&outlet_id=${d.outlets.PATIA}`, undefined, d.users.se1.session);
    expect(avail.body).toMatchObject({ answer: "AVAILABLE_NOW", model: "XUV700", variant: "XUV700 AX7 L DIESEL AT 7 STR AWD" });
  });

  it("colours of a model are maintained on the screen; a model without a list accepts any colour", async () => {
    const w = makeWorld();
    const d = await makeDealer(w);
    const m = await loadMasterSheet(w, d);
    const z = m.v("Scorpio-N Z4 Diesel MT 7 STR").id;
    expect((await w.api("PUT", "/api/master/colours", { model: "Scorpio-N", colours: ["Everest White", "Stealth Black"] }, d.users.admin.session)).body.colours).toEqual(["EVEREST WHITE", "STEALTH BLACK"]);
    const post = (colour: string) => w.api("POST", "/api/bookings", { outlet_id: d.outlets.PATIA, customer_name: "X", customer_mobile: "9876500002", variant_id: z, colour }, d.users.se1.session).then((r) => r.status);
    expect(await post("Deep Forest")).toBe(400);
    expect(await post("stealth  black")).toBe(201);
    await w.api("PUT", "/api/master/colours", { model: "Scorpio-N", colours: [] }, d.users.admin.session);
    expect(await post("Any Colour At All")).toBe(201);
  });
});

describe("allocation rules set from the screen", () => {
  const b = (id: string, outlet: string, date: string, commitment: string | null = null, amount = 0, override: object | null = null): QueueBooking => ({ id, booking_no: id, outlet_id: outlet, priority_ts: date, expected_delivery_date: commitment, booking_amount: amount, priority_override_json: override ? JSON.stringify(override) : null });
  const c = (id: string, outlet: string, status: string, invoice: string | null = null, eta: string | null = null): QueueCar => ({ id, vin: id, outlet_id: outlet, status, wholesale_invoice_date: invoice, expected_arrival_date: eta, received_at: status === "RECEIVED" ? "2026-10-01" : null });
  const rules = (patch: Partial<TenantSettings> = {}) => ({ ...DEFAULT_SETTINGS, ...patch });
  const order = (list: QueueBooking[], r: TenantSettings) => [...list].sort(queueCompare(r)).map((x) => x.id);

  it("queue order follows the criteria in the order listed", () => {
    const list = [b("A", "P", "2026-10-01", "2026-11-20", 21000), b("B", "P", "2026-10-02", "2026-11-05", 51000), b("C", "P", "2026-10-03", null, 100000), b("D", "P", "2026-10-04", "2026-11-05", 25000)];
    expect(order(list, rules())).toEqual(["A", "B", "C", "D"]);
    expect(order(list, rules({ queue_order: ["DELIVERY_COMMITMENT", "BOOKING_DATE"] }))).toEqual(["B", "D", "A", "C"]); // no committed date: after those with one
    expect(order(list, rules({ queue_order: ["BOOKING_AMOUNT"] }))).toEqual(["C", "B", "D", "A"]);
    expect(order(list, rules({ queue_order: ["DELIVERY_COMMITMENT", "BOOKING_AMOUNT"] }))).toEqual(["B", "D", "A", "C"]);
  });

  it("car order follows the criteria in the order listed", () => {
    const cars = [c("YARD-NEW", "P", "RECEIVED", "2026-09-20"), c("YARD-OLD", "C", "RECEIVED", "2026-08-01"), c("TRANSIT-OLDEST", "P", "IN_TRANSIT", "2026-07-01", "2026-11-01"), c("TRANSIT-SOON", "P", "IN_TRANSIT", "2026-09-25", "2026-10-20")];
    const pick = (r: TenantSettings, outlet = "P") => [...cars].sort(carCompare(r, outlet)).map((x) => x.id);
    expect(pick(rules())).toEqual(["YARD-NEW", "YARD-OLD", "TRANSIT-SOON", "TRANSIT-OLDEST"]); // yard, own outlet, arrival, invoice
    expect(pick(rules({ car_order: ["AT_DEALERSHIP", "OLDEST_INVOICE"] }))).toEqual(["YARD-OLD", "YARD-NEW", "TRANSIT-OLDEST", "TRANSIT-SOON"]);
    expect(pick(rules({ car_order: ["OLDEST_INVOICE"] }))[0]).toBe("TRANSIT-OLDEST");
    expect(pick(rules({ car_order: ["OWN_OUTLET", "EARLIEST_ARRIVAL"] }), "C")[0]).toBe("YARD-OLD");
  });

  it("nearby outlets: a spare car serves another outlet only if it is listed as nearby to it", () => {
    const queue = [b("PATIA-1", "P", "2026-10-01"), b("PURI-1", "U", "2026-10-02")];
    const cars = [c("CUTTACK-CAR", "C", "RECEIVED")];
    const m = (near: Record<string, string[]>) => matchBookings(queue, cars, rules({ outlet_scope: "SAME_OUTLET_NEARBY", nearby_outlets: near })).map((x) => `${x.booking.id}>${x.vehicle.id}:${x.pass}`);
    expect(m({})).toEqual([]);
    expect(m({ U: ["C"] })).toEqual(["PURI-1>CUTTACK-CAR:NEARBY_OUTLET"]); // Patia booked first but Cuttack is not nearby to Patia
    expect(m({ P: ["C"], U: ["C"] })).toEqual(["PATIA-1>CUTTACK-CAR:NEARBY_OUTLET"]);
  });

  it("the queue on screen, the allocation and the 'move ahead' request all follow the configured order", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    const m = await loadMasterSheet(w, d);
    const car = { variant_id: m.v(AX7L).id, colour: "Napoli Black" };
    expect((await setRules(w, d, { queue_order: ["DELIVERY_COMMITMENT", "BOOKING_DATE"] })).status).toBe(200);
    const first = await approvedBooking(w, d, "se1", car, "PATIA", "Booked first, wants it in December", "9876500001", { expected_delivery_date: "2026-12-15" });
    w.at("2026-10-13 11:00");
    const second = await approvedBooking(w, d, "se1", car, "PATIA", "Booked second, wedding in November", "9876500002", { expected_delivery_date: "2026-11-05" });
    w.at("2026-10-13 12:00");
    const third = await approvedBooking(w, d, "se2", car, "PATIA", "Booked third, mid November", "9876500003", { expected_delivery_date: "2026-11-20" });
    w.at("2026-10-13 12:30");
    const fourth = await approvedBooking(w, d, "se2", car, "PATIA", "Booked last, no date", "9876500004");
    const queue = async () => (await w.api("GET", `/api/bookings/${first.id}/queue`, undefined, d.users.se1.session)).body.map((q: any) => q.booking_no);
    expect(await queue()).toEqual([second.booking_no, third.booking_no, first.booking_no, fourth.booking_no]);
    expect((await booking(w, d, first.id)).queue).toEqual({ position: 3, waiting: 4 });
    const list = (await w.api("GET", "/api/bookings?view=waiting", undefined, d.users.head.session)).body;
    expect(list.map((x: any) => [x.booking_no, x.queue_position])).toEqual([[second.booking_no, 1], [third.booking_no, 2], [first.booking_no, 3], [fourth.booking_no, 4]]);

    // "Move ahead of the third booking": the request shows the approver what it will do, and it lands just before that booking.
    const ex = await w.api("POST", "/api/exceptions", { type: "PRIORITY_CHANGE", booking_id: fourth.id, payload: { before_booking_id: third.id }, reason: "Fleet customer, agreed by the Dealer Principal" }, d.users.agm.session);
    expect(JSON.parse(ex.body.payload_json)).toMatchObject({ from_position: 4, to_position: 2, waiting: 4 });
    await w.api("POST", `/api/exceptions/${ex.body.id}/approve`, {}, d.users.head.session);
    expect(await queue()).toEqual([second.booking_no, fourth.booking_no, third.booking_no, first.booking_no]);
    expect((await booking(w, d, fourth.id)).booking.moved_ahead).toBe(true);

    // One car arrives: it goes to the head of the queue as configured, not to the earliest booking.
    const arrived = await addCar(w, d, "MA1RULE0000000001", car, "PATIA", "RECEIVED");
    expect(arrived.allocations[0].bookingNo).toBe(second.booking_no);
    // The day-end check agrees with the configured order: nothing to report.
    const run = await w.api("POST", "/api/recon/run", {}, d.users.head.session);
    expect(run.body.summary.items.by_category.QUEUE_ORDER).toBeUndefined();
  });

  it("the day-end check flags a car given out of the configured order", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    await setRules(w, d, { queue_order: ["BOOKING_AMOUNT", "BOOKING_DATE"] });
    w.at("2026-10-13 10:05");
    const cfg = { model: "THAR", variant: "LX", colour: "RED" };
    const small = await approvedBooking(w, d, "se1", cfg, "PATIA", "Booked first, small amount", "9876500001", { booking_amount: 11000 });
    const big = await approvedBooking(w, d, "se1", cfg, "PATIA", "Booked later, large amount", "9876500002", { booking_amount: 100000 });
    w.at("2026-10-13 10:30");
    // A car is handed to the smaller booking behind the system's back.
    w.db.raw.exec(`INSERT INTO vehicles (id, tenant_id, outlet_id, vin, model, variant, colour, status, ever_allocated, source, created_at, updated_at) VALUES ('veh_x', '${d.tenantId}', '${d.outlets.PATIA}', 'MA1ORDER000000001', 'THAR', 'LX', 'RED', 'RECEIVED', 1, 'MANUAL', '2026-10-13T05:00:00.000Z', '2026-10-13T05:00:00.000Z')`);
    w.db.raw.exec(`INSERT INTO allocations (id, tenant_id, booking_id, vehicle_id, type, status, allocated_at, allocated_by, clock_started_at) VALUES ('alc_x', '${d.tenantId}', '${small.id}', 'veh_x', 'FREE_STOCK', 'ACTIVE', '2026-10-13T05:00:00.000Z', 'SYSTEM', '2026-10-13T05:00:00.000Z')`);
    w.db.raw.exec(`UPDATE bookings SET status = 'ALLOCATED' WHERE id = '${small.id}'`);
    const run = await w.api("POST", "/api/recon/run", {}, d.users.head.session);
    const item = (await w.api("GET", `/api/recon/runs/${run.body.run_id}`, undefined, d.users.head.session)).body.items.find((i: any) => i.category === "QUEUE_ORDER");
    expect(item.message).toContain(`Booking ${small.booking_no} holds car MA1ORDER000000001 while booking ${big.booking_no}`);
  });

  it("which car is given follows the configured car order", async () => {
    const cfg = { model: "THAR", variant: "LX", colour: "RED" };
    const run = async (patch: Record<string, unknown>) => {
      const w = makeWorld("2026-10-13 10:00");
      const d = await makeDealer(w);
      await setRules(w, d, patch);
      await addCar(w, d, "MA1CAR00000000001", cfg, "PATIA", "RECEIVED", { wholesale_invoice_date: "2026-09-20" });
      await addCar(w, d, "MA1CAR00000000002", cfg, "PATIA", "IN_TRANSIT", { wholesale_invoice_date: "2026-07-01", expected_arrival_date: "2026-10-30" });
      return (await approvedBooking(w, d, "se1", cfg, "PATIA", "Customer", "9876500001")).approval.allocations[0];
    };
    expect(await run({})).toMatchObject({ vin: "MA1CAR00000000001", type: "FREE_STOCK" });
    expect(await run({ car_order: ["OLDEST_INVOICE", "AT_DEALERSHIP"] })).toMatchObject({ vin: "MA1CAR00000000002", type: "IN_TRANSIT" });
    // "Allocate only cars that have reached the dealership": the in-transit car waits until it is received.
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    await setRules(w, d, { allocate_in_transit: false });
    const transit = await addCar(w, d, "MA1CAR00000000003", cfg, "PATIA", "IN_TRANSIT");
    const bk = await approvedBooking(w, d, "se1", cfg, "PATIA", "Customer", "9876500001");
    expect(bk.approval.allocations).toHaveLength(0);
    await w.tick();
    expect((await booking(w, d, bk.id)).booking.status).toBe("APPROVED");
    const received = await w.api("POST", `/api/vehicles/${transit.id}/receive`, undefined, d.users.stock.session);
    expect(received.body.allocations[0]).toMatchObject({ bookingId: bk.id, type: "FREE_STOCK" });
  });

  it("nearby outlets are set per outlet and respected by allocation", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    const puri = (await w.api("POST", "/api/outlets", { code: "PURI", name: "Puri", city: "Puri" }, d.users.admin.session)).body.id;
    const cfg = { model: "THAR", variant: "LX", colour: "RED" };
    expect((await setRules(w, d, { outlet_scope: "SAME_OUTLET_NEARBY", nearby_outlets: { [d.outlets.PATIA]: ["out_nope"] } })).status).toBe(400);
    expect((await setRules(w, d, { outlet_scope: "SAME_OUTLET_NEARBY", nearby_outlets: { [d.outlets.PATIA]: [d.outlets.CUTTACK] } })).status).toBe(200);
    const bk = await approvedBooking(w, d, "se1", cfg, "PATIA", "Patia Customer", "9876500001");
    w.db.raw.exec(`UPDATE users SET all_outlets = 1 WHERE id = '${d.users.stock.id}'`);
    const farCar = await w.api("POST", "/api/vehicles", { vin: "MA1NEAR0000000001", ...cfg, outlet_id: puri, status: "RECEIVED" }, d.users.admin.session);
    expect(farCar.body.allocations).toHaveLength(0); // Puri is not nearby to Patia
    const nearCar = await addCar(w, d, "MA1NEAR0000000002", cfg, "CUTTACK", "RECEIVED");
    expect(nearCar.allocations[0]).toMatchObject({ bookingId: bk.id, needsTransfer: true });
    expect(JSON.parse(one(w, `SELECT rule_trace_json FROM allocations WHERE booking_id = ?`, bk.id).rule_trace_json).rule).toBe("NEARBY_OUTLET");
  });

  it("a rule change is management's alone, is announced to everyone who receives alarms and is listed at day end", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    // The people the rules apply to cannot change them: not sales, stock, Finance, the ordering desk or the auditor.
    for (const who of ["sm", "se1", "stock", "accounts", "ordering", "auditor"]) expect((await w.api("PUT", "/api/settings", { queue_order: ["BOOKING_AMOUNT"] }, d.users[who].session)).status, who).toBe(403);
    expect((await setRules(w, d, { queue_order: [] })).status).toBe(400);
    expect((await setRules(w, d, { queue_order: ["BOOKING_DATE", "BOOKING_DATE"] })).status).toBe(400);
    expect((await setRules(w, d, { car_order: ["FASTEST"] })).status).toBe(400);
    const res = await setRules(w, d, { queue_order: ["BOOKING_AMOUNT", "BOOKING_DATE"], min_booking_amount: 11000 });
    expect(res.body.rules_changed).toEqual(["queue_order"]);
    const alert = (await w.api("GET", "/api/alerts", undefined, d.users.head.session)).body.find((a: any) => a.kind === "RULES_CHANGED");
    expect(alert.body).toContain("Asha Admin changed: queue order");
    // One announcement for each role that receives alarms: the Business Head / CEO and the Dealer Principal.
    const announced = () => w.db.q<any>(`SELECT target_role, body FROM alerts WHERE kind = 'RULES_CHANGED' ORDER BY created_at, target_role`).map((a) => `${a.target_role}: ${a.body.split(".")[0]}`);
    expect(announced()).toEqual(["CEO_VP: Asha Admin changed: queue order", "DEALER_PRINCIPAL: Asha Admin changed: queue order"]);
    const audit = one(w, `SELECT detail_json FROM audit_log WHERE action = 'ALLOCATION_RULES_CHANGED'`);
    expect(JSON.parse(audit.detail_json)).toMatchObject({ before: { queue_order: ["BOOKING_DATE"] }, after: { queue_order: ["BOOKING_AMOUNT", "BOOKING_DATE"] } });
    // The Business Head runs the business day to day and may set the rules as well. It is announced just the same,
    // under their name, so the Dealer Principal sees who changed what.
    w.at("2026-10-13 11:00");
    const byHead = await w.api("PUT", "/api/settings", { car_order: ["OLDEST_INVOICE", "AT_DEALERSHIP"] }, d.users.head.session);
    expect(byHead.status).toBe(200);
    expect(byHead.body.rules_changed).toEqual(["car_order"]);
    expect(announced().slice(2)).toEqual(["CEO_VP: Bikram Head changed: car order", "DEALER_PRINCIPAL: Bikram Head changed: car order"]);
    expect(w.db.q(`SELECT u.name FROM audit_log l JOIN users u ON u.id = l.actor WHERE l.action = 'ALLOCATION_RULES_CHANGED' ORDER BY l.at`).map((r: any) => r.name)).toEqual(["Asha Admin", "Bikram Head"]);
    const run = await w.api("POST", "/api/recon/run", {}, d.users.head.session);
    expect(run.body.summary.items.by_category.RULES_CHANGED).toBe(2);
    // What ties the system to the dealership's DMS stays with the administrator.
    expect((await w.api("PUT", "/api/settings", { dms_dealer_name: "ANOTHER DEALER" }, d.users.head.session)).status).toBe(403);
    expect((await setRules(w, d, { dms_dealer_name: "NORTHSTAR MOTORS" })).body.settings.dms_dealer_name).toBe("NORTHSTAR MOTORS");
    // A setting that is not an allocation rule changes quietly.
    expect((await setRules(w, d, { min_booking_amount: 21000 })).body.rules_changed).toEqual([]);
    expect(announced()).toHaveLength(4);
    // The screen is told what the criteria are, so nothing about them is fixed in the app.
    const meta = (await w.api("GET", "/api/settings", undefined, d.users.admin.session)).body;
    expect(Object.keys(meta.queue_criteria)).toEqual(["BOOKING_DATE", "DELIVERY_COMMITMENT", "BOOKING_AMOUNT"]);
    expect(Object.keys(meta.car_criteria)).toEqual(["AT_DEALERSHIP", "OWN_OUTLET", "EARLIEST_ARRIVAL", "OLDEST_INVOICE"]);
  });

  it("the effect of proposed rules can be previewed without changing anything", async () => {
    const w = makeWorld("2026-10-13 10:00");
    const d = await makeDealer(w);
    const cfg = { model: "THAR", variant: "LX", colour: "RED" };
    const a = await approvedBooking(w, d, "se1", cfg, "PATIA", "First", "9876500001", { booking_amount: 11000 });
    w.at("2026-10-13 11:00");
    const z = await approvedBooking(w, d, "se1", cfg, "PATIA", "Second", "9876500002", { booking_amount: 90000 });
    // One free car that the current rules cannot give to anyone (it is blocked from allocation only by being added behind the system).
    w.db.raw.exec(`INSERT INTO vehicles (id, tenant_id, outlet_id, vin, model, variant, colour, status, source, created_at, updated_at) VALUES ('veh_p', '${d.tenantId}', '${d.outlets.PATIA}', 'MA1PREV0000000001', 'THAR', 'LX', 'RED', 'RECEIVED', 'MANUAL', '2026-10-13T05:00:00.000Z', '2026-10-13T05:00:00.000Z')`);
    expect((await w.api("POST", "/api/settings/preview", { queue_order: ["BOOKING_AMOUNT"] }, d.users.sm.session)).status).toBe(403);
    expect((await w.api("POST", "/api/settings/preview", { queue_order: ["BOOKING_AMOUNT"] }, d.users.head.session)).status).toBe(200); // whoever may set the rules may first see what they would do
    const p = (await w.api("POST", "/api/settings/preview", { queue_order: ["BOOKING_AMOUNT", "BOOKING_DATE"] }, d.users.admin.session)).body;
    expect(p).toMatchObject({ waiting_bookings: 2, bookings_affected: 2 });
    expect(p.groups[0].rows.map((r: any) => [r.booking_no, r.position_now, r.position_then, r.car_now?.vin ?? null, r.car_then?.vin ?? null])).toEqual([
      [z.booking_no, 2, 1, null, "MA1PREV0000000001"],
      [a.booking_no, 1, 2, "MA1PREV0000000001", null],
    ]);
    // Nothing was changed by looking.
    expect((await w.api("GET", "/api/settings", undefined, d.users.admin.session)).body.settings.queue_order).toEqual(["BOOKING_DATE"]);
    expect(w.db.q(`SELECT id FROM allocations`)).toHaveLength(0);
    expect((await w.api("POST", "/api/settings/preview", {}, d.users.admin.session)).body.bookings_affected).toBe(0);
  });
});

describe("naming the car", () => {
  it("does not repeat the model when the variant name already starts with it", () => {
    expect(vehicleLabel({ model: "XUV700", variant: "XUV700 AX7 L DIESEL AT", colour: "NAPOLI BLACK" })).toBe("XUV700 AX7 L DIESEL AT NAPOLI BLACK");
    expect(vehicleLabel({ model: "XUV 3XO", variant: "XUV3XO AX5 PETROL MT", colour: "WHITE" })).toBe("XUV3XO AX5 PETROL MT WHITE");
    expect(vehicleLabel({ model: "CRETA", variant: "SX(O) 1.5 PETROL IVT", colour: "ABYSS BLACK" })).toBe("CRETA SX(O) 1.5 PETROL IVT ABYSS BLACK");
  });
});
