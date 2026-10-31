// The payment window: reminder, escalation and automatic re-allocation.
//
// This is a durable process, not an in-memory timer. The stage of every allocation lives in the
// database (clock_started_at, reminder_sent_at, escalated_at, released_at). The scheduled job calls
// `advancePaymentWindow` for each open allocation; the function reads the stored stage, performs at
// most the steps that are due, and records them in the same transaction as their messages. Running it
// twice, late, or after a failure gives the same result. The same function can be driven by a
// Cloudflare Workflow (step.sleepUntil + step.do) without changing the rules.

import type { Ctx } from "../env";
import { all, alertStmt, auditStmt, isGuardFailure, stmt } from "../lib/db";
import { addDays, HttpError, iso, localParts } from "../lib/util";
import { messageStmt } from "../whatsapp/outbox";
import { alarmRecipients, alarmStmts } from "./alarms";
import { allocateConfig, dealershipLabel, formatDate, releaseAllocation, vehicleLabel, type AllocationOutcome } from "./allocation";
import { dataStatus } from "./data-status";
import { salesExecMessage } from "./staff-notify";

interface OpenWindow {
  id: string;
  booking_id: string;
  vehicle_id: string;
  clock_started_at: string;
  window_extension_days: number;
  reminder_sent_at: string | null;
  escalated_at: string | null;
  /** Set when the DMS file itself says this car is allotted to this order. Such an allocation is not ours to undo. */
  dms_confirmed_at: string | null;
  payment_reported_at: string | null;
  booking_no: string;
  customer_name: string;
  customer_mobile: string;
  wa_opt_in: number;
  outlet_id: string;
  sales_exec_id: string | null;
  vin: string;
  model: string;
  variant: string;
  colour: string;
}

export interface WindowSchedule {
  day: number; // whole local calendar days since the car was at the dealership
  reminder_on: string;
  escalation_on: string;
  release_on: string;
}

/** Calendar dates on which each step falls, in the dealership's own timezone. */
export function windowSchedule(ctx: Ctx, clockStartedAt: string, extensionDays: number): WindowSchedule {
  const tz = ctx.tenant.timezone;
  const start = localParts(new Date(clockStartedAt), tz).date;
  const today = localParts(ctx.now, tz).date;
  const day = Math.round((new Date(`${today}T00:00:00Z`).getTime() - new Date(`${start}T00:00:00Z`).getTime()) / 86_400_000);
  const s = ctx.settings;
  return {
    day,
    reminder_on: addDays(start, s.reminder_days + extensionDays),
    escalation_on: addDays(start, s.escalation_days + extensionDays),
    release_on: addDays(start, s.reallocate_days + extensionDays),
  };
}

export function withinBusinessHours(ctx: Ctx): boolean {
  const t = localParts(ctx.now, ctx.tenant.timezone).time;
  return t >= ctx.settings.business_hours_from && t < ctx.settings.business_hours_to;
}

export interface WindowResult {
  reminders: number;
  escalations: number;
  released: number;
  reallocated: AllocationOutcome[];
  /** Cars due for release that were left with their customer: a payment is waiting for Finance, or the DMS files are out of date. */
  held: number;
}

async function openWindows(ctx: Ctx, allocationId?: string): Promise<OpenWindow[]> {
  return all<OpenWindow>(
    ctx.db,
    `SELECT a.id, a.booking_id, a.vehicle_id, a.clock_started_at, a.window_extension_days, a.reminder_sent_at, a.escalated_at, a.dms_confirmed_at, b.payment_reported_at,
            b.booking_no, b.customer_name, b.customer_mobile, b.wa_opt_in, b.outlet_id, b.sales_exec_id, v.vin, v.model, v.variant, v.colour
     FROM allocations a JOIN bookings b ON b.id = a.booking_id JOIN vehicles v ON v.id = a.vehicle_id
     WHERE a.tenant_id = ? AND a.status = 'ACTIVE' AND a.clock_started_at IS NOT NULL
       AND b.status = 'ALLOCATED' AND b.payment_received_at IS NULL ${allocationId ? "AND a.id = ?" : ""}`,
    ...(allocationId ? [ctx.tenantId, allocationId] : [ctx.tenantId]),
  );
}

