import type { Ctx, SessionUser } from "../env";
import { all, alertStmt, auditStmt, doneAlertStmt, first, isGuardFailure, run, stmt } from "../lib/db";
import { bad, conflict, forbidden, iso, localParts, newId, norm, normMobile, notFound, parseDate, parseDateTime, safeJson } from "../lib/util";
import { activeAllocationForBooking, allocateAll, allocateConfig, releaseAllocation, type AllocationOutcome } from "./allocation";
import { eventStmt } from "./inventory";
import { resolveConfig, type ConfigInput } from "./master";
import { alarmStmts } from "./alarms";
import { queueFor } from "./queue";
import { salesExecMessage } from "./staff-notify";

/** Whole local days between the booking date a booking carries and the day it was entered in the system. */
export function backdatedDays(ctx: Ctx, b: Pick<Booking, "booking_date" | "created_at">): number {
  const tz = ctx.tenant.timezone;
  const d = (isoTs: string) => new Date(`${localParts(new Date(isoTs), tz).date}T00:00:00Z`).getTime();
  return Math.max(0, Math.round((d(b.created_at) - d(b.booking_date)) / 86_400_000));
}

export interface Booking {
  id: string;
  tenant_id: string;
  outlet_id: string;
  variant_id: string | null;
  priority_override_json: string | null;
  booking_no: string;
  customer_name: string;
  customer_mobile: string;
  wa_opt_in: number;
  model: string;
  variant: string;
  colour: string;
  booking_date: string;
  priority_ts: string;
  booking_amount: number;
  expected_delivery_date: string | null;
  status: string;
  on_hold: number;
  hold_reason: string | null;
  hold_until: string | null;
  payment_reported_at: string | null;
  payment_reported_by: string | null;
  payment_amount: number | null;
  payment_ref: string | null;
  payment_note: string | null;
  payment_received_at: string | null;
  payment_verified_by: string | null;
  invoiced_at: string | null;
  delivered_at: string | null;
  sales_exec_id: string | null;
  checklist_json: string;
  source: string;
  submitted_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  decision_remarks: string | null;
  created_by: string;
  created_at: string;
}

export async function getBooking(ctx: Ctx, id: string): Promise<Booking> {
  const b = await first<Booking>(ctx.db, `SELECT * FROM bookings WHERE id = ? AND tenant_id = ?`, id, ctx.tenantId);
  if (!b) throw notFound("Booking");
  return b;
}

export interface BookingInput extends ConfigInput {
  booking_no?: string;
  outlet_id: string;
  customer_name: string;
  customer_mobile: string;
  wa_opt_in?: boolean;
  booking_date?: string;
  booking_amount?: number;
  expected_delivery_date?: string | null;
  sales_exec_id?: string | null;
}

async function generateBookingNo(ctx: Ctx): Promise<string> {
  const d = localParts(ctx.now, ctx.tenant.timezone).date.replace(/-/g, "").slice(2);
  for (let i = 0; i < 6; i++) {
    const n = `BK${d}-${String(Math.floor(Math.random() * 9000) + 1000)}`;
    if (!(await first(ctx.db, `SELECT id FROM bookings WHERE tenant_id = ? AND booking_no = ?`, ctx.tenantId, n))) return n;
  }
  return `BK${d}-${newId("x").slice(2, 10).toUpperCase()}`;
}

async function cleanInput(ctx: Ctx, input: BookingInput) {
  const mobile = normMobile(input.customer_mobile);
  if (!input.customer_name?.trim()) throw bad("Customer name is required");
  if (!mobile) throw bad("Customer mobile number is not valid");
  // The car booked must be a variant (and colour) from the vehicle master, when the dealership has one.
  const { variant_id, model, variant, colour } = await resolveConfig(ctx, input);
  const amount = Number(input.booking_amount ?? 0);
  if (!Number.isFinite(amount) || amount < 0) throw bad("Booking amount is not valid");
  let expected: string | null = null;
  if (input.expected_delivery_date) {
    expected = parseDate(input.expected_delivery_date);
    if (!expected) throw bad("Expected delivery date is not valid");
  }
  let bookingDate = iso(ctx.now);
  if (input.booking_date) {
    const p = parseDateTime(input.booking_date, ctx.tenant.timezone);
    if (!p) throw bad("Booking date is not valid");
    if (new Date(p).getTime() > ctx.now.getTime() + 60_000) throw bad("Booking date cannot be in the future");
    bookingDate = p;
  }
  return { mobile, variant_id, model, variant, colour, amount, expected, bookingDate, name: input.customer_name.trim().slice(0, 120) };
}

