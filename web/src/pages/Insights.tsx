// Three views added alongside the existing screens rather than in place of them: what the cars
// earned, whether the business is keeping up with itself, and whether the system is being used.
//
// They exist because the money arrived late. Until the retail invoice export was read, nothing here
// knew what a car sold for or what it had cost, so every screen could show movement and none could
// show whether the movement was worth anything. These are the ones that can.
//
// Each figure says what it is worked out from, and the ones that cannot be worked out for every car
// say so rather than averaging over the ones that happen to have the data.

import { useState } from "react";
import { api } from "../api";
import { Chart, dayLabel, PALETTE } from "../components/Chart";
import { Async, Card, Chip, DataTable, Empty, Field, Notice, Stat, type Column } from "../components/ui";
import { fmtDate, fmtMoney, fmtMoneyShort, fmtNumber, plural, today } from "../format";
import { useLoad } from "../hooks";
import { useSession } from "../session";
import type { ConsultantRow, ModelMoney, RequestRow, Unclaimed } from "../types";

const Basis = ({ text }: { text: string }) => <p className="measure-basis">{text}</p>;
const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};
const pc = (n: number | null) => (n === null ? "—" : `${n}%`);

/** The period picker, the same one the other reports use. */
function usePeriod(defaultFrom: string) {
  const day = today();
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(day);
  const valid = Boolean(from && to && from <= to && to <= day);
  const picker = (
    <Card title="Period">
      <div className="form-grid">
        <Field label="From">
          <input type="date" value={from} max={to || day} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <input type="date" value={to} min={from} max={day} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </div>
      {!valid && <Notice tone="warn">Choose a period that starts before it ends and does not end in the future.</Notice>}
    </Card>
  );
  return { from, to, valid, picker, key: valid ? `${from}:${to}` : "invalid" };
}

const change = (now: number, before: number) => {
  if (!before) return undefined;
  const d = Math.round(((now - before) / before) * 1000) / 10;
  return `${d >= 0 ? "+" : ""}${d}% on the period before`;
};

// ================================================================ the owner: what the cars earned

