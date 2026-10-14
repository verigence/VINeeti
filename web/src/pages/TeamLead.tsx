// The sales lead's board. One screen, no scrolling: four figures across the top, three pictures under
// them, and the one list that needs working through — which scrolls inside its own panel rather than
// pushing everything else off the screen.
//
// Each fact appears once. The payment bands are a chart and the overdue rows are a list, and they are
// not the same thing: one says how bad it is, the other says whom to ring.

import type { EChartsCoreOption } from "echarts/core";
import { useState } from "react";
import { api } from "../api";
import { PALETTE } from "../components/Chart";
import { BoardStale, ChartPanel, Kpi, MUTED, Panel, axis, nameAxis } from "../components/BoardParts";
import { Chip, DataTable, Empty, ErrorBox, Loading, type Column } from "../components/ui";
import { fmtDate, fmtMoney, fmtNumber, plural } from "../format";
import { useLoad } from "../hooks";
import { Link } from "../router";
import type { BelowMinimumRow, DueRow, HoldingRow } from "../types";

export function TeamLeadBoard() {
  const due = useLoad(() => api.paymentsDue(), "lead:due");
  const demand = useLoad(() => api.demand(), "lead:demand");
  const holding = useLoad(() => api.holding(), "lead:holding");
  const waiting = useLoad(() => api.waitingLine(), "lead:waiting");
  // The one list on this board shows one of two jobs. They are both "ring this customer about money",
  // but they are different money, so they are not mixed into one table with half the columns blank.
  const [list, setList] = useState<"CHASE" | "SHORT">("CHASE");

  if (due.loading && !due.data) return <Loading label="Loading the board" />;
  if (due.error && !due.data) return <ErrorBox message={due.error} onRetry={() => void due.reload()} />;
  const d = due.data;
  const dem = demand.data;
  const held = holding.data?.rows ?? [];
  const short = waiting.data?.below_minimum;

  // Allocated, paid for, and still not invoiced: the step that quietly adds days to every delivery.
  const toInvoice = held.filter((r) => !r.invoiced && r.payment === "RECEIVED");
  const overWindow = (d?.rows ?? []).filter((r) => r.days_left < 0);

  // Every car a booking is holding, by how long it has been held and what is still missing. This is the
  // lead's two standing questions in one picture: which cars have sat more than five days with nothing
  // paid, and which have been paid for and are still waiting on an invoice.
  const HELD_BANDS: [string, number, number][] = [["0-5 days", 0, 5], ["6-10 days", 6, 10], ["11-20 days", 11, 20], ["Over 20 days", 21, 1e9]];
  const STAGES = [
    { key: "Not paid", colour: "#9a2a20", of: (r: HoldingRow) => !r.invoiced && r.payment === "NONE" },
    { key: "Reported", colour: "#c98a2e", of: (r: HoldingRow) => !r.invoiced && r.payment === "REPORTED" },
    { key: "Paid, to bill", colour: PALETTE[3], of: (r: HoldingRow) => !r.invoiced && r.payment === "RECEIVED" },
    { key: "Billed", colour: PALETTE[1], of: (r: HoldingRow) => r.invoiced },
  ];
  const inBand = (b: [string, number, number]) => held.filter((r) => r.held_days >= b[1] && r.held_days <= b[2]);
  const heldByAge: EChartsCoreOption = {
    tooltip: { trigger: "axis" },
    legend: { bottom: 0, itemGap: 12, itemWidth: 10, itemHeight: 8, textStyle: { fontSize: 11, color: MUTED } },
    grid: { left: 4, right: 12, top: 10, bottom: 26, containLabel: true },
    xAxis: { type: "category", data: HELD_BANDS.map((b) => b[0]), ...axis, splitLine: { show: false } },
    yAxis: { type: "value", minInterval: 1, ...axis },
    series: STAGES.map((st, i) => ({
      name: st.key,
      type: "bar",
      stack: "h",
      barMaxWidth: 38,
      itemStyle: { color: st.colour, borderRadius: i === STAGES.length - 1 ? [4, 4, 0, 0] : undefined },
      data: HELD_BANDS.map((b) => inBand(b).filter(st.of).length),
    })),
  };

  const top = (dem?.rows ?? []).slice(0, 7);
  const demandBars: EChartsCoreOption = {
    tooltip: {
      trigger: "axis",
      formatter: (p: unknown) => {
        const a = (p as { name: string; value: number }[])[0];
        const r = top.find((x) => `${x.model} ${x.colour}` === a?.name);
        return r ? `${r.model} ${r.variant}<br/>${r.colour}<br/>${r.queue} waiting · ${r.free_now} free · ${r.on_order} on order<br/>longest wait ${r.longest_wait_days} days` : "";
      },
    },
    legend: { bottom: 0, itemGap: 14, textStyle: { fontSize: 11, color: MUTED } },
    grid: { left: 4, right: 14, top: 10, bottom: 26, containLabel: true },
    xAxis: { type: "value", minInterval: 1, ...axis },
    yAxis: nameAxis(top.map((r) => `${r.model} ${r.colour}`), 140),
    series: [
      { name: "Nothing coming", type: "bar", stack: "q", barMaxWidth: 16, itemStyle: { color: "#9a2a20" }, data: top.map((r) => r.short_by).reverse() },
      { name: "Covered", type: "bar", stack: "q", barMaxWidth: 16, itemStyle: { color: PALETTE[1], borderRadius: [0, 4, 4, 0] }, data: top.map((r) => r.queue - r.short_by).reverse() },
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

  // A booking below the dealership's minimum is not in the queue at all, so no car will ever come to it
  // on its own. Somebody has to collect the rest of the booking amount, and nobody will if this list is
  // not in front of them.
  const shortColumns: Column<BelowMinimumRow>[] = [
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
    { header: "Booked", num: true, cell: (r) => <span className="nowrap">{fmtDate(r.booked_on)}</span> },
    { header: "Waiting", num: true, cell: (r) => plural(r.waiting_days, "day") },
    { header: "Paid", num: true, cell: (r) => fmtMoney(r.booking_amount) },
    { header: "Short by", num: true, cell: (r) => <span className="strong danger-text">{fmtMoney(r.short_by)}</span> },
    { header: "Sales", cell: (r) => r.sales_exec ?? <span className="muted">—</span> },
  ];

  const chase = overWindow.length ? overWindow : d?.rows ?? [];
  const chaseTitle = `${overWindow.length ? "Chase these today" : "Payments still to collect"} (${fmtNumber(chase.length)})`;

  return (
    <div className="board-screen">
      <BoardStale source={d?.source} />
      <div className="board-kpis">
        <Kpi n={d?.totals.past_window ?? 0} label={`Past the ${d?.window_days ?? 0}-day payment window`} tone="danger" to="/payments" />
        <Kpi n={d?.totals.awaiting ?? 0} label="Held, nothing paid yet" tone="warn" to="/payments" />
        <Kpi n={toInvoice.length} label="Paid, waiting to be invoiced" tone={toInvoice.length ? "warn" : undefined} to="/bookings?status=ALLOCATED" />
        <Kpi n={dem?.totals.short ?? 0} label="Customers with nothing coming" tone="danger" to="/dashboards/orders" />
        {short && short.minimum > 0 && <Kpi n={short.bookings.length} label={`Under the ${fmtMoney(short.minimum)} minimum, out of the queue`} tone="danger" />}
      </div>

      <div className="board-charts">
        <ChartPanel title="Cars being held, by how long and what is missing" basis={holding.data?.basis} option={heldByAge} empty={!held.length} />
        <ChartPanel title="Biggest queues, and how much of each is covered" basis={dem?.basis} option={demandBars} empty={!top.length} />
      </div>

      <Panel
        title={
          short && short.minimum > 0 ? (
            <span className="panel-tabs">
              <button type="button" className={list === "CHASE" ? "on" : undefined} onClick={() => setList("CHASE")}>
                {chaseTitle}
              </button>
              <button type="button" className={list === "SHORT" ? "on" : undefined} onClick={() => setList("SHORT")}>
                Under the minimum ({fmtNumber(short.bookings.length)})
              </button>
            </span>
          ) : (
            chaseTitle
          )
        }
        basis={list === "SHORT" ? `A booking has to reach ${fmtMoney(short?.minimum ?? 0)} before it takes a place in the queue. These have not, so no car will come to them until the rest is paid. The minimum is only ever applied to a customer who has not been given a car.` : undefined}
        grow
      >
        {list === "SHORT" ? (
          short?.bookings.length ? (
            <DataTable columns={shortColumns} rows={short.bookings} rowKey={(r) => r.booking_id} caption="Bookings below the minimum booking amount" />
          ) : (
            <Empty title="Every booking has paid the minimum" hint="Nobody is sitting outside the queue for want of a booking amount." />
          )
        ) : chase.length ? (
          <DataTable columns={columns} rows={chase} rowKey={(r) => r.booking_id} caption="Payments owed on held cars" />
        ) : (
          <Empty title="Every held car is paid for" hint="Nothing is sitting against an unpaid booking." />
        )}
      </Panel>
    </div>
  );
}
