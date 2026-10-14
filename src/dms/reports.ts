// The two DMS exports the dealership uploads every day (or every few days), read into typed rows.
//
//   Stock report   one row per car (VIN): where it is, what it is, and whether the DMS has it allotted.
//   Booking sheet  one row per booking: the customer, the car booked and the booking's stage.
//
// Reading is separate from applying: nothing here touches the database, so the rules that turn a row
// into facts can be tested on their own. The facts follow the dealership's own inventory rules:
//   - Stock Type "Unalloted" = unallocated; "Alloted" and "IBND" = allocated (IBND also carries the
//     retail invoice: invoiced, not yet delivered).
//   - Vehicle Status "Received" / "In Transit" is where the car is; it says nothing about allocation.
//   - Stock.Order ID = Booking.DMS Booking Number is the only link between a car and a booking.
//   - What a description or column does not state stays blank.

import { MODEL_ALIASES, fuelFromDms, oemModelCodeOf, parseDescription, parseText } from "../oem/mahindra";
import { serialToDate, serialToLocalDateTime, tableWith, type Sheet } from "../lib/xlsx";
import { bad, localDayBounds, norm, normMobile, parseDate, parseDateTime } from "../lib/util";

export interface RowError {
  row: number;
  key: string;
  message: string;
}

/** The car a stock row or a booking names, in the terms the rest of the system uses. */
export interface DmsCar {
  /** Model family, e.g. "XUV 3XO". */
  model: string;
  /** The name bookings and cars are matched by: the OEM variant with its OEM model code, e.g. "AX5 PM MT (M1024)". */
  variant: string;
  /** The OEM variant name on its own, e.g. "AX5 PM MT". */
  variant_text: string;
  trim: string;
  transmission: string;
  fuel: string;
  drive: string;
  /** As the DMS gives it ("5", "7SF", "7CC"); from the description when the column is empty. */
  seater: string;
  oem_model_code: string;
  paint_alias: string;
  /** Description text without the bracketed codes. */
  text: string;
  /** False when the description did not follow a known pattern: the row is loaded on the DMS's own model column and flagged. */
  parsed: boolean;
}

export interface StockRow extends DmsCar {
  row: number;
  vin: string;
  dealer_name: string;
  outlet_code: string;
  outlet_name: string;
  description: string;
  category: string;
  /** Colour name exactly as the report gives it, in capitals. */
  dms_colour: string;
  oem_colour_code: string;
  oem_invoice_no: string | null;
  oem_invoice_date: string | null;
  net_dealer_price: number | null;
  engine_no: string | null;
  grn_no: string | null;
  /** When the car was received (GRN), as an instant. */
  grn_at: string | null;
  is_demo: boolean;
  status: "RECEIVED" | "IN_TRANSIT";
  stock_type: "UNALLOTED" | "ALLOTED" | "IBND";
  order_id: string | null;
  order_date: string | null;
  customer_name: string | null;
  sc_name: string | null;
  allotment_id: string | null;
  allotment_date: string | null;
  invoice_id: string | null;
  invoice_date: string | null;
  /** Data points in the row that disagree with each other; reported, never corrected. */
  issues: string[];
}

export interface StockReport {
  sheet: string;
  dealer_name: string;
  rows: StockRow[];
  errors: RowError[];
  /** Lines in the sheet that are not cars (the "Applied filters" footer). */
  ignored: number;
}

export const STOCK_ISSUES: Record<string, string> = {
  description_not_recognised: "Model Description not in a known pattern",
  seat_conflict: "Seating column and description disagree",
  unallocated_but_linked: "Unalloted, yet carries an order, allotment or invoice",
  allocated_without_order_id: "Alloted or IBND without an Order ID",
  ibnd_without_invoice: "IBND without a retail invoice",
  received_without_grn: "Received without a GRN date",
  transit_with_grn: "In Transit, yet has a GRN date",
  future_wholesale_date: "OEM invoice date after the report date",
  future_grn_date: "GRN date after the report date",
  grn_before_wholesale: "GRN date before the OEM invoice date",
  source_ageing_mismatch: "Ageing column differs from days since OEM invoice",
};

const text = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();
const orNull = (v: unknown) => text(v) || null;

/** A date cell: an Excel day number, or text in one of the DMS's formats. */
export function cellDate(v: unknown): string | null {
  const s = text(v);
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return serialToDate(Math.floor(Number(s)));
  return parseDate(s);
}

