// Personas and controls: who may do what, Finance verifying that a payment has been received, and the
// alarms that reach the Business Head / CEO and the Dealer Principal.
import { describe, expect, it } from "vitest";
import { loadBookings, loadStock, makeMahindraDealer, makeWorld, type BookingLine, type Dealer, type StockLine, type World } from "./harness";

const q = <T = any>(w: World, sql: string, ...p: unknown[]) => w.db.q<T>(sql, ...p);
const booking = (w: World, no: string) => q(w, `SELECT b.*, (SELECT v.vin FROM allocations a JOIN vehicles v ON v.id = a.vehicle_id WHERE a.booking_id = b.id AND a.status = 'ACTIVE') AS vin FROM bookings b WHERE b.booking_no = ?`, no)[0];
const alarms = (w: World, kind: string) => q(w, `SELECT target_role, title, body FROM alerts WHERE is_alarm = 1 AND kind = ? ORDER BY target_role`, kind);
const alarmMessages = (w: World) => q(w, `SELECT to_name, rendered_text FROM wa_messages WHERE event_key = 'MANAGEMENT_ALARM' ORDER BY created_at, to_name`);

const VIN = "MA1THAR0000000001";
const STOCK: StockLine[] = [{ vin: VIN, car: "THAR_WHITE" }];
const BOOKINGS: BookingLine[] = [
  { no: "OTF27A000001", car: "THAR_WHITE", created: "01-Sep-2026 10:00 AM", customer: "FIRST CUSTOMER", scId: "99ZZ0001" },
  { no: "OTF27A000002", car: "THAR_WHITE", created: "02-Sep-2026 10:00 AM", customer: "SECOND CUSTOMER", scId: "99ZZ0002" },
];

/** A dealership with one received car and two customers who booked it; the first holds the car. The sales executive is the first booking's consultant. */
async function start(at = "2026-10-05 10:00"): Promise<{ w: World; d: Dealer; first: any; second: any }> {
  const w = makeWorld(at);
  const d = await makeMahindraDealer(w);
  expect((await w.api("PATCH", `/api/users/${d.users.exec.id}`, { dms_code: "99ZZ0001" }, d.users.admin.session)).status).toBe(200);
  await loadStock(w, d.users.stock.session, STOCK);
  await loadBookings(w, d.users.crm.session, BOOKINGS);
  const first = booking(w, "OTF27A000001"), second = booking(w, "OTF27A000002");
  expect(first).toMatchObject({ status: "ALLOCATED", vin: VIN, sales_exec_id: d.users.exec.id });
  expect(second).toMatchObject({ status: "APPROVED", vin: null });
  return { w, d, first, second };
}
/** Moves to a later day, loads that day's files (so the data is current) and runs the scheduled job. */
async function day(w: World, d: Dealer, at: string) {
  w.at(at);
  await loadStock(w, d.users.stock.session, STOCK);
  await loadBookings(w, d.users.crm.session, BOOKINGS);
  return (await w.tick())[0];
}

