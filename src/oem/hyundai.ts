// Hyundai: reading the dealership's three DMS exports into the same rows the Mahindra reader gives.
//
// Written from a dealership's real exports (booking report, stock report, retail report). What these
// files say, and what they do not, decides how they are read:
//
//   Booking   one row per enquiry that reached booking. Keyed by Enquiry No. Model and variant carry
//             their HMIL codes in brackets: "New Venue(1Q)", "VENUE 1.2 Kappa MT HX 4(6366)".
//             There is no colour column and no outlet column.
//   Stock     one row per car (Vin Number). The variant code has a column of its own. The car is at
//             the dealership when Stock Location says Showroom; until then it is on its way. A car
//             the DMS has allotted carries the booking in Bkng No. There is no outlet column.
//   Retail    one row per invoice. The VIN is masked; the car is identified by the HMI invoice number
//             (the wholesale invoice the stock report also carries) and the customer by CustomerID,
//             which is the booking report's Cust. No. Invoice numbers are per dealer code, so two dealer
//             codes in one file can repeat a number: the invoice is keyed by dealer code and number.
//
// None of the three names an outlet in a form the others share, so a Hyundai dealership is worked as
// one outlet; the importer puts every row on it. What a file does not state stays blank.

import type { Sheet } from "../lib/xlsx";
import { tableWith } from "../lib/xlsx";
import { bad, norm, normMobile } from "../lib/util";
import { cellDate, cellInstant, cellMoney, type BookingSheet, type BookingSheetRow, type BookingStage, type DmsCar, type RetailReport, type StockReport } from "../dms/reports";

const text = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();
const orNull = (v: unknown) => text(v) || null;

export const HY_STOCK_HEADINGS = ["Vin Number", "Variant Code", "Variant", "Model", "Stock Location", "HMI Invoice No"];
export const HY_BOOKING_HEADINGS = ["Enquiry No", "Booking Date", "Enquiry Status", "Model", "Variant", "Cust. No"];
export const HY_RETAIL_HEADINGS = ["Invoice No", "Dealer Code", "HMI Invoice No", "Vin Number", "CustomerID"];

/** "New Venue(1Q)" -> { text: "New Venue", code: "1Q" }. A value with no bracketed code is all text. */
export function splitCode(raw: unknown): { text: string; code: string } {
  const s = text(raw);
  const m = /^(.*?)\s*\(([A-Za-z0-9]+)\)\s*$/.exec(s);
  return m ? { text: m[1].trim(), code: m[2].toUpperCase() } : { text: s, code: "" };
}

/** Gearbox as the variant name writes it: "1.2 Kappa MT HX 4" -> MT. Blank when it says none. */
function transmissionOf(variant: string): string {
  const m = /\b(AMT|IVT|DCT|IMT|MT|AT)\b/i.exec(variant);
  return m ? m[1].toUpperCase() : "";
}

function fuelOf(raw: unknown): string {
  const f = norm(raw);
  if (f.includes("ELECTRIC") || f === "EV") return "Electric";
  if (f.includes("DIESEL")) return "Diesel";
  if (f.includes("CNG")) return "CNG";
  if (f.includes("PETROL")) return "Petrol";
  return "";
}

/** The car as the rest of the system names it. The variant code is the key, written after the name. */
function car(model: string, variantText: string, variantCode: string, fuel = ""): DmsCar {
  return {
    model,
    variant: variantCode ? `${variantText} (${variantCode})` : variantText,
    variant_text: variantText,
    trim: "",
    transmission: transmissionOf(variantText),
    fuel,
    drive: "",
    seater: "",
    oem_model_code: variantCode,
    paint_alias: "",
    text: variantText,
    parsed: Boolean(variantCode),
  };
}

/** Which of the other two Hyundai files this is, for a plain message when it was put in the wrong place. */
function whichFile(sheets: Sheet[]): string | null {
  if (tableWith(sheets, HY_STOCK_HEADINGS)) return "the stock report";
  if (tableWith(sheets, HY_BOOKING_HEADINGS)) return "the booking report";
  if (tableWith(sheets, HY_RETAIL_HEADINGS)) return "the retail report";
  return null;
}