export function MoneyTab() {
  const period = usePeriod(daysAgo(29));
  const load = useLoad(() => (period.valid ? api.insightsMoney(period.from, period.to) : Promise.reject(new Error("The period is not valid"))), `insights:money:${period.key}`);

  const modelCols: Column<ModelMoney>[] = [
    { header: "Model", primary: true, cell: (r) => <span className="strong">{r.model}</span> },
    { header: "Sold", num: true, cell: (r) => fmtNumber(r.invoices) },
    { header: "Revenue", num: true, cell: (r) => fmtMoney(r.revenue) },
    { header: "Average sold for", num: true, cell: (r) => fmtMoney(r.avg_selling) },
    { header: "Out of our margin", num: true, cell: (r) => fmtMoney(r.dealer_discount) },
    { header: "On schemes", num: true, cell: (r) => fmtMoney(r.oem_discount) },
    {
      header: "Given away per car",
      num: true,
      cell: (r) =>
        r.avg_discount === null ? (
          <span className="muted">—</span>
        ) : (
          <span className={(r.discount_pct ?? 0) > 10 ? "strong danger" : "strong"}>
            {fmtMoney(r.avg_discount)}
            <span className="sub">{pc(r.discount_pct)} of the price</span>
          </span>
        ),
    },
  ];

  const unclaimedCols: Column<Unclaimed>[] = [
    { header: "Invoice", primary: true, cell: (r) => <><span className="strong mono">{r.invoice_no}</span><span className="sub">{r.invoice_date ? fmtDate(r.invoice_date) : ""}</span></> },
    { header: "Customer", cell: (r) => r.customer_name },
    { header: "Car", cell: (r) => <><span className="mono">{r.vin}</span><span className="sub">{r.model}</span></> },
    { header: "To claim back", num: true, cell: (r) => <span className="strong danger">{fmtMoney(r.amount)}</span> },
  ];

  return (
    <>
      {period.picker}
      <Async load={load}>
        {(d) => (
          <>
            <div className="tiles">
              <Stat label="Revenue" value={fmtMoneyShort(d.totals.revenue)} hint={change(d.totals.revenue, d.previous.revenue) ?? fmtMoney(d.totals.revenue)} />
              <Stat label="Cars invoiced" value={fmtNumber(d.totals.invoices)} hint={change(d.totals.invoices, d.previous.invoices)} />
              <Stat label="Average sold for" value={fmtMoneyShort(d.totals.avg_selling ?? 0)} hint={fmtMoney(d.totals.avg_selling ?? 0)} />
              <Stat
                label="Given away"
                value={fmtMoneyShort(d.totals.discount)}
                hint={`${pc(d.totals.discount_pct)} of what the cars would have sold for`}
                tone={(d.totals.discount_pct ?? 0) > 10 ? "warn" : undefined}
              />
            </div>
            <div className="tiles">
              <Stat label="Out of our own margin" value={fmtMoneyShort(d.totals.dealer_discount)} hint="Dealer discount: gone, not recoverable" />
              <Stat label="Loyalty and exchange" value={fmtMoneyShort(d.totals.loyalty_discount + d.totals.exchange_discount)} hint="Claimed back with their own credit notes" />
              <Stat label="On the manufacturer's schemes" value={fmtMoneyShort(d.totals.oem_discount)} hint="Recoverable with a credit note" />
              <Stat
                label="Not claimed back"
                value={d.claims_not_stated ? "—" : fmtMoneyShort(d.totals.unclaimed)}
                hint={d.claims_not_stated ? "The export leaves the credit note column blank on every row, so it says nothing either way" : `${plural(d.totals.unclaimed_cars, "car")} with no credit note against the discount`}
                tone={!d.claims_not_stated && d.totals.unclaimed > 0 ? "danger" : undefined}
              />
              <Stat label="Insurance written" value={fmtMoneyShort(d.attached.insurance_amount)} hint={`${pc(d.attached.insurance_pct)} of cars insured here`} />
            </div>

            {d.days.length > 1 && (
              <Card title="Revenue and discount, day by day" className="chart-card">
                <Chart
                  height={260}
                  option={{
                    tooltip: { trigger: "axis" },
                    legend: { bottom: 0, textStyle: { color: "#5b6672" } },
                    grid: { left: 70, right: 56, top: 16, bottom: 48 },
                    xAxis: { type: "category", data: d.days.map((x) => dayLabel(x.date)), axisLabel: { color: "#5b6672" }, axisTick: { show: false } },
                    yAxis: [
                      { type: "value", name: "Revenue", axisLabel: { color: "#5b6672", formatter: (v: number) => fmtMoneyShort(v) }, splitLine: { lineStyle: { color: "#e9eff3" } } },
                      { type: "value", name: "Cars", minInterval: 1, axisLabel: { color: "#5b6672" }, splitLine: { show: false } },
                    ],
                    series: [
                      { name: "Revenue", type: "bar", barMaxWidth: 20, itemStyle: { color: PALETTE[1], borderRadius: [3, 3, 0, 0] }, data: d.days.map((x) => x.revenue) },
                      { name: "Given away", type: "bar", barMaxWidth: 20, itemStyle: { color: PALETTE[5], borderRadius: [3, 3, 0, 0] }, data: d.days.map((x) => x.discount) },
                      { name: "Cars", type: "line", yAxisIndex: 1, smooth: true, symbol: "none", lineStyle: { color: PALETTE[5], width: 2 }, itemStyle: { color: PALETTE[5] }, data: d.days.map((x) => x.invoices) },
                    ],
                  }}
                />
                <p className="measure-basis">Discount is everything taken off the price that day — the dealership's own and the manufacturer's schemes together.</p>
              </Card>
            )}

            <div className="split split-even">
              {d.models.some((m) => m.discount_pct !== null) && (
                <Card title="How hard each model is discounted" className="chart-card">
                  <Chart
                    height={280}
                    option={{
                      tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, valueFormatter: (v: number) => `${v}%` },
                      grid: { left: 110, right: 48, top: 10, bottom: 28 },
                      xAxis: { type: "value", axisLabel: { color: "#5b6672", formatter: "{value}%" }, splitLine: { lineStyle: { color: "#e9eff3" } } },
                      yAxis: {
                        type: "category",
                        data: d.models.filter((m) => m.discount_pct !== null).slice(0, 10).map((m) => m.model).reverse(),
                        axisLabel: { color: "#5b6672" },
                        axisTick: { show: false },
                      },
                      series: [
                        {
                          name: "Share of the price given away",
                          type: "bar",
                          barMaxWidth: 18,
                          label: { show: true, position: "right", formatter: "{c}%", color: "#5b6672" },
                          data: d.models
                            .filter((m) => m.discount_pct !== null)
                            .slice(0, 10)
                            .map((m) => ({ value: m.discount_pct, itemStyle: { color: (m.discount_pct ?? 0) > 10 ? "#9a2a20" : PALETTE[1], borderRadius: [0, 3, 3, 0] } }))
                            .reverse(),
                        },
                      ],
                    }}
                  />
                  <p className="measure-basis">
                    The ten models with the most revenue, by how much of the price is given away on them — the dealership's own discount and the manufacturer's schemes together, against what the cars
                    would have sold for. A model that moves only when it is discounted shows up here and nowhere else.
                  </p>
                </Card>
              )}

              <Card title="What else came with the sale" className="chart-card">
                <Chart
                  height={280}
                  option={{
                    tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, valueFormatter: (v: number) => `${v}%` },
                    grid: { left: 130, right: 40, top: 10, bottom: 28 },
                    xAxis: { type: "value", max: 100, axisLabel: { color: "#5b6672", formatter: "{value}%" }, splitLine: { lineStyle: { color: "#e9eff3" } } },
                    yAxis: { type: "category", data: ["Exchange", "Insured here", "Financed through us", "Financed at all"], axisLabel: { color: "#5b6672" }, axisTick: { show: false } },
                    series: [
                      {
                        type: "bar",
                        barMaxWidth: 20,
                        itemStyle: { color: PALETTE[2], borderRadius: [0, 3, 3, 0] },
                        label: { show: true, position: "right", formatter: "{c}%", color: "#5b6672" },
                        data: [d.attached.exchange_pct ?? 0, d.attached.insurance_pct ?? 0, d.attached.dealer_finance_pct ?? 0, d.attached.finance_pct ?? 0],
                      },
                    ],
                  }}
                />
                <p className="measure-basis">
                  Finance arranged through the dealership and insurance written here earn a commission the car itself does not. The gap between financed at all and financed through us is business that
                  went to somebody else.
                </p>
              </Card>
            </div>

            <div className="tiles">
              <Stat label="Handed over" value={`${fmtNumber(d.delivery.delivered)} of ${fmtNumber(d.delivery.invoiced)}`} hint="A delivery note is recorded against the invoice" />
              <Stat label="Invoice to handover" value={d.delivery.median_days === null ? "—" : plural(d.delivery.median_days, "day")} hint="Median, over the cars with a delivery note" />
              <Stat label="Took over a week" value={fmtNumber(d.delivery.over_a_week)} tone={d.delivery.over_a_week ? "warn" : undefined} hint="Billed, and the customer still waiting" />
            </div>

            <Card title="Every model, by what it brings in" flush>
              <Async load={load} isEmpty={(x) => x.models.length === 0} empty={<Empty title="No retail invoices in this period" hint="Load the retail export on Upload DMS files." />}>
                {(x) => <DataTable columns={modelCols} rows={x.models} rowKey={(r) => r.model} caption="Models by revenue" />}
              </Async>
            </Card>

            {d.unclaimed_list.length > 0 && (
              <Card
                title="Scheme discount with no credit note"
                note="Money given away on the manufacturer's behalf that nobody has asked back. Each line is a claim somebody has to raise."
                flush
              >
                <DataTable columns={unclaimedCols} rows={d.unclaimed_list} rowKey={(r) => r.invoice_no} caption="Discount not claimed back" />
              </Card>
            )}

            <Basis text={d.basis} />
          </>
        )}
      </Async>
    </>
  );
}

