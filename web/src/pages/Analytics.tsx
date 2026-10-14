// Analytics: fixed rules over the two DMS files. Every view names its rule and the files it rests on.
import { useState } from "react";
import { api } from "../api";
import { DataSource } from "../components/DataSource";
import { Async, Card, Chip, DataTable, Empty, Field, Notice, PageHeader, Stat, Tabs, type Column } from "../components/ui";
import { fmtDate, fmtDateTime, fmtMoney, fmtNumber, plural, today } from "../format";
import { useLoad } from "../hooks";
import { Link } from "../router";
import { useSession } from "../session";
import { AGE_COLOURS, Chart, dayLabel, PALETTE } from "../components/Chart";
import type { AgeingRow, AllocationDayRow, NotPickedUpRow, SalesRow, StockDayRow } from "../types";

type Tab = "ageing" | "not-picked-up" | "sales" | "allocations" | "stock-days";

export function AnalyticsPage({ tab }: { tab: Tab }) {
  const { can } = useSession();
  const tabs = [
    { to: "/analytics/ageing", label: "Ageing stock" },
    ...(can("booking.view_all") ? [{ to: "/analytics/not-picked-up", label: "Not picked up" }] : []),
    { to: "/analytics/sales", label: "Most and least selling" },
    { to: "/analytics/allocations", label: "Allocations by day" },
    { to: "/analytics/stock-days", label: "Stock by day" },
  ];
  return (
    <>
      <PageHeader title="Reports" subtitle="Worked out from the stock report and the booking sheet by fixed rules, so the same files always give the same answer." />
      <DataSource />
      <Tabs current={`/analytics/${tab}`} tabs={tabs} />
      {tab === "ageing" && <Ageing />}
      {tab === "not-picked-up" && <NotPickedUp />}
      {tab === "sales" && <Sales />}
      {tab === "allocations" && <Allocations />}
      {tab === "stock-days" && <StockDays />}
    </>
  );
}

const Basis = ({ text }: { text: string }) => <p className="measure-basis">{text}</p>;

