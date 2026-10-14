// The allocation rules, as pure functions of the dealership's settings. Nothing here is fixed in code:
// which booking is served first, which car it is given and how far allocation may look across outlets
// are all read from the settings the administrator edits on the Allocation rules screen.

import type { TenantSettings } from "../lib/settings";
import { safeJson } from "../lib/util";

export type Rules = Pick<TenantSettings, "queue_order" | "car_order" | "outlet_scope" | "nearby_outlets">;

export interface QueueBooking {
  id: string;
  booking_no: string;
  outlet_id: string;
  priority_ts: string;
  expected_delivery_date?: string | null;
  booking_amount?: number | null;
  /** Set by an approved "move ahead of booking X": the values this booking queues with instead of its own. */
  priority_override_json?: string | null;
}

export interface QueueCar {
  id: string;
  vin: string;
  outlet_id: string;
  status: string;
  expected_arrival_date: string | null;
  wholesale_invoice_date: string | null;
  received_at: string | null;
}

/** The values a booking is ranked by. */
export function queueValues(b: QueueBooking): { date: string; commitment: string | null; amount: number } {
  const o = safeJson<{ expected_delivery_date?: string | null; booking_amount?: number }>(b.priority_override_json, {});
  return {
    date: b.priority_ts,
    commitment: "expected_delivery_date" in o ? o.expected_delivery_date ?? null : b.expected_delivery_date ?? null,
    amount: "booking_amount" in o ? Number(o.booking_amount) || 0 : Number(b.booking_amount) || 0,
  };
}

const text = (a: string, b: string) => (a === b ? 0 : a < b ? -1 : 1);

/** Orders waiting bookings: the criteria in the order configured, then booking date, then booking number. */
export function queueCompare(rules: Pick<Rules, "queue_order">): (a: QueueBooking, b: QueueBooking) => number {
  return (a, b) => {
    const x = queueValues(a), y = queueValues(b);
    for (const c of rules.queue_order) {
      let d = 0;
      if (c === "BOOKING_DATE") d = text(x.date, y.date);
      else if (c === "DELIVERY_COMMITMENT") d = text(x.commitment ?? "9999", y.commitment ?? "9999");
      else if (c === "BOOKING_AMOUNT") d = y.amount - x.amount;
      if (d) return d;
    }
    return text(x.date, y.date) || text(a.booking_no, b.booking_no);
  };
}

/** Orders the free cars a booking could be given: the criteria in the order configured, then time in the yard, then chassis number. */
export function carCompare(rules: Pick<Rules, "car_order">, bookingOutletId: string): (a: QueueCar, b: QueueCar) => number {
  const arrival = (c: QueueCar) => (c.status === "RECEIVED" ? "" : c.expected_arrival_date ?? "9999");
  return (a, b) => {
    for (const c of rules.car_order) {
      let d = 0;
      if (c === "AT_DEALERSHIP") d = Number(a.status !== "RECEIVED") - Number(b.status !== "RECEIVED");
      else if (c === "OWN_OUTLET") d = Number(a.outlet_id !== bookingOutletId) - Number(b.outlet_id !== bookingOutletId);
      else if (c === "EARLIEST_ARRIVAL") d = text(arrival(a), arrival(b));
      else if (c === "OLDEST_INVOICE") d = text(a.wholesale_invoice_date ?? "9999", b.wholesale_invoice_date ?? "9999");
      if (d) return d;
    }
    return text(a.received_at ?? "9999", b.received_at ?? "9999") || text(a.vin, b.vin);
  };
}

export interface Match<B extends QueueBooking, C extends QueueCar> {
  booking: B;
  vehicle: C;
  queuePosition: number;
  pass: "SAME_OUTLET" | "OTHER_OUTLET" | "NEARBY_OUTLET" | "DEALERSHIP_QUEUE" | "MANUAL_APPROVED_EXCEPTION";
}

/**
 * Matches the waiting bookings for one model / variant / colour to its free cars.
 *
 * Bookings are taken in queue order. How far a booking may reach for a car is the outlet rule:
 *   SAME_OUTLET_ONLY   - an outlet's cars serve only that outlet's bookings.
 *   SAME_OUTLET_NEARBY - first its own outlet's cars; then spare cars of the outlets listed as nearby to it.
 *   SAME_OUTLET_FIRST  - first its own outlet's cars; then any outlet's spare cars.
 *   ANY_OUTLET         - one queue for the whole dealership.
 * A "spare" car is one that no waiting booking at its own outlet has taken.
 */
export function matchBookings<B extends QueueBooking, C extends QueueCar>(bookings: B[], vehicles: C[], rules: Rules): Match<B, C>[] {
  const queue = [...bookings].sort(queueCompare(rules));
  const position = new Map(queue.map((b, i) => [b.id, i + 1]));
  const matches: Match<B, C>[] = [];
  const taken = new Set<string>();
  const served = new Set<string>();
  const give = (b: B, candidates: C[], pass: Match<B, C>["pass"]) => {
    if (!candidates.length) return false;
    const v = [...candidates].sort(carCompare(rules, b.outlet_id))[0];
    taken.add(v.id);
    served.add(b.id);
    matches.push({ booking: b, vehicle: v, queuePosition: position.get(b.id)!, pass });
    return true;
  };
  const free = () => vehicles.filter((v) => !taken.has(v.id));

  if (rules.outlet_scope === "ANY_OUTLET") {
    for (const b of queue) if (!give(b, free(), "DEALERSHIP_QUEUE")) break;
    return matches;
  }
  // Pass 1: each outlet's cars serve that outlet's bookings, in queue order.
  for (const b of queue) give(b, free().filter((v) => v.outlet_id === b.outlet_id), "SAME_OUTLET");
  // Pass 2: cars nobody at their own outlet took may serve a booking elsewhere.
  if (rules.outlet_scope === "SAME_OUTLET_FIRST") {
    for (const b of queue) if (!served.has(b.id)) give(b, free(), "OTHER_OUTLET");
  } else if (rules.outlet_scope === "SAME_OUTLET_NEARBY") {
    for (const b of queue) {
      if (served.has(b.id)) continue;
      const near = rules.nearby_outlets[b.outlet_id] ?? [];
      // Among equally suitable cars, the outlet listed first as nearby is preferred.
      const candidates = free().filter((v) => near.includes(v.outlet_id)).sort((x, y) => near.indexOf(x.outlet_id) - near.indexOf(y.outlet_id));
      give(b, candidates, "NEARBY_OUTLET");
    }
  }
  return matches;
}
