// The picture of the day, drawn for the person looking at it. A dealer principal wants the business;
// a sales manager wants the queue; finance wants the money; the CRM desk wants who has not been told;
// a sales executive wants their own customers. Each board asks only for the numbers its persona needs.
//
// Every chart is drawn from numbers the API worked out from the DMS files by fixed rules. Nothing here
// adds, averages or guesses: the browser only draws what it was given, and each card says what it is
// drawn from, so a number on screen can always be traced back to a file.

import type { EChartsCoreOption } from "echarts/core";
import { AGE_COLOURS, Chart, PALETTE, dayLabel } from "../components/Chart";
import { Card } from "../components/ui";
import { fmtNumber } from "../format";
import { useLoad } from "../hooks";
import { api } from "../api";
import { Link } from "../router";
import type { MonthPace, Overview, OwnerView } from "../types";

const MUTED = "#5b6672";
const axis = {
  axisLine: { lineStyle: { color: "#d9e2e8" } },
  axisTick: { show: false },
  axisLabel: { color: MUTED, fontSize: 11 },
  splitLine: { lineStyle: { color: "#eef3f6" } },
};

/**
 * A chart card: the heading, the picture, and — folded away under it — the sentence that says exactly
 * how the numbers were counted. The explanation matters (it is what makes a figure checkable), but it
 * is not what the person came to read, so it does not sit between the heading and the chart.
 *
 * A chart with nothing in it is not drawn at all. An empty box with "no data" in it takes the same
 * room as a real chart and says less than leaving the space to the charts that do have something.
 */
function ChartCard({ title, basis, children, empty }: { title: string; basis?: string; children: React.ReactNode; empty?: boolean }) {
  if (empty) return null;
  return (
    <Card title={title} className="chart-card">
      {children}
      {basis && (
        <details className="chart-basis">
          <summary>How this is counted</summary>
          <p>{basis}</p>
        </details>
      )}
    </Card>
  );
}