/** A date-and-time cell -> an instant, reading the cell as local time at the dealership. */
export function cellInstant(v: unknown, timeZone: string): string | null {
  const s = text(v);
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const local = serialToLocalDateTime(Number(s));
    return local ? parseDateTime(local, timeZone) : null;
  }
  return parseDateTime(s, timeZone);
}

/** The car named by a description text, with the DMS's own columns filling what the text does not state. */
function carFrom(p: ReturnType<typeof parseText>, oemModelCode: string, dms: { model: string; seating: string; fuel: string }): DmsCar {
  const parsed = p.parse_status !== "REVIEW";
  const model = parsed ? p.model : MODEL_ALIASES[norm(dms.model)] ?? norm(dms.model);
  const variantText = parsed ? p.variant : norm(p.text || p.raw_description);
  return {
    model,
    variant: oemModelCode ? `${variantText} (${oemModelCode})` : variantText,
    variant_text: variantText,
    trim: p.trim,
    transmission: p.transmission,
    fuel: p.fuel || dms.fuel,
    drive: p.drive,
    seater: norm(dms.seating) || (p.seater === "" ? "" : String(p.seater)),
    oem_model_code: oemModelCode,
    paint_alias: p.paint_alias,
    text: p.text || norm(p.raw_description),
    parsed,
  };
}

const STOCK_TYPES: Record<string, StockRow["stock_type"]> = { UNALLOTED: "UNALLOTED", UNALLOTTED: "UNALLOTED", ALLOTED: "ALLOTED", ALLOTTED: "ALLOTED", IBND: "IBND" };
const VEHICLE_STATUS: Record<string, StockRow["status"]> = { RECEIVED: "RECEIVED", "IN TRANSIT": "IN_TRANSIT", INTRANSIT: "IN_TRANSIT", "IN-TRANSIT": "IN_TRANSIT" };

export const STOCK_HEADINGS = ["VIN", "Model Description", "Stock Type", "Vehicle Status", "Dealer Location Code"];
export const BOOKING_HEADINGS = ["DMS Booking Number", "Booking Stage", "Created Date", "Model Description", "Model Code", "Location Code", "Customer Name"];

