// The sales executive's WhatsApp message. Every event a sales executive is alerted about in the app
// (allocation, arrival, payment verified, payment pending, car released) also goes to their mobile on
// WhatsApp, through one editable template, so they hear of it without opening the app.

import type { Ctx } from "../env";
import { first } from "../lib/db";
import { messageStmt } from "../whatsapp/outbox";

/** The statement that messages the booking's sales executive, or nothing when the booking has none. */
export async function salesExecMessage(ctx: Ctx, b: { sales_exec_id?: string | null; id: string; booking_no: string; customer_name: string }, title: string, detail: string): Promise<D1PreparedStatement[]> {
  if (!b.sales_exec_id) return [];
  const key = `user:${b.sales_exec_id}`;
  let u = ctx.cache.get(key) as { name: string; mobile: string } | null | undefined;
  if (u === undefined) {
    u = await first<{ name: string; mobile: string }>(ctx.db, `SELECT name, mobile FROM users WHERE id = ? AND tenant_id = ? AND is_active = 1`, b.sales_exec_id, ctx.tenantId);
    ctx.cache.set(key, u);
  }
  if (!u) return [];
  return [await messageStmt(ctx, { eventKey: "SALES_EXEC_UPDATE", toMobile: u.mobile, toName: u.name, bookingId: b.id, params: { name: u.name, booking_no: b.booking_no, customer_name: b.customer_name, title, detail: detail.slice(0, 600) } })];
}
