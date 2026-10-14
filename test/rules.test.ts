// The allocation rules and the small pieces they stand on, tested without a database.

import { describe, expect, it } from "vitest";
import { matchBookings, type BookingRow, type VehicleRow } from "../src/domain/allocation";
import { windowSchedule } from "../src/domain/timers";
import { DEFAULT_SETTINGS, mergeSettings, type TenantSettings } from "../src/lib/settings";
import { localDayBounds, localParts, norm, normMobile, parseCsv, parseDate, parseDateTime, toCsv } from "../src/lib/util";
import { buildSendPayload } from "../src/whatsapp/provider";
import { DEFAULT_TEMPLATES, paramNames, render, validateTemplateBody } from "../src/whatsapp/templates";

const bk = (id: string, outlet: string, ts: string): BookingRow => ({ id, booking_no: id, outlet_id: outlet, customer_name: id, customer_mobile: "919999999999", wa_opt_in: 1, model: "CRETA", variant: "SX", colour: "BLACK", priority_ts: ts, status: "APPROVED", on_hold: 0, hold_until: null });
const car = (id: string, outlet: string, status: "RECEIVED" | "IN_TRANSIT", extra: Partial<VehicleRow> = {}): VehicleRow => ({ id, vin: id, outlet_id: outlet, model: "CRETA", variant: "SX", colour: "BLACK", status, is_blocked: 0, expected_arrival_date: null, dispatch_date: null, wholesale_invoice_date: null, received_at: null, ever_allocated: 0, ...extra });
const rules = (outlet_scope: TenantSettings["outlet_scope"], extra: Partial<TenantSettings> = {}) => ({ ...DEFAULT_SETTINGS, outlet_scope, ...extra });
const pairs = (m: { booking: { id: string }; vehicle: { id: string } }[]) => m.map((x) => `${x.booking.id}>${x.vehicle.id}`).sort();

describe("matching bookings to cars", () => {
  const queue = [bk("B1", "P", "2026-10-01T05:00:00Z"), bk("B2", "P", "2026-10-02T05:00:00Z"), bk("B3", "C", "2026-10-03T05:00:00Z")];

  it("first booked, first served", () => {
    const m = matchBookings(queue, [car("V1", "P", "RECEIVED")], rules("SAME_OUTLET_FIRST"));
    expect(pairs(m)).toEqual(["B1>V1"]);
    expect(m[0].queuePosition).toBe(1);
  });

  it("a car at the dealership is used before one in transit, and the earliest arrival before a later one", () => {
    const cars = [car("LATE", "P", "IN_TRANSIT", { expected_arrival_date: "2026-11-20" }), car("SOON", "P", "IN_TRANSIT", { expected_arrival_date: "2026-11-02" }), car("YARD", "P", "RECEIVED")];
    expect(pairs(matchBookings(queue.slice(0, 2), cars, rules("SAME_OUTLET_FIRST")))).toEqual(["B1>YARD", "B2>SOON"]);
  });

  it("among cars in the yard the oldest wholesale invoice goes first", () => {
    const cars = [car("NEW", "P", "RECEIVED", { wholesale_invoice_date: "2026-09-20" }), car("OLD", "P", "RECEIVED", { wholesale_invoice_date: "2026-08-01" })];
    expect(pairs(matchBookings([queue[0]], cars, rules("SAME_OUTLET_FIRST")))).toEqual(["B1>OLD"]);
  });

  it("own outlet first: each outlet's car serves that outlet's queue; spare cars go to the most senior waiting customer elsewhere", () => {
    const cars = [car("PC", "P", "RECEIVED"), car("CC1", "C", "RECEIVED"), car("CC2", "C", "RECEIVED")];
    const m = matchBookings(queue, cars, rules("SAME_OUTLET_FIRST"));
    expect(pairs(m)).toEqual(["B1>PC", "B2>CC2", "B3>CC1"]);
    expect(m.find((x) => x.booking.id === "B2")!.pass).toBe("OTHER_OUTLET");
  });

  it("own outlet only: spare cars stay where they are", () => {
    const cars = [car("PC", "P", "RECEIVED"), car("CC1", "C", "RECEIVED"), car("CC2", "C", "RECEIVED")];
    expect(pairs(matchBookings(queue, cars, rules("SAME_OUTLET_ONLY")))).toEqual(["B1>PC", "B3>CC1"]);
  });

  it("whole dealership: one queue, preferring a car already at the customer's outlet", () => {
    const cars = [car("CC1", "C", "RECEIVED"), car("PC", "P", "RECEIVED")];
    expect(pairs(matchBookings(queue, cars, rules("ANY_OUTLET")))).toEqual(["B1>PC", "B2>CC1"]);
  });

  it("never gives one car to two bookings or two cars to one booking", () => {
    const many = Array.from({ length: 30 }, (_, i) => bk(`B${i}`, i % 2 ? "P" : "C", `2026-10-${String((i % 28) + 1).padStart(2, "0")}T05:00:00Z`));
    const cars = Array.from({ length: 17 }, (_, i) => car(`V${i}`, i % 3 ? "P" : "C", i % 2 ? "RECEIVED" : "IN_TRANSIT"));
    for (const scope of ["SAME_OUTLET_FIRST", "SAME_OUTLET_ONLY", "ANY_OUTLET"] as const) {
      const m = matchBookings(many, cars, rules(scope));
      expect(new Set(m.map((x) => x.booking.id)).size).toBe(m.length);
      expect(new Set(m.map((x) => x.vehicle.id)).size).toBe(m.length);
      if (scope !== "SAME_OUTLET_ONLY") expect(m).toHaveLength(17);
    }
  });
});