function notThis(sheets: Sheet[], what: string, headings: string[]): never {
  const other = whichFile(sheets);
  if (other) throw bad(`This looks like ${other}, not the ${what}. Upload it in its own place.`);
  // An export with nothing in it comes out as a heading row of one column, or nothing at all.
  const cells = sheets.reduce((n, s) => n + s.rows.reduce((m, r) => m + r.filter((c) => c.trim()).length, 0), 0);
  if (cells <= 2) throw bad(`This file is empty: it has no rows. Export the ${what} from the DMS again.`);
  throw bad(`This is not the Hyundai DMS ${what}: no sheet has the headings ${headings.join(", ")}`);
}

// ---------------------------------------------------------------- stock

export function readStockReport(sheets: Sheet[], opts: { timeZone: string; asOf: string }): StockReport {
  const t = tableWith(sheets, HY_STOCK_HEADINGS);
  if (!t) notThis(sheets, "stock report", HY_STOCK_HEADINGS);
  const out: StockReport = { sheet: t.sheet, dealer_name: "", rows: [], errors: [], ignored: 0 };
  const seen = new Set<string>();
  for (const r of t.records) {
    const row = Number(r._row);
    const vin = norm(r["vin number"]);
    if (!vin) {
      if (!text(r["variant"]) && !text(r["model"])) out.ignored++;
      else out.errors.push({ row, key: "(no VIN)", message: "Vin Number is blank" });
      continue;
    }
    const fail = (message: string) => out.errors.push({ row, key: vin, message });
    if (seen.has(vin)) { fail("Vin Number appears more than once in the report; only the first row was used"); continue; }
    const model = text(r["model"]);
    const variantText = text(r["variant"]);
    if (!model || !variantText) { fail("Model or Variant is blank"); continue; }
    seen.add(vin);

    const c = car(model, variantText, norm(r["variant code"]), fuelOf(r["fuel type"]));
    const issues: string[] = [];
    if (!c.parsed) issues.push("description_not_recognised");
    // The car is at the dealership once the stock report places it in the showroom. "In Out Status"
    // says In Transit for every car in the export, so it cannot be what tells the two apart.
    const status = norm(r["stock location"]) === "SHOWROOM" ? "RECEIVED" : "IN_TRANSIT";
    const oemInvoiceDate = cellDate(r["hmi invoice date"]);
    if (oemInvoiceDate && oemInvoiceDate > opts.asOf) issues.push("future_wholesale_date");
    const bookingNo = norm(r["bkng no"]) || null;
    const ageing = /^\d+$/.test(text(r["stock age"])) ? Number(text(r["stock age"])) : null;
    if (ageing !== null && oemInvoiceDate) {
      const days = Math.round((Date.parse(`${opts.asOf}T00:00:00Z`) - Date.parse(`${oemInvoiceDate}T00:00:00Z`)) / 86_400_000);
      if (days !== ageing) issues.push("source_ageing_mismatch");
    }

    out.rows.push({
      ...c,
      row,
      vin,
      dealer_name: "",
      // The file names no outlet. The importer puts the car on the dealership's outlet.
      outlet_code: "",
      outlet_name: "",
      description: c.variant,
      category: "",
      dms_colour: norm(r["exterior color name"]),
      oem_colour_code: norm(r["exterior color code"]),
      oem_invoice_no: orNull(r["hmi invoice no"]),
      oem_invoice_date: oemInvoiceDate,
      // HMIL's invoice amount includes tax, so it is not the dealer's net price; nothing is read for that.
      net_dealer_price: null,
      engine_no: orNull(r["engine no"]),
      grn_no: orNull(r["grn no"]),
      grn_at: null,
      is_demo: false,
      status,
      stock_type: bookingNo ? "ALLOTED" : "UNALLOTED",
      order_id: bookingNo,
      order_date: null,
      customer_name: orNull(r["cust name"]),
      sc_name: null,
      allotment_id: null,
      allotment_date: null,
      invoice_id: null,
      invoice_date: null,
      issues,
    });
  }
  if (!out.rows.length) throw bad("The stock report has no cars in it");
  return out;
}

