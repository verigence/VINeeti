// A dealership's own address. What is being protected is that the address settles which dealership a
// person is signing in to: not a code they type, and not a guess from their mobile number.
import { describe, expect, it } from "vitest";
import { makeDealer, makeWorld, PASSWORD, PLATFORM } from "./harness";

const HOST = "adityamotors.mh.jbrconsulting.in";

describe("a dealership reached at its own address", () => {
  it("is named on the sign-in screen, and signs people in without a dealer code", async () => {
    const w = makeWorld();
    const d = await makeDealer(w);
    w.db.raw.exec(`UPDATE tenants SET hostname = '${HOST}' WHERE slug = '${d.slug}'`);

    // The screen can say whose address this is before anybody signs in, and nothing more than that.
    const site = await w.api("GET", "/api/site", undefined, undefined, {}, HOST);
    expect(site.status).toBe(200);
    expect(site.body.dealership).toMatchObject({ slug: d.slug });
    expect(JSON.stringify(site.body)).not.toContain("hostname");

    // No dealer code typed, and none needed.
    const inn = await w.api("POST", "/api/auth/login", { mobile: d.users.se1.mobile, password: PASSWORD }, undefined, {}, HOST);
    expect(inn.status).toBe(200);

    // The shared address knows no dealership, and asks as it did before.
    const shared = await w.api("GET", "/api/site");
    expect(shared.body.dealership).toBeNull();
  });

  it("will not sign anybody in to another dealership, whatever code they type", async () => {
    const w = makeWorld();
    const a = await makeDealer(w);
    const made = await w.api("POST", "/api/platform/tenants", { slug: "other-motors", name: "Other Motors", oem: "Hyundai", outlets: [{ code: "MAIN", name: "Main" }], admin: { name: "Their Admin", mobile: "9500000001", email: "admin@other.example", password: PASSWORD } }, undefined, PLATFORM);
    expect(made.status).toBe(201);
    w.db.raw.exec(`UPDATE tenants SET hostname = '${HOST}' WHERE slug = '${a.slug}'`);
    w.db.raw.exec(`UPDATE users SET must_change_password = 0 WHERE mobile = '919500000001'`);

    // Their own code, at a different dealership's address: refused rather than quietly honoured.
    const crossed = await w.api("POST", "/api/auth/login", { dealer: "other-motors", mobile: "9500000001", password: PASSWORD }, undefined, {}, HOST);
    expect(crossed.status).toBe(401);
    // And the same person signs in perfectly well where they belong.
    expect((await w.api("POST", "/api/auth/login", { dealer: "other-motors", mobile: "9500000001", password: PASSWORD })).status).toBe(200);
    // The address's own dealership still works, with the matching code or none at all.
    expect((await w.api("POST", "/api/auth/login", { dealer: a.slug, mobile: a.users.se1.mobile, password: PASSWORD }, undefined, {}, HOST)).status).toBe(200);
  });

  it("falls back to the mobile number when the address belongs to nobody", async () => {
    const w = makeWorld();
    const d = await makeDealer(w);
    // An address nobody has claimed is not a way in to a dealership that did not claim it.
    const site = await w.api("GET", "/api/site", undefined, undefined, {}, "nobody.mh.jbrconsulting.in");
    expect(site.body.dealership).toBeNull();
    expect((await w.api("POST", "/api/auth/login", { mobile: d.users.se1.mobile, password: PASSWORD }, undefined, {}, "nobody.mh.jbrconsulting.in")).status).toBe(200);
  });
});
