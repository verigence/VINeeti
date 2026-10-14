// The TypeScript port must read every real description exactly as the dealership's Python parser does.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { oemModelCodeOf, parseDescription, parseText } from "../src/oem/mahindra";

const fx = JSON.parse(readFileSync(fileURLToPath(import.meta.resolve("./fixtures/mahindra-descriptions.json")), "utf8")) as { stock: any[]; bookings: any[] };

describe("Mahindra description parser", () => {
  it("reads all 258 stock report descriptions exactly as the Python parser", () => {
    expect(fx.stock.length).toBe(258);
    for (const want of fx.stock) expect(parseDescription(want.raw_description)).toEqual(want);
  });

  it("reads all 247 booking sheet descriptions exactly as the Python parser", () => {
    expect(fx.bookings.length).toBe(247);
    for (const want of fx.bookings) expect(parseText(want.raw_description)).toEqual(want);
  });

  it("keeps the (O) of a trim (the defect found in review)", () => {
    expect(parseDescription("MAHINDRA BOLERO B6 (O) BS-VI(A0DMNDWHIT)(M0821)").trim).toBe("B6 (O)");
    expect(parseDescription("MAHINDRA BOLERO B6 BS-VI(A0DMNDWHIT)(M0820)").trim).toBe("B6");
    expect(parseDescription("XUV3XO REVX M(O) PM MT AC(A3GLXGROBK)(M1049)").trim).toBe("REVX M(O)");
    expect(parseDescription("XUV3XO REVX M PM MT AC(A3GLXGROBK)(M1048)").trim).toBe("REVX M");
    expect(parseDescription("XUV3XO REVX EDGE (O) DS AS ZX(A3EVRSTOBK)(M1126)").trim).toBe("REVX EDGE (O)");
    expect(parseDescription("XUV3XO REVX EDGE DS MT AD(A3OBNBLKGG)(M1122)").trim).toBe("REVX EDGE");
  });

  it("leaves blank what the description does not say", () => {
    const d = parseDescription("BOL MAXX PUP HD 1.7 LX(A2WHITE)(M0246)");
    expect([d.model, d.variant, d.trim, d.transmission, d.fuel, d.drive, d.seater]).toEqual(["BOL MAXX PUP HD", "1.7 LX", "LX", "", "", "", ""]);
    expect(d.paint_alias).toBe("");
  });

  it("uses the report's own Color and Seating columns when given", () => {
    const d = parseDescription("BOL MAXX PUP HD 1.7 LX(A0DMNDWHIT)(M0246)", { colour: " White ", seating: "3" });
    expect([d.colour, d.colour_status, d.seater, d.seat_source]).toEqual(["WHITE", "DMS", 3, "DMS Seating column"]);
    // A seat count written in the description is not overridden by the column.
    const s = parseDescription("SCORPIO CLASSIC S MT 9S(A3DMNDWHIT)(M0886)", { seating: "9" });
    expect([s.seater, s.seat_source]).toEqual([9, "Description"]);
  });

  it("sends an unreadable description to review instead of guessing", () => {
    expect(parseDescription("XUV3XO AX5 PM MT WQ").parse_status).toBe("REVIEW");
    expect(parseDescription("NEWMODEL X1 (A3EVRSTWHT)(M9999)").review_reason).toBe("Unknown model prefix");
    expect(parseText("XUV700 AX7 PET MT 7 SEATER SBLK")).toMatchObject({ model: "XUV700", transmission: "Manual", fuel: "Petrol", seater: "", paint_alias: "" });
  });

  it("finds the OEM model code inside a booking's Model Code", () => {
    expect(oemModelCodeOf("X3XOM104918095856")).toBe("M1049");
    expect(oemModelCodeOf("MXHDM024617111596")).toBe("M0246");
    expect(oemModelCodeOf("ABC")).toBe("");
  });
});
