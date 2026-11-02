// Hyundai's three DMS exports, read by their own adapter into the same system.
//
// The rows below are made up. They have the headings and the value shapes of a dealership's real
// exports (dd/mm/yyyy dates, amounts with commas, codes in brackets, a masked VIN, invoice numbers that
// repeat across two dealer codes), and no real customer, car or invoice.
import { beforeAll, describe, expect, it } from "vitest";
import { oemAdapter } from "../src/oem";
import { makeWorld, PASSWORD, PLATFORM, type Session, type World } from "./harness";

const csv = (rows: Record<string, string>[]) => {
  const head = Object.keys(rows[0]);
  const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return new TextEncoder().encode([head.join(","), ...rows.map((r) => head.map((h) => cell(r[h] ?? "")).join(","))].join("\n"));
};

const stockRow = (o: Partial<Record<string, string>>) => ({
  "GRN No": "", "HMI Invoice No": "9000000001", "HMI Invoice Date": "01/10/2026", "Sign Off Date": "28/09/2026", "Stock Age": "12",
  "Model Code": "1Q", Model: "New Venue", "Variant Code": "6366", Variant: "VENUE 1.2 Kappa MT HX 4", "Color Type": "Solid",
  "Exterior Color Code": "SAW", "Exterior Color Name": "ATLAS WHITE", "Vin Number": "MALTEST0000000001", "Engine No": "G4LATEST001",
  "Order No": "5000000001", "HMIL Invoice Amt": "812345.67", "Stock Status": "Free Stock", "Basic Price": "700000", "Cust ID": "", "Cust Name": "", "Bkng No": "",
  "Fuel Type": "Petrol", "In Out Status": "In Transit", "Stock Location": "Showroom", "Order Type": "S-Normal Order", ...o,
});

const bookingRow = (o: Partial<Record<string, string>>) => ({
  No: "1", "Enquiry No": "E260000001", "Enquiry Date": "01/09/2026", "Booking Date": "02/09/2026", "Committed Delivery Date": "30/11/2026", "Due In (Days)": "40",
  "Enquiry Source": "Walk-in", "Cust. No": "C1000000001", "Customer Name": "Test Customer One", "Phone No": "9800000001", "Customer Type": "Individual",
  "Enquiry Status": "Booked", "Enquiry Type": "New", "Enquiry Category": "Individual", Model: "New Venue(1Q)", Variant: "VENUE 1.2 Kappa MT HX 4(6366)",
  Stcd: "TEST", City: "Test City", "CS Name": "Test Consultant", "Order Ref No": "", "Booking FIFO Skip": "", Dealer: "TEST HYUNDAI DEALER", "Priority Flag": "-",
  "Digital Docket Authentication Status": "", ...o,
});

const retailRow = (o: Partial<Record<string, string>>) => ({
  "No.": "1", "Main Dealer Code": "E0001", "Dealer Code": "E0001", "Confirm Date": "05/10/2026", "Invoice Date": "05/10/2026", "Delivery Date": "06/10/2026",
  Status: "INVOICE CONFIRM", "Invoice No": "I260000001", "Registration Name": "Test Customer Three", Model: "New Venue", "Order Ref No": "",
  Variant: "VENUE 1.2 Kappa MT HX 4", Color: "FIERY RED", "HMI Invoice No": "9000000009", "Vin Number": "**********00009", "Mode of Purchase": "Cash",
  "DSA/Financier": "Test Finance Ltd", "Basic Amount": "7,00,000", "Invoice Price": "8,26,000", "Dealer Cash Discount": "12,500", "Other Discount": "2,000",
  "Consultant Name": "Test Consultant", CustomerID: "C1000000003", "Booking Date": "03/09/2026", "CGST Amount": "63,000", "SGST Amount": "63,000", "IGST Amount": "0",
  "Customer GST No": "", ...o,
});

const one = (w: World, sql: string, ...p: unknown[]) => w.db.q<{ n: number }>(sql, ...p)[0].n;

