// What happens when somebody leaves, and when their replacement arrives.
//
// The system is role-driven rather than person-driven: a departure must not block anything, must not
// strand work, and the desk — the role, its bookings and the DMS ID the manufacturer's system knows
// it by — must carry on under whoever takes it over. The person's name stays on what they did,
// because an allocation somebody signed off is theirs whether or not they still work here.

import { beforeAll, describe, expect, it } from "vitest";
import { addCar, approvedBooking, CRETA, makeDealer, makeWorld, PASSWORD, type Dealer, type World } from "./harness";

let w: World;
let d: Dealer;

const user = (id: string) => w.db.q<any>(`SELECT * FROM users WHERE id = ?`, id)[0];
const add = async (name: string, mobile: string, role: string, dms?: string) => {
  const res = await w.api("POST", "/api/users", { name, mobile, email: `${mobile}@test.example`, role, all_outlets: true, outlet_ids: [], dms_code: dms }, d.users.admin.session);
  expect(res.status).toBe(201);
  return res.body.id as string;
};

beforeAll(async () => {
  w = makeWorld("2026-10-13 10:00");
  d = await makeDealer(w, "leaver-mahindra");
});

describe("somebody who has never done anything", () => {
  it("is removed outright, because there is no record that needs their name", async () => {
    const id = await add("Never Worked", "9876511001", "SALES_CONSULTANT");
    const res = await w.api("DELETE", `/api/users/${id}`, undefined, d.users.admin.session);
    expect(res.status).toBe(200);
    expect(res.body.left).toBeUndefined();
    expect(user(id)).toBeUndefined();
  });
});

describe("somebody who has worked here", () => {
  it("is recorded as having left rather than refused, and cannot sign in afterwards", async () => {
    await addCar(w, d, "MALC841CLRM500001", CRETA, "PATIA", "RECEIVED");
    await approvedBooking(w, d, "se1", CRETA, "PATIA", "A Customer", "9876511100");
    const res = await w.api("DELETE", `/api/users/${d.users.se1.id}`, undefined, d.users.admin.session);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, left: true, left_on: "2026-10-13" });
    const row = user(d.users.se1.id);
    expect(row).toBeTruthy();
    expect(row.is_active).toBe(0);
    expect(row.left_on).toBe("2026-10-13");
    // Their name is still on the work; nothing of what they did was deleted.
    expect(w.db.q<any>(`SELECT COUNT(*) AS n FROM bookings WHERE sales_exec_id = ?`, d.users.se1.id)[0].n).toBeGreaterThan(0);
    const back = await w.api("POST", "/api/auth/login", { dealer: d.slug, mobile: d.users.se1.mobile, password: PASSWORD });
    expect(back.status).toBe(401);
  });

  it("is recorded in the history, so a name that stops appearing can be accounted for", async () => {
    const trail = (await w.api("GET", "/api/audit?action=USER_LEFT", undefined, d.users.admin.session)).body;
    expect(trail.length).toBeGreaterThan(0);
    expect(trail[0].detail).toMatchObject({ left_on: "2026-10-13" });
  });
});