describe("Finance verifies that a payment has been received", () => {
  it("sales reports the payment; only Finance can verify it; verification is what keeps the car", async () => {
    const { w, d, first } = await start();
    const u = d.users;
    // The sales executive sees their own booking and reports the customer's payment with its reference.
    expect((await w.api("POST", `/api/bookings/${first.id}/payment-reported`, { amount: 250000 }, u.exec.session)).status).toBe(400); // no reference: Finance could not find it
    const reported = await w.api("POST", `/api/bookings/${first.id}/payment-reported`, { amount: 250000, reference: "UTR N123456789", note: "NEFT" }, u.exec.session);
    expect(reported.status).toBe(200);
    expect(booking(w, "OTF27A000001")).toMatchObject({ payment_reported_by: u.exec.id, payment_amount: 250000, payment_ref: "UTR N123456789", payment_received_at: null });
    expect((await w.api("POST", `/api/bookings/${first.id}/payment-reported`, { reference: "AGAIN" }, u.lead.session)).status).toBe(409);
    // It is in Finance's queue, first, as "to verify".
    const queue = (await w.api("GET", "/api/payments", undefined, u.finance.session)).body;
    expect(queue[0]).toMatchObject({ booking_no: "OTF27A000001", state: "TO_VERIFY", payment_ref: "UTR N123456789", overdue: false });
    expect(q(w, `SELECT target_role, kind FROM alerts WHERE kind = 'PAYMENT_TO_VERIFY'`)).toEqual([{ target_role: "ACCOUNTS", kind: "PAYMENT_TO_VERIFY" }]);
    // Nobody in sales, and nobody in management, can mark it received.
    for (const who of ["exec", "lead", "head", "dp", "crm", "stock", "auditor"]) {
      expect((await w.api("POST", `/api/bookings/${first.id}/payment-received`, {}, u[who].session)).status, who).toBe(403);
      expect((await w.api("POST", `/api/bookings/${first.id}/payment-not-received`, { note: "x" }, u[who].session)).status, who).toBe(403);
    }
    const verified = await w.api("POST", `/api/bookings/${first.id}/payment-received`, {}, u.finance.session);
    expect(verified.status).toBe(200);
    expect(booking(w, "OTF27A000001")).toMatchObject({ payment_verified_by: u.finance.id, payment_ref: "UTR N123456789", payment_amount: 250000 });
    expect(booking(w, "OTF27A000001").payment_received_at).toBeTruthy();
    expect((await w.api("GET", "/api/payments", undefined, u.finance.session)).body.find((p: any) => p.booking_no === "OTF27A000001").state).toBe("VERIFIED");
    // The sales executive is told, and the audit trail names who reported and who verified.
    expect(q(w, `SELECT target_user FROM alerts WHERE kind = 'PAYMENT_VERIFIED'`)).toEqual([{ target_user: u.exec.id }]);
    expect(q(w, `SELECT action, actor FROM audit_log WHERE action IN ('PAYMENT_REPORTED','PAYMENT_VERIFIED') ORDER BY at, action`)).toEqual([{ action: "PAYMENT_REPORTED", actor: u.exec.id }, { action: "PAYMENT_VERIFIED", actor: u.finance.id }]);
    // Long after the payment window, the car is still this customer's.
    const report = await day(w, d, "2026-10-20 10:00");
    expect(report).toMatchObject({ released: 0, held: 0 });
    expect(booking(w, "OTF27A000001")).toMatchObject({ status: "ALLOCATED", vin: VIN });
  });

  it("the person who reported a payment cannot be the one to verify it", async () => {
    const { w, d, first } = await start();
    // The administrator may do both jobs, but not both on the same payment.
    expect((await w.api("POST", `/api/bookings/${first.id}/payment-reported`, { reference: "RCPT 0042" }, d.users.admin.session)).status).toBe(200);
    const own = await w.api("POST", `/api/bookings/${first.id}/payment-received`, {}, d.users.admin.session);
    expect(own.status).toBe(403);
    expect(own.body.error.message).toBe("The person who reported a payment cannot verify it");
    expect((await w.api("POST", `/api/bookings/${first.id}/payment-received`, {}, d.users.finance.session)).status).toBe(200);
  });

  it("a reported payment holds the car past the re-allocation day; if Finance is late, management gets an alarm", async () => {
    const { w, d, first } = await start("2026-10-05 10:00");
    expect((await w.api("POST", `/api/bookings/${first.id}/payment-reported`, { amount: 250000, reference: "UTR N123456789" }, d.users.exec.session)).status).toBe(200);
    // Next day, more than 24 hours later: Finance has not verified it.
    const next = await day(w, d, "2026-10-06 11:00");
    expect(next.alarms).toBe(1);
    expect(alarms(w, "PAYMENT_VERIFY_OVERDUE").map((a) => a.target_role)).toEqual(["BUSINESS_HEAD", "DEALER_PRINCIPAL"]);
    expect(alarms(w, "PAYMENT_VERIFY_OVERDUE")[0].body).toContain("OTF27A000001");
    expect(alarmMessages(w).filter((m) => m.rendered_text.includes("not verified by Finance")).map((m) => m.to_name)).toEqual(["Bikram Head", "Dinesh Principal"]);
    expect((await w.api("GET", "/api/payments", undefined, d.users.finance.session)).body[0]).toMatchObject({ booking_no: "OTF27A000001", overdue: true });
    // The alarm is raised once, not at every run.
    expect((await day(w, d, "2026-10-06 15:00")).alarms).toBe(0);
    // Day 6 and beyond: the car would be re-allocated, but a payment is waiting for Finance, so it stays.
    const late = await day(w, d, "2026-10-12 10:00");
    expect(late).toMatchObject({ released: 0, held: 1 });
    expect(booking(w, "OTF27A000001")).toMatchObject({ status: "ALLOCATED", vin: VIN });
    expect(booking(w, "OTF27A000002")).toMatchObject({ status: "APPROVED", vin: null });
  });

  it("when Finance finds the payment has not come in, the window carries on and the car goes to the next customer", async () => {
    const { w, d, first } = await start("2026-10-05 10:00");
    await w.api("POST", `/api/bookings/${first.id}/payment-reported`, { reference: "CHQ 000123" }, d.users.exec.session);
    await day(w, d, "2026-10-12 10:00");
    expect(booking(w, "OTF27A000001")).toMatchObject({ status: "ALLOCATED", vin: VIN });
    expect((await w.api("POST", `/api/bookings/${first.id}/payment-not-received`, {}, d.users.finance.session)).status).toBe(400); // Finance says what was checked
    const no = await w.api("POST", `/api/bookings/${first.id}/payment-not-received`, { note: "Cheque returned by the bank." }, d.users.finance.session);
    expect(no.status).toBe(200);
    expect(booking(w, "OTF27A000001")).toMatchObject({ payment_reported_at: null, payment_ref: null, payment_received_at: null });
    // The person who reported it is told.
    expect(q(w, `SELECT target_user, body FROM alerts WHERE kind = 'PAYMENT_NOT_RECEIVED'`)).toEqual([{ target_user: d.users.exec.id, body: "Booking OTF27A000001 (FIRST CUSTOMER), reference CHQ 000123: Cheque returned by the bank. The payment window continues." }]);
    const after = await day(w, d, "2026-10-12 11:00");
    expect(after).toMatchObject({ released: 1, held: 0 });
    expect(booking(w, "OTF27A000001")).toMatchObject({ vin: null });
    expect(booking(w, "OTF27A000002")).toMatchObject({ status: "ALLOCATED", vin: VIN });
    // Taking a car back is an alarm for management.
    expect(alarms(w, "REALLOCATED").map((a) => a.target_role)).toEqual(["BUSINESS_HEAD", "DEALER_PRINCIPAL"]);
  });
});