// ================================================================ the CEO: is the business healthy

/** One shape for both request lists: waiting ones show how long, decided ones show who ruled. */
const requestCols = (waiting: boolean): Column<RequestRow>[] => [
  { header: "Booking", primary: true, cell: (r) => <><span className="strong nowrap">{r.booking_no}</span><span className="sub">{r.customer_name}</span></> },
  { header: "What is being asked", cell: (r) => <>{r.what}{r.vin ? <span className="sub mono">{r.vin}</span> : null}</> },
  { header: "Asked by", cell: (r) => r.requested_by || <span className="muted">–</span> },
  { header: "Raised", cell: (r) => fmtDate(r.requested_at) },
  waiting
    ? { header: "Waiting", num: true, cell: (r) => <span className={(r.days_waiting ?? 0) > 2 ? "strong danger" : ""}>{plural(r.days_waiting ?? 0, "day")}</span> }
    : {
        header: "Decision",
        status: true,
        cell: (r) => (
          <>
            {r.status === "APPROVED" ? <Chip tone="green">Approved</Chip> : r.status === "REJECTED" ? <Chip tone="red">Refused</Chip> : <Chip tone="grey">{r.status}</Chip>}
            {r.decided_by ? <span className="sub">by {r.decided_by}</span> : null}
          </>
        ),
      },
];

