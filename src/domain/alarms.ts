// Alarms: the few events that need the Business Head / CEO or the Dealer Principal, not just the person
// doing the work. Who receives them is the dealership's setting (alarm_roles). An alarm appears in the
// app for each of those roles and goes to each of those people on WhatsApp. Like every other message it
// is written in the same batch as the change that caused it, so an alarm is never lost or sent twice.
//
// What raises an alarm:
//   BYPASS                  a car reserved for one booking was allotted or invoiced to another in the DMS
//   OUT_OF_TURN             a car was allotted in the DMS ahead of an earlier booking, with no approval
//   CAR_LEFT_STOCK          a reserved car is no longer in the stock report and its booking is not invoiced
//   INVOICE_REVERSED        a retail invoice the DMS showed has been cancelled there
//   ESCALATION              payment not received by the escalation day
//   REALLOCATED             a car was taken back after the payment window and given to the next customer
//   PAYMENT_VERIFY_OVERDUE  sales reported a payment and Finance has not verified it in the agreed time
//   STALE_DATA              the DMS files have not been loaded for longer than agreed
//   RECON_HIGH              the day-end reconciliation found high-severity differences

import type { Ctx } from "../env";
import { all, alertStmt } from "../lib/db";
import { messageStmt } from "../whatsapp/outbox";

export const ALARM_KINDS: Record<string, string> = {
  BYPASS: "Car given to a different booking than the one it was reserved for",
  OUT_OF_TURN: "Car allotted ahead of an earlier booking without approval",
  CAR_LEFT_STOCK: "Reserved car no longer in stock",
  INVOICE_REVERSED: "Retail invoice cancelled in the DMS",
  ESCALATION: "Payment not received by the escalation day",
  REALLOCATED: "Car taken back after the payment window",
  PAYMENT_VERIFY_OVERDUE: "Payment reported but not verified by Finance",
  STALE_DATA: "DMS files not updated",
  RECON_HIGH: "Day-end reconciliation found high-severity differences",
};

export interface Alarm {
  kind: keyof typeof ALARM_KINDS | string;
  title: string;
  body: string;
  outletId?: string | null;
  entityType?: string;
  entityId?: string;
  /** False when the event already sends its own WhatsApp message to the same people. */
  whatsapp?: boolean;
}

/** The people who receive alarms: active users of the alarm roles. Read once per request. */
export async function alarmRecipients(ctx: Ctx): Promise<{ id: string; name: string; mobile: string; role: string }[]> {
  let people = ctx.cache.get("alarm_recipients") as { id: string; name: string; mobile: string; role: string }[] | undefined;
  if (!people) {
    const roles = ctx.settings.alarm_roles;
    people = roles.length ? await all(ctx.db, `SELECT id, name, mobile, role FROM users WHERE tenant_id = ? AND is_active = 1 AND role IN (${roles.map(() => "?").join(",")})`, ctx.tenantId, ...roles) : [];
    ctx.cache.set("alarm_recipients", people);
  }
  return people;
}

/** The statements that raise one alarm: an in-app alarm for each alarm role and a WhatsApp message to each of those people. */
export async function alarmStmts(ctx: Ctx, a: Alarm): Promise<D1PreparedStatement[]> {
  const stmts = ctx.settings.alarm_roles.map((role) => alertStmt(ctx, { targetRole: role, outletId: a.outletId, kind: a.kind, title: a.title, body: a.body, entityType: a.entityType, entityId: a.entityId, isAlarm: true }));
  if (a.whatsapp !== false) {
    for (const p of await alarmRecipients(ctx)) {
      stmts.push(await messageStmt(ctx, { eventKey: "MANAGEMENT_ALARM", toMobile: p.mobile, toName: p.name, bookingId: a.entityType === "booking" ? a.entityId : null, params: { dealership: ctx.tenant.name, title: a.title, detail: a.body.slice(0, 600) } }));
    }
  }
  return stmts;
}
