// Analytics: fixed rules over the two DMS files. Every view names its rule and the files it rests on.
import { useState } from "react";
import { api } from "../api";
import { DataSource } from "../components/DataSource";
import { Async, Card, Chip, DataTable, Empty, Field, Notice, PageHeader, Stat, Tabs, type Column } from "../components/ui";
import { fmtDate, fmtDateTime, fmtMoney, fmtNumber, plural, today } from "../format";
import { useLoad } from "../hooks";
import { Link } from "../router";
import { useSession } from "../session";
import { BusinessTab } from "./Insights";
import { AllocationDashboard, AlternativesDashboard, DelayedDashboard, OrderQueueDashboard } from "./Dashboards";
import { BoardPage } from "./Board";
import { AGE_COLOURS, Chart, dayLabel, PALETTE } from "../components/Chart";
import type { AgeingRow, AllocationDayRow, ControlDay, ControlViolation, DeltaMovement, DeltaRow, NotPickedUpRow, SalesRow, StockDayRow, WritebackRow } from "../types";

type Tab =
  // The day's picture, which used to be the bottom half of Home.
  | "board"
  // The day's work: what needs doing now.
  | "stock-allocation"
  | "orders"
  | "delayed"
  | "alternatives"
  // What the files add up to.
  | "ageing"
  | "not-picked-up"
  | "sales"
  | "allocations"
  | "changed"
  | "control"
  | "writeback"
  | "business"
  | "stock-days";