export async function createBooking(ctx: Ctx, input: BookingInput, user: SessionUser): Promise<Booking> {
  const c = await cleanInput(ctx, input);
  if (!(await first(ctx.db, `SELECT id FROM outlets WHERE id = ? AND tenant_id = ? AND is_active = 1`, input.outlet_id, ctx.tenantId))) throw bad("Outlet not found");
  const bookingNo = input.booking_no?.trim() ? norm(input.booking_no) : await generateBookingNo(ctx);
  if (await first(ctx.db, `SELECT id FROM bookings WHERE tenant_id = ? AND booking_no = ?`, ctx.tenantId, bookingNo)) throw conflict(`Booking number ${bookingNo} already exists`);
  const id = newId("bkg");
  const at = iso(ctx.now);
  const salesExec = input.sales_exec_id || (user.role === "SALES_CONSULTANT" ? user.id : null);
  if (salesExec && !(await first(ctx.db, `SELECT id FROM users WHERE id = ? AND tenant_id = ? AND is_active = 1`, salesExec, ctx.tenantId))) throw bad("Sales executive not found");
  await ctx.db.batch([
    stmt(
      ctx.db,
      `INSERT INTO bookings (id, tenant_id, outlet_id, booking_no, customer_name, customer_mobile, wa_opt_in, variant_id, model, variant, colour, booking_date, priority_ts, booking_amount, expected_delivery_date, status, sales_exec_id, source, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DRAFT',?,'APP',?,?,?)`,
      id, ctx.tenantId, input.outlet_id, bookingNo, c.name, c.mobile, input.wa_opt_in === false ? 0 : 1, c.variant_id, c.model, c.variant, c.colour, c.bookingDate, c.bookingDate, c.amount, c.expected, salesExec, user.id, at, at,
    ),
    auditStmt(ctx, "BOOKING_CREATED", "booking", id, { booking_no: bookingNo, model: c.model, variant: c.variant, colour: c.colour, outlet_id: input.outlet_id }),
  ]);
  return getBooking(ctx, id);
}

/** Before approval the booking can still be corrected. After approval, changes go through an exception request. */
export async function updateBooking(ctx: Ctx, id: string, patch: Partial<BookingInput>): Promise<Booking> {
  const b = await getBooking(ctx, id);
  if (!["DRAFT", "REJECTED"].includes(b.status)) throw conflict("Only a draft or rejected booking can be edited; use an exception request after submission");
  // The car is taken from the patch if it names one (by master variant, by name or by attributes); otherwise it stays as it is.
  const carGiven = patch.variant_id || patch.variant || patch.model || patch.trim;
  const car: ConfigInput = carGiven ? { variant_id: patch.variant_id, variant: patch.variant, model: patch.model, trim: patch.trim, transmission: patch.transmission, fuel: patch.fuel, drive: patch.drive, seater: patch.seater } : b.variant_id ? { variant_id: b.variant_id } : { model: b.model, variant: b.variant };
  const c = await cleanInput(ctx, {
    outlet_id: patch.outlet_id ?? b.outlet_id,
    customer_name: patch.customer_name ?? b.customer_name,
    customer_mobile: patch.customer_mobile ?? b.customer_mobile,
    ...car,
    colour: patch.colour ?? b.colour,
    booking_amount: patch.booking_amount ?? b.booking_amount,
    expected_delivery_date: patch.expected_delivery_date === undefined ? b.expected_delivery_date : patch.expected_delivery_date,
    booking_date: patch.booking_date ?? b.booking_date,
  });
  const outletId = patch.outlet_id ?? b.outlet_id;
  if (!(await first(ctx.db, `SELECT id FROM outlets WHERE id = ? AND tenant_id = ?`, outletId, ctx.tenantId))) throw bad("Outlet not found");
  const salesExec = patch.sales_exec_id === undefined ? b.sales_exec_id : patch.sales_exec_id || null;
  if (salesExec && !(await first(ctx.db, `SELECT id FROM users WHERE id = ? AND tenant_id = ? AND is_active = 1`, salesExec, ctx.tenantId))) throw bad("Sales executive not found");
  await ctx.db.batch([
    stmt(
      ctx.db,
      `UPDATE bookings SET outlet_id = ?, customer_name = ?, customer_mobile = ?, wa_opt_in = ?, variant_id = ?, model = ?, variant = ?, colour = ?, booking_date = ?, priority_ts = ?, booking_amount = ?, expected_delivery_date = ?, sales_exec_id = ?, status = 'DRAFT', updated_at = ? WHERE id = ? AND tenant_id = ? AND status IN ('DRAFT','REJECTED')`,
      outletId, c.name, c.mobile, patch.wa_opt_in === undefined ? b.wa_opt_in : patch.wa_opt_in ? 1 : 0, c.variant_id, c.model, c.variant, c.colour, c.bookingDate, c.bookingDate, c.amount, c.expected, salesExec, iso(ctx.now), id, ctx.tenantId,
    ),
    auditStmt(ctx, "BOOKING_EDITED", "booking", id, patch),
  ]);
  return getBooking(ctx, id);
}

