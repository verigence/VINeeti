// What the dealership is actually earning, how healthy the business is, and whether the system is
// being used as intended. Three views, one per person who asks a different question.
//
// These exist because the money arrived late. Until the retail invoice export was read, nothing in
// here knew what a car sold for, what was discounted, who financed it or when the customer took it
// away: the stock report says a chassis is invoiced, and that was the whole of it. The owner's
// screens could show how many cars were standing still but never what the standing still cost, and
// never, for a single car, the difference between what it was bought for and what it was sold for.
//
// Everything here is worked out from the selling side of the retail invoice -- what the car sold for
// and what was taken off that price -- and from nothing else.
//
// There is deliberately no cost and no margin. This system adds nothing of its own to what the DMS
// files give it, and what a chassis cost the dealership is not a number it should be carrying about
// in its reports: it is the dealership's own buying position, it is not what the retail file is for,
// and a margin figure assembled here would be this system asserting something no single file it was
// given actually says. So the question answered is what the price was and how much of it was given
// away, which the retail export states outright.

import type { Ctx } from "../env";
import { all, first } from "../lib/db";
import { addDays, localDayBounds, localParts } from "../lib/util";
import { releaseWords } from "./release-reasons";

const inList = (ids: string[] | null, col: string) => (ids ? `AND ${col} IN (${ids.map(() => "?").join(",") || "''"})` : "");
const round = (n: number) => Math.round(n * 100) / 100;
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 10) / 10;
};
/** Whole calendar days between two instants or dates, in the dealership's own day. */
const dayGap = (from: string | null, to: string | null) =>
  from && to ? Math.round((Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) / 86_400_000) : null;

// ================================================================ the owner: what the cars earned

export interface MoneyDay {
  date: string;
  invoices: number;
  revenue: number;
  /** Everything taken off the price that day: the dealership's own and the manufacturer's together. */
  discount: number;
}

export interface ModelMoney {
  model: string;
  invoices: number;
  revenue: number;
  avg_selling: number;
  dealer_discount: number;
  oem_discount: number;
  /** Everything taken off the price, as a share of what the cars of this model sold for. */
  discount_pct: number | null;
  avg_discount: number | null;
}

export interface Unclaimed {
  invoice_no: string;
  invoice_date: string | null;
  customer_name: string;
  vin: string;
  model: string;
  amount: number;
}

export interface OwnerMoney {
  period: { from: string; to: string };
  previous: { revenue: number; invoices: number; discount: number };
  totals: {
    invoices: number;
    revenue: number;
    selling: number;
    avg_selling: number | null;
    /** Discount out of the dealership's own margin, and the manufacturer's schemes passed on. */
    dealer_discount: number;
    oem_discount: number;
    loyalty_discount: number;
    exchange_discount: number;
    /** Everything taken off the price, and what share of the price that is. */
    discount: number;
    discount_pct: number | null;
    /** Scheme money given away with no credit note raised to claim it back. */
    unclaimed: number;
    unclaimed_cars: number;
  };
  attached: {
    financed: number;
    dealer_arranged: number;
    insured: number;
    exchanged: number;
    finance_pct: number | null;
    dealer_finance_pct: number | null;
    insurance_pct: number | null;
    exchange_pct: number | null;
    insurance_amount: number;
  };
  delivery: { invoiced: number; delivered: number; median_days: number | null; over_a_week: number };
  days: MoneyDay[];
  models: ModelMoney[];
  unclaimed_list: Unclaimed[];
  claims_not_stated: boolean;
  basis: string;
}

/**
 * The money, for the person whose money it is.
 *
 * Revenue is the retail invoice, because that is when the dealership has earned it. Beside it is the
 * only other thing the invoice states about the price: how much of it was given away.
 *
 * The discounts are kept apart on purpose. What comes out of the dealership's own margin is gone;
 * what was given on a manufacturer's scheme can be claimed back, and the claim is a credit note
 * number. Scheme money given away with no credit note against it is cash the dealership has simply
 * not asked for, and it is listed car by car rather than totalled, because somebody has to go and
 * raise those.
 */