describe("the desk carries on", () => {
  it("hands the DMS ID and its bookings to whoever takes over", async () => {
    const DMS = "SC-DESK-01";
    const leaver = await add("Ravi Leaving", "9876511201", "SALES_CONSULTANT", DMS);
    // Two bookings the manufacturer's system has under that desk.
    for (const [vin, mobile] of [["MALC841CLRM500002", "9876511301"], ["MALC841CLRM500003", "9876511302"]] as const) {
      await addCar(w, d, vin, CRETA, "PATIA", "RECEIVED");
      await approvedBooking(w, d, "se2", CRETA, "PATIA", `Customer ${mobile}`, mobile);
    }
    w.db.raw.exec(`UPDATE bookings SET sc_code = '${DMS}', sales_exec_id = '${leaver}' WHERE tenant_id = '${d.tenantId}' AND customer_mobile IN ('919876511301','919876511302')`);
    expect((await w.api("DELETE", `/api/users/${leaver}`, undefined, d.users.admin.session)).status).toBe(200);

    // The replacement joins in the same role and takes the same desk.
    const joiner = await add("Ravi Replacement", "9876511202", "SALES_CONSULTANT", DMS);
    expect(user(joiner).dms_code).toBe(DMS);
    const theirs = w.db.q<any>(`SELECT COUNT(*) AS n FROM bookings WHERE tenant_id = ? AND sales_exec_id = ?`, d.tenantId, joiner)[0].n;
    expect(theirs).toBe(2);
    expect(user(leaver).dms_code).toBeNull();
  });

  it("still refuses a DMS ID held by somebody who is actually here", async () => {
    const held = await add("Still Here", "9876511203", "SALES_CONSULTANT", "SC-DESK-02");
    const res = await w.api("POST", "/api/users", { name: "Someone Else", mobile: "9876511204", email: "else@test.example", role: "SALES_CONSULTANT", all_outlets: true, outlet_ids: [], dms_code: "SC-DESK-02" }, d.users.admin.session);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain("Still Here");
    expect(user(held).dms_code).toBe("SC-DESK-02");
  });

  it("leaves pending approvals to be decided by whoever else holds the role", async () => {
    // Approvals are addressed to a role, never to a person, so a departure cannot strand one. The
    // deciding role here has two people in it; one leaving leaves the other able to decide.
    const before = (await w.api("GET", "/api/exceptions?view=pending", undefined, d.users.head.session)).body;
    const second = await add("Second Head", "9876511205", "CEO_VP");
    expect((await w.api("DELETE", `/api/users/${second}`, undefined, d.users.admin.session)).status).toBe(200);
    const after = (await w.api("GET", "/api/exceptions?view=pending", undefined, d.users.head.session)).body;
    expect(after.length).toBe(before.length);
  });
});

describe("coming back", () => {
  it("clears the leaving date, so a working account never looks like a departed one", async () => {
    const id = await add("Boomerang Singh", "9876511210", "FINANCE");
    await addCar(w, d, "MALC841CLRM500009", CRETA, "PATIA", "RECEIVED");
    w.db.raw.exec(`INSERT INTO audit_log (id, tenant_id, actor, action, entity_type, entity_id, detail_json, at) VALUES ('aud_boom', '${d.tenantId}', '${id}', 'USER_UPDATED', 'user', '${id}', '{}', '2026-10-13T04:30:00Z')`);
    expect((await w.api("DELETE", `/api/users/${id}`, undefined, d.users.admin.session)).body.left).toBe(true);
    expect(user(id).left_on).toBe("2026-10-13");
    expect((await w.api("PATCH", `/api/users/${id}`, { is_active: true }, d.users.admin.session)).status).toBe(200);
    expect(user(id).left_on).toBeNull();
    expect(user(id).is_active).toBe(1);
  });

  it("does not put a leaving date on an account merely switched off", async () => {
    const id = await add("Suspended Sharma", "9876511211", "FINANCE");
    w.db.raw.exec(`INSERT INTO audit_log (id, tenant_id, actor, action, entity_type, entity_id, detail_json, at) VALUES ('aud_susp', '${d.tenantId}', '${id}', 'USER_UPDATED', 'user', '${id}', '{}', '2026-10-13T04:30:00Z')`);
    expect((await w.api("PATCH", `/api/users/${id}`, { is_active: false }, d.users.admin.session)).status).toBe(200);
    expect(user(id).is_active).toBe(0);
    // Off for a fortnight is not the same as gone, and the record must not say it is.
    expect(user(id).left_on).toBeNull();
  });
});

describe("the administrator themself", () => {
  it("cannot be removed by their own hand, leaving the dealership with nobody to administer it", async () => {
    const res = await w.api("DELETE", `/api/users/${d.users.admin.id}`, undefined, d.users.admin.session);
    expect(res.status).toBe(400);
    expect(user(d.users.admin.id).is_active).toBe(1);
  });
});
