// One deployment serves dealerships of different manufacturers, and each manufacturer's DMS exports its
// stock report and booking sheet in its own layout, with its own way of describing a car. Everything
// that depends on that is behind one adapter per manufacturer, chosen by the dealership's OEM. The rest
// of the system (queue, allocation, payment window, reconciliation, screens) is the same for all.
//
// Adapters in this version: Mahindra. A dealership of another manufacturer can be onboarded and worked
// from the screens, but its DMS files are refused with a plain message until its adapter is written from
// real exports. Nothing is guessed from an unknown layout.

import type { Sheet } from "../lib/xlsx";
import { readBookingSheet as mahindraBookingSheet, readStockReport as mahindraStockReport, type BookingSheet, type StockReport } from "../dms/reports";

export interface OemAdapter {
  key: string;
  label: string;
  /** What the dealership's files look like, for the upload screen. */
  stock_file: string;
  booking_file: string;
  /**
   * The manufacturer's vehicle segments, as its stock report writes them in the model's category, with
   * the name the dealership uses for each. A category the list does not know is shown as itself.
   */
  segments: { key: string; label: string; short: string }[];
  readStockReport(sheets: Sheet[], opts: { timeZone: string; asOf: string }): StockReport;
  readBookingSheet(sheets: Sheet[], opts: { timeZone: string }): BookingSheet;
}

export const OEM_ADAPTERS: OemAdapter[] = [
  {
    key: "MAHINDRA",
    label: "Mahindra",
    stock_file: "Stock report (Dealer Name, Dealer Location Code, Model Description, Color, VIN, GRN, Vehicle Status, Order ID, Stock Type, Invoice ID, ...)",
    booking_file: "Booking sheet (DMS Booking Number, Booking Stage, Created Date, Customer, Model Code, Model Description, Color, Sales Consultant, ...)",
    segments: [
      { key: "PERSONAL", label: "Passenger vehicles", short: "PV" },
      { key: "BEV", label: "Electric vehicles", short: "EV" },
      { key: "PROSPER", label: "Commercial vehicles", short: "CV" },
    ],
    readStockReport: mahindraStockReport,
    readBookingSheet: mahindraBookingSheet,
  },
];

/** The segment as the dealership says it: "Commercial vehicles (CV)" for Mahindra's PROSPER. */
export function segmentLabel(oem: string | null | undefined, category: string): string {
  const s = oemAdapter(oem)?.segments.find((x) => x.key === category);
  return s ? `${s.label} (${s.short})` : category;
}

/** The adapter for a dealership's manufacturer, matched on the name as written at onboarding ("Mahindra", "Mahindra & Mahindra", "M&M"). */
export function oemAdapter(oem: string | null | undefined): OemAdapter | null {
  const name = String(oem ?? "").toUpperCase().replace(/[^A-Z]/g, "");
  if (!name) return null;
  for (const a of OEM_ADAPTERS) if (name.includes(a.key) || (a.key === "MAHINDRA" && name === "MM")) return a;
  return null;
}

export const SUPPORTED_OEMS = OEM_ADAPTERS.map((a) => a.label);