export async function ownerMoney(ctx: Ctx, outletIds: string[] | null, period: { from: string; to: string }): Promise<OwnerMoney> {
  const tz = ctx.tenant.timezone;
  const T = ctx.tenantId;
  const scope = outletIds ?? [];
  const len = Math.max(1, Math.round((Date.parse(period.to) - Date.parse(period.from)) / 86_400_000) + 1);
  const prior = { from: addDays(period.from, -len), to: addDays(period.from, -1) };

  interface Row {
    invoice_no: string;
    invoice_date: string | null;
    customer_name: string;
    vin: string | null;
    model: string | null;
    invoice_amount: number | null;
    selling_price: number | null;
    dealer_discount: number | null;
    oem_scheme_discount: number | null;
    loyalty_discount: number | null;
    exchange_discount: number | null;
    bndp_credit_note: string | null;
    financier: string | null;
    finance_arranged_by: string | null;
    insurance_amount: number | null;
    exchange_indicator: string | null;
    delivery_note_date: string | null;
  }
  const fetch = (p: { from: string; to: string }) =>
    all<Row>(
      ctx.db,
      `SELECT r.invoice_no, r.invoice_date, r.customer_name, r.vin, r.model, r.invoice_amount, r.selling_price,
              r.dealer_discount, r.oem_scheme_discount, r.loyalty_discount, r.exchange_discount,
              r.bndp_credit_note, r.financier, r.finance_arranged_by, r.insurance_amount, r.exchange_indicator, r.delivery_note_date
         FROM retail_invoices r
        WHERE r.tenant_id = ? AND r.withdrawn_on IS NULL AND r.invoice_date >= ? AND r.invoice_date <= ? ${inList(outletIds, "r.outlet_id")}`,
      T, p.from, p.to, ...scope,
    );

  const rows = await fetch(period);
  const before = await fetch(prior);
  const sum = (xs: (number | null)[]) => xs.reduce((a: number, b) => a + (b ?? 0), 0);
  /** Everything taken off the price of one car, whoever is paying for it. */
  const discountOf = (r: Row) => (r.dealer_discount ?? 0) + (r.oem_scheme_discount ?? 0) + (r.loyalty_discount ?? 0) + (r.exchange_discount ?? 0);

  const selling = sum(rows.map((r) => r.selling_price));
  const revenue = sum(rows.map((r) => r.invoice_amount));
  const discount = rows.reduce((n, r) => n + discountOf(r), 0);

  // A scheme discount with no credit note against it. Only counted where the file fills that column
  // somewhere: an export that leaves it blank on every row says nothing about what was claimed, and
  // reading silence as "unclaimed" would put a number on the owner's screen that means nothing.
  const anyClaim = rows.some((r) => r.bndp_credit_note);
  const unclaimedRows = anyClaim ? rows.filter((r) => (r.oem_scheme_discount ?? 0) > 0 && !r.bndp_credit_note) : [];

  const byDay = new Map<string, MoneyDay>();
  for (const r of rows) {
    if (!r.invoice_date) continue;
    const d = byDay.get(r.invoice_date) ?? { date: r.invoice_date, invoices: 0, revenue: 0, discount: 0 };
    d.invoices++;
    d.revenue += r.invoice_amount ?? 0;
    d.discount += discountOf(r);
    byDay.set(r.invoice_date, d);
  }

  const byModel = new Map<string, { model: string; invoices: number; revenue: number; _selling: number; dealer: number; oem: number; _discount: number }>();
  for (const r of rows) {
    const key = r.model || "Not stated";
    const m = byModel.get(key) ?? { model: key, invoices: 0, revenue: 0, _selling: 0, dealer: 0, oem: 0, _discount: 0 };
    m.invoices++;
    m.revenue += r.invoice_amount ?? 0;
    m._selling += r.selling_price ?? 0;
    m.dealer += r.dealer_discount ?? 0;
    m.oem += r.oem_scheme_discount ?? 0;
    m._discount += discountOf(r);
    byModel.set(key, m);
  }
  const models: ModelMoney[] = [...byModel.values()]
    .map((m) => ({
      model: m.model,
      invoices: m.invoices,
      revenue: round(m.revenue),
      avg_selling: m.invoices ? round(m._selling / m.invoices) : 0,
      dealer_discount: round(m.dealer),
      oem_discount: round(m.oem),
      // Against the price before the discount came off, which is what "a tenth of the price" means.
      discount_pct: m._selling > 0 ? Math.round((m._discount / (m._selling + m._discount)) * 1000) / 10 : null,
      avg_discount: m.invoices ? round(m._discount / m.invoices) : null,
    }))
    .sort((a, b) => b.revenue - a.revenue);

  const financed = rows.filter((r) => r.financier && r.financier.toUpperCase() !== "CASH").length;
  const dealerArranged = rows.filter((r) => (r.finance_arranged_by ?? "").toUpperCase() === "DEALER").length;
  const insured = rows.filter((r) => (r.insurance_amount ?? 0) > 0).length;
  const exchanged = rows.filter((r) => (r.exchange_indicator ?? "").toUpperCase() === "YES").length;

  const lags = rows.map((r) => dayGap(r.invoice_date, r.delivery_note_date)).filter((n): n is number => n !== null && n >= 0);
  const delivered = rows.filter((r) => r.delivery_note_date).length;

  return {
    period,
    previous: { revenue: round(sum(before.map((r) => r.invoice_amount))), invoices: before.length, discount: round(before.reduce((n, r) => n + discountOf(r), 0)) },
    totals: {
      invoices: rows.length,
      revenue: round(revenue),
      selling: round(selling),
      avg_selling: rows.length ? round(selling / rows.length) : null,
      dealer_discount: round(sum(rows.map((r) => r.dealer_discount))),
      oem_discount: round(sum(rows.map((r) => r.oem_scheme_discount))),
      loyalty_discount: round(sum(rows.map((r) => r.loyalty_discount))),
      exchange_discount: round(sum(rows.map((r) => r.exchange_discount))),
      discount: round(discount),
      discount_pct: selling + discount > 0 ? Math.round((discount / (selling + discount)) * 1000) / 10 : null,
      unclaimed: round(sum(unclaimedRows.map((r) => r.oem_scheme_discount))),
      unclaimed_cars: unclaimedRows.length,
    },
    attached: {
      financed, dealer_arranged: dealerArranged, insured, exchanged,
      finance_pct: pct(financed, rows.length),
      dealer_finance_pct: pct(dealerArranged, rows.length),
      insurance_pct: pct(insured, rows.length),
      exchange_pct: pct(exchanged, rows.length),
      insurance_amount: round(sum(rows.map((r) => r.insurance_amount))),
    },
    delivery: { invoiced: rows.length, delivered, median_days: median(lags), over_a_week: lags.filter((n) => n > 7).length },
    days: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)).map((d) => ({ ...d, revenue: round(d.revenue), discount: round(d.discount) })),
    models,
    unclaimed_list: unclaimedRows
      .sort((a, b) => (b.oem_scheme_discount ?? 0) - (a.oem_scheme_discount ?? 0))
      .slice(0, 100)
      .map((r) => ({ invoice_no: r.invoice_no, invoice_date: r.invoice_date, customer_name: r.customer_name, vin: r.vin ?? "", model: r.model ?? "", amount: round(r.oem_scheme_discount ?? 0) })),
    claims_not_stated: !anyClaim,
    basis:
      "Everything here comes from the retail invoice and nothing else: what the car sold for and what was taken off that price. There is no cost and no margin -- this system reports what the files " +
      "state and does not work out the dealership's buying position. Revenue is counted on the invoice date. Discount is measured against the price before it came off. " +
      "Dealer discount comes out of the dealership's own margin; manufacturer scheme discount can be claimed back with a credit note, and scheme money with no credit note against it is listed car by car. " +
      "Withdrawn invoices are left out. The comparison is with the period of the same length immediately before.",
  };
}

