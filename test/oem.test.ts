// One deployment, many manufacturers: each one's DMS file layout is an adapter chosen by the dealership's OEM.
import { describe, expect, it } from "vitest";
import { oemAdapter } from "../src/oem";
import { makeWorld, PASSWORD, PLATFORM, stockFile } from "./harness";

describe("manufacturers", () => {
  it("picks the file layout from the OEM name as written at onboarding", () => {
    for (const name of ["Mahindra", "MAHINDRA", "Mahindra & Mahindra", "M&M", "Mahindra Automotive"]) expect(oemAdapter(name)?.key, name).toBe("MAHINDRA");
    for (const name of ["Hyundai", "Tata Motors", "", null]) expect(oemAdapter(name)).toBeNull();
  });

  it("refuses the DMS files of a manufacturer whose layout is not configured, plainly, and says so on sign-in", async () => {
    const w = makeWorld();
    const made = await w.api("POST", "/api/platform/tenants", { slug: "other-hyundai", name: "Other Motors", oem: "Hyundai", outlets: [{ code: "H1", name: "Main" }], admin: { name: "Admin", mobile: "9300000001", email: "dealer.admin@test.example", password: PASSWORD } }, undefined, PLATFORM);
    expect(made.status).toBe(201);
    w.db.raw.exec(`UPDATE users SET must_change_password = 0`);
    const s = await w.login("other-hyundai", "9300000001", PASSWORD);
    const me = (await w.api("GET", "/api/auth/me", undefined, s)).body;
    expect(me.tenant).toMatchObject({ oem: "Hyundai", dms_files: null });
    const res = await w.send("/api/uploads/stock?filename=stock.csv", stockFile([{ vin: "MA1THAR0000000001", car: "THAR_WHITE" }]), s);
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({ code: "OEM_NOT_SUPPORTED", message: "DMS files for Hyundai are not configured in this version (supported: Mahindra). The dealership can be worked from the screens; its file layout is added from real exports." });
    expect(w.db.q(`SELECT COUNT(*) AS n FROM uploads`)[0].n).toBe(0);
    // The screens still work: a car and a booking can be entered by hand.
    expect((await w.api("GET", "/api/stock/summary", undefined, s)).status).toBe(200);
  });

  it("tells a Mahindra dealership what its two files look like", async () => {
    const w = makeWorld();
    const made = await w.api("POST", "/api/platform/tenants", { slug: "mm-dealer", name: "MM Motors", oem: "Mahindra & Mahindra", admin: { name: "Admin", mobile: "9300000002", email: "dealer.admin@test.example", password: PASSWORD } }, undefined, PLATFORM);
    expect(made.status).toBe(201);
    w.db.raw.exec(`UPDATE users SET must_change_password = 0`);
    const s = await w.login("mm-dealer", "9300000002", PASSWORD);
    const me = (await w.api("GET", "/api/auth/me", undefined, s)).body;
    expect(me.tenant.dms_files.oem).toBe("Mahindra");
    expect(me.tenant.dms_files.stock_file).toContain("Model Description");
    expect(me.tenant.dms_files.booking_file).toContain("DMS Booking Number");
  });
});