describe("Hyundai DMS files", () => {
  let w: World, s: Session;
  beforeAll(async () => {
    w = makeWorld("2026-10-13 10:00");
    const made = await w.api("POST", "/api/platform/tenants", { slug: "test-hyundai", name: "Test Hyundai", oem: "Hyundai", admin: { name: "Admin", mobile: "9300000011", email: "dealer.admin@test.example", password: PASSWORD } }, undefined, PLATFORM);
    expect(made.status).toBe(201);
    w.db.raw.exec(`UPDATE users SET must_change_password = 0`);
    s = await w.login("test-hyundai", "9300000011", PASSWORD);
  }, 60_000);

  it("is the Hyundai adapter, for the name as written at onboarding", () => {
    for (const name of ["Hyundai", "HYUNDAI", "Hyundai Motor India"]) expect(oemAdapter(name)?.key, name).toBe("HYUNDAI");
  });

  it("refuses an empty export plainly", async () => {
    const res = await w.send("/api/uploads/bookings?filename=BLS%20-%20Booking.csv", new TextEncoder().encode("No\n"), s);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("This file is empty: it has no rows. Export the booking report from the DMS again.");
  });

  it("loads the stock report onto one outlet: in the showroom is received, the rest is on its way", async () => {
    const res = await w.send("/api/uploads/stock?filename=STOCK.csv&report_date=2026-10-13", csv([
      stockRow({}),
      stockRow({ "Vin Number": "MALTEST0000000002", "HMI Invoice No": "9000000002", "Exterior Color Code": "PR2", "Exterior Color Name": "FIERY RED" }),
      stockRow({ "Vin Number": "MALTEST0000000003", "HMI Invoice No": "9000000003", "Stock Location": "", "Stock Status": "Despatch" }),
      stockRow({ "Vin Number": "MALTEST0000000009", "HMI Invoice No": "9000000009", "Exterior Color Name": "FIERY RED", "Stock Location": "", "Stock Status": "From Other Dealer" }),
    ]), s);
    expect(res.status).toBe(200);
    expect(res.body.errors).toEqual([]);
    expect(res.body.created).toBe(4);
    expect(w.db.q(`SELECT code, name FROM outlets`)).toEqual([{ code: "MAIN", name: "Test Hyundai" }]);
    expect(w.db.q(`SELECT vin, status, model, variant, colour, wholesale_invoice_no AS inv, wholesale_invoice_date AS d FROM vehicles ORDER BY vin`)).toEqual([
      { vin: "MALTEST0000000001", status: "RECEIVED", model: "New Venue", variant: "VENUE 1.2 Kappa MT HX 4 (6366)", colour: "ATLAS WHITE", inv: "9000000001", d: "2026-10-01" },
      { vin: "MALTEST0000000002", status: "RECEIVED", model: "New Venue", variant: "VENUE 1.2 Kappa MT HX 4 (6366)", colour: "FIERY RED", inv: "9000000002", d: "2026-10-01" },
      { vin: "MALTEST0000000003", status: "IN_TRANSIT", model: "New Venue", variant: "VENUE 1.2 Kappa MT HX 4 (6366)", colour: "ATLAS WHITE", inv: "9000000003", d: "2026-10-01" },
      { vin: "MALTEST0000000009", status: "IN_TRANSIT", model: "New Venue", variant: "VENUE 1.2 Kappa MT HX 4 (6366)", colour: "FIERY RED", inv: "9000000009", d: "2026-10-01" },
    ]);
    // HMIL's invoice amount carries tax; it is not taken as the dealer's net price.
    expect(one(w, `SELECT COUNT(*) AS n FROM vehicles WHERE net_dealer_price IS NOT NULL`)).toBe(0);
  });

  it("loads bookings under the same variant, with no colour, and offers them no car until the colour is given", async () => {
    const res = await w.send("/api/uploads/bookings?filename=BDK%20-%20Booking.csv", csv([
      bookingRow({}),
      bookingRow({ No: "2", "Enquiry No": "E260000002", "Cust. No": "C1000000002", "Customer Name": "Test Customer Two", "Phone No": "9800000002", "Booking Date": "04/09/2026" }),
      bookingRow({ No: "3", "Enquiry No": "E260000003", "Cust. No": "C1000000003", "Customer Name": "Test Customer Three", "Phone No": "9800000003", "Enquiry Status": "Retail" }),
    ]), s);
    expect(res.status).toBe(200);
    expect(res.body.errors).toEqual([]);
    expect(res.body.allocations).toBe(0);
    expect(w.db.q(`SELECT booking_no, status, model, variant, colour, dms_customer_no AS cust FROM bookings ORDER BY booking_no`)).toEqual([
      { booking_no: "E260000001", status: "APPROVED", model: "New Venue", variant: "VENUE 1.2 Kappa MT HX 4 (6366)", colour: "COLOUR NOT GIVEN", cust: "C1000000001" },
      { booking_no: "E260000002", status: "APPROVED", model: "New Venue", variant: "VENUE 1.2 Kappa MT HX 4 (6366)", colour: "COLOUR NOT GIVEN", cust: "C1000000002" },
      // "Retail" is invoiced; the report does not say the car was handed over.
      { booking_no: "E260000003", status: "INVOICED", model: "New Venue", variant: "VENUE 1.2 Kappa MT HX 4 (6366)", colour: "COLOUR NOT GIVEN", cust: "C1000000003" },
    ]);
    expect(one(w, `SELECT COUNT(*) AS n FROM vehicle_variants`)).toBe(1);
    expect(one(w, `SELECT COUNT(*) AS n FROM allocations`)).toBe(0);
  });

  it("takes the colour once, from the booking, and then allocates like any other booking", async () => {
    const id = w.db.q<{ id: string }>(`SELECT id FROM bookings WHERE booking_no = 'E260000001'`)[0].id;
    const given = await w.api("POST", `/api/bookings/${id}/colour`, { colour: "atlas white" }, s);
    expect(given.status).toBe(200);
    expect(given.body.allocations).toBe(1);
    expect(w.db.q(`SELECT b.booking_no, b.colour, v.vin FROM allocations a JOIN bookings b ON b.id = a.booking_id JOIN vehicles v ON v.id = a.vehicle_id WHERE a.status = 'ACTIVE'`)).toEqual([
      { booking_no: "E260000001", colour: "ATLAS WHITE", vin: "MALTEST0000000001" },
    ]);
    const again = await w.api("POST", `/api/bookings/${id}/colour`, { colour: "FIERY RED" }, s);
    expect(again.status).toBe(409);
    expect(one(w, `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'BOOKING_COLOUR_GIVEN'`)).toBe(1);
  });

  it("keeps a colour given in the app when the same booking report is loaded again", async () => {
    const res = await w.send("/api/uploads/bookings?filename=BDK%20-%20Booking.csv", csv([
      bookingRow({}),
      bookingRow({ No: "2", "Enquiry No": "E260000002", "Cust. No": "C1000000002", "Customer Name": "Test Customer Two", "Phone No": "9800000002", "Booking Date": "04/09/2026" }),
      bookingRow({ No: "3", "Enquiry No": "E260000003", "Cust. No": "C1000000003", "Customer Name": "Test Customer Three", "Phone No": "9800000003", "Enquiry Status": "Retail" }),
    ]), s);
    expect(res.status).toBe(200);
    expect(res.body.errors).toEqual([]);
    expect(w.db.q(`SELECT booking_no, colour FROM bookings WHERE status IN ('APPROVED','ALLOCATED') ORDER BY booking_no`)).toEqual([
      { booking_no: "E260000001", colour: "ATLAS WHITE" },
      { booking_no: "E260000002", colour: "COLOUR NOT GIVEN" },
    ]);
    expect(one(w, `SELECT COUNT(*) AS n FROM allocations WHERE status = 'ACTIVE'`)).toBe(1);
  });

  it("reads the retail report: invoices per dealer code, the car by its HMI invoice, the booking by the customer number", async () => {
    const res = await w.send("/api/uploads/retail?filename=RTL.csv&report_date=2026-10-13", csv([
      retailRow({}),
      // The second dealer code has its own series: the same invoice number is a different invoice.
      retailRow({ "No.": "2", "Dealer Code": "E0002", "HMI Invoice No": "9000000077", "Vin Number": "**********00077", CustomerID: "C1000000077", "Registration Name": "Test Customer Seven", "Mode of Purchase": "Finance", "Delivery Date": "" }),
    ]), s);
    expect(res.status).toBe(200);
    expect(res.body.errors).toEqual([]);
    const rows = w.db.q<any>(`SELECT r.invoice_no, r.vin, r.chassis_no, v.vin AS car, b.booking_no AS booking, r.invoice_amount, r.selling_price, r.dealer_discount, r.gst_amount, r.financier, r.delivery_note_date
                                FROM retail_invoices r LEFT JOIN vehicles v ON v.id = r.vehicle_id LEFT JOIN bookings b ON b.id = r.booking_id ORDER BY r.invoice_no`);
    expect(rows).toEqual([
      { invoice_no: "E0001/I260000001", vin: "MALTEST0000000009", chassis_no: "**********00009", car: "MALTEST0000000009", booking: "E260000003", invoice_amount: 826000, selling_price: 700000, dealer_discount: 12500, gst_amount: 126000, financier: null, delivery_note_date: "2026-10-06" },
      { invoice_no: "E0002/I260000001", vin: null, chassis_no: "**********00077", car: null, booking: null, invoice_amount: 826000, selling_price: 700000, dealer_discount: 12500, gst_amount: 126000, financier: "Test Finance Ltd", delivery_note_date: null },
    ]);
    expect(res.body.summary.attached.delivered).toBe(1);
    // Reading the retail report moves no car and no booking.
    expect(w.db.q(`SELECT status FROM bookings WHERE booking_no = 'E260000003'`)).toEqual([{ status: "INVOICED" }]);
  });

  it("refuses files that name no outlet once the dealership has two, rather than guessing", async () => {
    w.db.raw.exec(`INSERT INTO outlets (id, tenant_id, code, name, is_active, created_at) SELECT 'out_second', tenant_id, 'SECOND', 'Second', 1, created_at FROM outlets LIMIT 1`);
    const res = await w.send("/api/uploads/stock?filename=STOCK.csv&report_date=2026-10-13", csv([stockRow({})]), s);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("Hyundai DMS files do not say which outlet a row is for, and this dealership has 2 outlets. Load them as a person who works at one outlet only.");
  });
});