export function BusinessTab() {
  const period = usePeriod(daysAgo(29));
  const load = useLoad(() => (period.valid ? api.insightsBusiness(period.from, period.to) : Promise.reject(new Error("The period is not valid"))), `insights:business:${period.key}`);

  const cols: Column<ConsultantRow>[] = [
    { header: "Consultant", primary: true, cell: (r) => <span className="strong">{r.name}</span> },
    { header: "Bookings taken", num: true, cell: (r) => fmtNumber(r.bookings) },
    {
      header: "Cancelled",
      num: true,
      cell: (r) => (r.cancelled ? <span className={(r.cancel_pct ?? 0) > 10 ? "strong danger" : ""}>{fmtNumber(r.cancelled)}<span className="sub">{pc(r.cancel_pct)}</span></span> : <span className="muted">0</span>),
    },
    { header: "Cars sold", num: true, cell: (r) => fmtNumber(r.invoiced) },
    { header: "Revenue", num: true, cell: (r) => fmtMoney(r.revenue) },
    {
      header: "Discount per car",
      num: true,
      cell: (r) => (r.avg_dealer_discount === null ? <span className="muted">—</span> : <span className={r.avg_dealer_discount > 10000 ? "strong danger" : ""}>{fmtMoney(r.avg_dealer_discount)}</span>),
    },
    { header: "Financed", num: true, cell: (r) => pc(r.financed_pct) },
    { header: "Insured", num: true, cell: (r) => pc(r.insured_pct) },
  ];

  return (
    <>
      {period.picker}
      <Async load={load}>
        {(d) => (
          <>
            <div className="tiles">
              <Stat label="Bookings taken" value={fmtNumber(d.totals.booked)} />
              <Stat label="Cancelled" value={fmtNumber(d.totals.cancelled)} hint={pc(d.totals.cancel_pct)} tone={(d.totals.cancel_pct ?? 0) > 10 ? "danger" : undefined} />
              <Stat label="Invoiced" value={fmtNumber(d.totals.invoiced)} />
              <Stat label="Handed over" value={fmtNumber(d.totals.delivered)} />
              <Stat
                label="Queue"
                value={fmtNumber(d.totals.queue_end)}
                hint={`${d.totals.queue_end >= d.totals.queue_start ? "up" : "down"} from ${fmtNumber(d.totals.queue_start)} at the start`}
                tone={d.totals.queue_end > d.totals.queue_start ? "warn" : undefined}
              />
            </div>
            <div className="tiles">
              <Stat label="Booking to car allocated" value={d.totals.median_days_to_allocate === null ? "—" : plural(d.totals.median_days_to_allocate, "day")} hint="Median, over the bookings allocated in this period" />
              <Stat label="Booking to invoice" value={d.totals.median_days_to_invoice === null ? "—" : plural(d.totals.median_days_to_invoice, "day")} hint="Median, over the bookings invoiced in this period" />
            </div>

            {d.days.length > 1 && (
              <>
                <Card title="The queue, day by day" className="chart-card">
                  <Chart
                    height={240}
                    option={{
                      tooltip: { trigger: "axis" },
                      grid: { left: 56, right: 24, top: 16, bottom: 30 },
                      xAxis: { type: "category", data: d.days.map((x) => dayLabel(x.date)), axisLabel: { color: "#5b6672" }, axisTick: { show: false } },
                      yAxis: { type: "value", minInterval: 1, axisLabel: { color: "#5b6672" }, splitLine: { lineStyle: { color: "#e9eff3" } } },
                      series: [
                        {
                          name: "Customers waiting",
                          type: "line",
                          smooth: true,
                          symbol: "none",
                          areaStyle: { color: "rgba(0,152,168,0.14)" },
                          lineStyle: { color: PALETTE[1], width: 2 },
                          itemStyle: { color: PALETTE[1] },
                          data: d.days.map((x) => x.queue),
                        },
                      ],
                    }}
                  />
                  <p className="measure-basis">
                    Bookings taken that have no car, no cancellation and no invoice yet. A line that climbs is orders being taken faster than stock can fill them; the drops are the days stock arrived.
                  </p>
                </Card>

                <Card title="Booked, allocated, invoiced, handed over" className="chart-card">
                  <Chart
                    height={240}
                    option={{
                      tooltip: { trigger: "axis" },
                      legend: { bottom: 0, textStyle: { color: "#5b6672" } },
                      grid: { left: 56, right: 24, top: 16, bottom: 48 },
                      xAxis: { type: "category", data: d.days.map((x) => dayLabel(x.date)), axisLabel: { color: "#5b6672" }, axisTick: { show: false } },
                      yAxis: { type: "value", minInterval: 1, axisLabel: { color: "#5b6672" }, splitLine: { lineStyle: { color: "#e9eff3" } } },
                      series: [
                        { name: "Booked", type: "bar", stack: undefined, barMaxWidth: 14, itemStyle: { color: PALETTE[0] }, data: d.days.map((x) => x.booked) },
                        { name: "Allocated", type: "bar", barMaxWidth: 14, itemStyle: { color: PALETTE[1] }, data: d.days.map((x) => x.allocated) },
                        { name: "Invoiced", type: "bar", barMaxWidth: 14, itemStyle: { color: PALETTE[3] }, data: d.days.map((x) => x.invoiced) },
                        { name: "Handed over", type: "bar", barMaxWidth: 14, itemStyle: { color: PALETTE[4] }, data: d.days.map((x) => x.delivered) },
                        { name: "Cancelled", type: "line", symbol: "none", lineStyle: { color: "#9a2a20", width: 2 }, itemStyle: { color: "#9a2a20" }, data: d.days.map((x) => x.cancelled) },
                      ],
                    }}
                  />
                </Card>
              </>
            )}

            {/*
              The two ends of the same question: what was put to an approver, and what went round
              them anyway. Side by side, because a day with no requests and several allotments made
              straight in the DMS is not a quiet day.
            */}
            <Card title="Put to an approver, and gone round them" className="chart-card">
              <div className="tiles tiles-compact">
                <Stat label="Changes put up for approval" value={fmtNumber(d.governance.totals.requested)} />
                <Stat label="Approved" value={fmtNumber(d.governance.totals.approved)} />
                <Stat label="Refused" value={fmtNumber(d.governance.totals.rejected)} />
                <Stat
                  label="Still waiting"
                  value={fmtNumber(d.governance.totals.pending)}
                  hint={d.governance.oldest_pending_days === null ? undefined : `oldest ${plural(d.governance.oldest_pending_days, "day")} old`}
                  tone={(d.governance.oldest_pending_days ?? 0) > 2 ? "danger" : undefined}
                />
                <Stat
                  label="Allotted in the DMS, not here"
                  value={fmtNumber(d.governance.totals.outside)}
                  hint="Nobody here was asked"
                  tone={d.governance.totals.outside ? "danger" : undefined}
                />
              </div>
              {d.days.length > 1 && (
                <Chart
                  height={230}
                  option={{
                    tooltip: { trigger: "axis" },
                    legend: { bottom: 0, textStyle: { color: "#5b6672" } },
                    grid: { left: 56, right: 24, top: 16, bottom: 48 },
                    xAxis: { type: "category", data: d.governance.days.map((x) => dayLabel(x.date)), axisLabel: { color: "#5b6672" }, axisTick: { show: false } },
                    yAxis: { type: "value", minInterval: 1, axisLabel: { color: "#5b6672" }, splitLine: { lineStyle: { color: "#e9eff3" } } },
                    series: [
                      { name: "Put up for approval", type: "bar", barMaxWidth: 16, itemStyle: { color: PALETTE[1], borderRadius: [3, 3, 0, 0] }, data: d.governance.days.map((x) => x.requested) },
                      { name: "Approved", type: "bar", barMaxWidth: 16, itemStyle: { color: PALETTE[4], borderRadius: [3, 3, 0, 0] }, data: d.governance.days.map((x) => x.approved) },
                      { name: "Refused", type: "bar", barMaxWidth: 16, itemStyle: { color: PALETTE[7], borderRadius: [3, 3, 0, 0] }, data: d.governance.days.map((x) => x.rejected) },
                      { name: "Allotted in the DMS, not here", type: "line", symbol: "circle", symbolSize: 6, lineStyle: { color: "#9a2a20", width: 2 }, itemStyle: { color: "#9a2a20" }, data: d.governance.days.map((x) => x.outside) },
                    ],
                  }}
                />
              )}
              <p className="measure-basis">
                Requests are counted on the day they were raised and decisions on the day they were made. An allotment made in the DMS is counted on the day the DMS says it was allotted, not the day
                the file reached us, so a report loaded late does not bunch three days of them onto one.
              </p>
            </Card>

            {d.governance.pending.length > 0 && (
              <Card title="Waiting for a decision" note="Nothing moves on these until somebody rules. The oldest is at the top." flush>
                <DataTable columns={requestCols(true)} rows={d.governance.pending} rowKey={(r) => r.id} caption="Waiting for a decision" />
              </Card>
            )}

            {d.governance.decided.length > 0 && (
              <Card title="Decided in this period" flush>
                <DataTable columns={requestCols(false)} rows={d.governance.decided} rowKey={(r) => r.id} caption="Decided in this period" />
              </Card>
            )}

            {d.cancel_reasons.length > 0 && (
              <Card title="Why bookings were cancelled" flush>
                <DataTable
                  columns={[
                    { header: "Reason", primary: true, cell: (r: { reason: string; n: number }) => r.reason },
                    { header: "Bookings", num: true, cell: (r: { reason: string; n: number }) => fmtNumber(r.n) },
                  ]}
                  rows={d.cancel_reasons}
                  rowKey={(r) => r.reason}
                  caption="Cancellation reasons"
                />
              </Card>
            )}

            <Card
              title="Sales consultants"
              note="Sorted by revenue. The column to read beside it is the discount per car: volume bought with the dealership's own margin is not the same as selling well."
              flush
            >
              <Async load={load} isEmpty={(x) => x.consultants.length === 0} empty={<Empty title="No consultant named on any booking or invoice in this period" />}>
                {(x) => (
                  <>
                    <DataTable columns={cols} rows={x.consultants.slice(0, 30)} rowKey={(r) => r.name} caption="Sales consultants" />
                    {x.consultants.length > 30 && (
                      <p className="measure-basis">
                        The first 30 of {fmtNumber(x.consultants.length)} by revenue. A dealership this size has a long tail of consultants with one or two bookings, and a table that lists all of them
                        is a table nobody reads to the end.
                      </p>
                    )}
                  </>
                )}
              </Async>
            </Card>

            <Basis text={d.basis} />
          </>
        )}
      </Async>
    </>
  );
}