/** The headline figures across the top of the home screen, in the product's colours. */
export function HeadlineBand({ items }: { items: { label: string; value: string; sub?: string; to?: string; tone?: "warn" | "danger" }[] }) {
  if (!items.length) return null;
  return (
    <div className="headline">
      {items.map((h) => {
        const inner = (
          <>
            <span className="headline-value">{h.value}</span>
            <span className="headline-label">{h.label}</span>
            {h.sub && <span className="headline-sub">{h.sub}</span>}
          </>
        );
        const cls = `headline-item${h.tone ? ` headline-${h.tone}` : ""}`;
        return h.to ? (
          <Link key={h.label} to={h.to} className={`${cls} headline-link`}>
            {inner}
          </Link>
        ) : (
          <div key={h.label} className={cls}>
            {inner}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- dealer principal and CEO
/** The business: what sold, what is sitting, and which way stock is moving. */
export function OwnerBoard({ owner }: { owner: OwnerView | null }) {
  const sales = useLoad(() => api.sales(), "home:sales");
  const stock = useLoad(() => api.stockByDay(), "home:stock-days");
  const models = (sales.data?.models ?? []).filter((m) => m.sold > 0).slice(0, 8);
  const days = stock.data?.days ?? [];
  const buckets = owner?.unsold_by_age.buckets ?? [];

  const byModel: EChartsCoreOption = {
    tooltip: { trigger: "axis" },
    legend: { show: false },
    grid: { left: 8, right: 24, top: 8, bottom: 8, containLabel: true },
    xAxis: { type: "value", ...axis },
    yAxis: { type: "category", data: models.map((m) => m.model).reverse(), ...axis, splitLine: { show: false } },
    series: [
      {
        type: "bar",
        data: models.map((m) => m.sold).reverse(),
        barMaxWidth: 22,
        itemStyle: { color: PALETTE[1], borderRadius: [0, 4, 4, 0] },
        label: { show: true, position: "right", color: MUTED, fontSize: 11 },
      },
    ],
  };

  const mix: EChartsCoreOption = {
    tooltip: { trigger: "item" },
    legend: { bottom: 0, itemGap: 14, padding: [0, 8, 0, 8] },
    series: [
      {
        type: "pie",
        radius: ["40%", "60%"],
        center: ["50%", "34%"],
        itemStyle: { borderColor: "#fff", borderWidth: 2 },
        label: { show: false },
        data: models.map((m) => ({ name: m.model, value: m.sold })),
      },
    ],
  };

  const movement: EChartsCoreOption = {
    tooltip: { trigger: "axis" },
    legend: { bottom: 0, data: ["Free in the yard", "Reserved", "On the way"] },
    grid: { left: 8, right: 16, top: 12, bottom: 44, containLabel: true },
    xAxis: { type: "category", boundaryGap: false, data: days.map((d) => dayLabel(d.date)), ...axis, splitLine: { show: false } },
    yAxis: { type: "value", ...axis },
    series: [
      { name: "Free in the yard", type: "line", stack: "s", areaStyle: { opacity: 0.85 }, showSymbol: false, lineStyle: { width: 1 }, itemStyle: { color: PALETTE[1] }, data: days.map((d) => d.total.in_yard_free) },
      { name: "Reserved", type: "line", stack: "s", areaStyle: { opacity: 0.85 }, showSymbol: false, lineStyle: { width: 1 }, itemStyle: { color: PALETTE[0] }, data: days.map((d) => d.total.in_yard_reserved + d.total.in_transit_reserved) },
      { name: "On the way", type: "line", stack: "s", areaStyle: { opacity: 0.85 }, showSymbol: false, lineStyle: { width: 1 }, itemStyle: { color: PALETTE[3] }, data: days.map((d) => d.total.in_transit_free) },
    ],
  };

  const ageing: EChartsCoreOption = {
    tooltip: { trigger: "axis" },
    legend: { bottom: 0, data: ["In the yard", "On the way"] },
    grid: { left: 8, right: 16, top: 12, bottom: 44, containLabel: true },
    xAxis: { type: "category", data: buckets.map((b) => b.label), ...axis, splitLine: { show: false } },
    yAxis: { type: "value", ...axis },
    series: [
      { name: "In the yard", type: "bar", stack: "a", barMaxWidth: 46, itemStyle: { color: AGE_COLOURS[0] }, data: buckets.map((b) => b.in_yard) },
      { name: "On the way", type: "bar", stack: "a", barMaxWidth: 46, itemStyle: { color: AGE_COLOURS[1], borderRadius: [4, 4, 0, 0] }, data: buckets.map((b) => b.in_transit) },
    ],
  };

  // No grid of its own: Home puts every chart a person has into one grid, so they tile together
  // instead of each board opening a new row of its own.
  return (
    <>
      <ChartCard title="What is selling" basis={sales.data?.basis} empty={!models.length}>
        <Chart option={byModel} height={Math.max(180, Math.min(models.length * 30 + 30, 240))} />
      </ChartCard>
      <ChartCard title="Share of what sold" basis={sales.data ? `${fmtNumber(sales.data.total_sold)} delivered in this period.` : undefined} empty={!models.length}>
        <Chart option={mix} height={240} />
      </ChartCard>
      <ChartCard title="Stock, day by day" basis={stock.data?.basis} empty={days.length < 2}>
        <Chart option={movement} height={240} />
      </ChartCard>
      <ChartCard title="Cars nobody has booked, by how long they have been here" basis={owner?.unsold_by_age.basis} empty={!buckets.length}>
        <Chart option={ageing} height={240} />
      </ChartCard>
    </>
  );
}

// ---------------------------------------------------------------- sales manager, general manager
/** The queue: where the bookings stand, and what the yard looks like against them. */
export function QueueBoard({ o }: { o: Overview }) {
  const steps = [
    { name: "Waiting for approval", value: o.bookings.awaiting_approval },
    { name: "Waiting for a car", value: o.bookings.waiting },
    { name: "Car reserved", value: o.bookings.allocated },
    { name: "Billed, to deliver", value: o.bookings.invoiced },
  ];
  const pipeline: EChartsCoreOption = {
    tooltip: { trigger: "axis" },
    legend: { show: false },
    grid: { left: 8, right: 28, top: 8, bottom: 8, containLabel: true },
    xAxis: { type: "value", ...axis },
    yAxis: { type: "category", data: steps.map((s) => s.name).reverse(), ...axis, splitLine: { show: false } },
    series: [
      {
        type: "bar",
        data: steps.map((s) => s.value).reverse(),
        barMaxWidth: 24,
        itemStyle: { color: PALETTE[0], borderRadius: [0, 4, 4, 0] },
        label: { show: true, position: "right", color: MUTED, fontSize: 11 },
      },
    ],
  };

  const stock = [
    { name: "Free in the yard", value: o.stock.yard_free, colour: PALETTE[1] },
    { name: "Reserved in the yard", value: o.stock.yard_allocated, colour: PALETTE[0] },
    { name: "Free, on the way", value: o.stock.transit_free, colour: PALETTE[3] },
    { name: "Reserved, on the way", value: o.stock.transit_allocated, colour: PALETTE[4] },
    { name: "Blocked or demo", value: o.stock.blocked, colour: PALETTE[7] },
  ].filter((s) => s.value > 0);
  const yard: EChartsCoreOption = {
    tooltip: { trigger: "item" },
    legend: { bottom: 0, itemGap: 14, padding: [0, 8, 0, 8] },
    series: [
      {
        type: "pie",
        radius: ["40%", "60%"],
        center: ["50%", "34%"],
        itemStyle: { borderColor: "#fff", borderWidth: 2 },
        label: { show: false },
        data: stock.map((s) => ({ name: s.name, value: s.value, itemStyle: { color: s.colour } })),
      },
    ],
  };

  return (
    <>
      <ChartCard title="Where the bookings stand" basis="Open bookings in the outlets you cover, counted now." empty={steps.every((s) => !s.value)}>
        <Chart option={pipeline} height={190} />
      </ChartCard>
      <ChartCard title="What is in the yard and on the way" basis="Cars from the latest stock report." empty={!stock.length}>
        <Chart option={yard} height={240} />
      </ChartCard>
    </>
  );
}

// ---------------------------------------------------------------- finance
/** The money: what is claimed, what is confirmed, and what the dealership is still waiting for. */
export function MoneyBoard({ awaiting, toVerify, verifiedNotInvoiced }: { awaiting: number; toVerify: number; verifiedNotInvoiced: number }) {
  const parts = [
    { name: "Waiting for payment", value: awaiting, colour: PALETTE[5] },
    { name: "Paid, to check", value: toVerify, colour: PALETTE[1] },
    { name: "Checked, to bill", value: verifiedNotInvoiced, colour: PALETTE[0] },
  ].filter((p) => p.value > 0);
  const option: EChartsCoreOption = {
    tooltip: { trigger: "item" },
    legend: { bottom: 0, itemGap: 14, padding: [0, 8, 0, 8] },
    series: [
      {
        type: "pie",
        radius: ["40%", "60%"],
        center: ["50%", "34%"],
        itemStyle: { borderColor: "#fff", borderWidth: 2 },
        label: { show: false },
        data: parts.map((p) => ({ name: p.name, value: p.value, itemStyle: { color: p.colour } })),
      },
    ],
  };
  return (
    <ChartCard title="Where the money stands" basis="Bookings holding a car, counted now." empty={!parts.length}>
      <Chart option={option} height={240} />
    </ChartCard>
  );
}

// ---------------------------------------------------------------- the CRM desk
/** Who has been told and who has not: every message sent to a customer, by what happened to it. */
export function MessagesBoard({ counts }: { counts: { status: string; n: number }[] }) {
  const colour: Record<string, string> = { DELIVERED: "#1e6b3e", READ: PALETTE[1], SENT: PALETTE[3], QUEUED: PALETTE[7], FAILED: "#9a2a20", SKIPPED: "#b0bcc6" };
  const parts = counts.filter((c) => c.n > 0);
  const option: EChartsCoreOption = {
    tooltip: { trigger: "item" },
    legend: { bottom: 0, itemGap: 14, padding: [0, 8, 0, 8] },
    series: [
      {
        type: "pie",
        radius: ["40%", "60%"],
        center: ["50%", "34%"],
        itemStyle: { borderColor: "#fff", borderWidth: 2 },
        label: { show: false },
        data: parts.map((c) => ({ name: statusWord(c.status), value: c.n, itemStyle: { color: colour[c.status] ?? PALETTE[7] } })),
      },
    ],
  };
  return (
    <ChartCard title="Messages to customers" basis="Every WhatsApp message this dealership has sent, by what happened to it." empty={!parts.length}>
      <Chart option={option} height={240} />
    </ChartCard>
  );
}

const statusWord = (s: string) =>
  s === "DELIVERED" ? "Delivered" : s === "READ" ? "Read" : s === "SENT" ? "Sent" : s === "QUEUED" ? "Waiting to go" : s === "FAILED" ? "Did not go" : s === "SKIPPED" ? "Not sent" : s;

// ---------------------------------------------------------------- how the month is going
/**
 * The month on one line, for the two people who answer for it. A retail is a car with its retail
 * invoice raised — what the manufacturer counts — so the figure here is the figure that will be
 * argued about at the review. The projection is today's pace carried to the end of the month and is
 * labelled as that, not as a forecast: nothing here is modelled.
 */
export function PaceCard({ m }: { m: MonthPace }) {
  const { retails: r, month } = m;
  const target = r.target;
  const pctOfTarget = target ? Math.min(100, Math.round((r.this_month / target) * 100)) : null;
  // Where the month should be by now if it ran evenly: the mark the bar is read against.
  const expected = target ? Math.round((target * month.days_elapsed) / month.days_total) : null;
  const ahead = expected === null ? null : r.this_month - expected;
  const vsLast = r.this_month - r.previous_month_to_date;

  return (
    <Card title="How the month is going" className="pace-card">
      <div className="pace-head">
        <div className="pace-figure">
          <span className="pace-value">{fmtNumber(r.this_month)}</span>
          <span className="pace-unit">retails so far</span>
        </div>
        <ul className="pace-facts">
          <li>
            <span>Last month, same {month.days_elapsed} days</span>
            <strong className={vsLast < 0 ? "down" : vsLast > 0 ? "up" : undefined}>
              {fmtNumber(r.previous_month_to_date)}
              {vsLast !== 0 && ` (${vsLast > 0 ? "+" : ""}${fmtNumber(vsLast)})`}
            </strong>
          </li>
          <li>
            <span>Running at</span>
            <strong>{r.per_day} a day</strong>
          </li>
          <li>
            <span>At this pace, the month closes near</span>
            <strong>{fmtNumber(r.projected)}</strong>
          </li>
          <li>
            <span>Days left</span>
            <strong>{fmtNumber(month.days_left)}</strong>
          </li>
        </ul>
      </div>
      {target ? (
        <div className="pace-bar-wrap">
          <div className="pace-bar" role="img" aria-label={`${fmtNumber(r.this_month)} of a target of ${fmtNumber(target)}`}>
            <span className={`pace-fill${ahead !== null && ahead < 0 ? " behind" : ""}`} style={{ width: `${pctOfTarget}%` }} />
            {expected !== null && <span className="pace-mark" style={{ left: `${Math.min(100, Math.round((expected / target) * 100))}%` }} />}
          </div>
          <p className="pace-verdict">
            {pctOfTarget}% of a target of {fmtNumber(target)}.{" "}
            {ahead === null ? null : ahead >= 0 ? <span className="up">{fmtNumber(ahead)} ahead of an even run through the month.</span> : <span className="down">{fmtNumber(-ahead)} behind an even run through the month.</span>}
          </p>
        </div>
      ) : (
        <p className="pace-no-target">
          No monthly target is set, so the pace above is shown without a verdict against it. A target can be set under Settings.
        </p>
      )}
      <details className="chart-basis">
        <summary>How this is counted</summary>
        <p>{m.basis}</p>
      </details>
    </Card>
  );
}

/** Each outlet's own month, so the one that is behind is seen rather than worked out. */
export function OutletLeague({ m, owner }: { m: MonthPace; owner: OwnerView | null }) {
  if (m.outlets.length < 2) return null;
  const waiting = new Map((owner?.outlets ?? []).map((o) => [o.outlet_id, o]));
  const max = Math.max(1, ...m.outlets.map((o) => o.retails));
  return (
    <Card title="Each outlet this month" className="league-card">
      <ul className="league">
        {m.outlets.map((o) => {
          const w = waiting.get(o.outlet_id);
          return (
            <li key={o.outlet_id} className="league-row">
              <span className="league-name">{o.name}</span>
              <span className="league-bar">
                <span style={{ width: `${Math.round((o.retails / max) * 100)}%` }} />
              </span>
              <span className="league-n">{fmtNumber(o.retails)}</span>
              {w && (
                <span className="league-sub">
                  {fmtNumber(w.waiting)} waiting · {fmtNumber(w.cars_free)} free
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <details className="chart-basis">
        <summary>How this is counted</summary>
        <p>Retails this month at each outlet, counted by the retail invoice date in the stock report. "Waiting" and "free" are today's position from the latest files.</p>
      </details>
    </Card>
  );
}

/** Retails month by month: the question a CEO asks is which way the line is going, not today's count. */
export function TrendBoard({ m }: { m: MonthPace }) {
  const months = m.months;
  const target = m.retails.target;
  const label = (ym: string) => new Date(`${ym}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "short", year: "2-digit", timeZone: "UTC" });
  const option: EChartsCoreOption = {
    tooltip: { trigger: "axis" },
    legend: { show: false },
    grid: { left: 8, right: 16, top: 16, bottom: 28, containLabel: true },
    xAxis: { type: "category", data: months.map((x) => label(x.month)), ...axis, splitLine: { show: false } },
    yAxis: { type: "value", ...axis },
    series: [
      {
        type: "bar",
        data: months.map((x, i) => ({ value: x.retails, itemStyle: { color: i === months.length - 1 ? PALETTE[1] : PALETTE[0], borderRadius: [4, 4, 0, 0] } })),
        barMaxWidth: 34,
        // The month in progress is not a full month: it is drawn in the lighter colour, not compared as if it were.
        markLine: target ? { silent: true, symbol: "none", lineStyle: { color: "#c98a2e", type: "dashed" }, data: [{ yAxis: target, label: { formatter: `Target ${target}`, color: "#7a5200", fontSize: 11 } }] } : undefined,
      },
    ],
  };
  return (
    <ChartCard title="Retails, month by month" basis={`A retail is a car whose retail invoice date falls in that month. The last bar is this month so far (${m.month.days_elapsed} of ${m.month.days_total} days), not a full month.`} empty={months.length < 2}>
      <Chart option={option} height={260} />
    </ChartCard>
  );
}