// ---------------------------------------------------------------- bookings

function stageOf(status: string): BookingStage | null {
  const s = norm(status);
  if (s === "BOOKED") return "BOOKED";
  // "Retail" is the report's last stage: the car has been invoiced to the customer. Whether it has
  // also been handed over the report does not say (the retail report shows some not yet delivered),
  // so the booking is invoiced; it is not called delivered on this file's word.
  if (s === "RETAIL" || s === "RETAILED" || s === "INVOICED") return "INVOICED";
  if (s.includes("CANCEL") || s === "LOST" || s === "CLOSED") return "CANCELLED";
  return null;
}

export function readBookingSheet(sheets: Sheet[], opts: { timeZone: string }): BookingSheet {
  const t = tableWith(sheets, HY_BOOKING_HEADINGS);
  if (!t) notThis(sheets, "booking report", HY_BOOKING_HEADINGS);
  // Read a colour if the export ever carries one; this one does not.
  const colourKey = ["color", "colour", "exterior color", "exterior color name"].find((k) => t.header.some((h) => h.toLowerCase() === k)) ?? null;
  const out: BookingSheet = { sheet: t.sheet, dealer_name: "", rows: [], errors: [], layout: "Hyundai booking report", outlet_by: "code", has_mobile: true, has_colour: Boolean(colourKey) };
  const seen = new Set<string>();
  for (const r of t.records) {
    const row = Number(r._row);
    const bookingNo = norm(r["enquiry no"]);
    if (!bookingNo) {
      if (text(r["cust. no"]) || text(r["customer name"])) out.errors.push({ row, key: "(no number)", message: "Enquiry No is blank" });
      continue;
    }
    const fail = (message: string) => out.errors.push({ row, key: bookingNo, message });
    if (seen.has(bookingNo)) { fail("Enquiry No appears more than once in the report; only the first row was used"); continue; }
    const stage = stageOf(r["enquiry status"]);
    if (!stage) { fail(`Enquiry Status "${text(r["enquiry status"])}" is not recognised (expected Booked or Retail)`); continue; }
    const bookingDate = cellInstant(r["booking date"], opts.timeZone);
    if (!bookingDate) { fail(`Booking Date "${text(r["booking date"])}" is not a date`); continue; }
    const model = splitCode(r["model"]).text;
    const variant = splitCode(r["variant"]);
    if (!model || !variant.text) { fail("Model or Variant is blank"); continue; }
    const customer = text(r["customer name"]);
    if (!customer) { fail("Customer Name is blank"); continue; }
    seen.add(bookingNo);

    const c = car(model, variant.text, variant.code);
    if (!out.dealer_name) out.dealer_name = text(r["dealer"]);
    const row_: BookingSheetRow = {
      ...c,
      row,
      booking_no: bookingNo,
      dms_ref: orNull(r["order ref no"]),
      enquiry_no: bookingNo,
      dealer_name: text(r["dealer"]),
      outlet_code: "",
      outlet_name: "",
      stage,
      dms_stage: text(r["enquiry status"]),
      dms_enquiry_stage: text(r["enquiry category"]),
      booking_date: bookingDate,
      customer_name: customer.slice(0, 120),
      customer_mobile: normMobile(r["phone no"]),
      booking_amount: 0,
      description: text(r["variant"]),
      dms_colour: colourKey ? norm(r[colourKey]) : "",
      sc_name: orNull(r["cs name"]),
      sc_code: null,
      sm_name: null,
      customer_no: norm(r["cust. no"]) || null,
    };
    out.rows.push(row_);
  }
  if (!out.rows.length) throw bad("The booking report has no bookings in it");
  return out;
}

// ---------------------------------------------------------------- retail