/** Reads a stock report. `asOf` is the date the report describes (YYYY-MM-DD), used only for the date checks. */
export function readStockReport(sheets: Sheet[], opts: { timeZone: string; asOf: string }): StockReport {
  const t = tableWith(sheets, STOCK_HEADINGS);
  if (!t) {
    if (tableWith(sheets, ["DMS Booking Number", "Booking Stage"])) throw bad("This looks like the booking sheet, not the stock report. Upload it under Booking sheet.");
    throw bad(`This is not the DMS stock report: no sheet has the headings ${STOCK_HEADINGS.join(", ")}`);
  }
  const out: StockReport = { sheet: t.sheet, dealer_name: "", rows: [], errors: [], ignored: 0 };
  const seen = new Set<string>();
  for (const r of t.records) {
    const row = Number(r._row);
    const vin = norm(r["vin"]);
    if (!vin) {
      // The export ends with an "Applied filters: ..." line; anything else without a VIN is reported.
      if (!text(r["model description"]) && !text(r["stock type"])) out.ignored++;
      else out.errors.push({ row, key: "(no VIN)", message: "VIN is blank" });
      continue;
    }
    const fail = (message: string) => out.errors.push({ row, key: vin, message });
    if (seen.has(vin)) { fail("VIN appears more than once in the report; only the first row was used"); continue; }
    const stockType = STOCK_TYPES[norm(r["stock type"])];
    if (!stockType) { fail(`Stock Type "${text(r["stock type"])}" is not recognised (expected Unalloted, Alloted or IBND)`); continue; }
    const status = VEHICLE_STATUS[norm(r["vehicle status"])];
    if (!status) { fail(`Vehicle Status "${text(r["vehicle status"])}" is not recognised (expected Received or In Transit)`); continue; }
    const outletCode = norm(r["dealer location code"]);
    if (!outletCode) { fail("Dealer Location Code is blank"); continue; }
    const description = text(r["model description"]);
    if (!description) { fail("Model Description is blank"); continue; }
    seen.add(vin);

    const p = parseDescription(description, { colour: r["color"], seating: r["seating"] });
    const electric = norm(r["emission"]) === "ELECTRIC";
    const car = carFrom(p, p.oem_model_code, { model: r["model"] ?? "", seating: r["seating"] ?? "", fuel: electric ? "Electric" : "" });
    const issues: string[] = [];
    if (!car.parsed) issues.push("description_not_recognised");
    const seatCol = /^\d+/.exec(norm(r["seating"]))?.[0];
    if (seatCol && p.seat_source === "Description" && String(p.seater) !== seatCol) issues.push("seat_conflict");

    const oemInvoiceDate = cellDate(r["oem invoice date"]);
    const grnAt = cellInstant(r["grn date"], opts.timeZone);
    const grnDate = cellDate(r["grn date"]);
    const orderId = norm(r["order id"]) || null;
    const allotmentId = orNull(r["allotment id"]);
    const allotmentDate = cellDate(r["allotment date"]);
    const invoiceId = orNull(r["invoice id"]);
    const invoiceDate = cellDate(r["invoice date"]);
    if (stockType === "UNALLOTED" && (orderId || allotmentId || allotmentDate || invoiceId)) issues.push("unallocated_but_linked");
    if (stockType !== "UNALLOTED" && !orderId) issues.push("allocated_without_order_id");
    if (stockType === "IBND" && !invoiceId) issues.push("ibnd_without_invoice");
    if (status === "RECEIVED" && !grnDate) issues.push("received_without_grn");
    if (status === "IN_TRANSIT" && grnDate) issues.push("transit_with_grn");
    if (oemInvoiceDate && oemInvoiceDate > opts.asOf) issues.push("future_wholesale_date");
    if (grnDate && grnDate > opts.asOf) issues.push("future_grn_date");
    if (grnDate && oemInvoiceDate && grnDate < oemInvoiceDate) issues.push("grn_before_wholesale");
    const ageing = /^\d+$/.test(text(r["ageing"])) ? Number(text(r["ageing"])) : null;
    if (ageing !== null && oemInvoiceDate) {
      const days = Math.round((Date.parse(`${opts.asOf}T00:00:00Z`) - Date.parse(`${oemInvoiceDate}T00:00:00Z`)) / 86_400_000);
      if (days !== ageing) issues.push("source_ageing_mismatch");
    }
    const price = Number(text(r["net dealer price"]));

    if (!out.dealer_name) out.dealer_name = text(r["dealer name"]);
    out.rows.push({
      ...car,
      row,
      vin,
      dealer_name: text(r["dealer name"]),
      outlet_code: outletCode,
      outlet_name: text(r["dealer location name"]) || outletCode,
      description,
      category: norm(r["segment code"]),
      dms_colour: norm(r["color"]) || norm(p.colour),
      oem_colour_code: p.oem_colour_code,
      oem_invoice_no: orNull(r["oem invoice number"]),
      oem_invoice_date: oemInvoiceDate,
      net_dealer_price: text(r["net dealer price"]) && Number.isFinite(price) && price > 0 ? Math.round(price * 100) / 100 : null,
      engine_no: orNull(r["engine number"]),
      grn_no: orNull(r["grn no."]),
      grn_at: grnAt,
      is_demo: norm(r["demo vehicle"]) === "YES",
      status,
      stock_type: stockType,
      order_id: orderId,
      order_date: cellDate(r["order date"]),
      customer_name: orNull(r["customer name"]),
      sc_name: orNull(r["sc name"]),
      allotment_id: allotmentId,
      allotment_date: allotmentDate,
      invoice_id: invoiceId,
      invoice_date: invoiceDate,
      issues,
    });
  }
  if (!out.rows.length) throw bad("The stock report has no cars in it");
  return out;
}

export type BookingStage = "BOOKED" | "INVOICED" | "DELIVERED" | "CANCELLED";

export interface BookingSheetRow extends DmsCar {
  row: number;
  /** DMS Booking Number (OTF...): the booking's identity, and what a stock row's Order ID refers to. */
  booking_no: string;
  /** The dealer-side Booking Number (B-...). */
  dms_ref: string | null;
  enquiry_no: string | null;
  dealer_name: string;
  outlet_code: string;
  outlet_name: string;
  stage: BookingStage;
  dms_stage: string;
  dms_enquiry_stage: string;
  /** When the booking was created in the DMS, as an instant: its place in the queue. */
  booking_date: string;
  customer_name: string;
  customer_mobile: string | null;
  booking_amount: number;
  description: string;
  /** Colour name as the booking sheet gives it, in capitals. */
  dms_colour: string;
  sc_name: string | null;
  sc_code: string | null;
  sm_name: string | null;
}

export interface BookingSheet {
  sheet: string;
  dealer_name: string;
  rows: BookingSheetRow[];
  errors: RowError[];
}