describe("the payment window counts calendar days at the dealership", () => {
  const ctx = (now: string) => ({ tenant: { timezone: "Asia/Kolkata" }, settings: DEFAULT_SETTINGS, now: new Date(now) }) as any;
  it("a car received late in the evening still counts that day as day 0", () => {
    // Received 15 Oct 23:30 IST = 18:00 UTC.
    const s = windowSchedule(ctx("2026-10-16T02:00:00Z"), "2026-10-15T18:00:00Z", 0);
    expect(s).toEqual({ day: 1, reminder_on: "2026-10-18", escalation_on: "2026-10-20", release_on: "2026-10-21" });
  });
  it("a car received just after midnight IST belongs to the new day although it is still the previous day in UTC", () => {
    const s = windowSchedule(ctx("2026-10-15T19:00:00Z"), "2026-10-15T18:45:00Z", 0); // 16 Oct 00:15 IST
    expect(s).toMatchObject({ day: 0, reminder_on: "2026-10-19", release_on: "2026-10-22" });
  });
  it("an extension shifts all three dates", () => {
    expect(windowSchedule(ctx("2026-10-16T02:00:00Z"), "2026-10-15T06:00:00Z", 2)).toMatchObject({ reminder_on: "2026-10-20", escalation_on: "2026-10-22", release_on: "2026-10-23" });
  });
  it("crosses a month end correctly", () => {
    expect(windowSchedule(ctx("2026-10-30T06:00:00Z"), "2026-10-29T06:00:00Z", 0)).toMatchObject({ reminder_on: "2026-11-01", escalation_on: "2026-11-03", release_on: "2026-11-04" });
  });
});