// ================================================================ the CEO: is the business healthy

export interface FunnelDay {
  date: string;
  booked: number;
  allocated: number;
  invoiced: number;
  delivered: number;
  cancelled: number;
  /** Bookings still waiting for a car at the end of that day. */
  queue: number;
}

export interface ConsultantRow {
  name: string;
  code: string | null;
  bookings: number;
  invoiced: number;
  cancelled: number;
  cancel_pct: number | null;
  revenue: number;
  /** Average discount out of the dealership's own margin, per car sold. */
  avg_dealer_discount: number | null;
  financed_pct: number | null;
  insured_pct: number | null;
}

export interface GovernanceDay {
  date: string;
  /** Allocation changes put to an approver that day. */
  requested: number;
  approved: number;
  rejected: number;
  /** Cars allotted in the DMS that never came through this system. */
  outside: number;
}

export interface RequestRow {
  id: string;
  booking_no: string;
  customer_name: string;
  vin: string | null;
  what: string;
  status: string;
  requested_at: string;
  requested_by: string;
  decided_by: string | null;
  decided_at: string | null;
  days_waiting: number | null;
}

export interface BusinessHealth {
  period: { from: string; to: string };
  totals: {
    booked: number;
    cancelled: number;
    cancel_pct: number | null;
    invoiced: number;
    delivered: number;
    queue_start: number;
    queue_end: number;
    median_days_to_allocate: number | null;
    median_days_to_invoice: number | null;
  };
  days: FunnelDay[];
  cancel_reasons: { reason: string; n: number }[];
  consultants: ConsultantRow[];
  /**
   * The two things an approver needs counted by day: what was put to them, and what went round them
   * anyway. They belong together because they are the same question asked from both ends -- how much
   * of the allocation that changed hands did anyone get to decide.
   */
  governance: {
    days: GovernanceDay[];
    totals: { requested: number; approved: number; rejected: number; pending: number; outside: number };
    oldest_pending_days: number | null;
    pending: RequestRow[];
    decided: RequestRow[];
  };
  basis: string;
}