/** The booking submission checklist (step 3 of the process). The person submitting confirms each item is on file; no copy is kept here. */
export const CHECKLIST_LABELS: Record<string, string> = {
  DOCKET: "Signed booking docket",
  KYC: "KYC documents",
  PAN_AADHAAR: "PAN card and Aadhaar card",
  PAYMENT_PROOF: "Proof of minimum booking amount (IMPS screenshot / money receipt)",
};

export interface ChecklistTick {
  by: string;
  at: string;
}

export function checklistOf(b: { checklist_json?: string | null }): Record<string, ChecklistTick> {
  return safeJson<Record<string, ChecklistTick>>(b.checklist_json, {});
}

export function missingChecklist(ctx: Ctx, b: { checklist_json?: string | null }): string[] {
  const have = checklistOf(b);
  return ctx.settings.required_documents.filter((k) => !have[k]);
}

/** Ticks or unticks checklist items on a booking that has not been submitted yet. */
export async function setChecklist(ctx: Ctx, id: string, ticks: Record<string, unknown>): Promise<Booking> {
  const b = await getBooking(ctx, id);
  if (!["DRAFT", "REJECTED"].includes(b.status)) throw conflict("The checklist can only be changed before the booking is submitted");
  const have = checklistOf(b);
  const changes: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(ticks ?? {})) {
    if (!(k in CHECKLIST_LABELS)) throw bad("Unknown checklist item");
    if (v && !have[k]) (have[k] = { by: ctx.actor, at: iso(ctx.now) }), (changes[k] = true);
    if (!v && have[k]) delete have[k], (changes[k] = false);
  }
  if (Object.keys(changes).length) {
    await ctx.db.batch([
      stmt(ctx.db, `UPDATE bookings SET checklist_json = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND status IN ('DRAFT','REJECTED')`, JSON.stringify(have), iso(ctx.now), id, ctx.tenantId),
      auditStmt(ctx, "BOOKING_CHECKLIST", "booking", id, changes),
    ]);
  }
  return getBooking(ctx, id);
}

export async function submitBooking(ctx: Ctx, id: string): Promise<Booking> {
  const b = await getBooking(ctx, id);
  if (!["DRAFT", "REJECTED"].includes(b.status)) throw conflict("This booking has already been submitted");
  const missing = missingChecklist(ctx, b);
  if (missing.length) throw bad(`Confirm these are on file before submitting: ${missing.map((k) => CHECKLIST_LABELS[k] ?? k).join("; ")}`, "CHECKLIST_INCOMPLETE");
  if (b.booking_amount < ctx.settings.min_booking_amount) throw bad(`Booking amount is below the minimum of ${ctx.settings.min_booking_amount}`, "AMOUNT_BELOW_MINIMUM");
  const at = iso(ctx.now);
  // The booking date decides the place in the queue, so a date earlier than the day of entry is pointed out to the approver.
  const back = backdatedDays(ctx, b);
  const note = back > 0 ? ` Booking date is ${back} day(s) before it was entered in the system; check the dates on the docket and the payment proof.` : "";
  await ctx.db.batch([
    stmt(ctx.db, `UPDATE bookings SET status = 'SUBMITTED', submitted_at = ?, decision_remarks = NULL, updated_at = ? WHERE id = ? AND tenant_id = ?`, at, at, id, ctx.tenantId),
    auditStmt(ctx, "BOOKING_SUBMITTED", "booking", id, back > 0 ? { backdated_days: back, booking_date: b.booking_date } : {}),
    ...ctx.settings.booking_approver_roles.map((role) =>
      alertStmt(ctx, { targetRole: role, outletId: b.outlet_id, kind: "BOOKING_APPROVAL", title: "Booking waiting for approval", body: `${b.booking_no}: ${b.customer_name}, ${b.model} ${b.variant} ${b.colour}.${note}`, entityType: "booking", entityId: id }),
    ),
  ]);
  return getBooking(ctx, id);
}

