// The Dealer Principal's board: the money and the movement.
//
// Two questions decide this person's day. How much of the dealership's money is lying in the yard, and
// how old is it? And is the place actually turning cars over — allotting, billing and handing over —
// day by day? Everything else they can ask someone for.
//
// So: what is blocked and what was churned across the top, those two pictures under it, and then the
// one list that is a job rather than a number — the models that are not selling and are holding the
// oldest stock. Each fact appears once. The age bands are a chart because the shape is the point; the
// models are a list because each line is something to do.

import type { EChartsCoreOption } from "echarts/core";
import { api } from "../api";
import { AGE_COLOURS, PALETTE, dayLabel } from "../components/Chart";
import { BoardStale, ChartPanel, Kpi, Panel, axis, shortBand } from "../components/BoardParts";
import { DataTable, Empty, ErrorBox, Loading, type Column } from "../components/ui";
import { fmtMoney, fmtMoneyShort, fmtNumber, plural, today } from "../format";
import { useLoad } from "../hooks";
import type { ModelRow } from "../types";

/** This month so far: the frame a dealer principal reads the business in. */
const monthStart = () => `${today().slice(0, 7)}-01`;

export function DealerPrincipalBoard() {
  const from = monthStart();
  const to = today();
  const money = useLoad(() => api.money(from, to), `dp:money:${from}`);
  const daily = useLoad(() => api.daily(from, to), `dp:daily:${from}`);
  const models = useLoad(() => api.models(), "dp:models");
  // Only for one figure: how long the yard would last at this month's selling pace. It is the plainest
  // answer there is to "how much stock have we got", because it is in days rather than in cars.
  const pace = useLoad(() => api.monthPace(), "dp:pace");

  if (money.loading && !money.data) return <Loading label="Loading the board" />;
  if (money.error && !money.data) return <ErrorBox message={money.error} onRetry={() => void money.reload()} />;
  const m = money.data;
  const days = daily.data?.days ?? [];
  const moved = daily.data?.totals;

  const over90 = m?.blocked.find((b) => b.label === "Over 90 days");

  // What the money is sitting in, by how long it has sat. Value is the bar; the car count is in the
  // tooltip, because the two together on one axis would need two scales and read as one.
  const blockedByAge: EChartsCoreOption = {
    tooltip: {
      trigger: "axis",
      formatter: (p: unknown) => {
        const a = (p as { name: string }[])[0];
        const b = m?.blocked.find((x) => shortBand(x.label) === a?.name);
        return b ? `${b.label}<br/>${fmtMoney(b.value)}<br/>${plural(b.cars, "car")}` : "";
      },
    },
    legend: { show: false },
    grid: { left: 4, right: 12, top: 12, bottom: 12, containLabel: true },
    xAxis: { type: "category", data: (m?.blocked ?? []).map((b) => shortBand(b.label)), ...axis, splitLine: { show: false } },
    yAxis: { type: "value", ...axis, axisLabel: { ...axis.axisLabel, formatter: (v: number) => fmtMoneyShort(v) } },
    series: [
      {
        type: "bar",
        barMaxWidth: 46,
        data: (m?.blocked ?? []).map((b, i) => ({ value: b.value, itemStyle: { color: AGE_COLOURS[i] ?? AGE_COLOURS[3], borderRadius: [4, 4, 0, 0] } })),
      },
    ],
  };

  // Allotment, release, billing, handover: the four things that happen to a car, day by day. A day on
  // which nothing happened is a zero on the line, not a gap, so a quiet week looks like a quiet week.
  const movement: EChartsCoreOption = {
    tooltip: { trigger: "axis" },
    legend: { bottom: 0, data: ["Allotted", "Released", "Billed", "Handed over"] },
    grid: { left: 4, right: 14, top: 12, bottom: 30, containLabel: true },
    xAxis: { type: "category", boundaryGap: false, data: days.map((d) => dayLabel(d.date)), ...axis, splitLine: { show: false } },
    yAxis: { type: "value", minInterval: 1, ...axis },
    series: [
      { name: "Allotted", type: "line", showSymbol: false, lineStyle: { width: 2 }, itemStyle: { color: PALETTE[0] }, data: days.map((d) => d.allocated) },
      { name: "Released", type: "line", showSymbol: false, lineStyle: { width: 2, type: "dashed" }, itemStyle: { color: PALETTE[5] }, data: days.map((d) => d.released) },
      { name: "Billed", type: "line", showSymbol: false, lineStyle: { width: 2 }, itemStyle: { color: PALETTE[1] }, data: days.map((d) => d.invoiced) },
      { name: "Handed over", type: "line", showSymbol: false, areaStyle: { opacity: 0.18 }, lineStyle: { width: 2 }, itemStyle: { color: PALETTE[3] }, data: days.map((d) => d.delivered) },
    ],
  };

  const columns: Column<ModelRow>[] = [
    { header: "Model", primary: true, cell: (r) => <span className="strong">{r.model}</span> },
    { header: "Free now", num: true, cell: (r) => fmtNumber(r.yard_free + r.transit_free) },
    { header: "Over 60 days", num: true, cell: (r) => (r.old_free > 0 ? <span className="strong danger-text">{fmtNumber(r.old_free)}</span> : <span className="muted">—</span>) },
    { header: "Oldest", num: true, cell: (r) => (r.oldest_days === null ? <span className="muted">—</span> : plural(r.oldest_days, "day")) },
    { header: "Money in the old ones", num: true, cell: (r) => (r.old_value ? <span title={fmtMoney(r.old_value)}>{fmtMoneyShort(r.old_value)}</span> : <span className="muted">—</span>) },
    { header: "Sold in 90 days", num: true, cell: (r) => (r.sold_90 > 0 ? fmtNumber(r.sold_90) : <span className="muted">none</span>) },
    {
      header: "Months of cover",
      num: true,
      status: true,
      cell: (r) =>
        r.months_of_cover === null ? (
          <span className="danger-text strong">nothing sold</span>
        ) : (
          <span className={r.months_of_cover >= 3 ? "strong danger-text" : r.months_of_cover >= 2 ? "strong" : undefined}>{r.months_of_cover}</span>
        ),
    },
  ];

  // Not selling, or selling too slowly to clear what is standing: the ones whose stock is turning into
  // a cost. Worst first, measured by old stock and then by how long the oldest has been there.
  const stuck = (models.data?.rows ?? [])
    .filter((r) => r.old_free > 0 || (r.yard_free + r.transit_free > 0 && (r.months_of_cover === null || r.months_of_cover >= 3)))
    .sort((a, b) => b.old_free - a.old_free || (b.oldest_days ?? 0) - (a.oldest_days ?? 0) || b.yard_free + b.transit_free - (a.yard_free + a.transit_free));

  return (
    <div className="board-screen">
      <BoardStale source={m?.source} />
      <div className="board-kpis">
        <Kpi value={fmtMoneyShort(m?.blocked_total.value)} label={`Lying in ${plural(m?.blocked_total.cars ?? 0, "unsold car")}`} />
        <Kpi value={fmtMoneyShort(m?.churned.value)} label={`Churned this month · ${plural(m?.churned.cars ?? 0, "car")} billed`} />
        <Kpi n={moved?.delivered ?? 0} label="Handed over this month" />
        <Kpi
          value={pace.data?.stock.days_of_stock == null ? "—" : `${fmtNumber(Math.round(pace.data.stock.days_of_stock))} days`}
          label={`Of stock on hand at this month's pace · ${plural(pace.data?.stock.on_hand ?? 0, "car")}`}
          tone={(pace.data?.stock.days_of_stock ?? 0) > 90 ? "warn" : undefined}
        />
        <Kpi n={over90?.cars ?? 0} label={`Standing over 90 days${over90?.value ? ` · ${fmtMoneyShort(over90.value)}` : ""}`} tone="danger" to="/stock/cars?commitment=FREE" />
      </div>

      <div className="board-charts">
        <ChartPanel title="What the money is sitting in, by age" basis={m?.basis} option={blockedByAge} height={180} empty={!m?.blocked.some((b) => b.cars > 0)} />
        <ChartPanel title="Allotted, billed and handed over, day by day" basis={daily.data?.basis} option={movement} height={180} empty={days.length < 2} />
      </div>

      <Panel title={`Models that are not clearing (${fmtNumber(stuck.length)})`} basis={models.data?.basis} grow>
        {stuck.length ? (
          <DataTable columns={columns} rows={stuck} rowKey={(r) => r.model} caption="Models holding old stock or selling too slowly to clear it" />
        ) : (
          <Empty title="Nothing is standing still" hint="No model is holding stock over 60 days or carrying more than three months of cover." />
        )}
      </Panel>
    </div>
  );
}