/**
 * Whether the business is keeping up with itself.
 *
 * The funnel is counted on the day each thing happened, not the day a file arrived, so a report
 * loaded late does not make a quiet Tuesday look like a record Thursday. The queue line is the one
 * worth watching: bookings taken against cars allocated, carried forward, which goes up when the
 * dealership is selling orders it cannot fill and down when stock is catching up.
 *
 * The consultant table is the uncomfortable one, and deliberately so. Units and revenue flatter
 * whoever sells the most; the column that matters beside them is the average discount out of the
 * dealership's own margin, because volume bought with the dealer's money is not performance.
 */
export async function businessHealth(ctx: Ctx, outletIds: string[] | null, period: { from: string; to: string }): Promise<BusinessHealth> {
  const tz = ctx.tenant.timezone;
  const T = ctx.tenantId;
  const scope = outletIds ?? [];
  const [a, b] = [localDayBounds(period.from, tz).start, localDayBounds(period.to, tz).end];
  const dayOf = (at: string) => localParts(new Date(at), tz).date;

  const bookings = await all<{ id: string; booking_date: string; status: string; cancelled_at: string | null; cancel_reason: string | null; invoiced_at: string | null; delivered_at: string | null; sc_name: string | null; sc_code: string | null }>(
    ctx.db,
    `SELECT id, booking_date, status, cancelled_at, cancel_reason, invoiced_at, delivered_at, sc_name, sc_code
       FROM bookings WHERE tenant_id = ? ${inList(outletIds, "outlet_id")}`,
    T, ...scope,
  );
  const allocs = await all<{ booking_id: string; allocated_at: string }>(
    ctx.db,
    `SELECT a.booking_id, MIN(a.allocated_at) AS allocated_at FROM allocations a JOIN bookings b ON b.id = a.booking_id
      WHERE a.tenant_id = ? ${inList(outletIds, "b.outlet_id")} GROUP BY a.booking_id`,
    T, ...scope,
  );
  const firstAlloc = new Map(allocs.map((x) => [x.booking_id, x.allocated_at]));

  const days: FunnelDay[] = [];
  for (let d = period.from; d <= period.to; d = addDays(d, 1)) days.push({ date: d, booked: 0, allocated: 0, invoiced: 0, delivered: 0, cancelled: 0, queue: 0 });
  const index = new Map(days.map((d, i) => [d.date, i]));
  const bump = (at: string | null, key: keyof FunnelDay) => {
    if (!at) return;
    const i = index.get(dayOf(at));
    if (i !== undefined) (days[i][key] as number)++;
  };
  for (const bk of bookings) {
    bump(bk.booking_date, "booked");
    bump(firstAlloc.get(bk.id) ?? null, "allocated");
    bump(bk.invoiced_at, "invoiced");
    bump(bk.delivered_at, "delivered");
    bump(bk.cancelled_at, "cancelled");
  }

  // The queue carried forward: every booking taken by the end of that day that had not yet been given
  // a car, cancelled or invoiced by then. Counted from the whole order book rather than the period,
  // so the line starts at the real depth instead of at zero.
  //
  // Each booking joins the queue once and leaves once, so it is a sweep over 2n events and a running
  // total, not a scan of every booking on every day -- a year of a busy dealership is a million
  // comparisons done the obvious way, for a line with 365 points on it.
  const endOf = (date: string) => localDayBounds(date, tz).end;
  const cuts = days.map((d) => endOf(d.date));
  const enters = new Array<number>(days.length + 1).fill(0);
  const leaves = new Array<number>(days.length + 1).fill(0);
  let standing = 0;
  /** The first day in the period whose end is after `at`, or days.length when it is past the period. */
  const slot = (at: string) => {
    let lo = 0, hi = days.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cuts[mid] > at) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };
  for (const bk of bookings) {
    const got = firstAlloc.get(bk.id);
    const out = [got, bk.cancelled_at, bk.invoiced_at].filter((x): x is string => Boolean(x)).sort()[0] ?? null;
    const inAt = slot(bk.booking_date);
    const outAt = out ? slot(out) : days.length + 1;
    if (outAt <= inAt) continue; // joined and left before the end of the same day: never in the queue overnight
    if (inAt >= days.length) continue; // taken after the period
    if (inAt === 0 && bk.booking_date < cuts[0]) standing++; // already waiting when the period opened
    else enters[inAt]++;
    if (outAt <= days.length) leaves[outAt]++;
  }
  // `standing` counts those already in the queue before the first day; the sweep adds the rest.
  let depth = standing;
  for (let i = 0; i < days.length; i++) {
    if (i > 0) depth += enters[i];
    depth -= leaves[i];
    days[i].queue = Math.max(0, depth);
  }

  const inPeriod = (at: string | null) => Boolean(at && at >= a && at < b);
  const booked = bookings.filter((bk) => inPeriod(bk.booking_date));
  const cancelled = bookings.filter((bk) => inPeriod(bk.cancelled_at));
  const invoiced = bookings.filter((bk) => inPeriod(bk.invoiced_at));

  const toAllocate = bookings
    .filter((bk) => inPeriod(firstAlloc.get(bk.id) ?? null))
    .map((bk) => dayGap(bk.booking_date, firstAlloc.get(bk.id)!))
    .filter((n): n is number => n !== null && n >= 0);
  const toInvoice = invoiced.map((bk) => dayGap(bk.booking_date, bk.invoiced_at)).filter((n): n is number => n !== null && n >= 0);

  const reasons = new Map<string, number>();
  for (const bk of cancelled) {
    const key = (bk.cancel_reason ?? "").trim() || "Not stated";
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }

  // The money side of a consultant's work comes from the retail export, which names the consultant
  // on the invoice; the booking sheet names them on the order. They are matched on the name the DMS
  // writes, because the two files do not share a code.
  const sold = await all<{ sc_name: string | null; n: number; revenue: number; dealer_discount: number; financed: number; insured: number }>(
    ctx.db,
    `SELECT r.sc_name,
            COUNT(*) AS n,
            COALESCE(SUM(r.invoice_amount), 0) AS revenue,
            COALESCE(SUM(r.dealer_discount), 0) AS dealer_discount,
            SUM(CASE WHEN r.financier IS NOT NULL AND UPPER(r.financier) <> 'CASH' THEN 1 ELSE 0 END) AS financed,
            SUM(CASE WHEN COALESCE(r.insurance_amount, 0) > 0 THEN 1 ELSE 0 END) AS insured
       FROM retail_invoices r
      WHERE r.tenant_id = ? AND r.withdrawn_on IS NULL AND r.invoice_date >= ? AND r.invoice_date <= ? ${inList(outletIds, "r.outlet_id")}
      GROUP BY r.sc_name`,
    T, period.from, period.to, ...scope,
  );
  const soldBy = new Map(sold.filter((x) => x.sc_name).map((x) => [x.sc_name!.trim().toUpperCase(), x]));

  const people = new Map<string, ConsultantRow>();
  const personOf = (name: string | null, code: string | null) => {
    const key = (name ?? "").trim().toUpperCase() || "NOT NAMED";
    const row = people.get(key) ?? { name: (name ?? "").trim() || "Not named", code, bookings: 0, invoiced: 0, cancelled: 0, cancel_pct: null, revenue: 0, avg_dealer_discount: null, financed_pct: null, insured_pct: null };
    people.set(key, row);
    return row;
  };
  for (const bk of booked) personOf(bk.sc_name, bk.sc_code).bookings++;
  for (const bk of cancelled) personOf(bk.sc_name, bk.sc_code).cancelled++;
  for (const [key, s] of soldBy) {
    const row = personOf(s.sc_name, null);
    row.invoiced = s.n;
    row.revenue = round(s.revenue);
    row.avg_dealer_discount = s.n ? round(s.dealer_discount / s.n) : null;
    row.financed_pct = pct(s.financed, s.n);
    row.insured_pct = pct(s.insured, s.n);
    void key;
  }
  const consultants = [...people.values()]
    .map((p) => ({ ...p, cancel_pct: pct(p.cancelled, p.bookings + p.cancelled) }))
    .filter((p) => p.bookings || p.invoiced || p.cancelled)
    .sort((x, y) => y.revenue - x.revenue || y.invoiced - x.invoiced || y.bookings - x.bookings);

  // ---- what was put to an approver, and what went round them anyway
  const requests = await all<{ id: string; type: string; status: string; reason: string; payload_json: string; requested_at: string; decided_at: string | null; booking_no: string; customer_name: string; requester: string | null; decider: string | null }>(
    ctx.db,
    `SELECT e.id, e.type, e.status, e.reason, e.payload_json, e.requested_at, e.decided_at,
            b.booking_no, b.customer_name, rq.name AS requester, dc.name AS decider
       FROM exceptions e
       JOIN bookings b ON b.id = e.booking_id
       LEFT JOIN users rq ON rq.id = e.requested_by
       LEFT JOIN users dc ON dc.id = e.decided_by
      WHERE e.tenant_id = ? ${inList(outletIds, "b.outlet_id")}`,
    T, ...scope,
  );
  // An allotment made in the DMS is dated by the day the DMS says it happened, not by the day the
  // file reached us: a report loaded three days late would otherwise bunch three days of them onto
  // one, which is the opposite of what a daily count is for.
  const outsideRows = await all<{ at: string; detail_json: string }>(
    ctx.db,
    `SELECT a.at, a.detail_json FROM audit_log a WHERE a.tenant_id = ? AND a.action = 'ALLOTTED_OUTSIDE_SYSTEM'`,
    T,
  );

  const gov: GovernanceDay[] = days.map((d) => ({ date: d.date, requested: 0, approved: 0, rejected: 0, outside: 0 }));
  const govIndex = new Map(gov.map((d, i) => [d.date, i]));
  const at = (date: string | null, key: keyof GovernanceDay) => {
    if (!date) return;
    const i = govIndex.get(date);
    if (i !== undefined) (gov[i][key] as number)++;
  };
  for (const r of requests) {
    at(dayOf(r.requested_at), "requested");
    if (r.decided_at && r.status === "APPROVED") at(dayOf(r.decided_at), "approved");
    if (r.decided_at && r.status === "REJECTED") at(dayOf(r.decided_at), "rejected");
  }
  for (const r of outsideRows) {
    let when: string | null = null;
    try {
      const d = JSON.parse(r.detail_json) as Record<string, unknown>;
      when = (typeof d.allotment_date === "string" && d.allotment_date) || (typeof d.report_date === "string" && d.report_date) || null;
    } catch { /* an audit line whose detail will not parse is still one allotment, dated by its own row */ }
    at(when ?? dayOf(r.at), "outside");
  }

  const shape = (r: (typeof requests)[number]): RequestRow => {
    const p = (() => { try { return JSON.parse(r.payload_json) as Record<string, unknown>; } catch { return {}; } })();
    const reason = typeof p.release_reason === "string" ? p.release_reason : null;
    return {
      id: r.id,
      booking_no: r.booking_no,
      customer_name: r.customer_name,
      vin: typeof p.vin === "string" ? p.vin : null,
      what: r.type === "RELEASE_ALLOCATION" ? (reason ? releaseWords(reason) : "Take the car back") : r.type.replace(/_/g, " ").toLowerCase().replace(/^./, (m) => m.toUpperCase()),
      status: r.status,
      requested_at: r.requested_at,
      requested_by: r.requester ?? "",
      decided_by: r.decider,
      decided_at: r.decided_at,
      days_waiting: r.decided_at ? null : Math.floor((ctx.now.getTime() - Date.parse(r.requested_at)) / 86_400_000),
    };
  };
  const pending = requests.filter((r) => r.status === "PENDING").map(shape).sort((x, y) => x.requested_at.localeCompare(y.requested_at));
  const decidedIn = requests.filter((r) => r.decided_at && r.decided_at >= a && r.decided_at < b).map(shape).sort((x, y) => (y.decided_at ?? "").localeCompare(x.decided_at ?? ""));

  return {
    period,
    governance: {
      days: gov,
      totals: {
        requested: gov.reduce((n, d) => n + d.requested, 0),
        approved: gov.reduce((n, d) => n + d.approved, 0),
        rejected: gov.reduce((n, d) => n + d.rejected, 0),
        pending: pending.length,
        outside: gov.reduce((n, d) => n + d.outside, 0),
      },
      oldest_pending_days: pending.length ? Math.max(...pending.map((x) => x.days_waiting ?? 0)) : null,
      pending,
      decided: decidedIn.slice(0, 100),
    },
    totals: {
      booked: booked.length,
      cancelled: cancelled.length,
      cancel_pct: pct(cancelled.length, booked.length + cancelled.length),
      invoiced: invoiced.length,
      delivered: bookings.filter((bk) => inPeriod(bk.delivered_at)).length,
      queue_start: days[0]?.queue ?? 0,
      queue_end: days[days.length - 1]?.queue ?? 0,
      median_days_to_allocate: median(toAllocate),
      median_days_to_invoice: median(toInvoice),
    },
    days,
    cancel_reasons: [...reasons.entries()].map(([reason, n]) => ({ reason, n })).sort((x, y) => y.n - x.n),
    consultants,
    basis:
      "Each step is counted on the day it happened, not the day a file arrived, so a report loaded late does not pile onto the wrong day. " +
      "The queue is every booking taken by the end of that day that had no car, no cancellation and no invoice yet, counted from the whole order book rather than the period. " +
      "Days to allocate and to invoice are medians over the bookings that reached that step inside the period. " +
      "A consultant's sales, revenue and discount come from the retail export, which names them on the invoice; bookings and cancellations come from the booking sheet. Withdrawn invoices are left out. " +
      "Requests are counted on the day they were raised and decisions on the day they were made. An allotment made in the DMS is counted on the day the DMS says it was allotted, not the day the file arrived.",
  };
}

