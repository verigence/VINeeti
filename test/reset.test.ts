// Emptying a dealership so it can start afresh. What matters is the line between what a dealership did
// and what it is: the doing goes, the being stays, and nothing of another dealership is touched.
import { describe, expect, it } from "vitest";
import { approvedBooking, addCar, CRETA, makeDealer, makeMahindraDealer, makeWorld, PASSWORD, PLATFORM, VENUE, type Session, type World } from "./harness";
import { CLEARED, KEPT } from "../src/domain/reset";

async function console_(w: World): Promise<Session> {
  const who = { mobile: "9800000001", name: "Platform Owner", password: "Platform@2026" };
  await w.api("POST", "/api/platform/bootstrap", who, undefined, { Authorization: PLATFORM.Authorization });
  const res = await w.api("POST", "/api/platform/login", { mobile: who.mobile, password: who.password });
  return { cookie: (res.headers.get("Set-Cookie") ?? "").split(";")[0] } as Session;
}
const count = (w: World, table: string, tenant: string) => w.db.q<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ?`, tenant)[0].n;

describe("starting a dealership afresh", () => {
  it("clears what was done, keeps what was set up, and leaves other dealerships alone", async () => {
    const w = makeWorld();
    const a = await makeDealer(w);
    const b = await makeMahindraDealer(w, "other-mahindra", "92000000");
    const su = await console_(w);

    // A dealership with a day behind it: cars, a booking, an approval, an allocation.
    await addCar(w, a, "MALC841CLRM200021", VENUE, "PATIA", "RECEIVED");
    await approvedBooking(w, a, "se1", CRETA, "PATIA", "Vikram Rao", "9811111111");
    const aId = w.db.q<{ id: string }>(`SELECT id FROM tenants WHERE slug = ?`, a.slug)[0].id;
    const bId = w.db.q<{ id: string }>(`SELECT id FROM tenants WHERE slug = ?`, b.slug)[0].id;
    expect(count(w, "bookings", aId)).toBeGreaterThan(0);
    expect(count(w, "vehicles", aId)).toBeGreaterThan(0);
    expect(count(w, "audit_log", aId)).toBeGreaterThan(0);
    const usersBefore = count(w, "users", aId);
    const outletsBefore = count(w, "outlets", aId);
    const variantsBefore = count(w, "vehicle_variants", aId);
    const otherBookings = count(w, "bookings", bId);

    // The name has to be typed, and a near miss removes nothing at all.
    const wrong = await w.api("POST", `/api/platform/tenants/${a.slug}/reset`, { confirm: a.slug }, su);
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.message).toContain("Nothing has been removed");
    expect(count(w, "bookings", aId)).toBeGreaterThan(0);

    const name = w.db.q<{ name: string }>(`SELECT name FROM tenants WHERE id = ?`, aId)[0].name;
    const res = await w.api("POST", `/api/platform/tenants/${a.slug}/reset`, { confirm: name }, su);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.total).toBeGreaterThan(0);

    // Everything the dealership did is gone, bar the one line saying it was emptied.
    for (const table of CLEARED) expect(count(w, table, aId), table).toBe(table === "audit_log" ? 1 : 0);
    // Everything it is remains: its people, its outlets, its vehicle master.
    expect(count(w, "users", aId)).toBe(usersBefore);
    expect(count(w, "outlets", aId)).toBe(outletsBefore);
    expect(count(w, "vehicle_variants", aId)).toBe(variantsBefore);
    expect(KEPT).toContain("users");
    // The other dealership is untouched.
    expect(count(w, "bookings", bId)).toBe(otherBookings);

    // People can still sign in, which is the point of keeping them.
    expect((await w.api("POST", "/api/auth/login", { dealer: a.slug, mobile: a.users.se1.mobile, password: PASSWORD })).status).toBe(200);
    // And the reset itself is on the record, with what it removed.
    const line = w.db.q<{ detail_json: string }>(`SELECT detail_json FROM audit_log WHERE tenant_id = ? AND action = 'DEALERSHIP_RESET'`, aId);
    expect(line.length).toBe(1);
    expect(line[0].detail_json).toContain("bookings");

    // The guarantee the reset had to suspend is back: neither history can be written over again.
    for (const t of ["audit_log", "vehicle_events"]) {
      const guards = w.db.q<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND tbl_name = ?`, t)[0].n;
      expect(guards, t).toBe(2);
    }
    expect(() => w.db.raw.exec(`DELETE FROM audit_log WHERE tenant_id = '${aId}'`)).toThrow(/append-only/);
  });

  it("is the platform's to do, not a dealership administrator's", async () => {
    const w = makeWorld();
    const d = await makeDealer(w);
    const name = w.db.q<{ name: string }>(`SELECT name FROM tenants WHERE slug = ?`, d.slug)[0].name;
    expect((await w.api("POST", `/api/platform/tenants/${d.slug}/reset`, { confirm: name }, d.users.admin.session)).status).toBe(401);
    expect((await w.api("POST", `/api/platform/tenants/${d.slug}/reset`, { confirm: name })).status).toBe(401);
    expect(w.db.q<{ n: number }>(`SELECT COUNT(*) AS n FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE t.slug = ?`, d.slug)[0].n).toBeGreaterThan(0);
  });
});