export function readRetailReport(sheets: Sheet[], opts: { timeZone: string; asOf: string }): RetailReport {
  const t = tableWith(sheets, HY_RETAIL_HEADINGS);
  if (!t) notThis(sheets, "retail report", HY_RETAIL_HEADINGS);
  const out: RetailReport = { sheet: t.sheet, dealer_name: "", rows: [], errors: [], ignored: 0, claims_not_stated: [] };
  const seen = new Set<string>();
  for (const r of t.records) {
    const row = Number(r._row);
    const number = norm(r["invoice no"]);
    const dealerCode = norm(r["dealer code"]);
    if (!number) {
      if (!text(r["hmi invoice no"]) && !text(r["customerid"])) out.ignored++;
      else out.errors.push({ row, key: "(no invoice number)", message: "Invoice No is blank" });
      continue;
    }
    // Each dealer code has its own invoice series, so the number alone can repeat within one file.
    const invoiceNo = dealerCode ? `${dealerCode}/${number}` : number;
    const fail = (message: string) => out.errors.push({ row, key: invoiceNo, message });
    if (seen.has(invoiceNo)) { fail("Invoice No appears more than once for this dealer code; only the first row was used"); continue; }
    seen.add(invoiceNo);

    const rawVin = norm(r["vin number"]);
    const masked = rawVin.includes("*");
    const invoiceDate = cellDate(r["invoice date"]);
    const customerNo = norm(r["customerid"]) || null;
    const purchase = norm(r["mode of purchase"]);
    const tax = ["cgst amount", "sgst amount", "igst amount", "comp cess amount"].map((k) => cellMoney(r[k]));
    const issues: string[] = [];
    if (!rawVin && !text(r["hmi invoice no"])) issues.push("no_vin");
    if (!norm(r["order ref no"]) && !customerNo) issues.push("no_booking");
    if (cellMoney(r["invoice price"]) === null) issues.push("amount_missing");
    if (invoiceDate && invoiceDate > opts.asOf) issues.push("invoice_after_report");

    out.rows.push({
      row,
      invoice_no: invoiceNo,
      invoice_at: cellInstant(r["invoice date"], opts.timeZone),
      invoice_date: invoiceDate,
      status: text(r["status"]) || "Invoiced",
      outlet_code: "",
      outlet_name: "",
      // The export masks the VIN. The car is found by its HMI invoice number instead.
      vin: masked ? "" : rawVin,
      chassis_no: masked ? rawVin : "",
      booking_no: norm(r["order ref no"]),
      allotment_id: null,
      oem_model_code: "",
      model: text(r["model"]),
      variant: text(r["variant"]),
      colour: text(r["color"]),
      customer_name: text(r["registration name"]),
      customer_type: "",
      customer_gstin: orNull(r["customer gst no"]),
      sc_name: orNull(r["consultant name"]),
      invoice_amount: cellMoney(r["invoice price"]),
      selling_price: cellMoney(r["basic amount"]),
      gst_amount: tax.some((x) => x !== null) ? tax.reduce<number>((a, x) => a + (x ?? 0), 0) : null,
      tcs_amount: null,
      dealer_discount: cellMoney(r["dealer cash discount"]),
      // "Other Discount" does not say who gives it, so it is not put down as anybody's.
      oem_scheme_discount: null,
      loyalty_discount: null,
      exchange_discount: null,
      corporate_discount: null,
      bndp_credit_note: null,
      loyalty_credit_note: null,
      exchange_credit_note: null,
      // A financier is named on cash sales too (the DSA), so it is taken only when the purchase was not cash.
      financier: purchase && purchase !== "CASH" ? orNull(r["dsa/financier"]) : null,
      finance_arranged_by: null,
      finance_amount: null,
      insurer: null,
      insurance_amount: null,
      exchange_indicator: null,
      delivery_note_no: null,
      delivery_note_date: cellDate(r["delivery date"]),
      irn_at: null,
      unclaimed: 0,
      issues,
      oem_invoice_no: norm(r["hmi invoice no"]) || null,
      customer_no: customerNo,
    });
  }
  return out;
}