export async function approveBooking(ctx: Ctx, id: string, approver: SessionUser, remarks?: string): Promise<{ booking: Booking; allocations: AllocationOutcome[] }> {
  const b = await getBooking(ctx, id);
  if (b.status !== "SUBMITTED") throw conflict("Only a submitted booking can be approved");
  if (b.created_by === approver.id) throw forbidden("The person who created a booking cannot approve it");
  if (b.created_by.startsWith("UPLOAD:")) {
    // A booking that came in a file was "created" by whoever loaded the file.
    const up = await first<{ uploaded_by: string }>(ctx.db, `SELECT uploaded_by FROM uploads WHERE id = ? AND tenant_id = ?`, b.created_by.slice(7), ctx.tenantId);
    if (up?.uploaded_by === approver.id) throw forbidden("The person who loaded a booking cannot approve it");
  }
  const at = iso(ctx.now);
  try {
    await ctx.db.batch([
      auditStmt(ctx, "BOOKING_APPROVED", "booking", id, { remarks: remarks ?? null, backdated_days: backdatedDays(ctx, b) || undefined }, { sql: `SELECT 1 FROM bookings WHERE id = ? AND tenant_id = ? AND status = 'SUBMITTED'`, params: [id, ctx.tenantId] }),
      stmt(ctx.db, `UPDATE bookings SET status = 'APPROVED', approved_by = ?, approved_at = ?, decision_remarks = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND status = 'SUBMITTED'`, approver.id, at, remarks ?? null, at, id, ctx.tenantId),
      doneAlertStmt(ctx, "BOOKING_APPROVAL", id),
    ]);
  } catch (e) {
    if (isGuardFailure(e)) throw conflict("This booking has already been decided");
    throw e;
  }
  // Approval is the allocation trigger: the whole queue for this car is re-run, so order is preserved.
  const allocations = await allocateConfig(ctx, b);
  return { booking: await getBooking(ctx, id), allocations };
}

export async function rejectBooking(ctx: Ctx, id: string, approver: SessionUser, remarks: string): Promise<Booking> {
  const b = await getBooking(ctx, id);
  if (b.status !== "SUBMITTED") throw conflict("Only a submitted booking can be rejected");
  if (!remarks?.trim()) throw bad("A reason is required to reject a booking");
  const at = iso(ctx.now);
  await ctx.db.batch([
    stmt(ctx.db, `UPDATE bookings SET status = 'REJECTED', approved_by = ?, approved_at = ?, decision_remarks = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`, approver.id, at, remarks.trim(), at, id, ctx.tenantId),
    auditStmt(ctx, "BOOKING_REJECTED", "booking", id, { remarks: remarks.trim() }),
    doneAlertStmt(ctx, "BOOKING_APPROVAL", id),
    alertStmt(ctx, { targetUser: b.sales_exec_id ?? b.created_by, outletId: b.outlet_id, kind: "BOOKING_REJECTED", title: "Booking sent back", body: `${b.booking_no} (${b.customer_name}) was not approved: ${remarks.trim()}`, entityType: "booking", entityId: id }),
  ]);
  return getBooking(ctx, id);
}

export async function cancelBooking(ctx: Ctx, id: string, reason: string): Promise<{ allocations: AllocationOutcome[] }> {
  const b = await getBooking(ctx, id);
  if (!reason?.trim()) throw bad("A reason is required");
  if (!["DRAFT", "SUBMITTED", "APPROVED", "ALLOCATED", "REJECTED"].includes(b.status)) throw conflict("An invoiced or delivered booking cannot be cancelled here");
  const at = iso(ctx.now);
  const alloc = await activeAllocationForBooking(ctx, id);
  const cancel = [
    stmt(ctx.db, `UPDATE bookings SET status = 'CANCELLED', cancelled_at = ?, cancel_reason = ?, on_hold = 0, hold_reason = NULL, hold_until = NULL, updated_at = ? WHERE id = ? AND tenant_id = ?`, at, reason.trim(), at, id, ctx.tenantId),
    auditStmt(ctx, "BOOKING_CANCELLED", "booking", id, { reason: reason.trim() }),
    doneAlertStmt(ctx, "BOOKING_APPROVAL", id),
  ];
  // Cancelling and freeing the car are one step: a cancelled booking can never be left holding a car.
  if (alloc) return { allocations: await releaseAllocation(ctx, alloc, "BOOKING_CANCELLED", { also: cancel }) };
  await ctx.db.batch(cancel);
  return { allocations: [] };
}

