// What else can honestly be offered when the car the customer asked for is not there.
//
// Three rules decide what appears here, and they are the whole point of the feature.
//
// 1. Only cars that exist. Every suggestion is a car in the latest stock report, in the yard or on the
//    way. Nothing is suggested because it could be ordered.
//
// 2. Only cars that are genuinely spare. A car with no allocation against it is not offerable if
//    customers are already waiting for that exact model, variant and colour: offering it would hand a
//    new customer a car that belongs to someone further up the queue. So for every configuration the
//    cars already waited for are taken off first, and only what is left over is suggested. This is the
//    same arithmetic the availability answer uses, applied to every configuration at once.
//
// 3. The yard before the road. A car standing at the dealership beats one in transit, because the
//    first can be handed over and the second is a date, and a date in the stock report is often not firm.
//
// What is left comes back in two groups, because these are two different conversations: cars that can
// be handed over now, and cars that are on the way with a date. The yard group comes first, as asked.
//
// Inside each group the order is how small a compromise the car asks of the customer: the same car in
// another colour first, then the same car with a different gearbox or fuel, then a trim up or down,
// and only then another model of the same kind. The groups are kept apart rather than merged into one
// ranking on purpose — a customer who came for a Thar is not served by a different model standing in
// the yard just because it is standing there, and nor is the consultant served by being told so. Both
// answers are put in front of them, labelled, and the choice is theirs.
//
// What this does not do, and cannot: it does not know the customer. It has no budget, no part-exchange,
// no reason why they picked that colour, and nothing in the two DMS files carries any of that. So this
// is a ranking of how close a car is to the one asked for, and it is labelled as that — not a
// prediction of what the customer will accept.

import type { Ctx } from "../env";
import { inQueue } from "./queue";
import { all } from "../lib/db";
import { addDays, localParts } from "../lib/util";
import { dataStatus } from "./data-status";

/**
 * How far each difference moves a car away from the one that was asked for. The numbers are a ranking,
 * not a measurement: what matters is the order they put the suggestions in, which is the order a sales
 * consultant would offer them in — colour is the easiest thing to talk a customer round on, the model
 * itself the hardest.
 */
const COST = {
  colour: 2,
  drive: 8,
  transmission: 12,
  fuel: 15,
  trimStep: 20, // per step up or down the trim ladder, where stock prices let it be worked out
  trimUnknown: 24, // a different trim whose place in the ladder cannot be told from stock
  variant: 10, // a different variant of the same trim
  seat: 25, // per seat of difference
  model: 100,
  otherOutlet: 6,
};

interface Car {
  model: string; variant: string; colour: string; status: string;
  trim_level: string; transmission: string; fuel: string; seater: string; drive: string; category: string;
  outlet: string; outlet_id: string;
  expected_arrival_date: string | null; wholesale_invoice_date: string | null;
  net_dealer_price: number | null;
}