export function AnalyticsPage({ tab }: { tab: Tab }) {
  const { can } = useSession();
  // Two kinds of thing on one page, in that order: what somebody has to do about today, then what
  // the files say when you stand back from them. They were two menu entries and the same people
  // opened both, one after the other, every morning.
  const tabs = [
    ...(can("booking.view_all") ? [{ to: "/analytics/board", label: "Today's board" }] : []),
    { to: "/analytics/stock-allocation", label: "Stock allocation" },
    { to: "/analytics/orders", label: "Order queue" },
    { to: "/analytics/delayed", label: "Delayed deliveries" },
    { to: "/analytics/alternatives", label: "Alternatives available" },
    { to: "/analytics/ageing", label: "Ageing stock" },
    ...(can("booking.view_all") ? [{ to: "/analytics/not-picked-up", label: "Not picked up" }] : []),
    { to: "/analytics/sales", label: "Most and least selling" },
    { to: "/analytics/changed", label: "What changed" },
    { to: "/analytics/allocations", label: "Allocations by day" },
    ...(can("booking.view_all") ? [{ to: "/analytics/control", label: "Who allocated" }] : []),
    { to: "/analytics/writeback", label: "To update in DMS" },
    ...(can("booking.view_all") ? [{ to: "/analytics/business", label: "Business health (new)" }] : []),
    { to: "/analytics/stock-days", label: "Stock by day" },
  ];
  return (
    <>
      <PageHeader title="Reports" subtitle="What needs doing today, and what the files add up to. Every figure says the rule it was worked out by, so the same files always give the same answer." />
      <DataSource />
      <Tabs current={`/analytics/${tab}`} tabs={tabs} />
      {tab === "board" && <BoardPage />}
      {tab === "stock-allocation" && <AllocationDashboard />}
      {tab === "orders" && <OrderQueueDashboard />}
      {tab === "delayed" && <DelayedDashboard />}
      {tab === "alternatives" && <AlternativesDashboard />}
      {tab === "ageing" && <Ageing />}
      {tab === "not-picked-up" && <NotPickedUp />}
      {tab === "sales" && <Sales />}
      {tab === "changed" && <Changed />}
      {tab === "allocations" && <Allocations />}
      {tab === "control" && <Control />}
      {tab === "writeback" && <Writeback />}
      {tab === "business" && <BusinessTab />}
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

// ---------------------------------------------------------------- what the DMS has not been told
/**
 * The work list for the back office: every car this system and the DMS disagree about.
 *
 * Not a day's diary. A line nobody acted on yesterday is still here today rather than having
 * scrolled off a date range, and a line goes when a stock report shows the DMS agreeing -- so there
 * is nothing for anyone to tick off, forget to tick off, or tick off on the wrong row.
 */
function Writeback() {
  const load = useLoad(() => api.dmsWriteback(), "analytics:writeback");
  const columns: Column<WritebackRow>[] = [
    {
      header: "Do this",
      primary: true,
      cell: (r) => (
        <>
          <span className="chips">{r.action === "ALLOT" ? <Chip tone="green">Allot</Chip> : <Chip tone="red">Remove allotment</Chip>}</span>
          <span className="sub">{r.instruction}</span>
        </>
      ),
    },
    {
      header: "Booking",
      cell: (r) => (
        <Link to={`/bookings/${r.booking_id}`} className="cell-link">
          <span className="strong nowrap">{r.booking_no}</span>
          <span className="sub">
            {r.customer_name}
            {r.dms_ref ? ` · ${r.dms_ref}` : ""}
          </span>
        </Link>
      ),
    },
    {
      header: "Car",
      cell: (r) => (
        <>
          <span className="mono">{r.vin}</span>
          <span className="sub">
            {r.model} {r.variant} · {r.colour}
          </span>
        </>
      ),
    },
    { header: "DMS shows", cell: (r) => r.dms_shows ?? <span className="muted">–</span> },
    {
      header: "Why",
      cell: (r) => (
        <>
          {r.reason}
          {r.paired_with ? <span className="sub">{r.paired_with}</span> : null}
          {r.by ? <span className="sub">Approved by {r.by}</span> : null}
        </>
      ),
    },
    { header: "Decided", cell: (r) => <>{fmtDate(r.decided_at)}<span className="sub">{plural(r.days_waiting, "day")} ago</span></>, hideIfEmpty: () => false },
  ];
  return (
    <Async load={load}>
      {(d) => (
        <>
          {/* The sheet is the point of this tab, so it is the first thing on it and not a small
              button halfway down the page beside a card heading, which is where it used to sit. */}
          <Card
            title="The sheet to key into the DMS"
            note={
              d.rows.length > 0
                ? `${fmtNumber(d.totals.allot)} to allot, ${fmtNumber(d.totals.remove)} to remove. One file, three tabs, in the DMS's own column names.`
                : "Nothing is waiting: the DMS agrees with this system about every car."
            }
          >
            {/* Always here, pending or not. A button that comes and goes is a button nobody
                trusts to be there, and an empty sheet is a clearer answer than a missing control. */}
            <a className="btn btn-primary" href={api.dmsWritebackUrl} download>
              Download as Excel
            </a>
          </Card>
          <div className="tiles">
            <Stat label="Allotments to remove" value={fmtNumber(d.totals.remove)} hint="Still allotted in the DMS to a booking this system has released" tone={d.totals.remove ? "danger" : undefined} />
            <Stat label="Allotments to make" value={fmtNumber(d.totals.allot)} hint="Held here for a customer, not yet allotted in the DMS" />
          </div>
          {d.rows.length > 0 && (
            <Notice tone="info">
              The download is an upload file: one tab of allotments to make, one of allotments to remove, in the DMS's own column names, and a third giving the reason and approver behind every line.
              Remove before you allot — a car has to come off one booking before it goes on another — and the tabs are in that order. Lines disappear by themselves once a stock report shows the DMS
              agreeing, so there is nothing to tick off.
            </Notice>
          )}
          {d.conflicts.length > 0 && (
            <Notice tone="warn">
              {plural(d.conflicts.length, "car")} left off this list. The DMS has already invoiced {d.conflicts.length === 1 ? "it" : "them"} to another order, and a completed sale is not reversed from
              an upload sheet. {d.conflicts.length === 1 ? "It is" : "They are"} with the approvers instead:{" "}
              {d.conflicts.map((c) => `${c.vin} (allocated here to ${c.booking_no}, invoiced in the DMS to ${c.dms_booking_no})`).join("; ")}.
            </Notice>
          )}
          <Card
            title="Every allocation, and where it stands"
            note="So the difference between this list and the allocations report accounts for itself. Every allocation on record falls into one line, whatever day it was decided."
            flush
          >
            <DataTable
              columns={[
                { header: "", primary: true, cell: (r: { label: string; n: number; tone?: string }) => <span className={r.tone === "do" ? "strong" : ""}>{r.label}</span> },
                { header: "Allocations", num: true, cell: (r: { label: string; n: number; tone?: string }) => <span className={r.tone === "do" ? "strong" : r.n ? "" : "muted"}>{fmtNumber(r.n)}</span> },
              ]}
              rows={[
                { label: "Already matching in the DMS — nothing to do", n: d.reconcile.confirmed },
                { label: "To allot — on this list", n: d.reconcile.to_allot, tone: "do" },
                { label: "To remove — on this list", n: d.reconcile.to_remove, tone: "do" },
                { label: "Let go here, and the DMS already agrees", n: d.reconcile.released_settled },
                { label: "Already invoiced in the DMS to another order", n: d.reconcile.sold_elsewhere },
                { label: "Delivered and closed", n: d.reconcile.fulfilled },
                { label: "Every allocation on record", n: d.reconcile.total },
              ]}
              rowKey={(r) => r.label}
              caption="Every allocation, and where it stands"
            />
          </Card>

          <Card
            title="Allocation decisions to load into the DMS"
            note="Allocation is decided here; this is what the DMS has not been told yet."
            actions={
              <a className="btn btn-secondary btn-sm" href={api.dmsWritebackUrl} download>
                Download as Excel
              </a>
            }
            flush
          >
            <Async load={load} isEmpty={(x) => x.rows.length === 0} empty={<Empty title="Nothing to key in" hint="The DMS agrees with this system about every car." />}>
              {(x) => <DataTable columns={columns} rows={x.rows} rowKey={(r) => `${r.action}:${r.vin}:${r.booking_no}`} caption="Changes to key into the DMS" />}
            </Async>
          </Card>
          <Basis text={d.basis} />
        </>
      )}
    </Async>
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

/**
 * Who allocated what, day by day, and what got round the system.
 *
 * The three sources are never added together: the queue's own decision, a person's decision carried
 * out here on an approved request, and one simply read from the DMS. "Waiting to be entered" is the
 * back office's work list — an allocation this system made that no later stock report has shown the
 * DMS agreeing with, so it is either not yet keyed in or was keyed in and did not take.
 */
function Control() {
  const period = usePeriod(daysAgo(13));
  const load = useLoad(
    () => (period.valid ? api.allocationControl(period.from, period.to) : Promise.reject(new Error("The period is not valid"))),
    `analytics:control:${period.key}`,
  );
  const dayCols: Column<ControlDay>[] = [
    { header: "Day", primary: true, cell: (r) => fmtDate(r.date) },
    { header: "By the system", num: true, cell: (r) => fmtNumber(r.by_system) },
    { header: "By approved request", num: true, cell: (r) => fmtNumber(r.by_approved_request) },
    { header: "Read from the DMS", num: true, cell: (r) => fmtNumber(r.adopted_from_dms) },
    { header: "Waiting to be entered", num: true, cell: (r) => (r.awaiting_entry_in_dms ? <Chip tone="amber">{fmtNumber(r.awaiting_entry_in_dms)}</Chip> : <span className="muted">—</span>) },
    { header: "Violations", num: true, cell: (r) => (r.violations ? <Chip tone="red">{fmtNumber(r.violations)}</Chip> : <span className="muted">—</span>) },
  ];
  const vCols: Column<ControlViolation>[] = [
    { header: "Day", primary: true, cell: (r) => fmtDate(r.date) },
    {
      header: "What happened",
      cell: (r) =>
        r.kind === "OVERTURNED"
          ? r.taken_from_booking_no
            ? `Allocated here to ${r.taken_from_booking_no}, given in the DMS to ${r.booking_no}`
            : "Given a different car in the DMS from the one allocated here"
          : r.kind === "UNKNOWN_BOOKING"
            ? "Booking was never in this system and is already allotted"
            : "Booking was waiting in the queue here and was allotted without being asked",
    },
    { header: "Booking", cell: (r) => <Link to={`/bookings/${r.booking_id}`} className="cell-link"><span className="strong nowrap">{r.booking_no}</span><span className="sub">{r.customer_name}</span></Link> },
    { header: "Car", cell: (r) => <span className="mono">{r.vin}</span> },
  ];
  return (
    <>
      {period.picker}
      <Async load={load}>
        {(d) => (
          <>
            {!d.controls_from ? (
              <Notice tone="warn" title="No day has been set yet. ">
                Until a dealership says which day it puts allocation through this system, an allotment made in the DMS is taken on without comment. Set it on the rules screen.
              </Notice>
            ) : (
              <Notice tone="info">Every car has been meant to be given out here since {fmtDate(d.controls_from)}.</Notice>
            )}
            <div className="tiles">
              <Stat label="Allocated by the system" value={fmtNumber(d.totals.by_system)} hint={`${fmtDate(d.period.from)} to ${fmtDate(d.period.to)}`} />
              <Stat label="By approved request" value={fmtNumber(d.totals.by_approved_request)} hint="A car moved on a request somebody approved" />
              <Stat label="Waiting to be entered in the DMS" value={fmtNumber(d.totals.awaiting_entry_in_dms)} hint="Allocated here, not yet confirmed by a stock report" />
              <Stat label="Allotted outside the system" value={fmtNumber(d.totals.violations)} hint={`${d.totals.overturned} overturned · ${d.totals.unknown_booking} unknown booking · ${d.totals.not_through_system} went round the queue`} />
            </div>
            <Card title="Day by day" flush>
              <DataTable columns={dayCols} rows={d.days} rowKey={(r) => r.date} caption="Allocation by day" />
            </Card>
            <Card title={`Allotted outside the system (${d.violations.length})`} note="These stand in the DMS: it is the record, and the customer has been told. What is reported is that the decision was made somewhere else." flush>
              {d.violations.length ? <DataTable columns={vCols} rows={d.violations} rowKey={(r) => `${r.date}:${r.booking_no}:${r.vin}`} caption="Violations" /> : <Empty title="Every allotment in this period came through the system." />}
            </Card>
            <Basis text={d.basis} />
          </>
        )}
      </Async>
    </>
  );
}

/**
 * What changed, day by day.
 *
 * The delta a person reads after the evening's files go in. Nothing is compared here: the import
 * writes each movement down as it reads the files, so this is a read over a log the database will
 * not let anyone alter afterwards.
 *
 * The movements needing the retail file are shown and marked rather than hidden. A report that
 * silently leaves out what it cannot see teaches people to trust a number that is not whole.
 */
function Changed() {
  const period = usePeriod(daysAgo(13));
  const load = useLoad(
    () => (period.valid ? api.dailyDelta(period.from, period.to) : Promise.reject(new Error("The period is not valid"))),
    `analytics:changed:${period.key}`,
  );
  const rowCols: Column<DeltaRow>[] = [
    { header: "Day", primary: true, cell: (r) => fmtDate(r.date) },
    { header: "What", cell: (r) => (r.code === "B3" ? "Booking cancelled" : r.code === "S5" ? "Left stock with no invoice" : r.code === "S6" ? "Listed again after leaving" : "Retail invoice withdrawn") },
    { header: "Booking", cell: (r) => r.booking_no ?? <span className="muted">—</span>, hideIfEmpty: (r) => !r.booking_no },
    { header: "Customer", cell: (r) => r.customer_name ?? <span className="muted">—</span> },
    { header: "Car", cell: (r) => (r.vin ? <span><span className="mono">{r.vin}</span><span className="sub">{r.detail}</span></span> : r.detail) },
  ];
  return (
    <>
      {period.picker}
      <Async load={load}>
        {(d) => {
          const cols: Column<DeltaMovement>[] = [
            {
              header: "Movement",
              primary: true,
              cell: (m) => (
                <span>
                  <span className="strong">{m.label}</span>
                  <span className="sub">{m.note}</span>
                </span>
              ),
            },
            { header: "In the period", num: true, cell: (m) => (m.pending ? <Chip tone="grey">Not loaded</Chip> : fmtNumber(m.total)) },
            ...d.dates.map((day, i) => ({
              header: dayLabel(day),
              num: true,
              cell: (m: DeltaMovement) => (m.pending ? <span className="muted">—</span> : m.by_day[i] ? fmtNumber(m.by_day[i]) : <span className="muted">—</span>),
            })),
          ];
          return (
            <>
              <div className="tiles">
                <Stat label="Cars given out by this system" value={fmtNumber(d.movements.find((m) => m.code === "A1")?.total ?? 0)} hint={`${fmtDate(d.period.from)} to ${fmtDate(d.period.to)}`} />
                <Stat label="Allotments read from the DMS" value={fmtNumber(d.movements.find((m) => m.code === "A3")?.total ?? 0)} hint="Decided there, taken on here" />
                <Stat label="Cars arrived" value={fmtNumber(d.movements.find((m) => m.code === "S1")?.total ?? 0)} hint="Chassis not in the report before" />
                <Stat label="Left stock with no invoice" value={fmtNumber(d.movements.find((m) => m.code === "S5")?.total ?? 0)} hint="Gone, and nothing says why" />
              </div>
              <Card title="Every movement, day by day" note="Dated by the day the thing happened, not the day its file arrived." flush>
                <DataTable columns={cols} rows={d.movements} rowKey={(m) => m.code} caption="Movements" />
              </Card>
              <Card title={`Worth asking about (${d.rows.length})`} note="The movements that are a question for somebody rather than a number to read." flush>
                {d.rows.length ? <DataTable columns={rowCols} rows={d.rows} rowKey={(r) => `${r.date}:${r.code}:${r.vin ?? ""}:${r.booking_no ?? ""}`} caption="Worth asking about" /> : <Empty title="Nothing in this period needs asking about." />}
              </Card>
              <Basis text={d.basis} />
            </>
          );
        }}
      </Async>
    </>
  );
}