// ================================================================ the administrator: is it being used

export interface LoadDay {
  date: string;
  stock: number;
  bookings: number;
  retail: number;
  errors: number;
}

export interface SystemHealth {
  period: { from: string; to: string };
  files: { expected_days: number; days_with_stock: number; days_with_bookings: number; days_with_retail: number; error_rows: number; days: LoadDay[] };
  control: {
    from: string | null;
    decided_here: number;
    made_in_dms: number;
    through_system_pct: number | null;
    refused: number;
    violations: number;
  };
  approvals: { open: number; oldest_days: number | null; decided: number; median_hours: number | null };
  /**
   * Who is actually using the system, measured by what they have done rather than by signing in: a
   * sign-in followed by nothing is not use, and nothing records sign-ins anyway.
   */
  people: { users: number; active_30: number; idle: number; by_role: { role: string; n: number; active_30: number }[] };
  messages: { sent: number; failed: number; queued: number } | null;
  quality: { issue: string; cars: number }[];
  basis: string;
}

/**
 * Whether the system is actually being used, and whether what reaches it is any good.
 *
 * Nothing here is about the business: an administrator is asked different questions -- did the files
 * arrive, are people signing in, are approvals being answered, and is allocation going through the
 * system or round it. That last one is the only measure of whether the thing is doing its job at all.
 */