/**
 * Sales reports that the customer has paid for the allocated car. This does not stop the payment
 * window: Finance has to verify it. While a reported payment waits for Finance the car is not
 * re-allocated, and if Finance does not act in the agreed time an alarm is raised.
 */
export async function reportPayment(ctx: Ctx, id: string, input: { amount?: unknown; reference?: unknown; note?: unknown }): Promise<Booking> {
  const b = await getBooking(ctx, id);
  if (b.status !== "ALLOCATED") throw conflict("A payment is reported against a booking that holds a car");
  if (b.payment_received_at) throw conflict("Finance has already verified the payment for this booking");
  if (b.payment_reported_at) throw conflict("A payment has already been reported for this booking and is waiting for Finance");
  const reference = String(input.reference ?? "").trim().slice(0, 80);
  if (!reference) throw bad("Give the payment reference (UTR, receipt or cheque number) so Finance can find it");
  const amount = input.amount === undefined || input.amount === null || input.amount === "" ? null : Number(input.amount);
  if (amount !== null && !(Number.isFinite(amount) && amount > 0)) throw bad("The amount is not valid");
  const note = String(input.note ?? "").trim().slice(0, 300) || null;
  const at = iso(ctx.now);
  try {
    await ctx.db.batch([
      auditStmt(ctx, "PAYMENT_REPORTED", "booking", id, { amount, reference, note }, { sql: `SELECT 1 FROM bookings WHERE id = ? AND tenant_id = ? AND status = 'ALLOCATED' AND payment_reported_at IS NULL AND payment_received_at IS NULL`, params: [id, ctx.tenantId] }),
      stmt(ctx.db, `UPDATE bookings SET payment_reported_at = ?, payment_reported_by = ?, payment_amount = ?, payment_ref = ?, payment_note = ?, payment_overdue_alarm_at = NULL, updated_at = ? WHERE id = ? AND tenant_id = ?`, at, ctx.actor, amount, reference, note, at, id, ctx.tenantId),
      alertStmt(ctx, { targetRole: "FINANCE", outletId: b.outlet_id, kind: "PAYMENT_TO_VERIFY", title: "Payment to verify", body: `Booking ${b.booking_no} (${b.customer_name}): payment reported${amount ? ` of ${amount.toLocaleString("en-IN")}` : ""}, reference ${reference}. Verify that it has been received.`, entityType: "booking", entityId: id }),
    ]);
  } catch (e) {
    if (isGuardFailure(e)) throw conflict("This booking was changed by someone else a moment ago. Refresh and try again.");
    throw e;
  }
  return getBooking(ctx, id);
}

/**
 * Finance verifies that the payment has been received. This is what stops the reminder, the escalation
 * and the re-allocation. A person who reported the payment cannot be the one to verify it.
 */