// ================================================================ the administrator: is it being used

export function SystemTab() {
  const { roleLabel } = useSession();
  const period = usePeriod(daysAgo(29));
  const load = useLoad(() => (period.valid ? api.insightsSystem(period.from, period.to) : Promise.reject(new Error("The period is not valid"))), `insights:system:${period.key}`);

  return (
    <>
      {period.picker}
      <Async load={load}>
        {(d) => (
          <>
            <div className="tiles">
              <Stat
                label="Allocation through the system"
                value={pc(d.control.through_system_pct)}
                hint={`${fmtNumber(d.control.decided_here)} decided here, ${fmtNumber(d.control.made_in_dms)} made in the DMS`}
                tone={(d.control.through_system_pct ?? 100) < 80 ? "warn" : undefined}
              />
              <Stat label="Allotments refused" value={fmtNumber(d.control.refused)} hint="Made in the DMS over a car held here; the allocation stood" tone={d.control.refused ? "warn" : undefined} />
              <Stat label="Approvals waiting" value={fmtNumber(d.approvals.open)} hint={d.approvals.oldest_days === null ? undefined : `oldest ${plural(d.approvals.oldest_days, "day")} old`} tone={(d.approvals.oldest_days ?? 0) > 2 ? "danger" : undefined} />
              <Stat label="Answered in" value={d.approvals.median_hours === null ? "—" : `${d.approvals.median_hours} h`} hint={`${plural(d.approvals.decided, "decision")} in this period`} />
            </div>

            {d.control.from === null && (
              <Notice tone="warn">
                No day has been set from which allocation must go through this system, so an allotment made straight in the DMS is taken on without comment and nothing above counts as a violation. It
                is set under Rules and settings.
              </Notice>
            )}

            <div className="tiles">
              <Stat label="Stock reports loaded" value={`${fmtNumber(d.files.days_with_stock)} of ${fmtNumber(d.files.expected_days)} days`} tone={d.files.days_with_stock < d.files.expected_days / 2 ? "warn" : undefined} />
              <Stat label="Booking sheets loaded" value={`${fmtNumber(d.files.days_with_bookings)} of ${fmtNumber(d.files.expected_days)} days`} />
              <Stat label="Retail exports loaded" value={`${fmtNumber(d.files.days_with_retail)} of ${fmtNumber(d.files.expected_days)} days`} />
              <Stat label="Rows in error" value={fmtNumber(d.files.error_rows)} tone={d.files.error_rows ? "warn" : undefined} />
            </div>

            {d.files.days.length > 1 && (
              <Card title="Files loaded, day by day" className="chart-card">
                <Chart
                  height={220}
                  option={{
                    tooltip: { trigger: "axis" },
                    legend: { bottom: 0, textStyle: { color: "#5b6672" } },
                    grid: { left: 48, right: 24, top: 16, bottom: 48 },
                    xAxis: { type: "category", data: d.files.days.map((x) => dayLabel(x.date)), axisLabel: { color: "#5b6672" }, axisTick: { show: false } },
                    yAxis: { type: "value", minInterval: 1, axisLabel: { color: "#5b6672" }, splitLine: { lineStyle: { color: "#e9eff3" } } },
                    series: [
                      { name: "Stock", type: "bar", stack: "f", barMaxWidth: 18, itemStyle: { color: PALETTE[0] }, data: d.files.days.map((x) => x.stock) },
                      { name: "Bookings", type: "bar", stack: "f", barMaxWidth: 18, itemStyle: { color: PALETTE[1] }, data: d.files.days.map((x) => x.bookings) },
                      { name: "Retail", type: "bar", stack: "f", barMaxWidth: 18, itemStyle: { color: PALETTE[3] }, data: d.files.days.map((x) => x.retail) },
                    ],
                  }}
                />
                <p className="measure-basis">A day with no bar is a day nothing was loaded. The allocation the system does is only as current as the last file it was given.</p>
              </Card>
            )}

            <div className="split split-even">
              <Card title="Who is using it" note="Someone counts as active if the audit trail shows them doing something in the last thirty days — not merely signing in." flush>
                <DataTable
                  columns={[
                    { header: "Role", primary: true, cell: (r: { role: string; n: number; active_30: number }) => roleLabel(r.role) },
                    { header: "People", num: true, cell: (r: { role: string; n: number; active_30: number }) => fmtNumber(r.n) },
                    {
                      header: "Active",
                      num: true,
                      cell: (r: { role: string; n: number; active_30: number }) =>
                        r.active_30 === r.n ? <Chip tone="green">all</Chip> : <span className={r.active_30 === 0 ? "strong danger" : ""}>{fmtNumber(r.active_30)}</span>,
                    },
                  ]}
                  rows={d.people.by_role}
                  rowKey={(r) => r.role}
                  caption="People by role"
                />
              </Card>

              <Card title="What the files disagree about" note="Rows in the stock report whose own columns contradict each other, on cars still in stock." flush>
                <Async load={load} isEmpty={(x) => x.quality.length === 0} empty={<Empty title="Nothing in the latest files contradicts itself" />}>
                  {(x) => (
                    <DataTable
                      columns={[
                        { header: "Issue", primary: true, cell: (r: { issue: string; cars: number }) => r.issue.replace(/_/g, " ").replace(/^./, (m) => m.toUpperCase()) },
                        { header: "Cars", num: true, cell: (r: { issue: string; cars: number }) => fmtNumber(r.cars) },
                      ]}
                      rows={x.quality}
                      rowKey={(r) => r.issue}
                      caption="Data issues"
                    />
                  )}
                </Async>
              </Card>
            </div>

            {d.messages && (
              <div className="tiles">
                <Stat label="Messages sent" value={fmtNumber(d.messages.sent)} />
                <Stat label="Failed" value={fmtNumber(d.messages.failed)} tone={d.messages.failed ? "danger" : undefined} />
                <Stat label="Still queued" value={fmtNumber(d.messages.queued)} tone={d.messages.queued > 50 ? "warn" : undefined} />
              </div>
            )}

            <Basis text={d.basis} />
          </>
        )}
      </Async>
    </>
  );
}
