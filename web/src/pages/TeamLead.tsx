// The sales lead's board. One screen, no scrolling: four figures across the top, three pictures under
// them, and the one list that needs working through — which scrolls inside its own panel rather than
// pushing everything else off the screen.
//
// Each fact appears once. The payment bands are a chart and the overdue rows are a list, and they are
// not the same thing: one says how bad it is, the other says whom to ring.

import type { EChartsCoreOption } from "echarts/core";
import { api } from "../api";
import { Chart, PALETTE } from "../components/Chart";
import { Chip, DataTable, Empty, ErrorBox, Loading, type Column } from "../components/ui";
import { fmtNumber, plural } from "../format";
import { useLoad } from "../hooks";
import { Link } from "../router";
import type { DueRow } from "../types";

const MUTED = "#5b6672";
const axis = {
  axisLine: { lineStyle: { color: "#d9e2e8" } },
  axisTick: { show: false },
  axisLabel: { color: MUTED, fontSize: 11 },
  splitLine: { lineStyle: { color: "#eef3f6" } },
};

export function TeamLeadBoard() {
  const due = useLoad(() => api.paymentsDue(), "lead:due");
  const demand = useLoad(() => api.demand(), "lead:demand");
  const holding = useLoad(() => api.holding(), "lead:holding");

  if (due.loading && !due.data) return <Loading label="Loading the board" />;
  if (due.error && !due.data) return <ErrorBox message={due.error} onRetry={() => void due.reload()} />;
  const d = due.data;
  const dem = demand.data;
  const held = holding.data?.rows ?? [];

  // Allocated, paid for, and still not invoiced: the step that quietly adds days to every delivery.
  const toInvoice = held.filter((r) => !r.invoiced && r.payment === "RECEIVED");
  const overWindow = (d?.rows ?? []).filter((r) => r.days_left < 0);

  const paymentBands: EChartsCoreOption = {
    tooltip: { trigger: "axis" },
    legend: { show: false },
    grid: { left: 4, right: 12, top: 10, bottom: 4, containLabel: true },
    xAxis: { type: "value", minInterval: 1, ...axis },
    yAxis: { type: "category", data: (d?.buckets ?? []).map((b) => b.label).reverse(), ...axis, splitLine: { show: false } },
    series: [
      {
        type: "bar",
        barMaxWidth: 18,
        data: (d?.buckets ?? [])
          .map((b, i) => ({ value: b.bookings, itemStyle: { color: [PALETTE[1], PALETTE[3], "#c98a2e", "#9a2a20"][i] ?? PALETTE[0], borderRadius: [0, 4, 4, 0] } }))
          .reverse(),
        label: { show: true, position: "right", color: MUTED, fontSize: 11 },
      },
    ],
  };

  const top = (dem?.rows ?? []).slice(0, 7);
  const demandBars: EChartsCoreOption = {
    tooltip: { trigger: "axis", formatter: (p: unknown) => {
      const a = (p as { name: string; value: number }[])[0];
      const r = top.find((x) => `${x.model} ${x.colour}` === a?.name);
      return r ? `${r.model} ${r.variant}<br/>${r.colour}<br/>${r.queue} waiting · ${r.free_now} free · ${r.on_order} on order<br/>longest wait ${r.longest_wait_days} days` : "";
    } },
    legend: { show: false },
    grid: { left: 4, right: 14, top: 10, bottom: 4, containLabel: true },
    xAxis: { type: "value", minInterval: 1, ...axis },
    yAxis: { type: "category", data: top.map((r) => `${r.model} ${r.colour}`).reverse(), ...axis, splitLine: { show: false }, axisLabel: { ...axis.axisLabel, width: 150, overflow: "truncate" } },
    series: [
      { name: "Nothing coming", type: "bar", stack: "q", barMaxWidth: 16, itemStyle: { color: "#9a2a20" }, data: top.map((r) => r.short_by).reverse() },
      { name: "Covered", type: "bar", stack: "q", barMaxWidth: 16, itemStyle: { color: PALETTE[1], borderRadius: [0, 4, 4, 0] }, data: top.map((r) => r.queue - r.short_by).reverse() },
    ],
  };

  // Customers with no car, by model: which models the unserved demand actually sits in.
  const byModel = new Map<string, number>();
  for (const r of dem?.rows ?? []) byModel.set(r.model, (byModel.get(r.model) ?? 0) + r.queue);
  const models = [...byModel].sort((a, b) => b[1] - a[1]);
  const unservedPie: EChartsCoreOption = {
    tooltip: { trigger: "item" },
    legend: { bottom: 0, itemGap: 10, textStyle: { fontSize: 11, color: MUTED } },
    series: [
      {
        type: "pie",
        radius: ["42%", "64%"],
        center: ["50%", "40%"],
        itemStyle: { borderColor: "#fff", borderWidth: 2 },
        label: { show: false },
        data: models.slice(0, 7).map(([name, value]) => ({ name, value })),
      },
    ],
  };

  const columns: Column<DueRow>[] = [
    {
      header: "Booking",
      primary: true,
      cell: (r) => (
        <Link to={`/bookings/${r.booking_id}`} className="cell-link">
          <span className="strong nowrap">{r.booking_no}</span>
          <span className="sub">{r.customer_name}</span>
        </Link>
      ),
    },
    { header: "Car", cell: (r) => (<span><span>{r.model}</span><span className="sub">{r.colour}</span></span>) },
    { header: "In the window", num: true, cell: (r) => <span className={r.days_left < 0 ? "strong danger-text" : undefined}>{plural(r.window_days, "day")}</span> },
    { header: "Left", num: true, cell: (r) => (r.days_left < 0 ? <Chip tone="red">{plural(-r.days_left, "day")} over</Chip> : plural(r.days_left, "day")) },
    { header: "Payment", status: true, cell: (r) => (r.state === "REPORTED" ? <Chip tone="amber">Reported, not checked</Chip> : <Chip tone="red">Not paid</Chip>) },
    { header: "Sales", cell: (r) => r.sales_exec ?? <span className="muted">—</span> },
  ];

  return (
    <div className="board-screen">
      <div className="board-kpis">
        <Kpi n={d?.totals.past_window ?? 0} label={`Past the ${d?.window_days ?? 0}-day payment window`} tone="danger" to="/payments" />
        <Kpi n={d?.totals.awaiting ?? 0} label="Held, nothing paid yet" tone="warn" to="/payments" />
        <Kpi n={toInvoice.length} label="Paid, waiting to be invoiced" tone={toInvoice.length ? "warn" : undefined} to="/bookings?status=ALLOCATED" />
        <Kpi n={dem?.totals.short ?? 0} label="Customers with nothing coming" tone="danger" to="/dashboards/orders" />
      </div>

      <div className="board-charts">
        <Panel title="Money owed, by how long the car has been held" basis={d?.basis}>
          <Chart option={paymentBands} height={168} />
        </Panel>
        <Panel title="Biggest queues, and how much of each is covered" basis={dem?.basis}>
          <Chart option={demandBars} height={168} />
        </Panel>
        <Panel title="Customers with no car, by model">
          <Chart option={unservedPie} height={168} />
        </Panel>
      </div>

      <Panel title={`Chase these today (${fmtNumber(overWindow.length || d?.rows.length || 0)})`} grow>
        {(overWindow.length ? overWindow : d?.rows ?? []).length ? (
          <DataTable columns={columns} rows={overWindow.length ? overWindow : d!.rows} rowKey={(r) => r.booking_id} caption="Payments owed on held cars" />
        ) : (
          <Empty title="Every held car is paid for" hint="Nothing is sitting against an unpaid booking." />
        )}
      </Panel>
    </div>
  );
}

function Kpi({ n, label, tone, to }: { n: number; label: string; tone?: "warn" | "danger"; to: string }) {
  return (
    <Link to={to} className={`board-kpi${tone && n > 0 ? ` board-kpi-${tone}` : ""}`}>
      <span className="board-kpi-n">{fmtNumber(n)}</span>
      <span className="board-kpi-label">{label}</span>
    </Link>
  );
}

function Panel({ title, basis, children, grow }: { title: string; basis?: string; children: React.ReactNode; grow?: boolean }) {
  return (
    <section className={`board-panel${grow ? " board-panel-grow" : ""}`}>
      <h2>{title}</h2>
      <div className="board-panel-body">{children}</div>
      {basis && (
        <details className="chart-basis">
          <summary>How this is counted</summary>
          <p>{basis}</p>
        </details>
      )}
    </section>
  );
}