function stageOf(bookingStage: string, enquiryStage: string): BookingStage | null {
  const s = norm(bookingStage);
  if (s.includes("CANCEL")) return "CANCELLED";
  if (s === "BOOKED") return "BOOKED";
  if (s === "INVOICED") return norm(enquiryStage) === "DELIVERED" ? "DELIVERED" : "INVOICED";
  return null;
}

export function readBookingSheet(sheets: Sheet[], opts: { timeZone: string }): BookingSheet {
  const t = tableWith(sheets, BOOKING_HEADINGS);
  if (!t) {
    if (tableWith(sheets, ["VIN", "Stock Type"])) throw bad("This looks like the stock report, not the booking sheet. Upload it under Stock report.");
    throw bad(`This is not the DMS booking sheet: no sheet has the headings ${BOOKING_HEADINGS.join(", ")}`);
  }
  const out: BookingSheet = { sheet: t.sheet, dealer_name: "", rows: [], errors: [] };
  const seen = new Set<string>();
  for (const r of t.records) {
    const row = Number(r._row);
    const bookingNo = norm(r["dms booking number"]);
    if (!bookingNo) {
      if (text(r["booking number"]) || text(r["customer name"])) out.errors.push({ row, key: "(no number)", message: "DMS Booking Number is blank" });
      continue;
    }
    const fail = (message: string) => out.errors.push({ row, key: bookingNo, message });
    if (seen.has(bookingNo)) { fail("DMS Booking Number appears more than once in the sheet; only the first row was used"); continue; }
    const stage = stageOf(r["booking stage"] ?? "", r["enquiry stage"] ?? "");
    if (!stage) { fail(`Booking Stage "${text(r["booking stage"])}" is not recognised (expected Booked, Invoiced or Cancellation Initiated)`); continue; }
    const outletCode = norm(r["location code"]);
    if (!outletCode) { fail("Location Code is blank"); continue; }
    const bookingDate = cellInstant(r["created date"], opts.timeZone);
    if (!bookingDate) { fail(`Created Date "${text(r["created date"])}" is not a date`); continue; }
    const description = text(r["model description"]);
    if (!description) { fail("Model Description is blank"); continue; }
    const customer = text(r["customer name"]);
    if (!customer) { fail("Customer Name is blank"); continue; }
    seen.add(bookingNo);

    const p = parseText(description);
    const car = carFrom(p, oemModelCodeOf(r["model code"]), { model: r["product family"] ?? "", seating: r["seating capacity"] ?? "", fuel: fuelFromDms(r["fuel type"]) });
    const amount = Number(text(r["booking amount"]).replace(/[,₹\s]/g, ""));
    if (!out.dealer_name) out.dealer_name = text(r["dealer name"]);
    out.rows.push({
      ...car,
      row,
      booking_no: bookingNo,
      dms_ref: orNull(r["booking number"]),
      enquiry_no: orNull(r["enquiry number"]),
      dealer_name: text(r["dealer name"]),
      outlet_code: outletCode,
      outlet_name: text(r["dealer location"]) || outletCode,
      stage,
      dms_stage: text(r["booking stage"]),
      dms_enquiry_stage: text(r["enquiry stage"]),
      booking_date: bookingDate,
      customer_name: customer.slice(0, 120),
      customer_mobile: normMobile(r["customer mobile phone"]),
      booking_amount: Number.isFinite(amount) && amount > 0 ? amount : 0,
      description,
      dms_colour: norm(r["color"]),
      sc_name: orNull(r["sales consultant"]),
      sc_code: norm(r["sc mile id"]) || null,
      sm_name: orNull(r["sales manager"]),
    });
  }
  if (!out.rows.length) throw bad("The booking sheet has no bookings in it");
  return out;
}

/** "stock report as on 05.10.2026.xlsx" -> 2026-10-05. Null when the file name carries no date. */
export function dateInFilename(filename: string | undefined): string | null {
  const m = /(\d{1,2})[.\-_](\d{1,2})[.\-_](\d{4})/.exec(filename ?? "");
  return m ? parseDate(`${m[1]}-${m[2]}-${m[3]}`) : null;
}

/** Noon, local time, of a report date: the moment used for "as on" facts that carry only a date. */
export function reportInstant(date: string, timeZone: string): string {
  return new Date(new Date(localDayBounds(date, timeZone).start).getTime() + 12 * 3_600_000).toISOString();
}