/** Performs whatever is due for one allocation. Idempotent: each step is written in one batch that only goes through once. */
export async function advancePaymentWindow(ctx: Ctx, w: OpenWindow, result: WindowResult): Promise<void> {
  const today = localParts(ctx.now, ctx.tenant.timezone).date;
  const sch = windowSchedule(ctx, w.clock_started_at, w.window_extension_days);
  const at = iso(ctx.now);
  // Most runs find nothing due; return before touching the database.
  if (today < sch.reminder_on) return;
  if (today < sch.escalation_on && w.reminder_sent_at) return;
  if (today < sch.release_on && today >= sch.escalation_on && w.escalated_at) return;
  const active = (column: string) => ({ sql: `SELECT 1 FROM allocations WHERE id = ? AND tenant_id = ? AND status = 'ACTIVE' AND ${column} IS NULL`, params: [w.id, ctx.tenantId] });

  if (today >= sch.release_on) {
    // A car the DMS itself allotted to this order is never taken back here. The DMS is the dealership's
    // record of who has which car; releasing one against it would put the two systems in conflict and
    // the next file load would simply assert it again. The overdue payment is still raised — somebody
    // has to chase it — but freeing the car is a decision for the dealership to make in the DMS.
    if (w.dms_confirmed_at) {
      result.held++;
      if (!w.escalated_at) {
        await escalateDmsHold(ctx, w, sch, at);
        result.escalations++;
      }
      return;
    }
    // A car is not taken back while a payment the sales team reported is waiting for Finance to verify,
    // nor while the DMS files are out of date: the customer may have paid and been invoiced since the
    // last file. Both situations raise their own alarm; the release happens once they are cleared.
    if (w.payment_reported_at || (await dataStatus(ctx)).stale) {
      result.held++;
      return;
    }
    // Day of re-allocation: free the car and hand it to the next eligible booking. The release, the
    // alerts and (without a hold) the move to the back of the queue are one batch.
    const hold = ctx.settings.hold_after_timeout ? { reason: "PAYMENT_TIMEOUT", until: null } : undefined;
    const also = [
      ...(await alarmStmts(ctx, { kind: "REALLOCATED", outletId: w.outlet_id, title: "Car released after payment timeout", body: `${vehicleLabel(w)} (${w.vin}) was released from booking ${w.booking_no} (${w.customer_name}) after ${sch.day} days without payment.`, entityType: "booking", entityId: w.booking_id })),
      alertStmt(ctx, { targetRole: "SALES_LEAD", outletId: w.outlet_id, kind: "REALLOCATED", title: "Car released after payment timeout", body: `Booking ${w.booking_no} (${w.customer_name}) lost its allocated ${vehicleLabel(w)}. ${hold ? "The booking is on hold until the customer is ready." : "The booking has rejoined the queue."}`, entityType: "booking", entityId: w.booking_id }),
    ];
    if (w.sales_exec_id) {
      const detail = `Booking ${w.booking_no} (${w.customer_name}) did not complete payment in ${sch.day} days, so ${vehicleLabel(w)} (${w.vin}) has been released. ${hold ? "Ask your manager to mark the customer ready when payment is arranged." : "The booking has rejoined the queue."}`;
      also.push(alertStmt(ctx, { targetUser: w.sales_exec_id, outletId: w.outlet_id, kind: "REALLOCATED", title: "Your booking lost its car", body: detail, entityType: "booking", entityId: w.booking_id }), ...(await salesExecMessage(ctx, { id: w.booking_id, sales_exec_id: w.sales_exec_id, booking_no: w.booking_no, customer_name: w.customer_name }, "Your booking lost its car", detail)));
    }
    // Without a hold the booking rejoins at the back of the queue, otherwise it would win the same car again.
    if (!hold) also.push(stmt(ctx.db, `UPDATE bookings SET priority_ts = ?, priority_override_json = NULL, updated_at = ? WHERE id = ? AND tenant_id = ?`, at, at, w.booking_id, ctx.tenantId));
    const next = await releaseAllocation(ctx, w, "PAYMENT_TIMEOUT", { hold, also });
    result.released++;
    result.reallocated.push(...next);
    return;
  }

  if (today >= sch.escalation_on && !w.escalated_at) {
    const heads = await alarmRecipients(ctx);
    const params = { vehicle: `${vehicleLabel(w)} (chassis ${w.vin})`, customer_name: w.customer_name, booking_no: w.booking_no, days: String(sch.day), release_date: formatDate(sch.release_on) };
    const stmts = [
      // Guarded on "not escalated yet", so the step fires once even if two runs overlap.
      auditStmt(ctx, "PAYMENT_ESCALATED", "booking", w.booking_id, { allocation_id: w.id, day: sch.day, release_on: sch.release_on }, active("escalated_at")),
      stmt(ctx.db, `UPDATE allocations SET escalated_at = ? WHERE id = ? AND tenant_id = ?`, at, w.id, ctx.tenantId),
      // The escalation has its own WhatsApp message (below), so the alarm itself is raised in the app only.
      ...(await alarmStmts(ctx, { kind: "ESCALATION", outletId: w.outlet_id, whatsapp: false, title: "Payment pending on an allocated car", body: `${vehicleLabel(w)} (${w.vin}) has been allocated to ${w.customer_name}, booking ${w.booking_no}, for ${sch.day} days with no payment${w.payment_reported_at ? " verified (a payment has been reported and is waiting for Finance)" : ""}. It will be re-allocated on ${formatDate(sch.release_on)}.`, entityType: "booking", entityId: w.booking_id })),
    ];
    for (const h of heads) stmts.push(await messageStmt(ctx, { eventKey: "PAYMENT_ESCALATION", toMobile: h.mobile, toName: h.name, bookingId: w.booking_id, params }));
    await ctx.db.batch(stmts);
    result.escalations++;
    return;
  }

  if (today >= sch.reminder_on && !w.reminder_sent_at) {
    const dealership = await dealershipLabel(ctx, w.outlet_id);
    const stmts = [
      auditStmt(ctx, "PAYMENT_REMINDER_SENT", "booking", w.booking_id, { allocation_id: w.id, day: sch.day }, active("reminder_sent_at")),
      stmt(ctx.db, `UPDATE allocations SET reminder_sent_at = ? WHERE id = ? AND tenant_id = ?`, at, w.id, ctx.tenantId),
      await messageStmt(ctx, {
        eventKey: "PAYMENT_REMINDER",
        toMobile: w.customer_mobile,
        toName: w.customer_name,
        bookingId: w.booking_id,
        optIn: Boolean(w.wa_opt_in),
        params: { customer_name: w.customer_name, days: String(sch.day), vehicle: vehicleLabel(w), dealership },
      }),
    ];
    if (w.sales_exec_id) {
      const detail = `Booking ${w.booking_no} (${w.customer_name}): ${sch.day} days since the car arrived and no payment yet. The customer has been reminded. The car is re-allocated on ${formatDate(sch.release_on)}.`;
      stmts.push(alertStmt(ctx, { targetUser: w.sales_exec_id, outletId: w.outlet_id, kind: "PAYMENT_PENDING", title: "Payment pending on your booking", body: detail, entityType: "booking", entityId: w.booking_id }), ...(await salesExecMessage(ctx, { id: w.booking_id, sales_exec_id: w.sales_exec_id, booking_no: w.booking_no, customer_name: w.customer_name }, "Payment pending on your booking", detail)));
    }
    await ctx.db.batch(stmts);
    result.reminders++;
  }
}