describe("alarms for the Business Head / CEO and the Dealer Principal", () => {
  it("each sees the alarms; other personas do not; who receives them is a setting", async () => {
    const { w, d } = await start("2026-10-05 10:00");
    // No payment at all: escalation on day 5.
    const esc = await day(w, d, "2026-10-10 10:00");
    expect(esc.escalations).toBe(1);
    for (const who of ["head", "dp"]) {
      const list = (await w.api("GET", "/api/alerts?alarms=1", undefined, d.users[who].session)).body;
      expect(list.map((a: any) => [a.kind, a.kind_label, a.is_alarm]), who).toEqual([["ESCALATION", "Payment not received by the escalation day", true]]);
    }
    for (const who of ["lead", "exec", "finance", "crm", "stock", "auditor", "admin"]) expect((await w.api("GET", "/api/alerts?alarms=1", undefined, d.users[who].session)).body, who).toEqual([]);
    expect((await w.api("GET", "/api/auth/me", undefined, d.users.head.session)).body.receives_alarms).toBe(true);
    expect((await w.api("GET", "/api/auth/me", undefined, d.users.finance.session)).body.receives_alarms).toBe(false);
    // The dealership adds Finance to the alarm recipients. Finance cannot make that change; the Business Head can.
    expect((await w.api("PUT", "/api/settings", { alarm_roles: ["BUSINESS_HEAD", "DEALER_PRINCIPAL", "ACCOUNTS"] }, d.users.finance.session)).status).toBe(403);
    expect((await w.api("PUT", "/api/settings", { alarm_roles: ["BUSINESS_HEAD", "DEALER_PRINCIPAL", "ACCOUNTS"] }, d.users.head.session)).status).toBe(200);
    const rel = await day(w, d, "2026-10-11 10:00");
    expect(rel.released).toBe(1);
    expect(alarms(w, "REALLOCATED").map((a) => a.target_role)).toEqual(["ACCOUNTS", "BUSINESS_HEAD", "DEALER_PRINCIPAL"]);
    expect((await w.api("GET", "/api/alerts?alarms=1", undefined, d.users.finance.session)).body.map((a: any) => a.kind)).toEqual(["REALLOCATED"]);
  });

  it("DMS files not loaded for longer than agreed: one alarm a day, and no car is re-allocated on old data", async () => {
    const { w, d } = await start("2026-10-05 10:00");
    // Nothing is loaded after the 5th. On the 12th the payment window is long over, but the files are 7 days old.
    w.at("2026-10-12 10:00");
    const report = (await w.tick())[0];
    expect(report).toMatchObject({ released: 0, held: 1, alarms: 1 });
    expect(booking(w, "OTF27A000001")).toMatchObject({ status: "ALLOCATED", vin: VIN });
    const stale = alarms(w, "STALE_DATA");
    expect(stale.map((a) => a.target_role)).toEqual(["BUSINESS_HEAD", "DEALER_PRINCIPAL"]);
    expect(stale[0].body).toBe("The stock report is 7 day(s) old (as on 2026-10-05); The booking sheet is 7 day(s) old (as on 2026-10-05). The files are expected every 3 day(s). Until they are loaded, stock and queue positions may be out of date and no car is re-allocated automatically.");
    w.at("2026-10-12 16:00");
    expect((await w.tick())[0].alarms).toBe(0);
    expect((await w.api("GET", "/api/data-status", undefined, d.users.exec.session)).body).toMatchObject({ stale: true, stale_files: ["STOCK", "BOOKINGS"] });
    // Once the day's files are in, the overdue car moves to the next customer.
    const fresh = await day(w, d, "2026-10-13 10:00");
    expect(fresh).toMatchObject({ released: 1, held: 0 });
    expect(booking(w, "OTF27A000002")).toMatchObject({ status: "ALLOCATED", vin: VIN });
  });

  it("high-severity findings at day end are an alarm, once for the day", async () => {
    const { w, d } = await start("2026-10-05 10:00");
    // Next day the reserved car is no longer in the stock report and its booking is not invoiced.
    w.at("2026-10-06 18:00");
    const res = await loadStock(w, d.users.stock.session, [{ vin: "MA1SCN00000000001", car: "SCORPIO_N" }]);
    expect(res.body.summary.left_stock).toMatchObject({ on_hold: 1 });
    expect(alarms(w, "CAR_LEFT_STOCK").map((a) => a.target_role)).toEqual(["BUSINESS_HEAD", "DEALER_PRINCIPAL"]);
    const run = await w.api("POST", "/api/recon/run", undefined, d.users.head.session);
    expect(run.status).toBe(201);
    const high = alarms(w, "RECON_HIGH");
    expect(high.map((a) => a.target_role)).toEqual(["BUSINESS_HEAD", "DEALER_PRINCIPAL"]);
    expect(high[0].body).toBe("Reconciliation for 2026-10-06: 1 high-severity finding(s). Reserved car no longer in the stock report: 1. Each one needs a person to look at it and close it with a note.");
    // Running it again the same day does not raise it again.
    await w.api("POST", "/api/recon/run", undefined, d.users.head.session);
    expect(alarms(w, "RECON_HIGH")).toHaveLength(2);
    expect(alarmMessages(w).filter((m) => m.rendered_text.includes("high-severity")).map((m) => m.to_name)).toEqual(["Bikram Head", "Dinesh Principal"]);
  });
});

