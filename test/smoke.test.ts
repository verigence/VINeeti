import { describe, expect, it } from "vitest";
import { makeDealer, makeWorld } from "./harness";

describe("harness", () => {
  it("creates a dealership with every persona", async () => {
    const w = makeWorld();
    const d = await makeDealer(w);
    expect(Object.keys(d.users)).toHaveLength(14);
    const me = await w.api("GET", "/api/auth/me", undefined, d.users.se1.session);
    expect(me.body.user.role).toBe("SALES_CONSULTANT");
    expect(me.body.outlets.map((o: any) => o.code)).toEqual(["PATIA"]);
  });
});