export async function verifyPayment(ctx: Ctx, id: string, verifier: SessionUser, input: { amount?: unknown; reference?: unknown; note?: unknown } = {}): Promise<Booking> {
  const b = await getBooking(ctx, id);
  if (b.status !== "ALLOCATED") throw conflict("Payment is verified against a booking that holds a car");
  if (b.payment_received_at) throw conflict("The payment is already verified");
  if (b.payment_reported_by === verifier.id) throw forbidden("The person who reported a payment cannot verify it");
  const reference = String(input.reference ?? "").trim().slice(0, 80) || b.payment_ref;
  if (!reference) throw bad("Give the payment reference (UTR, receipt or cheque number)");
  const amount = input.amount === undefined || input.amount === null || input.amount === "" ? b.payment_amount : Number(input.amount);
  if (amount !== null && !(Number.isFinite(amount) && amount > 0)) throw bad("The amount is not valid");
  const note = String(input.note ?? "").trim().slice(0, 300) || b.payment_note;
  const at = iso(ctx.now);
  try {
    await ctx.db.batch([
      auditStmt(ctx, "PAYMENT_VERIFIED", "booking", id, { amount, reference, note, reported_by: b.payment_reported_by }, { sql: `SELECT 1 FROM bookings WHERE id = ? AND tenant_id = ? AND status = 'ALLOCATED' AND payment_received_at IS NULL`, params: [id, ctx.tenantId] }),
      stmt(ctx.db, `UPDATE bookings SET payment_received_at = ?, payment_verified_by = ?, payment_amount = ?, payment_ref = ?, payment_note = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`, at, verifier.id, amount, reference, note, at, id, ctx.tenantId),
      doneAlertStmt(ctx, "PAYMENT_TO_VERIFY", id),
      ...(b.sales_exec_id ? [alertStmt(ctx, { targetUser: b.sales_exec_id, outletId: b.outlet_id, kind: "PAYMENT_VERIFIED", title: "Payment verified by Finance", body: `Booking ${b.booking_no} (${b.customer_name}): Finance has verified the payment. The car stays with this customer; proceed to invoicing.`, entityType: "booking", entityId: id })] : []),
      ...(await salesExecMessage(ctx, b, "Payment verified by Finance", "Finance has verified the payment. The car stays with this customer; proceed to invoicing.")),
    ]);
  } catch (e) {
    if (isGuardFailure(e)) throw conflict("This booking was changed by someone else a moment ago. Refresh and try again.");
    throw e;
  }
  return getBooking(ctx, id);
}

/** Finance finds that a reported payment has not been received. The payment window carries on from where it was. */
export async function rejectPayment(ctx: Ctx, id: string, note: string): Promise<Booking> {
  const b = await getBooking(ctx, id);
  if (!b.payment_reported_at || b.payment_received_at) throw conflict("There is no reported payment waiting for verification on this booking");
  if (!note?.trim()) throw bad("Say what was checked and not found");
  const at = iso(ctx.now);
  await ctx.db.batch([
    auditStmt(ctx, "PAYMENT_NOT_RECEIVED", "booking", id, { reference: b.payment_ref, amount: b.payment_amount, reported_by: b.payment_reported_by, note: note.trim() }, { sql: `SELECT 1 FROM bookings WHERE id = ? AND tenant_id = ? AND payment_reported_at IS NOT NULL AND payment_received_at IS NULL`, params: [id, ctx.tenantId] }),
    stmt(ctx.db, `UPDATE bookings SET payment_reported_at = NULL, payment_reported_by = NULL, payment_amount = NULL, payment_ref = NULL, payment_note = NULL, payment_overdue_alarm_at = NULL, updated_at = ? WHERE id = ? AND tenant_id = ?`, at, id, ctx.tenantId),
    doneAlertStmt(ctx, "PAYMENT_TO_VERIFY", id),
    alertStmt(ctx, { targetUser: b.payment_reported_by ?? b.sales_exec_id ?? b.created_by, outletId: b.outlet_id, kind: "PAYMENT_NOT_RECEIVED", title: "Finance could not find the payment", body: `Booking ${b.booking_no} (${b.customer_name}), reference ${b.payment_ref}: ${note.trim()} The payment window continues.`, entityType: "booking", entityId: id }),
  ]);
  return getBooking(ctx, id);
}

/** Reported payments Finance has not verified within the agreed time are raised as an alarm, once each. */
export async function raiseOverdueVerifications(ctx: Ctx, limit = 20): Promise<number> {
  const cutoff = new Date(ctx.now.getTime() - ctx.settings.payment_verify_hours * 3_600_000).toISOString();
  const due = await all<Booking>(ctx.db, `SELECT * FROM bookings WHERE tenant_id = ? AND status = 'ALLOCATED' AND payment_reported_at IS NOT NULL AND payment_received_at IS NULL AND payment_overdue_alarm_at IS NULL AND payment_reported_at <= ? LIMIT ?`, ctx.tenantId, cutoff, limit);
  for (const b of due) {
    await ctx.db.batch([
      stmt(ctx.db, `UPDATE bookings SET payment_overdue_alarm_at = ? WHERE id = ? AND tenant_id = ? AND payment_overdue_alarm_at IS NULL`, iso(ctx.now), b.id, ctx.tenantId),
      ...(await alarmStmts(ctx, { kind: "PAYMENT_VERIFY_OVERDUE", outletId: b.outlet_id, title: "Payment reported but not verified by Finance", body: `Booking ${b.booking_no} (${b.customer_name}): a payment (reference ${b.payment_ref}) was reported more than ${ctx.settings.payment_verify_hours} hours ago and Finance has not verified it. The car is being held for this customer meanwhile.`, entityType: "booking", entityId: b.id })),
    ]);
  }
  return due.length;
}