describe("roles and controls", () => {
  it("every persona signs in and gets only what its role allows", async () => {
    const { w, d, first } = await start();
    const u = d.users;
    const status = async (who: string, method: string, path: string, body?: unknown) => (await w.api(method, path, body, u[who].session)).status;
    const everyone = ["admin", "dp", "head", "lead", "exec", "finance", "crm", "stock", "auditor"];
    const only = async (allowed: string[], method: string, path: string, body?: unknown, ok = 200) => {
      for (const who of everyone) expect(await status(who, method, path, body), `${who} ${method} ${path}`).toBe(allowed.includes(who) ? ok : 403);
    };
    // Everyone can see stock and get the stock-and-date answer.
    await only(everyone, "GET", `/api/stock/availability?model=THAR&variant=${encodeURIComponent("LXT D MT 2WD 4S HT (M0877)")}&colour=${encodeURIComponent("EVEREST WHITE")}`);
    // The owner's view, the measures and the out-of-turn list: management, Finance, the auditor and the administrator.
    await only(["admin", "dp", "head", "finance", "auditor"], "GET", "/api/dashboards/owner");
    await only(["admin", "dp", "head", "finance", "auditor"], "GET", "/api/dashboards/measures");
    await only(["admin", "dp", "head", "finance", "auditor"], "GET", "/api/dashboards/out-of-turn");
    // Reviewing an out-of-turn allocation: the Dealer Principal and the Business Head only (404: there is none here).
    await only(["dp", "head"], "POST", "/api/out-of-turn/none/review", { note: "Checked" }, 404);
    // Users and the employee sheet: the System Admin only.
    await only(["admin"], "GET", "/api/users");
    await only(["admin"], "GET", "/api/users/template");
    // Settings and allocation rules: the System Admin, the Business Head and the Dealer Principal.
    await only(["admin", "dp", "head"], "PUT", "/api/settings", { payment_verify_hours: 24 });
    expect(await status("head", "PUT", "/api/settings", { dms_dealer_name: "OTHER MOTORS" })).toBe(403); // what ties the system to the DMS is the administrator's alone
    // The audit trail.
    await only(["admin", "dp", "head", "auditor"], "GET", "/api/audit");
    // The day-end reconciliation: seen by those who act on it, run by those who own it.
    await only(["admin", "dp", "head", "lead", "finance", "crm", "stock", "auditor"], "GET", "/api/recon/runs");
    await only(["admin", "head", "finance", "stock"], "POST", "/api/recon/run", undefined, 201);
    // The vehicle master: the System Admin (and the ordering desk, which this dealership has not staffed).
    await only(["admin"], "GET", "/api/master");
    // WhatsApp: set up by the System Admin; the log is read by management, the Sales Lead, CRM and the auditor.
    await only(["admin"], "PUT", "/api/wa/config", { enabled: true });
    await only(["admin", "dp", "head", "lead", "crm", "auditor"], "GET", "/api/wa/messages");
    // Correcting a customer's mobile number: CRM and the System Admin.
    await only(["admin", "crm"], "POST", `/api/bookings/${first.id}/contact`, { customer_mobile: "9876500011" });
    // The auditor reads everything and changes nothing.
    for (const [method, path, body] of [["POST", "/api/bookings", {}], ["POST", "/api/exceptions", {}], ["POST", "/api/allocations/run", {}], ["POST", `/api/bookings/${first.id}/cancel`, { reason: "x" }], ["POST", "/api/uploads/stock", {}], ["POST", "/api/vehicles", {}]] as const) {
      expect(await status("auditor", method, path, body), `auditor ${path}`).toBe(403);
    }
    // A sales executive sees only their own bookings; the Sales Lead sees the outlet's.
    expect((await w.api("GET", "/api/bookings", undefined, u.exec.session)).body.map((b: any) => b.booking_no)).toEqual(["OTF27A000001"]);
    expect((await w.api("GET", "/api/bookings", undefined, u.lead.session)).body.map((b: any) => b.booking_no).sort()).toEqual(["OTF27A000001", "OTF27A000002"]);
    expect(await status("exec", "GET", `/api/bookings/${booking(w, "OTF27A000002").id}`)).toBe(403);
    // Dealer price is shown to those who may see stock value, and to nobody else.
    const price = async (who: string) => (await w.api("GET", "/api/vehicles", undefined, u[who].session)).body[0].net_dealer_price;
    expect(await price("finance")).toBe(1000000);
    expect(await price("dp")).toBe(1000000);
    expect(await price("exec")).toBeUndefined();
    expect(await price("lead")).toBeUndefined();
    // Resetting a person's password: the System Admin only (it signs that person out, so it is checked last).
    for (const who of everyone.filter((x) => x !== "admin")) expect(await status(who, "POST", `/api/users/${u.auditor.id}/reset-password`), who).toBe(403);
    expect(await status("admin", "POST", `/api/users/${u.auditor.id}/reset-password`)).toBe(200);
    expect(await status("auditor", "GET", "/api/auth/me")).toBe(401);
  });

  it("the roles-and-controls table shows each persona, its purpose and what it may do under the current settings", async () => {
    const { w, d, first } = await start();
    const res = await w.api("GET", "/api/roles", undefined, d.users.lead.session);
    expect(res.status).toBe(200);
    const roles: any[] = res.body.roles;
    expect(roles.map((r) => r.label)).toEqual(["System Admin", "Dealer Principal", "Business Head / CEO", "Sales Lead", "Sales Executive", "Finance", "CRM", "Stock In-charge", "Ordering Desk", "Auditor"]);
    const perms = (role: string) => roles.find((r) => r.role === role).permissions as string[];
    expect(perms("ACCOUNTS")).toContain("booking.payment");
    expect(perms("SALES_EXEC")).toContain("booking.payment_report");
    expect(perms("SALES_EXEC")).not.toContain("booking.payment");
    expect(perms("BUSINESS_HEAD")).toContain("exception.decide");
    expect(perms("DEALER_PRINCIPAL")).toContain("exception.decide");
    expect(perms("SALES_MANAGER")).not.toContain("exception.decide");
    expect(roles.filter((r) => r.receives_alarms).map((r) => r.role)).toEqual(["DEALER_PRINCIPAL", "BUSINESS_HEAD"]);
    expect(res.body.permission_labels["booking.payment"]).toBe("Verify payments; record invoicing");
    // Exceptions need two people: whoever raises a request cannot decide it, even with the right role.
    const b2 = booking(w, "OTF27A000002");
    const raised = await w.api("POST", "/api/exceptions", { type: "PRIORITY_CHANGE", booking_id: b2.id, reason: "Customer's wedding date", payload: { before_booking_id: first.id } }, d.users.head.session);
    expect(raised.status).toBe(201);
    const self = await w.api("POST", `/api/exceptions/${raised.body.id}/approve`, { remarks: "ok" }, d.users.head.session);
    expect(self.status).toBe(403);
    expect((await w.api("POST", `/api/exceptions/${raised.body.id}/approve`, { remarks: "Seen the invitation" }, d.users.lead.session)).status).toBe(403);
    expect((await w.api("POST", `/api/exceptions/${raised.body.id}/approve`, { remarks: "Seen the invitation" }, d.users.dp.session)).status).toBe(200);
  });
});
