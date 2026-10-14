// "What would these rules do?" Shown on the Allocation rules screen before a change is saved. Nothing
// is written: the same comparison and matching functions that allocation uses are run twice, once with
// the rules in force and once with the proposed ones, over the bookings waiting and the cars free now.

import type { Ctx } from "../env";
import { all } from "../lib/db";
import type { TenantSettings } from "../lib/settings";
import { queueKey, waitingQueues, type Waiting } from "./queue";
import { matchBookings, queueCompare, type QueueCar } from "./rules";

interface FreeCar extends QueueCar {
  model: string;
  variant: string;
  colour: string;
}

export async function previewRules(ctx: Ctx, proposed: TenantSettings, outletName: Map<string, string>) {
  const freeCars = async (s: TenantSettings) => {
    const rows = await all<FreeCar>(
      ctx.db,
      `SELECT v.id, v.vin, v.outlet_id, v.status, v.expected_arrival_date, v.wholesale_invoice_date, v.received_at, v.model, v.variant, v.colour FROM vehicles v
       WHERE v.tenant_id = ? AND v.status IN (${s.allocate_in_transit ? "'RECEIVED','IN_TRANSIT'" : "'RECEIVED'"}) AND v.is_blocked = 0
         AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.vehicle_id = v.id AND a.status = 'ACTIVE') LIMIT 3000`,
      ctx.tenantId,
    );
    const byCar = new Map<string, FreeCar[]>();
    for (const v of rows) {
      const k = `${v.model}|${v.variant}|${v.colour}`;
      if (!byCar.has(k)) byCar.set(k, []);
      byCar.get(k)!.push(v);
    }
    return byCar;
  };
  const carsNow = await freeCars(ctx.settings);
  const carsThen = proposed.allocate_in_transit === ctx.settings.allocate_in_transit ? carsNow : await freeCars(proposed);

  /** Position of each booking in its queue under one set of rules (each outlet has its own queue under "own outlet only"). */
  const positions = (waiting: Waiting[], s: TenantSettings) => {
    const queues = new Map<string, Waiting[]>();
    for (const b of waiting) {
      const k = queueKey(s, b);
      if (!queues.has(k)) queues.set(k, []);
      queues.get(k)!.push(b);
    }
    const out = new Map<string, number>();
    for (const q of queues.values()) [...q].sort(queueCompare(s)).forEach((b, i) => out.set(b.id, i + 1));
    return out;
  };

  // Everyone waiting, grouped by car regardless of outlet, so both sets of rules are judged on the same bookings.
  const groupsByCar = await waitingQueues(ctx, undefined, { ...ctx.settings, outlet_scope: "ANY_OUTLET" });
  let affected = 0, total = 0;
  const groups = [...groupsByCar.entries()].map(([key, waiting]) => {
    total += waiting.length;
    const posNow = positions(waiting, ctx.settings), posThen = positions(waiting, proposed);
    const carNow = new Map(matchBookings(waiting, carsNow.get(key) ?? [], ctx.settings).map((m) => [m.booking.id, m.vehicle]));
    const carThen = new Map(matchBookings(waiting, carsThen.get(key) ?? [], proposed).map((m) => [m.booking.id, m.vehicle]));
    const rows = waiting.map((b) => {
      const a = carNow.get(b.id), z = carThen.get(b.id);
      const changed = posNow.get(b.id) !== posThen.get(b.id) || a?.id !== z?.id;
      if (changed) affected++;
      const car = (v?: FreeCar) => (v ? { vin: v.vin, outlet: outletName.get(v.outlet_id) ?? "", status: v.status } : null);
      return {
        booking_no: b.booking_no, outlet: outletName.get(b.outlet_id) ?? "", booking_date: b.booking_date, expected_delivery_date: b.expected_delivery_date ?? null, booking_amount: b.booking_amount ?? 0,
        position_now: posNow.get(b.id) ?? null, position_then: posThen.get(b.id) ?? null, car_now: car(a), car_then: car(z), changed,
      };
    });
    const [model, variant, colour] = key.split("|");
    return { model, variant, colour, waiting: waiting.length, free_cars: (carsThen.get(key) ?? []).length, changed: rows.filter((r) => r.changed).length, rows: rows.sort((x, y) => (x.position_then ?? 0) - (y.position_then ?? 0) || x.booking_no.localeCompare(y.booking_no)).slice(0, 25) };
  });
  groups.sort((x, y) => y.changed - x.changed || y.waiting - x.waiting);
  return { waiting_bookings: total, bookings_affected: affected, groups: groups.slice(0, 20) };
}
