// Browsing the yard the way a customer browses a shop: start with a model, then narrow by whatever
// matters to the customer in front of you — trim, transmission, fuel, seats, colour, outlet — with the
// count of cars beside every choice, so a sales executive can see what is actually there before saying
// anything to the customer.
//
// Every count is of real cars in the latest stock report. A choice that would leave nothing is still
// listed, with zero beside it, because "we have none in that colour" is an answer too.

import type { Ctx } from "../env";
import { all } from "../lib/db";
import { addDays, localParts } from "../lib/util";
import { dataStatus } from "./data-status";

/** The attributes a car can be narrowed by, in the order they are asked about on the shop floor. */
export const FACETS = ["model", "trim_level", "transmission", "fuel", "seater", "drive", "variant", "colour", "outlet"] as const;
export type Facet = (typeof FACETS)[number];

export interface BrowseQuery extends Partial<Record<Facet, string>> {
  /** FREE: nothing holds the car (what can be offered). ALL: every car in stock, reserved ones included. */
  show?: "FREE" | "ALL";
}

interface Row {
  id: string; vin: string; status: string; model: string; variant: string; colour: string;
  trim_level: string; transmission: string; fuel: string; seater: string; drive: string;
  outlet: string; outlet_id: string; is_free: number;
  expected_arrival_date: string | null; wholesale_invoice_date: string | null;
}

/**
 * The cars that match, the counts for every choice that could be made next, and a car-by-car list
 * grouped the way a customer thinks of it: model, variant, colour.
 */
export async function browseStock(ctx: Ctx, q: BrowseQuery, outletIds: string[] | null, models: string[] | null = null) {
  const scope = (outletIds?.length ? ` AND v.outlet_id IN (${outletIds.map(() => "?").join(",")})` : "") + (models ? ` AND v.model IN (${models.map(() => "?").join(",") || "''"})` : "");
  const rows = await all<Row>(
    ctx.db,
    `SELECT v.id, v.vin, v.status, v.model, v.variant, v.colour,
            COALESCE(vv.trim_level, '') AS trim_level, COALESCE(vv.transmission, '') AS transmission,
            COALESCE(vv.fuel, '') AS fuel, COALESCE(vv.seater, '') AS seater, COALESCE(vv.drive, '') AS drive,
            o.name AS outlet, v.outlet_id, v.expected_arrival_date, v.wholesale_invoice_date,
            CASE WHEN v.is_blocked = 0 AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.vehicle_id = v.id AND a.status = 'ACTIVE') THEN 1 ELSE 0 END AS is_free
       FROM vehicles v
       JOIN outlets o ON o.id = v.outlet_id
       LEFT JOIN vehicle_variants vv ON vv.id = v.variant_id
      WHERE v.tenant_id = ? AND v.status IN ('RECEIVED','IN_TRANSIT') AND v.is_demo = 0${scope}`,
    ctx.tenantId, ...(outletIds ?? []), ...(models ?? []),
  );

  const show = q.show === "ALL" ? "ALL" : "FREE";
  const pool = show === "FREE" ? rows.filter((r) => r.is_free === 1) : rows;
  const value = (r: Row, f: Facet) => (f === "outlet" ? r.outlet : (r[f as keyof Row] as string) || "");
  const chosen = FACETS.filter((f) => (q[f] ?? "").trim() !== "");
  const matches = (r: Row, except?: Facet) => chosen.every((f) => f === except || value(r, f) === q[f]);

  // Each facet's counts are worked out with every other choice applied but not its own, so the numbers
  // beside the colours say what is there in the model and trim already picked — the way a shop filter works.
  const facets: Record<string, { value: string; cars: number }[]> = {};
  for (const f of FACETS) {
    const counts = new Map<string, number>();
    for (const r of pool.filter((x) => matches(x, f))) {
      const v = value(r, f);
      if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    facets[f] = [...counts].map(([v, n]) => ({ value: v, cars: n })).sort((a, b) => (b.cars - a.cars) || a.value.localeCompare(b.value));
  }

  const found = pool.filter((r) => matches(r));
  const today = localParts(ctx.now, ctx.tenant.timezone).date;
  const arrival = (r: Row) =>
    r.status !== "IN_TRANSIT" ? null
    : r.expected_arrival_date ? { date: r.expected_arrival_date, indicative: false }
    : r.wholesale_invoice_date && ctx.settings.transit_days ? { date: addDays(r.wholesale_invoice_date, ctx.settings.transit_days), indicative: true }
    : null;

  // Grouped as a customer asks for a car: this model, this variant, in this colour.
  const groups = new Map<string, { model: string; variant: string; colour: string; trim_level: string; transmission: string; fuel: string; seater: string; in_yard: number; in_transit: number; outlets: Record<string, number>; soonest: string | null; soonest_indicative: boolean }>();
  for (const r of found) {
    const key = `${r.model}\u0000${r.variant}\u0000${r.colour}`;
    let g = groups.get(key);
    if (!g) {
      g = { model: r.model, variant: r.variant, colour: r.colour, trim_level: r.trim_level, transmission: r.transmission, fuel: r.fuel, seater: r.seater, in_yard: 0, in_transit: 0, outlets: {}, soonest: null, soonest_indicative: false };
      groups.set(key, g);
    }
    if (r.status === "RECEIVED") g.in_yard += 1;
    else g.in_transit += 1;
    g.outlets[r.outlet] = (g.outlets[r.outlet] ?? 0) + 1;
    const a = arrival(r);
    if (a && (!g.soonest || a.date < g.soonest)) {
      g.soonest = a.date;
      g.soonest_indicative = a.indicative;
    }
  }

  const source = await dataStatus(ctx);
  return {
    show,
    chosen: Object.fromEntries(chosen.map((f) => [f, q[f]!])),
    total: found.length,
    in_yard: found.filter((r) => r.status === "RECEIVED").length,
    in_transit: found.filter((r) => r.status === "IN_TRANSIT").length,
    facets,
    groups: [...groups.values()].sort((a, b) => b.in_yard - a.in_yard || b.in_transit - a.in_transit || a.model.localeCompare(b.model)).slice(0, 200),
    as_on: today,
    source: { stock_as_on: source.stock?.report_date ?? null, bookings_as_on: source.bookings?.report_date ?? null, stale: source.stale },
    basis:
      show === "FREE"
        ? "Cars in the latest stock report that are in the yard or on the way, are not blocked, and are not held by any booking. Demo cars are not counted."
        : "Every car in the latest stock report that is in the yard or on the way, held or not. Demo cars are not counted.",
  };
}