/** A from/to period, checked before it is sent. */
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
const daysAgo = (n: number) => {
  const d = new Date(`${today()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

// ---------------------------------------------------------------- ageing inventory by model
function Ageing() {
  const load = useLoad(() => api.ageing(), "analytics:ageing");
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Async load={load} empty={<Empty title="No unsold stock" hint="Every car in the latest stock report is held by a booking." />} isEmpty={(d) => d.rows.length === 0}>
      {(d) => {
        const withValue = d.totals.value !== undefined;
        const columns: Column<AgeingRow>[] = [
          { header: "Model", primary: true, cell: (r) => <button type="button" className="linkish strong" onClick={() => setOpen(open === r.model ? null : r.model)}>{r.model}</button> },
          { header: "Unsold cars", num: true, cell: (r) => <span className="strong">{r.cars}</span> },
          { header: "In yard", num: true, cell: (r) => r.in_yard },
          { header: "In transit", num: true, cell: (r) => r.in_transit },
          ...d.buckets.map((label, i): Column<AgeingRow> => ({ header: label, num: true, cell: (r) => (r.buckets[i] ? <span className={i >= 2 ? "strong danger" : ""}>{r.buckets[i]}</span> : <span className="muted">0</span>) })),
          { header: "Oldest", num: true, cell: (r) => (r.oldest_days === null ? <span className="muted">Not known</span> : plural(r.oldest_days, "day")) },
          { header: "Average", num: true, cell: (r) => (r.average_days === null ? <span className="muted">Not known</span> : plural(r.average_days, "day")) },
          ...(withValue ? [{ header: "Dealer value", num: true, cell: (r: AgeingRow) => fmtMoney(r.value) } as Column<AgeingRow>] : []),
        ];
        const detail = d.rows.find((r) => r.model === open);
        return (
          <>
            <div className="tiles">
              <Stat label="Unsold cars" value={fmtNumber(d.totals.cars)} />
              <Stat label="Over 30 days" value={fmtNumber(d.totals.over_30_days)} tone={d.totals.over_30_days ? "warn" : undefined} />
              <Stat label="Over 60 days" value={fmtNumber(d.totals.over_60_days)} tone={d.totals.over_60_days ? "danger" : undefined} />
              {withValue && <Stat label="Dealer value, unsold" value={fmtMoney(d.totals.value)} />}
            </div>
            <Card title="Unsold cars by model and age" className="chart-card">
              <Chart
                height={Math.max(220, d.rows.length * 26 + 70)}
                option={{
                  color: AGE_COLOURS,
                  xAxis: { type: "value", minInterval: 1, axisLabel: { color: "#5b6672" }, splitLine: { lineStyle: { color: "#e9eff3" } } },
                  yAxis: { type: "category", inverse: true, data: d.rows.map((r) => r.model), axisLabel: { color: "#1b2733", fontSize: 12 }, axisTick: { show: false }, axisLine: { show: false } },
                  series: d.buckets.map((label, i) => ({ name: label, type: "bar", stack: "age", barMaxWidth: 18, emphasis: { focus: "series" }, data: d.rows.map((r) => r.buckets[i]) })),
                }}
              />
            </Card>
            <Card title={`Unsold stock by model, as on ${fmtDate(d.as_of)}`} note="Tap a model for its oldest cars." flush>
              <DataTable columns={columns} rows={d.rows} rowKey={(r) => r.model} caption="Ageing stock by model" scroll />
            </Card>
            {detail && (
              <Card title={`${detail.model}: oldest unsold cars`} flush>
                <DataTable
                  columns={[
                    { header: "Chassis", primary: true, cell: (c) => <span className="mono">{c.vin}</span> },
                    { header: "Car", cell: (c) => <>{c.variant}<span className="sub">{c.colour}</span></> },
                    { header: "Outlet", cell: (c) => c.outlet },
                    { header: "Where", status: true, cell: (c) => <Chip tone={c.status === "RECEIVED" ? "green" : "blue"}>{c.status === "RECEIVED" ? "In the yard" : "In transit"}</Chip> },
                    { header: "OEM invoice", cell: (c) => fmtDate(c.oem_invoice_date) },
                    { header: "Age", num: true, cell: (c) => (c.age_days === null ? <span className="muted">Not known</span> : <span className={c.age_days > 60 ? "strong danger" : c.age_days > 30 ? "strong" : ""}>{plural(c.age_days, "day")}</span>) },
                    ...(withValue ? [{ header: "Dealer price", num: true, cell: (c: AgeingRow["cars_detail"][number]) => fmtMoney(c.value) } as Column<AgeingRow["cars_detail"][number]>] : []),
                  ]}
                  rows={detail.cars_detail}
                  rowKey={(c) => c.vin}
                  caption={`Oldest unsold ${detail.model}`}
                />
              </Card>
            )}
            <Basis text={d.basis} />
          </>
        );
      }}
    </Async>
  );
}

// ---------------------------------------------------------------- customers who have not picked up their car
function NotPickedUp() {
  const [days, setDays] = useState(10);
  const load = useLoad(() => api.notPickedUp(days), `analytics:npu:${days}`);
  const columns: Column<NotPickedUpRow>[] = [
    { header: "Booking", primary: true, cell: (r) => <Link to={`/bookings/${r.booking_id}`} className="cell-link"><span className="strong nowrap">{r.booking_no}</span><span className="sub">{r.customer_name}</span></Link> },
    { header: "Car", cell: (r) => <>{r.model} {r.variant}<span className="sub">{r.colour} · {r.vin}</span></> },
    { header: "Outlet", cell: (r) => r.outlet },
    { header: "Sales executive", cell: (r) => r.sales_exec ?? <span className="muted">Not linked</span> },
    { header: "Waiting since", cell: (r) => fmtDate(r.since) },
    { header: "Days", num: true, cell: (r) => <span className="strong danger">{r.days}</span> },
    { header: "Stage", status: true, cell: (r) => (r.stage === "INVOICED_NOT_TAKEN" ? <Chip tone="indigo">Invoiced {fmtDate(r.invoiced_on)}, not taken</Chip> : r.payment_received_at ? <Chip tone="green">Paid, not invoiced</Chip> : r.payment_reported_at ? <Chip tone="amber">Payment with Finance</Chip> : <Chip tone="red">Payment pending</Chip>) },
  ];
  return (
    <>
      <Card title="Waiting longer than">
        <div className="form-grid">
          <Field label="Days">
            <input type="number" min={0} max={365} value={days} onChange={(e) => setDays(Math.max(0, Math.min(365, Number(e.target.value) || 0)))} />
          </Field>
        </div>
      </Card>
      <Async load={load}>
        {(d) => (
          <>
            <div className="tiles">
              <Stat label={`Waiting more than ${d.days} days`} value={fmtNumber(d.counts.total)} tone={d.counts.total ? "danger" : undefined} />
              <Stat label="Payment or invoicing pending" value={fmtNumber(d.counts.waiting_for_payment)} />
              <Stat label="Invoiced, not taken" value={fmtNumber(d.counts.invoiced_not_taken)} />
            </div>
            <Card title={`Customers who have not picked up their car, as on ${fmtDate(d.as_of)}`} flush>
              {d.rows.length ? <DataTable columns={columns} rows={d.rows} rowKey={(r) => r.booking_id} caption="Not picked up" /> : <Empty title="Nobody is waiting that long" hint={`No reserved car has been at the dealership for more than ${d.days} days.`} />}
            </Card>
            <Basis text={d.basis} />
          </>
        )}
      </Async>
    </>
  );
}

// ---------------------------------------------------------------- most and least selling
function Sales() {
  const period = usePeriod(daysAgo(89));
  const load = useLoad(() => (period.valid ? api.sales(period.from, period.to) : Promise.reject(new Error("The period is not valid"))), `analytics:sales:${period.key}`);
  const modelCols: Column<SalesRow>[] = [
    { header: "Model", primary: true, cell: (r) => <span className="strong">{r.model}</span> },
    { header: "Sold", num: true, cell: (r) => <span className="strong">{r.sold}</span> },
    { header: "Share", num: true, cell: (r) => (r.share_pct === null || r.share_pct === undefined ? <span className="muted">–</span> : `${r.share_pct}%`) },
    { header: "Delivered", num: true, cell: (r) => r.delivered },
    { header: "Unsold in stock", num: true, cell: (r) => r.unsold_in_stock },
    { header: "Customers waiting", num: true, cell: (r) => r.waiting_bookings },
  ];
  const carCols: Column<SalesRow>[] = [
    { header: "Car", primary: true, cell: (r) => <><span className="strong">{r.model} {r.variant}</span><span className="sub">{r.colour}</span></> },
    { header: "Sold", num: true, cell: (r) => <span className="strong">{r.sold}</span> },
    { header: "Delivered", num: true, cell: (r) => r.delivered },
    { header: "Unsold in stock", num: true, cell: (r) => r.unsold_in_stock },
    { header: "Customers waiting", num: true, cell: (r) => r.waiting_bookings },
  ];
  const pick = (label: string, r: SalesRow | null, what: "model" | "car") => (
    <Stat label={label} value={r ? (what === "car" ? `${r.model} ${r.variant}` : r.model) : "None"} hint={r ? `${plural(r.sold, "sale")}${what === "car" ? `, ${r.colour}` : ""}${r.unsold_in_stock ? ` · ${r.unsold_in_stock} unsold in stock` : ""}` : "No sale in the period"} />
  );
  return (
    <>
      {period.picker}
      <Async load={load}>
        {(d) => (
          <>
            <div className="tiles">
              <Stat label="Sold in the period" value={fmtNumber(d.total_sold)} hint={`${fmtDate(d.period.from)} to ${fmtDate(d.period.to)}`} />
              {pick("Most selling model", d.most_selling_model, "model")}
              {pick("Most selling car", d.most_selling_car, "car")}
              {pick("Least selling model", d.least_selling_model, "model")}
            </div>
            {d.total_sold > 0 && (
              <div className="chart-grid">
                <Card title="Sales by model" className="chart-card">
                  <Chart
                    height={Math.max(200, Math.min(12, d.models.filter((m) => m.sold > 0).length) * 28 + 60)}
                    option={{
                      legend: { show: false },
                      xAxis: { type: "value", minInterval: 1, axisLabel: { color: "#5b6672" }, splitLine: { lineStyle: { color: "#e9eff3" } } },
                      yAxis: { type: "category", inverse: true, data: d.models.filter((m) => m.sold > 0).slice(0, 12).map((m) => m.model), axisLabel: { color: "#1b2733", fontSize: 12 }, axisTick: { show: false }, axisLine: { show: false } },
                      series: [{ name: "Sold", type: "bar", barMaxWidth: 18, itemStyle: { color: PALETTE[1], borderRadius: [0, 3, 3, 0] }, label: { show: true, position: "right", color: "#1b2733" }, data: d.models.filter((m) => m.sold > 0).slice(0, 12).map((m) => m.sold) }],
                    }}
                  />
                </Card>
                <Card title="Share of sales" className="chart-card">
                  <Chart
                    height={260}
                    option={{
                      tooltip: { trigger: "item", backgroundColor: "#002858", borderWidth: 0, textStyle: { color: "#fff", fontSize: 12 } },
                      legend: { bottom: 0, type: "scroll", icon: "circle", textStyle: { fontSize: 11, color: "#5b6672" } },
                      series: [{ type: "pie", radius: ["42%", "70%"], center: ["50%", "44%"], label: { show: false }, itemStyle: { borderColor: "#fff", borderWidth: 2 }, data: d.models.filter((m) => m.sold > 0).map((m) => ({ name: m.model, value: m.sold })) }],
                    }}
                  />
                </Card>
              </div>
            )}
            <Card title="Models" flush>
              {d.models.length ? <DataTable columns={modelCols} rows={d.models} rowKey={(r) => r.key} caption="Sales by model" /> : <Empty title="Nothing to rank" hint="No sale in the period and no car in stock." />}
            </Card>
            <Card title="Cars (model, variant and colour): the top 15" flush>
              {d.cars.length ? <DataTable columns={carCols} rows={d.cars.slice(0, 15)} rowKey={(r) => r.key} caption="Sales by car" /> : <Empty title="Nothing to rank" />}
            </Card>
            <Basis text={d.basis} />
          </>
        )}
      </Async>
    </>
  );
}

// ---------------------------------------------------------------- allocations and releases by day
function Allocations() {
  const period = usePeriod(daysAgo(13));
  const load = useLoad(() => (period.valid ? api.allocationsByDay(period.from, period.to) : Promise.reject(new Error("The period is not valid"))), `analytics:alloc:${period.key}`);
  const [open, setOpen] = useState<string | null>(null);
  const rowCols: Column<AllocationDayRow>[] = [
    { header: "When", primary: true, cell: (r) => <><span className="strong">{fmtDateTime(r.at)}</span><span className="sub">{r.outlet}</span></> },
    { header: "What", status: true, cell: (r) => (r.kind === "ALLOCATED" ? <Chip tone="green">Allocated</Chip> : <Chip tone="red">Released</Chip>) },
    { header: "Booking", cell: (r) => <Link to={`/bookings/${r.booking_id}`} className="cell-link"><span className="strong nowrap">{r.booking_no}</span><span className="sub">{r.customer_name}</span></Link> },
    { header: "Car", cell: (r) => <>{r.model} {r.variant}<span className="sub">{r.colour} · {r.vin}</span></> },
    { header: "How / why", cell: (r) => r.how },
    { header: "By", cell: (r) => r.by || <span className="muted">–</span>, hideIfEmpty: (r) => !r.by },
  ];
  return (
    <>
      {period.picker}
      <Async load={load}>
        {(d) => (
          <>
            <div className="tiles">
              <Stat label="Allocations" value={fmtNumber(d.totals.allocated)} hint={`${fmtDate(d.period.from)} to ${fmtDate(d.period.to)}`} />
              <Stat label="Releases (de-allocations)" value={fmtNumber(d.totals.released)} />
            </div>
            {d.days.length > 0 && (
              <Card title="Allocations and releases, day by day" className="chart-card">
                <Chart
                  height={240}
                  option={{
                    xAxis: { type: "category", data: d.days.map((x) => dayLabel(x.date)), axisLabel: { color: "#5b6672" }, axisTick: { show: false } },
                    yAxis: { type: "value", minInterval: 1, axisLabel: { color: "#5b6672" }, splitLine: { lineStyle: { color: "#e9eff3" } } },
                    series: [
                      { name: "Allocated", type: "bar", barMaxWidth: 22, itemStyle: { color: PALETTE[1], borderRadius: [3, 3, 0, 0] }, data: d.days.map((x) => x.allocated) },
                      { name: "Released", type: "bar", barMaxWidth: 22, itemStyle: { color: "#9a2a20", borderRadius: [3, 3, 0, 0] }, data: d.days.map((x) => x.released) },
                    ],
                  }}
                />
              </Card>
            )}
            <Card title="By day and outlet" note="Tap a day for every allocation and release of that day." flush>
              {d.days.length ? (
                <DataTable
                  columns={[
                    { header: "Day", primary: true, cell: (x) => <button type="button" className="linkish strong" onClick={() => setOpen(open === x.date ? null : x.date)}>{fmtDate(x.date)}</button> },
                    { header: "Allocated", num: true, cell: (x) => <span className="strong">{x.allocated}</span> },
                    { header: "Released", num: true, cell: (x) => (x.released ? <span className="strong danger">{x.released}</span> : <span className="muted">0</span>) },
                    { header: "By outlet", cell: (x) => x.outlets.map((o) => `${o.outlet}: ${o.allocated} / ${o.released}`).join(" · ") },
                    { header: "Release reasons", cell: (x) => Object.entries(x.reasons).map(([k, n]) => `${k}: ${n}`).join(" · ") || <span className="muted">–</span>, hideIfEmpty: (x) => !x.released },
                  ]}
                  rows={d.days}
                  rowKey={(x) => x.date}
                  caption="Allocations by day"
                />
              ) : (
                <Empty title="Nothing in this period" hint="No car was allocated or released between these dates." />
              )}
            </Card>
            {open && (
              <Card title={`${fmtDate(open)}: every allocation and release`} flush>
                <DataTable columns={rowCols} rows={d.rows.filter((r) => r.at.slice(0, 10) === open || fmtDate(r.at) === fmtDate(open))} rowKey={(r) => `${r.kind}:${r.at}:${r.booking_id}`} caption="Allocations of the day" />
              </Card>
            )}
            <Basis text={d.basis} />
          </>
        )}
      </Async>
    </>
  );
}

// ---------------------------------------------------------------- stock by day
function StockDays() {
  const period = usePeriod(daysAgo(29));
  const load = useLoad(() => (period.valid ? api.stockByDay(period.from, period.to) : Promise.reject(new Error("The period is not valid"))), `analytics:stock:${period.key}`);
  const [open, setOpen] = useState<string | null>(null);
  const cols = (withOutlet: boolean, withValue: boolean): Column<StockDayRow>[] => [
    withOutlet ? { header: "Outlet", primary: true, cell: (r) => <span className="strong">{r.outlet}</span> } : { header: "Day", primary: true, cell: (r) => <button type="button" className="linkish strong" onClick={() => setOpen(open === r.date ? null : r.date)}>{fmtDate(r.date)}</button> },
    { header: "Free in yard", num: true, cell: (r) => <span className="strong">{r.in_yard_free}</span> },
    { header: "Reserved in yard", num: true, cell: (r) => r.in_yard_reserved },
    { header: "Free in transit", num: true, cell: (r) => r.in_transit_free },
    { header: "Reserved in transit", num: true, cell: (r) => r.in_transit_reserved },
    { header: "Invoiced, in stock", num: true, cell: (r) => r.invoiced_in_stock },
    { header: "Blocked / demo", num: true, cell: (r) => r.blocked },
    { header: "Total", num: true, cell: (r) => <span className="strong">{r.total}</span> },
    ...(withValue ? [{ header: "Value of free cars", num: true, cell: (r: StockDayRow) => fmtMoney(r.value_unsold ?? 0) } as Column<StockDayRow>] : []),
  ];
  return (
    <>
      {period.picker}
      <Async load={load}>
        {(d) => {
          const withValue = d.days.some((x) => x.total.value_unsold !== undefined);
          const day = d.days.find((x) => x.date === open);
          return (
            <>
              {d.days.length > 0 && (
                <Card title="Stock position, day by day" className="chart-card">
                  <Chart
                    height={260}
                    option={{
                      xAxis: { type: "category", data: d.days.map((x) => dayLabel(x.date)), axisLabel: { color: "#5b6672" }, axisTick: { show: false } },
                      yAxis: { type: "value", minInterval: 1, axisLabel: { color: "#5b6672" }, splitLine: { lineStyle: { color: "#e9eff3" } } },
                      series: [
                        { name: "Free in yard", type: "bar", stack: "s", barMaxWidth: 26, data: d.days.map((x) => x.total.in_yard_free) },
                        { name: "Reserved in yard", type: "bar", stack: "s", data: d.days.map((x) => x.total.in_yard_reserved) },
                        { name: "Free in transit", type: "bar", stack: "s", data: d.days.map((x) => x.total.in_transit_free) },
                        { name: "Reserved in transit", type: "bar", stack: "s", data: d.days.map((x) => x.total.in_transit_reserved) },
                        { name: "Invoiced, in stock", type: "bar", stack: "s", data: d.days.map((x) => x.total.invoiced_in_stock) },
                      ],
                    }}
                  />
                </Card>
              )}
              <Card title="Dealership, day by day" note="Tap a day for each outlet's position." flush>
                {d.days.length ? <DataTable columns={cols(false, withValue)} rows={d.days.map((x) => x.total)} rowKey={(r) => r.date} caption="Stock by day" scroll /> : <Empty title="No position recorded in this period" hint="A day's position is recorded when a DMS file is loaded or the day-end reconciliation runs." />}
              </Card>
              {day && (
                <Card title={`${fmtDate(day.date)}: by outlet`} flush>
                  <DataTable columns={cols(true, withValue)} rows={day.outlets} rowKey={(r) => r.outlet_id ?? r.outlet ?? ""} caption="Stock by outlet" scroll />
                </Card>
              )}
              <Basis text={d.basis} />
            </>
          );
        }}
      </Async>
    </>
  );
}