export interface Alternative {
  model: string; variant: string; colour: string;
  trim_level: string; transmission: string; fuel: string; seater: string;
  /** Cars that could be given to a new customer today, after everyone already waiting is served. */
  spare_in_yard: number;
  spare_in_transit: number;
  /** Customers already waiting for this exact model, variant and colour. */
  waiting: number;
  outlets: { outlet: string; cars: number; same_outlet: boolean }[];
  soonest_arrival: string | null;
  soonest_indicative: boolean;
  /** What is different from the car asked for, in words to say to the customer. */
  differs: string[];
  headline: string;
  /** Difference in the dealer price in the stock report. Only for roles that may see stock value. */
  price_gap: number | null;
  closeness: number;
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toUpperCase();

/**
 * Alternatives to a configuration the customer cannot have, best first.
 *
 * `want` is the car asked for. `outletId` is the customer's outlet, used only to prefer a car standing
 * at it — a car at another outlet is still offered, because the dealership can move it.
 */
export async function alternatives(
  ctx: Ctx,
  want: { model: string; variant: string; colour: string },
  outletId: string | null,
  opts: { withValue: boolean; limit?: number } = { withValue: false },
): Promise<{ asked: typeof want; can_give_now: Alternative[]; on_the_way: Alternative[]; alternatives: Alternative[]; considered: number; source: { stock_as_on: string | null; stale: boolean }; basis: string }> {
  const cars = await all<Car>(
    ctx.db,
    `SELECT v.model, v.variant, v.colour, v.status, v.outlet_id, o.name AS outlet,
            v.expected_arrival_date, v.wholesale_invoice_date, v.net_dealer_price,
            COALESCE(vv.trim_level, '') AS trim_level, COALESCE(vv.transmission, '') AS transmission,
            COALESCE(vv.fuel, '') AS fuel, COALESCE(vv.seater, '') AS seater,
            COALESCE(vv.drive, '') AS drive, COALESCE(vv.category, '') AS category
       FROM vehicles v
       JOIN outlets o ON o.id = v.outlet_id
       LEFT JOIN vehicle_variants vv ON vv.id = v.variant_id
      WHERE v.tenant_id = ? AND v.status IN ('RECEIVED','IN_TRANSIT') AND v.is_blocked = 0 AND v.is_demo = 0
        AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.vehicle_id = v.id AND a.status = 'ACTIVE')`,
    ctx.tenantId,
  );

  // Customers already in the queue for each exact configuration. Their cars are not ours to offer.
  const waitingRows = await all<{ model: string; variant: string; colour: string; n: number }>(
    ctx.db,
    `SELECT model, variant, colour, COUNT(*) AS n FROM bookings
      WHERE tenant_id = ? AND ${inQueue(ctx.settings)} GROUP BY model, variant, colour`,
    ctx.tenantId,
  );
  const waitingFor = new Map(waitingRows.map((r) => [`${norm(r.model)}|${norm(r.variant)}|${norm(r.colour)}`, r.n]));

  // The trim ladder, as far as stock can tell it: a trim's place is the average dealer price of the
  // cars of that trim standing in the yard or on the way. Where no price is carried, the ladder has no
  // rung for that trim and the difference is reported as "a different trim" rather than guessed at.
  const trimPrices = new Map<string, number[]>();
  for (const c of cars) {
    if (!c.trim_level || !c.net_dealer_price) continue;
    const k = `${norm(c.model)}|${norm(c.trim_level)}`;
    trimPrices.set(k, [...(trimPrices.get(k) ?? []), c.net_dealer_price]);
  }
  const trimRank = new Map<string, number>();
  for (const [k, xs] of trimPrices) trimRank.set(k, xs.reduce((a, b) => a + b, 0) / xs.length);
  const ladderFor = (model: string) =>
    [...trimRank.entries()].filter(([k]) => k.startsWith(`${norm(model)}|`)).sort((a, b) => a[1] - b[1]).map(([k]) => k.split("|")[1]);

  // What was asked for, described from any car of that configuration in stock (or of that variant).
  const sample = cars.find((c) => norm(c.model) === norm(want.model) && norm(c.variant) === norm(want.variant)) ?? cars.find((c) => norm(c.model) === norm(want.model)) ?? null;
  const wantPrice = (() => {
    const xs = cars.filter((c) => norm(c.model) === norm(want.model) && norm(c.variant) === norm(want.variant) && c.net_dealer_price).map((c) => c.net_dealer_price!);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  })();

  // One entry per model, variant and colour, with the cars behind it.
  const groups = new Map<string, { c: Car; yard: Car[]; transit: Car[] }>();
  for (const c of cars) {
    const k = `${norm(c.model)}|${norm(c.variant)}|${norm(c.colour)}`;
    const g = groups.get(k) ?? { c, yard: [], transit: [] };
    (c.status === "RECEIVED" ? g.yard : g.transit).push(c);
    groups.set(k, g);
  }

  const today = localParts(ctx.now, ctx.tenant.timezone).date;
  const asked = `${norm(want.model)}|${norm(want.variant)}|${norm(want.colour)}`;
  const out: Alternative[] = [];

  for (const [k, g] of groups) {
    if (k === asked) continue; // this is the car they cannot have; the availability answer covers it
    const waiting = waitingFor.get(k) ?? 0;
    // Everyone already waiting is served from the yard first, then from the road: what is left is spare.
    const spareYard = Math.max(0, g.yard.length - waiting);
    const spareTransit = Math.max(0, g.transit.length - Math.max(0, waiting - g.yard.length));
    if (spareYard + spareTransit === 0) continue;

    const c = g.c;
    const differs: string[] = [];
    let cost = 0;

    const sameModel = norm(c.model) === norm(want.model);
    if (!sameModel) {
      // Another model is only worth offering if it is the same kind of vehicle. A customer who came for
      // a seven-seat SUV is not served by a pick-up, however free it is.
      if (sample && (norm(c.category) !== norm(sample.category) || !c.category)) continue;
      cost += COST.model;
      differs.push(`a different model: ${c.model}`);
      if (sample?.seater && c.seater && c.seater !== sample.seater) {
        const gap = Math.abs(Number(c.seater) - Number(sample.seater));
        if (Number.isFinite(gap) && gap > 2) continue; // too far from what they came in for
        cost += COST.seat * (Number.isFinite(gap) ? gap : 1);
        differs.push(`${c.seater} seats instead of ${sample.seater}`);
      }
    } else {
      if (norm(c.variant) !== norm(want.variant)) {
        const ladder = ladderFor(c.model);
        const from = sample ? ladder.indexOf(sample.trim_level) : -1;
        const to = ladder.indexOf(c.trim_level);
        if (norm(c.trim_level) !== norm(sample?.trim_level ?? "")) {
          if (from >= 0 && to >= 0) {
            cost += COST.trimStep * Math.abs(to - from);
            differs.push(to > from ? `a higher trim (${c.trim_level})` : `a lower trim (${c.trim_level})`);
          } else {
            cost += COST.trimUnknown;
            differs.push(`a different trim (${c.trim_level})`);
          }
        } else {
          cost += COST.variant;
          differs.push(`a different variant of the same trim (${c.variant})`);
        }
        if (sample) {
          if (c.transmission && sample.transmission && norm(c.transmission) !== norm(sample.transmission)) {
            cost += COST.transmission;
            differs.push(`${c.transmission.toLowerCase()} instead of ${sample.transmission.toLowerCase()}`);
          }
          if (c.fuel && sample.fuel && norm(c.fuel) !== norm(sample.fuel)) {
            cost += COST.fuel;
            differs.push(`${c.fuel.toLowerCase()} instead of ${sample.fuel.toLowerCase()}`);
          }
          if (c.drive && sample.drive && norm(c.drive) !== norm(sample.drive)) {
            cost += COST.drive;
            differs.push(`${c.drive} instead of ${sample.drive}`);
          }
          if (c.seater && sample.seater && c.seater !== sample.seater) {
            const gap = Math.abs(Number(c.seater) - Number(sample.seater));
            cost += COST.seat * (Number.isFinite(gap) ? gap : 1);
            differs.push(`${c.seater} seats instead of ${sample.seater}`);
          }
        }
      }
    }
    if (norm(c.colour) !== norm(want.colour)) {
      cost += COST.colour;
      differs.push(`${c.colour} instead of ${want.colour}`);
    }
    if (differs.length === 0) continue;

    // A car standing at the customer's own outlet comes before one that has to be moved between outlets.
    const at = [...g.yard, ...g.transit];
    const here = outletId ? at.some((x) => x.outlet_id === outletId) : true;
    if (!here) cost += COST.otherOutlet;

    const byOutlet = new Map<string, { outlet: string; cars: number; same_outlet: boolean }>();
    for (const x of at.slice(0, spareYard + spareTransit)) {
      const e = byOutlet.get(x.outlet_id) ?? { outlet: x.outlet, cars: 0, same_outlet: outletId ? x.outlet_id === outletId : false };
      e.cars += 1;
      byOutlet.set(x.outlet_id, e);
    }

    // When the car is only on the road, the date matters: a firm date from the dealership, or an
    // indicative one from the dealership's usual transit time, always marked as indicative.
    let soonest: string | null = null;
    let indicative = false;
    if (spareYard === 0) {
      for (const x of g.transit) {
        const firm = x.expected_arrival_date;
        const guess = !firm && x.wholesale_invoice_date && ctx.settings.transit_days ? addDays(x.wholesale_invoice_date, ctx.settings.transit_days) : null;
        const date = firm ?? guess;
        if (date && (!soonest || date < soonest)) {
          soonest = date;
          indicative = !firm;
        }
      }
    }

    const priceGap = opts.withValue && wantPrice && c.net_dealer_price ? Math.round(c.net_dealer_price - wantPrice) : null;
    const where = spareYard > 0 ? `${spareYard} in the yard` : soonest ? `${spareTransit} on the way, ${indicative ? "around" : "expected"} ${soonest}` : `${spareTransit} on the way, no date yet`;
    out.push({
      model: c.model, variant: c.variant, colour: c.colour,
      trim_level: c.trim_level, transmission: c.transmission, fuel: c.fuel, seater: c.seater,
      spare_in_yard: spareYard, spare_in_transit: spareTransit, waiting,
      outlets: [...byOutlet.values()].sort((a, b) => Number(b.same_outlet) - Number(a.same_outlet) || b.cars - a.cars),
      soonest_arrival: soonest, soonest_indicative: indicative,
      differs,
      headline: `${c.model} ${c.variant} in ${c.colour} — ${where}.`,
      price_gap: priceGap,
      closeness: cost,
    });
  }

  const byCloseness = (a: Alternative, b: Alternative) => a.closeness - b.closeness || b.spare_in_yard - a.spare_in_yard || a.model.localeCompare(b.model) || a.colour.localeCompare(b.colour);
  const limit = opts.limit ?? 6;
  const ready = out.filter((a) => a.spare_in_yard > 0).sort(byCloseness).slice(0, limit);
  const coming = out.filter((a) => a.spare_in_yard === 0).sort(byCloseness).slice(0, limit);
  const source = await dataStatus(ctx);
  return {
    asked: want,
    // Cars that can be handed over now, then cars with a date. The single list keeps that order, for
    // anything that wants one list.
    can_give_now: ready,
    on_the_way: coming,
    alternatives: [...ready, ...coming],
    considered: groups.size,
    source: { stock_as_on: source.stock?.report_date ?? null, stale: source.stale },
    basis:
      `Cars in the stock report as on ${source.stock?.report_date ?? today} that are in the yard or on the way, are not blocked, are not demo cars and have no booking against them. ` +
      "For each model, variant and colour the customers already waiting for it are served first, and only what is left over is offered here. " +
      "Cars that can be given now are listed before cars on the way, and within each list the closest to what the customer asked for comes first. " +
      "Closeness is how little is different about the car, not a guess at what this customer would accept. Nothing is reserved by this screen.",
  };
}
