// The Excel reader, on anonymised copies of the two DMS exports (same sheets, headings and cell types as the real files).
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readExport, serialToDate, serialToLocalDateTime, tableWith } from "../src/lib/xlsx";

export const fixture = (name: string) => new Uint8Array(readFileSync(fileURLToPath(import.meta.resolve(`./fixtures/${name}`))));

describe("Excel reader", () => {
  it("reads the stock report: 742 cars, headings with stray spaces, the footer line", async () => {
    const sheets = await readExport(fixture("stock_report.sample.xlsx"), "stock.xlsx");
    expect(sheets.map((s) => s.name)).toEqual(["Export"]);
    const t = tableWith(sheets, ["VIN", "Stock Type", "Model Description"])!;
    expect(t.header.length).toBe(43);
    expect(t.header).toContain("Variant Desc"); // " Variant Desc" in the file
    const cars = t.records.filter((r) => r["vin"]);
    expect(cars.length).toBe(742);
    expect(new Set(cars.map((r) => r["vin"])).size).toBe(742);
    expect(t.records.filter((r) => !r["vin"]).map((r) => r["dealer name"])).toEqual(["Applied filters: user_login_id is SAMPLE"]);
    const count = (k: string) => cars.reduce((m, r) => m.set(r[k], (m.get(r[k]) ?? 0) + 1), new Map<string, number>());
    expect(Object.fromEntries(count("stock type"))).toEqual({ Unalloted: 550, IBND: 188, Alloted: 4 });
    expect(Object.fromEntries(count("vehicle status"))).toEqual({ Received: 505, "In Transit": 237 });
    const one = cars.find((r) => r["invoice id"])!;
    expect(one["oem invoice date"]).toMatch(/^\d{5}$/); // an Excel day number
    expect(one["grn date"]).toMatch(/^\d{5}\.\d+$/); // day number with time
    expect(one["invoice date"]).toMatch(/^\d{4}-\d{2}-\d{2}$/); // text
  });

  it("reads the booking sheet and ignores the pivot sheet in front of it", async () => {
    const sheets = await readExport(fixture("booking_sheet.sample.xlsx"));
    expect(sheets.map((s) => s.name)).toEqual(["Sheet1", "FETB_EDP_v1_1"]);
    const t = tableWith(sheets, ["DMS Booking Number", "Booking Stage"])!;
    expect(t.sheet).toBe("FETB_EDP_v1_1");
    expect(t.header.length).toBe(67);
    expect(t.records.length).toBe(636);
    const stages = t.records.reduce((m, r) => m.set(r["booking stage"], (m.get(r["booking stage"]) ?? 0) + 1), new Map<string, number>());
    expect(Object.fromEntries(stages)).toEqual({ Booked: 368, Invoiced: 252, "Cancellation Initiated": 16 });
    expect(t.records[0]["created date"]).toMatch(/^\d{2}-[A-Z][a-z]{2}-\d{4} \d{2}:\d{2} [AP]M$/);
    expect(t.records[0]["customer mobile phone"]).toMatch(/^\d{10}$/);
  });

  it("accepts a CSV with the same headings, and refuses what it cannot read", async () => {
    const csv = new TextEncoder().encode("VIN, Stock Type ,Model Description\nMA1X,Unalloted,THAR LXT D MT 2WD 4S HT WQ(A3EVRSTWHT)(M0877)\n");
    const t = tableWith(await readExport(csv, "a.csv"), ["VIN", "Stock Type"])!;
    expect(t.records).toEqual([{ _row: "2", vin: "MA1X", "stock type": "Unalloted", "model description": "THAR LXT D MT 2WD 4S HT WQ(A3EVRSTWHT)(M0877)" }]);
    await expect(readExport(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]))).rejects.toThrow(/save it as \.xlsx/);
    await expect(readExport(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).rejects.toThrow(/not a valid \.xlsx/);
    await expect(readExport(new Uint8Array())).rejects.toThrow(/empty/);
  });

  it("converts Excel day numbers", () => {
    expect(serialToDate(46284)).toBe("2026-09-19");
    expect(serialToDate(45894)).toBe("2025-08-25");
    expect(serialToLocalDateTime(45902.756660648149)).toBe("2025-09-02T18:10");
    expect(serialToDate(NaN)).toBeNull();
  });

  // The real exports are not kept in the repository. When their paths are given, the reader is checked on them too.
  const real = [process.env.STOCK_PATH, process.env.BOOKINGS_PATH];
  it.skipIf(!real.every((p) => p && existsSync(p)))("reads the real exports", async () => {
    const stock = tableWith(await readExport(new Uint8Array(readFileSync(real[0]!))), ["VIN", "Stock Type"])!;
    expect(stock.records.filter((r) => r["vin"]).length).toBe(742);
    const book = tableWith(await readExport(new Uint8Array(readFileSync(real[1]!))), ["DMS Booking Number", "Booking Stage"])!;
    expect(book.records.length).toBe(636);
  });
});
