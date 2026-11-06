// The Reader: sees every screen, changes nothing but their own password.
import { beforeAll, describe, expect, it } from "vitest";
import { approvedBooking, CRETA, makeDealer, makeWorld, type Dealer, type Session, type World } from "./harness";

let w: World, d: Dealer, reader: Session, bookingId: string;

beforeAll(async () => {
  w = makeWorld("2026-10-13 10:00");
  d = await makeDealer(w);
  bookingId = (await approvedBooking(w, d, "se1", CRETA, "PATIA", "Reader Test Customer", "9800000301")).id;
  const made = await w.api("POST", "/api/users", { name: "Rita Reader", mobile: "9000000088", email: "reader@test.example", role: "READER", all_outlets: true, outlet_ids: [] }, d.users.admin.session);
  expect(made.status).toBe(201);
  const first = await w.login(d.slug, "9000000088", made.body.temporary_password);
  // Their own password is the one thing they change.
  expect((await w.api("POST", "/api/auth/change-password", { current: made.body.temporary_password, next: "ReaderOwn1234" }, first)).status).toBe(200);
  reader = await w.login(d.slug, "9000000088", "ReaderOwn1234");
}, 120_000);

describe("the Reader", () => {
  it("is a role the administrator can give, seeing every outlet", async () => {
    const roles = await w.api("GET", "/api/roles", undefined, d.users.admin.session);
    expect(roles.body.roles.find((r: any) => r.role === "READER")).toMatchObject({ label: "Reader" });
    const me = await w.api("GET", "/api/auth/me", undefined, reader);
    expect(me.body.user).toMatchObject({ role: "READER", allOutlets: true, read_only: true });
    // The rights the screens use to decide what to offer: looking, never acting.
    expect(me.body.user.permissions).toEqual(expect.arrayContaining(["stock.view", "booking.view_all", "dashboards.view", "owner.view", "stock.value", "recon.view", "audit.view", "report.day_end"]));
    for (const p of ["booking.create", "booking.approve", "exception.request", "exception.decide", "admin.users", "admin.settings", "admin.reset", "upload.stock", "master.manage", "stock.manage"]) expect(me.body.user.permissions).not.toContain(p);
  });

  it("reads every screen's data, including the ones whose owners edit them", async () => {
    for (const path of [
      "/api/bookings", `/api/bookings/${bookingId}`, "/api/vehicles", "/api/stock/summary", "/api/payments", "/api/exceptions", "/api/orders",
      "/api/users", "/api/outlets", "/api/settings", "/api/master", "/api/audit", "/api/sign-ins", "/api/recon/runs", "/api/uploads", "/api/eod/status",
      "/api/dashboards/overview", "/api/dashboards/owner", "/api/insights/money", "/api/reports/day-end/setup", "/api/reports/day-end?date=2026-10-13", "/api/health",
    ]) {
      const res = await w.api("GET", path, undefined, reader);
      expect(res.status, path).toBe(200);
    }
  });

  it("changes nothing: every change is refused before it reaches the screen's route", async () => {
    const tries: [string, string, unknown][] = [
      ["POST", "/api/bookings", { outlet_id: d.outlets.PATIA, customer_name: "X", customer_mobile: "9800000399", booking_amount: 25000, ...CRETA }],
      ["POST", `/api/bookings/${bookingId}/cancel`, { reason: "x" }],
      ["POST", "/api/exceptions", { type: "DEFER_DELIVERY", booking_id: bookingId, payload: { until: "2026-12-01" }, reason: "x" }],
      ["PUT", "/api/settings", { approval_sla_hours: 12 }],
      ["POST", "/api/users", { name: "Y", mobile: "9000000099", email: "y@test.example", role: "READER" }],
      ["POST", `/api/users/${d.users.se1.id}/reset-password`, {}],
      ["POST", "/api/allocations/run", {}],
      ["POST", "/api/recon/run", {}],
      ["POST", "/api/reports/day-end/send", { date: "2026-10-13", to: "me" }],
      ["POST", "/api/settings/clear-data", { confirm: "x", password: "ReaderOwn1234" }],
    ];
    for (const [method, path, body] of tries) {
      const res = await w.api(method, path, body, reader);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body.error.code, `${method} ${path}`).toBe("READ_ONLY");
    }
    expect(w.db.q(`SELECT status FROM bookings WHERE id = ?`, bookingId)).toEqual([{ status: "APPROVED" }]);
    expect(w.db.q(`SELECT COUNT(*) AS n FROM users WHERE mobile = '9000000099'`)).toEqual([{ n: 0 }]);
  });

  it("can raise a support ticket with the VINeeti team", async () => {
    const res = await w.api("POST", "/api/support/tickets", { subject: "A screen does not load", body: "The stock screen stays blank." }, reader);
    expect(res.status).toBe(201);
    const mine = (await w.api("GET", "/api/support/tickets", undefined, reader)).body;
    expect(Array.isArray(mine) ? mine.length : mine.tickets.length).toBe(1);
  });

  it("can still sign out", async () => {
    expect((await w.api("POST", "/api/auth/logout", {}, reader)).status).toBeLessThan(300);
  });
});