/**
 * An allotment the DMS made has passed its payment day. The car stays where the DMS put it; what this
 * raises is the money. Management and the booking's own consultant are told once — through the alarm
 * wording rather than the payment-escalation wording, which promises a re-allocation that is not going
 * to happen here.
 */
async function escalateDmsHold(ctx: Ctx, w: OpenWindow, sch: WindowSchedule, at: string): Promise<void> {
  const detail = `${vehicleLabel(w)} (${w.vin}) is allotted to booking ${w.booking_no} (${w.customer_name}) in the DMS and has been for ${sch.day} days with no payment${w.payment_reported_at ? " verified (a payment has been reported and is waiting for Finance)" : ""}. The allotment is the DMS's own, so the car has not been released: either collect the payment or free the car in the DMS.`;
  const stmts = [
    // Guarded on "not escalated yet", so this fires once however often the job runs.
    auditStmt(ctx, "PAYMENT_ESCALATED", "booking", w.booking_id, { allocation_id: w.id, day: sch.day, dms_allotment: true }, { sql: `SELECT 1 FROM allocations WHERE id = ? AND tenant_id = ? AND status = 'ACTIVE' AND escalated_at IS NULL`, params: [w.id, ctx.tenantId] }),
    stmt(ctx.db, `UPDATE allocations SET escalated_at = ? WHERE id = ? AND tenant_id = ?`, at, w.id, ctx.tenantId),
    ...(await alarmStmts(ctx, { kind: "ESCALATION", outletId: w.outlet_id, title: "Payment overdue on a car the DMS allotted", body: detail, entityType: "booking", entityId: w.booking_id })),
  ];
  if (w.sales_exec_id) {
    stmts.push(
      alertStmt(ctx, { targetUser: w.sales_exec_id, outletId: w.outlet_id, kind: "PAYMENT_PENDING", title: "Payment overdue on your booking", body: detail, entityType: "booking", entityId: w.booking_id }),
      ...(await salesExecMessage(ctx, { id: w.booking_id, sales_exec_id: w.sales_exec_id, booking_no: w.booking_no, customer_name: w.customer_name }, "Payment overdue on your booking", detail)),
    );
  }
  await ctx.db.batch(stmts);
}