export async function invoiceBooking(ctx: Ctx, id: string): Promise<Booking> {
  const b = await getBooking(ctx, id);
  if (b.status !== "ALLOCATED") throw conflict("Only an allocated booking can be invoiced");
  const alloc = await activeAllocationForBooking(ctx, id);
  if (!alloc) throw conflict("This booking has no allocated car");
  const v = await first<{ id: string; vin: string; status: string }>(ctx.db, `SELECT id, vin, status FROM vehicles WHERE id = ? AND tenant_id = ?`, alloc.vehicle_id, ctx.tenantId);
  if (!v || v.status !== "RECEIVED") throw conflict("The allocated car has not been received at the dealership yet");
  const at = iso(ctx.now);
  await ctx.db.batch([
    stmt(ctx.db, `UPDATE bookings SET status = 'INVOICED', invoiced_at = ?, payment_received_at = COALESCE(payment_received_at, ?), updated_at = ? WHERE id = ? AND tenant_id = ?`, at, at, at, id, ctx.tenantId),
    stmt(ctx.db, `UPDATE vehicles SET status = 'INVOICED', invoiced_at = ?, dms_booking_no = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`, at, b.booking_no, at, v.id, ctx.tenantId),
    eventStmt(ctx, v.id, "INVOICED", "RECEIVED", "INVOICED", { booking_id: id }),
    auditStmt(ctx, "INVOICED", "booking", id, { vehicle_id: v.id, vin: v.vin }),
  ]);
  return getBooking(ctx, id);
}

export async function deliverBooking(ctx: Ctx, id: string): Promise<Booking> {
  const b = await getBooking(ctx, id);
  if (b.status !== "INVOICED") throw conflict("Only an invoiced booking can be marked delivered");
  const alloc = await activeAllocationForBooking(ctx, id);
  const at = iso(ctx.now);
  const stmts = [
    stmt(ctx.db, `UPDATE bookings SET status = 'DELIVERED', delivered_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`, at, at, id, ctx.tenantId),
    auditStmt(ctx, "DELIVERED", "booking", id, { vehicle_id: alloc?.vehicle_id ?? null }),
  ];
  if (alloc) {
    stmts.push(
      stmt(ctx.db, `UPDATE allocations SET status = 'FULFILLED', fulfilled_at = ? WHERE id = ?`, at, alloc.id),
      stmt(ctx.db, `UPDATE vehicles SET status = 'DELIVERED', delivered_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`, at, at, alloc.vehicle_id, ctx.tenantId),
      eventStmt(ctx, alloc.vehicle_id, "DELIVERED", "INVOICED", "DELIVERED", { booking_id: id }),
    );
  }
  await ctx.db.batch(stmts);
  return getBooking(ctx, id);
}

/** Staff confirm that a customer who was on hold is ready again; the booking rejoins the queue with its original priority. */
export async function markReady(ctx: Ctx, id: string): Promise<{ allocations: AllocationOutcome[] }> {
  const b = await getBooking(ctx, id);
  if (!b.on_hold) throw conflict("This booking is not on hold");
  if (b.status !== "APPROVED") throw conflict("Only a waiting booking can be released from hold");
  await ctx.db.batch([
    stmt(ctx.db, `UPDATE bookings SET on_hold = 0, hold_reason = NULL, hold_until = NULL, updated_at = ? WHERE id = ? AND tenant_id = ?`, iso(ctx.now), id, ctx.tenantId),
    auditStmt(ctx, "HOLD_LIFTED", "booking", id, { previous_reason: b.hold_reason }),
  ]);
  return { allocations: await allocateConfig(ctx, b) };
}

/** Place in the queue among bookings still waiting for the same car, under the dealership's queue rules. */
export async function queuePosition(ctx: Ctx, b: Pick<Booking, "id" | "model" | "variant" | "colour" | "outlet_id">): Promise<{ position: number; waiting: number }> {
  const q = await queueFor(ctx, b);
  const i = q.findIndex((x) => x.id === b.id);
  return { position: i < 0 ? q.length + 1 : i + 1, waiting: q.length };
}