export async function systemHealth(ctx: Ctx, period: { from: string; to: string }): Promise<SystemHealth> {
  const tz = ctx.tenant.timezone;
  const T = ctx.tenantId;
  const [a, b] = [localDayBounds(period.from, tz).start, localDayBounds(period.to, tz).end];
  const dayOf = (at: string) => localParts(new Date(at), tz).date;

  const uploads = await all<{ kind: string; at: string; error_count: number; status: string }>(
    ctx.db,
    `SELECT kind, at, error_count, status FROM uploads WHERE tenant_id = ? AND at >= ? AND at < ?`,
    T, a, b,
  );
  const days: LoadDay[] = [];
  for (let d = period.from; d <= period.to; d = addDays(d, 1)) days.push({ date: d, stock: 0, bookings: 0, retail: 0, errors: 0 });
  const index = new Map(days.map((d, i) => [d.date, i]));
  for (const u of uploads) {
    const i = index.get(dayOf(u.at));
    if (i === undefined) continue;
    if (u.kind === "STOCK") days[i].stock++;
    else if (u.kind === "BOOKINGS") days[i].bookings++;
    else if (u.kind === "RETAIL") days[i].retail++;
    days[i].errors += Number(u.error_count ?? 0);
  }

  const control = await first<{ decided_here: number; made_in_dms: number }>(
    ctx.db,
    `SELECT SUM(CASE WHEN source <> 'DMS' THEN 1 ELSE 0 END) AS decided_here, SUM(CASE WHEN source = 'DMS' THEN 1 ELSE 0 END) AS made_in_dms
       FROM allocations WHERE tenant_id = ? AND allocated_at >= ? AND allocated_at < ?`,
    T, a, b,
  );
  const outside = await all<{ detail_json: string }>(
    ctx.db,
    `SELECT detail_json FROM audit_log WHERE tenant_id = ? AND action = 'ALLOTTED_OUTSIDE_SYSTEM' AND at >= ? AND at < ?`,
    T, a, b,
  );
  const refused = outside.filter((x) => {
    try { return JSON.parse(x.detail_json).violation === "REFUSED"; } catch { return false; }
  }).length;

  const open = await all<{ requested_at: string }>(ctx.db, `SELECT requested_at FROM exceptions WHERE tenant_id = ? AND status = 'PENDING'`, T);
  const decided = await all<{ requested_at: string; decided_at: string }>(
    ctx.db,
    `SELECT requested_at, decided_at FROM exceptions WHERE tenant_id = ? AND decided_at IS NOT NULL AND decided_at >= ? AND decided_at < ?`,
    T, a, b,
  );
  const hours = decided.map((x) => Math.round(((Date.parse(x.decided_at) - Date.parse(x.requested_at)) / 3_600_000) * 10) / 10).filter((n) => n >= 0);
  const now = ctx.now.getTime();
  const openDays = open.map((x) => Math.floor((now - Date.parse(x.requested_at)) / 86_400_000));

  const users = await all<{ id: string; role: string; is_active: number }>(ctx.db, `SELECT id, role, is_active FROM users WHERE tenant_id = ?`, T);
  const live = users.filter((u) => u.is_active);
  // Activity, not sign-ins. Nothing records a sign-in, and one followed by nothing is not use of the
  // system anyway; the audit log names whoever did each thing, which answers the real question and
  // answers it for the months already behind us.
  const actors = new Set(
    (await all<{ actor: string }>(ctx.db, `SELECT DISTINCT actor FROM audit_log WHERE tenant_id = ? AND at >= ?`, T, new Date(now - 30 * 86_400_000).toISOString())).map((x) => x.actor),
  );
  const roles = new Map<string, { role: string; n: number; active_30: number }>();
  for (const u of live) {
    const r = roles.get(u.role) ?? { role: u.role, n: 0, active_30: 0 };
    r.n++;
    if (actors.has(u.id)) r.active_30++;
    roles.set(u.role, r);
  }

  let messages: SystemHealth["messages"] = null;
  try {
    messages = (await first<{ sent: number; failed: number; queued: number }>(
      ctx.db,
      `SELECT SUM(CASE WHEN status IN ('SENT','DELIVERED','READ') THEN 1 ELSE 0 END) AS sent,
              SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN status = 'QUEUED' THEN 1 ELSE 0 END) AS queued
         FROM wa_messages WHERE tenant_id = ? AND created_at >= ? AND created_at < ?`,
      T, a, b,
    )) ?? null;
  } catch {
    // The dealership may not have WhatsApp set up at all, which is not a fault to report.
    messages = null;
  }

  const issueRows = await all<{ dms_issues_json: string }>(ctx.db, `SELECT dms_issues_json FROM vehicles WHERE tenant_id = ? AND dms_issues_json <> '[]' AND status <> 'REMOVED'`, T);
  const issues = new Map<string, number>();
  for (const r of issueRows) {
    try {
      for (const k of JSON.parse(r.dms_issues_json) as string[]) issues.set(k, (issues.get(k) ?? 0) + 1);
    } catch { /* a row whose issue list will not parse is not itself a data-quality finding worth a line */ }
  }

  const expected = days.length;
  return {
    period,
    files: {
      expected_days: expected,
      days_with_stock: days.filter((d) => d.stock > 0).length,
      days_with_bookings: days.filter((d) => d.bookings > 0).length,
      days_with_retail: days.filter((d) => d.retail > 0).length,
      error_rows: days.reduce((n, d) => n + d.errors, 0),
      days,
    },
    control: {
      from: ctx.settings.allocation_control_from,
      decided_here: Number(control?.decided_here ?? 0),
      made_in_dms: Number(control?.made_in_dms ?? 0),
      through_system_pct: pct(Number(control?.decided_here ?? 0), Number(control?.decided_here ?? 0) + Number(control?.made_in_dms ?? 0)),
      refused,
      violations: outside.length,
    },
    approvals: { open: open.length, oldest_days: openDays.length ? Math.max(...openDays) : null, decided: decided.length, median_hours: median(hours) },
    people: {
      users: live.length,
      active_30: live.filter((u) => actors.has(u.id)).length,
      idle: live.filter((u) => !actors.has(u.id)).length,
      by_role: [...roles.values()].sort((x, y) => y.n - x.n),
    },
    messages,
    quality: [...issues.entries()].map(([issue, cars]) => ({ issue, cars })).sort((x, y) => y.cars - x.cars),
    basis:
      "File loads are counted on the day they were loaded here, one row per load, so two loads of the same file on one day count twice. " +
      "Allocations through the system are those this system decided; the rest were made in the DMS and read from a stock report. " +
      "Approvals are every kind of request, not only releases. A user counts as active if the audit log shows them doing something in the last thirty days, which is use rather than a sign-in. " +
      "Data issues are the ones the stock report's own rows disagree about, on cars still in stock.",
  };
}

