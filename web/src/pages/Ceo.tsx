// The Business Head's / CEO's board: the operation as a whole.
//
// A CEO is not chasing a car or a customer. The questions are about the shape of the business: which
// models are piling up, whether the dealership is still ordering more of exactly those, how much money
// is tied up and for how long, how many customers are waiting with nothing coming, and which models
// earn their place in the yard against which ones do not.
//
// The piling-up picture carries the order bank beside the old stock, because "standing and still being
// ordered" is one fact, not two. The list ranks models by how fast they actually move, so the two ends
// of it are the highly sellable and the barely sellable without anyone having to work it out.

import type { EChartsCoreOption } from "echarts/core";
import { api } from "../api";
import { AGE_COLOURS, PALETTE } from "../components/Chart";
import { BoardStale, ChartPanel, Kpi, MUTED, Panel, axis, nameAxis, shortBand } from "../components/BoardParts";
import { DataTable, Empty, ErrorBox, Loading, type Column } from "../components/ui";
import { fmtMoney, fmtMoneyShort, fmtNumber, plural } from "../format";
import { useLoad } from "../hooks";
import type { ModelRow } from "../types";

export function CeoBoard() {
  const models = useLoad(() => api.models(), "ceo:models");
  const money = useLoad(() => api.money(), "ceo:money");
  const waiting = useLoad(() => api.waitingLine(), "ceo:waiting");

  if (models.loading && !models.data) return <Loading label="Loading the board" />;
  if (models.error && !models.data) return <ErrorBox message={models.error} onRetry={() => void models.reload()} />;
  const rows = models.data?.rows ?? [];
  const m = money.data;
  const w = waiting.data;

  // Piling up: free cars standing over 60 days. Worst first, and only the ones that have any.
  const piling = [...rows].filter((r) => r.old_free > 0).sort((a, b) => b.old_free - a.old_free).slice(0, 7);
  const stillOrdering = piling.filter((r) => r.on_order > 0);
  const pilingUp: EChartsCoreOption = {
    tooltip: {
      trigger: "axis",
      formatter: (p: unknown) => {
        const a = (p as { name: string }[])[0];
        const r = piling.find((x) => x.model === a?.name);
        if (!r) return "";
        return `${r.model}<br/>${plural(r.old_free, "car")} standing over 60 days${r.old_value ? ` · ${fmtMoney(r.old_value)}` : ""}<br/>${r.on_order > 0 ? `${fmtNumber(r.on_order)} more on order` : "nothing more on order"}<br/>${r.sold_90} sold in 90 days`;
      },
    },
    legend: { bottom: 0, data: ["Standing over 60 days", "Still on order"] },
    grid: { left: 4, right: 20, top: 10, bottom: 30, containLabel: true },
    xAxis: { type: "value", minInterval: 1, ...axis },
    yAxis: nameAxis(piling.map((r) => r.model), 120),
    series: [
      { name: "Standing over 60 days", type: "bar", stack: "p", barMaxWidth: 16, itemStyle: { color: AGE_COLOURS[3] }, data: piling.map((r) => r.old_free).reverse() },
      // Beside it, not behind it: ordering more of a model that is already standing is the thing to see.
      { name: "Still on order", type: "bar", stack: "p", barMaxWidth: 16, itemStyle: { color: PALETTE[7], borderRadius: [0, 4, 4, 0] }, data: piling.map((r) => r.on_order).reverse() },
    ],
  };

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
    series: [{ type: "bar", barMaxWidth: 40, data: (m?.blocked ?? []).map((b, i) => ({ value: b.value, itemStyle: { color: AGE_COLOURS[i] ?? AGE_COLOURS[3], borderRadius: [4, 4, 0, 0] } })) }],
  };

  const waitingAges: EChartsCoreOption = {
    tooltip: { trigger: "axis" },
    legend: { show: false },
    grid: { left: 4, right: 12, top: 12, bottom: 12, containLabel: true },
    xAxis: { type: "category", data: (w?.buckets ?? []).map((b) => shortBand(b.label)), ...axis, splitLine: { show: false } },
    yAxis: { type: "value", minInterval: 1, ...axis },
    series: [
      {
        type: "bar",
        barMaxWidth: 40,
        data: (w?.buckets ?? []).map((b, i) => ({ value: b.bookings, itemStyle: { color: [PALETTE[1], PALETTE[3], "#c98a2e", "#b85c38", "#9a2a20"][i] ?? PALETTE[0], borderRadius: [4, 4, 0, 0] } })),
        label: { show: true, position: "top", color: MUTED, fontSize: 11 },
      },
    ],
  };

  const columns: Column<ModelRow>[] = [
    { header: "Model", primary: true, cell: (r) => <span className="strong">{r.model}</span> },
    { header: "Sold in 90 days", num: true, cell: (r) => (r.sold_90 > 0 ? fmtNumber(r.sold_90) : <span className="muted">none</span>) },
    { header: "Free now", num: true, cell: (r) => fmtNumber(r.yard_free + r.transit_free) },
    {
      header: "Months of cover",
      num: true,
      status: true,
      cell: (r) =>
        r.months_of_cover === null ? (
          <span className="danger-text strong">{r.yard_free + r.transit_free > 0 ? "nothing sold" : "—"}</span>
        ) : (
          <span className={r.months_of_cover >= 3 ? "strong danger-text" : r.months_of_cover < 1 ? "strong" : undefined}>{r.months_of_cover}</span>
        ),
    },
    { header: "Customers waiting", num: true, cell: (r) => (r.waiting > 0 ? <span className="strong">{fmtNumber(r.waiting)}</span> : <span className="muted">—</span>) },
    { header: "Money standing", num: true, cell: (r) => (r.value ? <span title={fmtMoney(r.value)}>{fmtMoneyShort(r.value)}</span> : <span className="muted">—</span>) },
  ];

  // Fastest first: a model that sells is a model that earns its space, and the bottom of this list is
  // where the yard is being paid for twice.
  const ranked = [...rows].sort((a, b) => b.sold_90 - a.sold_90 || b.waiting - a.waiting || a.model.localeCompare(b.model));
  const overSixty = (w?.buckets ?? []).filter((b) => b.label === "31-60 days" || b.label === "Over 60 days").reduce((n, b) => n + b.bookings, 0);

  return (
    <div className="board-screen">
      <BoardStale source={models.data?.source} />
      <div className="board-kpis">
        <Kpi n={piling.length} label="Models with stock standing over 60 days" tone="warn" />
        <Kpi n={stillOrdering.length} label="Of those, still being ordered" tone="danger" to="/analytics/orders" />
        <Kpi value={fmtMoneyShort(m?.blocked_total.value)} label={`Lying in ${plural(m?.blocked_total.cars ?? 0, "unsold car")}`} />
        <Kpi n={overSixty} label="Customers waiting over a month" tone="warn" to="/analytics/orders" />
      </div>

      <div className="board-charts">
        <ChartPanel title="Piling up, and what is still on order" basis={models.data?.basis} option={pilingUp} height={180} empty={!piling.length} />
        <ChartPanel title="Money tied up, by age" basis={m?.basis} option={blockedByAge} height={180} empty={!m?.blocked.some((b) => b.cars > 0)} />
        <ChartPanel title="How long customers have been waiting" basis={w?.basis} option={waitingAges} height={180} empty={!w?.rows.length} />
      </div>

      <Panel title="Every model, fastest-selling first" basis="Sold counts cars with a retail invoice in the last 90 days. Months of cover is the free stock divided by the last 90 days' sales a month: how long the yard would last at that rate. Customers waiting are approved bookings in the queue with no car allocated." grow>
        {ranked.length ? (
          <DataTable columns={columns} rows={ranked} rowKey={(r) => r.model} caption="Models by how fast they sell, with what is standing against each" />
        ) : (
          <Empty title="No stock and no sales yet" hint="Load the stock report and the booking sheet on Daily update." />
        )}
      </Panel>
    </div>
  );
}