/**
 * Advances the open payment windows of the dealership. Called by the scheduled job. `budget` limits how
 * many steps one firing takes; what is left over is done on the next firing a few minutes later.
 */
export async function processPaymentWindows(ctx: Ctx, budget: { left: number } = { left: 200 }): Promise<WindowResult> {
  const result: WindowResult = { reminders: 0, escalations: 0, released: 0, reallocated: [], held: 0 };
  for (const w of await openWindows(ctx)) {
    if (budget.left <= 0) break;
    const before = result.reminders + result.escalations + result.released * 3 + result.reallocated.length;
    try {
      await advancePaymentWindow(ctx, w, result);
    } catch (e) {
      // Another run or a user got there first (guard), or a one-off database error: this window is tried again next time.
      if (!isGuardFailure(e) && !(e instanceof HttpError)) console.error(`payment window ${w.id} failed:`, e);
    }
    budget.left -= result.reminders + result.escalations + result.released * 3 + result.reallocated.length - before;
  }
  return result;
}

/** Bookings whose hold date has passed rejoin the queue. */
export async function liftExpiredHolds(ctx: Ctx): Promise<number> {
  const today = localParts(ctx.now, ctx.tenant.timezone).date;
  const due = await all<{ id: string; model: string; variant: string; colour: string; hold_reason: string | null }>(
    ctx.db,
    `SELECT id, model, variant, colour, hold_reason FROM bookings WHERE tenant_id = ? AND status = 'APPROVED' AND on_hold = 1 AND hold_until IS NOT NULL AND hold_until <= ? LIMIT 25`,
    ctx.tenantId,
    today,
  );
  for (const b of due) {
    await ctx.db.batch([
      stmt(ctx.db, `UPDATE bookings SET on_hold = 0, hold_reason = NULL, hold_until = NULL, updated_at = ? WHERE id = ? AND tenant_id = ?`, iso(ctx.now), b.id, ctx.tenantId),
      auditStmt(ctx, "HOLD_LIFTED", "booking", b.id, { previous_reason: b.hold_reason, automatic: true }),
    ]);
    await allocateConfig(ctx, b);
  }
  return due.length;
}