describe("reading dealer data", () => {
  it("reads dates the way Indian DMS exports write them", () => {
    expect(parseDate("2026-10-13")).toBe("2026-10-13");
    expect(parseDate("13/10/2026")).toBe("2026-10-13");
    expect(parseDate("13-10-2026")).toBe("2026-10-13");
    expect(parseDate("3.1.2026")).toBe("2026-01-03");
    expect(parseDate("13 Oct 2026")).toBe("2026-10-13");
    expect(parseDate("13-October-2026")).toBe("2026-10-13");
    expect(parseDate("31/02/2026")).toBeNull();
    expect(parseDate("soon")).toBeNull();
  });
  it("reads booking date-times as India time", () => {
    expect(parseDateTime("13/10/2026 10:30")).toBe("2026-10-13T05:00:00.000Z");
    expect(parseDateTime("2026-10-13 04:45 PM")).toBe("2026-10-13T11:15:00.000Z");
    expect(parseDateTime("2026-10-13")).toBe("2026-10-12T18:30:00.000Z");
    expect(parseDateTime("2026-10-13T05:00:00Z")).toBe("2026-10-13T05:00:00.000Z");
    expect(parseDateTime("2026-10-13T10:30:00+05:30")).toBe("2026-10-13T05:00:00.000Z");
    expect(parseDateTime("2026-10-13T10:30")).toBe("2026-10-13T05:00:00.000Z"); // no zone given: the dealership's local time
  });
  it("normalises mobile numbers to the form WhatsApp needs", () => {
    expect(normMobile("98765 43210")).toBe("919876543210");
    expect(normMobile("+91-98765-43210")).toBe("919876543210");
    expect(normMobile("09876543210")).toBe("919876543210");
    expect(normMobile("0091 9876543210")).toBe("919876543210");
    expect(normMobile("12345")).toBeNull();
    expect(normMobile("")).toBeNull();
  });
  it("matches model, variant and colour regardless of case and spacing", () => {
    expect(norm("  Creta   sx(o)  ")).toBe("CRETA SX(O)");
  });
  it("reads CSV with quotes, commas inside fields, blank lines and a BOM", () => {
    const rows = parseCsv('﻿vin,model,variant\r\n"V1","Creta","SX(O), Dual Tone"\r\n\r\nV2,Venue,"S ""Plus"""\n');
    expect(rows).toEqual([["vin", "model", "variant"], ["V1", "Creta", "SX(O), Dual Tone"], ["V2", "Venue", 'S "Plus"']]);
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
  it("knows where a local day starts and ends", () => {
    expect(localDayBounds("2026-10-13", "Asia/Kolkata")).toEqual({ start: "2026-10-12T18:30:00.000Z", end: "2026-10-13T18:30:00.000Z" });
    expect(localParts(new Date("2026-10-12T18:29:00Z"), "Asia/Kolkata")).toEqual({ date: "2026-10-12", time: "23:59" });
    expect(localParts(new Date("2026-10-12T18:30:00Z"), "Asia/Kolkata")).toEqual({ date: "2026-10-13", time: "00:00" });
  });
});

describe("settings and templates", () => {
  it("keeps the three days in order", () => {
    expect(() => mergeSettings(DEFAULT_SETTINGS, { reminder_days: 6 })).toThrow(/increase/);
    expect(mergeSettings(DEFAULT_SETTINGS, { reminder_days: 2, escalation_days: 3, reallocate_days: 4 })).toMatchObject({ reminder_days: 2, escalation_days: 3, reallocate_days: 4 });
  });
  it("renders named parameters and builds the Cloud API payload in template order", () => {
    const body = "Dear {{customer_name}}, your {{vehicle}} is ready. Thank you.";
    expect(paramNames(body)).toEqual(["customer_name", "vehicle"]);
    expect(render(body, { customer_name: "Rahul", vehicle: "Creta" })).toBe("Dear Rahul, your Creta is ready. Thank you.");
    expect(buildSendPayload({ to: "919876543210", templateName: "t", language: "en", params: { vehicle: "Creta", customer_name: "Rahul" }, paramOrder: ["customer_name", "vehicle"] })).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "919876543210",
      type: "template",
      template: { name: "t", language: { code: "en" }, components: [{ type: "body", parameters: [{ type: "text", parameter_name: "customer_name", text: "Rahul" }, { type: "text", parameter_name: "vehicle", text: "Creta" }] }] },
    });
  });
  it("every default message passes the wording rules it is checked against when edited", () => {
    for (const t of DEFAULT_TEMPLATES) {
      // The one-time code is the exception: it is an authentication template, whose wording WhatsApp fixes (it starts
      // with the code) and which therefore cannot be edited, so the rules for editable wording are not applied to it.
      if (t.category !== "AUTHENTICATION") expect(validateTemplateBody(t.body), t.event_key).toBeNull();
      expect(paramNames(t.body).filter((p) => !(p in t.examples)), t.event_key).toEqual([]);
    }
    const fixed = DEFAULT_TEMPLATES.filter((t) => t.category === "AUTHENTICATION");
    expect(fixed.map((t) => t.event_key)).toEqual(["PASSWORD_OTP"]);
    expect(paramNames(fixed[0].body)).toEqual(["code"]);
    expect(validateTemplateBody(fixed[0].body)).toMatch(/start or end/); // which is why it is exempt, not because the check was loosened
  });
  it("applies Meta's rules to template wording", () => {
    expect(validateTemplateBody("Dear {{customer_name}}, hello.")).toBeNull();
    expect(validateTemplateBody("{{customer_name}} hello.")).toMatch(/start or end/);
    expect(validateTemplateBody("Hello {{customer_name}}{{vehicle}} there.")).toMatch(/next to each other/);
    expect(validateTemplateBody("Hello {{1}} there.")).toMatch(/lowercase names/);
    expect(validateTemplateBody("")).toMatch(/required/);
  });
});
