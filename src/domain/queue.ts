// The waiting queue as people see it: for each model / variant / colour, the bookings waiting for a car
// in the order the dealership's rules will serve them. Positions shown on screens, the order checked at
// day end and the order allocation uses are all computed by the same comparison (rules.ts).

import type { Ctx } from "../env";
import { all } from "../lib/db";
import type { TenantSettings } from "../lib/settings";
import { queueCompare, type QueueBooking } from "./rules";

export interface Waiting extends QueueBooking {
  model: string;
  variant: string;
  colour: string;
  booking_date: string;
  customer_name: string;
  approved_at: string | null;
  created_at: string;
}

/** Bookings queue together when they wait for the same car; with "own outlet only", each outlet has its own queue. */
export function queueKey(settings: Pick<TenantSettings, "outlet_scope">, b: { model: string; variant: string; colour: string; outlet_id: string }): string {
  return `${b.model}|${b.variant}|${b.colour}${settings.outlet_scope === "SAME_OUTLET_ONLY" ? `|${b.outlet_id}` : ""}`;
}

/** Every waiting booking of the dealership (optionally of one model / variant / colour), grouped into queues and sorted. */
export async function waitingQueues(ctx: Ctx, cfg?: { model: string; variant: string; colour: string }, settings: TenantSettings = ctx.settings): Promise<Map<string, Waiting[]>> {
  const rows = await all<Waiting>(
    ctx.db,
    `SELECT id, booking_no, outlet_id, model, variant, colour, booking_date, priority_ts, expected_delivery_date, booking_amount, priority_override_json, customer_name, approved_at, created_at
     FROM bookings WHERE tenant_id = ? AND status = 'APPROVED' AND on_hold = 0 ${cfg ? "AND model = ? AND variant = ? AND colour = ?" : ""} LIMIT 5000`,
    ...(cfg ? [ctx.tenantId, cfg.model, cfg.variant, cfg.colour] : [ctx.tenantId]),
  );
  const queues = new Map<string, Waiting[]>();
  for (const r of rows) {
    const k = queueKey(settings, r);
    if (!queues.has(k)) queues.set(k, []);
    queues.get(k)!.push(r);
  }
  const cmp = queueCompare(settings);
  for (const q of queues.values()) q.sort(cmp);
  return queues;
}

/** Position of every waiting booking in its queue. */
export async function queuePositions(ctx: Ctx): Promise<Map<string, { position: number; waiting: number }>> {
  const out = new Map<string, { position: number; waiting: number }>();
  for (const q of (await waitingQueues(ctx)).values()) q.forEach((b, i) => out.set(b.id, { position: i + 1, waiting: q.length }));
  return out;
}

/** The queue one booking stands in, in order. */
export async function queueFor(ctx: Ctx, b: { model: string; variant: string; colour: string; outlet_id: string }): Promise<Waiting[]> {
  return (await waitingQueues(ctx, b)).get(queueKey(ctx.settings, b)) ?? [];
}
