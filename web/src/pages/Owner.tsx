// The owner's view: fairness, ageing and what is at risk, across the outlets the person covers.
// Every number comes from the server; where it has nothing to measure from, it says so.

import { useState } from "react";
import { api } from "../api";
import { ConfirmDialog } from "../components/Dialog";
import { DataSource } from "../components/DataSource";
import { Async, Button, Card, Chip, DataTable, Empty, Field, Notice, PageHeader, Stat, Tabs, type Column } from "../components/ui";
import { fmtDate, fmtDateTime, fmtMoney, fmtNumber, plural, today } from "../format";
import { useAction, useHashScroll, useLoad } from "../hooks";
import { plainText } from "../labels";
import { canSeePayments } from "../nav";
import { Link } from "../router";
import { useSession } from "../session";
import { Chart, PALETTE } from "../components/Chart";
import type { AgeBucket, AtRiskRow, Measure, OutOfTurnRow, OwnerView } from "../types";

type Tab = "overview" | "out-of-turn" | "measures";

export function OwnerPage({ tab }: { tab: Tab }) {
  return (
    <>
      <PageHeader title="Owner" subtitle="Fairness, ageing and what is at risk." />
      <Tabs
        current={tab === "overview" ? "/owner" : `/owner/${tab}`}
        tabs={[
          { to: "/owner", label: "Overview" },
          { to: "/owner/out-of-turn", label: "Out-of-turn allocations" },
          { to: "/owner/measures", label: "Measures" },
        ]}
      />
      {tab === "overview" && <Overview />}
      {tab === "out-of-turn" && <OutOfTurn />}
      {tab === "measures" && <Measures />}
    </>
  );
}

// ---------------------------------------------------------------- the owner's numbers (also shown on Home)
export function OwnerTiles({ o }: { o: OwnerView }) {
  const { can } = useSession();
  const payments = canSeePayments(can) ? "/payments" : undefined;
  return (
    <div className="tiles">
      <Stat label="Customers waiting" value={fmtNumber(o.customers_waiting)} to={can("booking.view") ? "/bookings?view=waiting" : undefined} />
      <Stat label="Cars not matched" value={fmtNumber(o.cars_not_matched)} to={can("stock.view") ? "/stock/cars?commitment=FREE" : undefined} />
      <Stat label="Delivery dates at risk" value={fmtNumber(o.delivery_dates_at_risk.count)} to="/owner#at-risk" tone={o.delivery_dates_at_risk.count ? "danger" : undefined} hint={o.delivery_dates_at_risk.overdue ? `${fmtNumber(o.delivery_dates_at_risk.overdue)} already past` : undefined} />
      <Stat label="Out-of-turn allocations this month" value={fmtNumber(o.out_of_turn.this_month)} to="/owner/out-of-turn" tone={o.out_of_turn.this_month ? "warn" : undefined} />
      <Stat label="Out-of-turn, under review" value={fmtNumber(o.out_of_turn.under_review)} to="/owner/out-of-turn" tone={o.out_of_turn.under_review ? "danger" : undefined} />
      <Stat label="Payments awaiting" value={fmtNumber(o.payments.awaiting_payment)} to={payments} />
      <Stat label="Payments to verify" value={fmtNumber(o.payments.to_verify)} to={payments} tone={o.payments.to_verify ? "warn" : undefined} />
      <Stat label="Unsold stock" value={fmtNumber(o.unsold_by_age.total)} to="/owner#unsold" />
    </div>
  );
}

function AgeBars({ buckets }: { buckets: AgeBucket[] }) {
  const max = Math.max(1, ...buckets.map((b) => b.cars));
  return (
    <ul className="bars">
      {buckets.map((b) => (
        <li key={b.label} className="bar-row">
          <span className="bar-label">{b.label}</span>
          <span className="bar-track" aria-hidden="true">
            <span className="bar-fill" style={{ width: `${(b.cars / max) * 100}%` }} />
          </span>
          <span className="bar-value">{plural(b.cars, "car")}</span>
          <span className="bar-detail">
            {fmtNumber(b.in_yard)} in yard · {fmtNumber(b.in_transit)} in transit
            {b.value !== undefined ? ` · ${fmtMoney(b.value)}` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Overview() {
  const load = useLoad(() => api.ownerView(), "owner:view");
  useHashScroll(!load.loading);
  const outletColumns: Column<OwnerView["outlets"][number]>[] = [
    {
      header: "Outlet",
      primary: true,
      cell: (r) => (
        <>
          <span className="strong">{r.name}</span>
          <span className="sub mono">{r.code}</span>
        </>
      ),
    },
    { header: "Customers waiting", num: true, cell: (r) => fmtNumber(r.waiting) },
    { header: "Bookings holding a car", num: true, cell: (r) => fmtNumber(r.holding_a_car) },
    { header: "Cars", num: true, cell: (r) => fmtNumber(r.cars) },
    { header: "Cars free", num: true, cell: (r) => fmtNumber(r.cars_free) },
  ];
  const riskColumns: Column<AtRiskRow>[] = [
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
    { header: "State", status: true, cell: (r) => (r.overdue ? <Chip tone="red">Past the date</Chip> : <Chip tone="amber">Within 7 days</Chip>) },
    {
      header: "Car",
      cell: (r) => (
        <span>
          <span>
            {r.model} {r.variant}
          </span>
          <span className="sub">{r.colour}</span>
        </span>
      ),
    },
    { header: "Outlet", cell: (r) => r.outlet },
    { header: "Committed delivery", cell: (r) => fmtDate(r.expected_delivery_date) },
    { header: "Why", cell: (r) => r.why },
  ];

  return (
    <Async load={load} isEmpty={() => false}>
      {(o) => (
        <>
          <DataSource status={o.source} />
          <div className="tile-groups">
            <OwnerTiles o={o} />
          </div>
          <div id="unsold" className="anchor">
            <div className="chart-grid">
              <Card title="Unsold stock by age" className="chart-card">
                <Chart
                  height={220}
                  option={{
                    legend: { show: false },
                    xAxis: { type: "category", data: o.unsold_by_age.buckets.map((b) => b.label), axisLabel: { color: "#5b6672", fontSize: 11 }, axisTick: { show: false } },
                    yAxis: { type: "value", minInterval: 1, axisLabel: { color: "#5b6672" }, splitLine: { lineStyle: { color: "#e9eff3" } } },
                    series: [
                      { name: "In yard", type: "bar", stack: "a", barMaxWidth: 36, itemStyle: { color: PALETTE[0] }, data: o.unsold_by_age.buckets.map((b) => b.in_yard) },
                      { name: "In transit", type: "bar", stack: "a", itemStyle: { color: PALETTE[2], borderRadius: [3, 3, 0, 0] }, data: o.unsold_by_age.buckets.map((b) => b.in_transit) },
                    ],
                  }}
                />
              </Card>
              <Card title="Customers and cars by outlet" className="chart-card">
                <Chart
                  height={220}
                  option={{
                    xAxis: { type: "category", data: o.outlets.map((x) => x.name), axisLabel: { color: "#5b6672", fontSize: 11, interval: 0, rotate: o.outlets.length > 4 ? 20 : 0 }, axisTick: { show: false } },
                    yAxis: { type: "value", minInterval: 1, axisLabel: { color: "#5b6672" }, splitLine: { lineStyle: { color: "#e9eff3" } } },
                    series: [
                      { name: "Customers waiting", type: "bar", barMaxWidth: 20, itemStyle: { color: "#9a2a20", borderRadius: [3, 3, 0, 0] }, data: o.outlets.map((x) => x.waiting) },
                      { name: "Holding a car", type: "bar", barMaxWidth: 20, itemStyle: { color: PALETTE[1], borderRadius: [3, 3, 0, 0] }, data: o.outlets.map((x) => x.holding_a_car) },
                      { name: "Cars free", type: "bar", barMaxWidth: 20, itemStyle: { color: PALETTE[0], borderRadius: [3, 3, 0, 0] }, data: o.outlets.map((x) => x.cars_free) },
                    ],
                  }}
                />
              </Card>
            </div>
            <Card title={`Unsold stock by age (${fmtNumber(o.unsold_by_age.total)})`} note={o.unsold_by_age.basis}>
              {o.unsold_by_age.total ? <AgeBars buckets={o.unsold_by_age.buckets} /> : <Empty title="No unsold stock" />}
            </Card>
          </div>
          <Card title="By outlet" flush>
            {o.outlets.length ? <DataTable columns={outletColumns} rows={o.outlets} rowKey={(r) => r.outlet_id} caption="Position by outlet" /> : <Empty title="No outlets" />}
          </Card>
          <div id="at-risk" className="anchor">
            <Card title={`Delivery dates at risk (${fmtNumber(o.delivery_dates_at_risk.count)})`} note={o.delivery_dates_at_risk.basis} flush>
              {o.delivery_dates_at_risk.rows.length ? (
                <>
                  {o.delivery_dates_at_risk.count > o.delivery_dates_at_risk.rows.length && <p className="list-count">The first {o.delivery_dates_at_risk.rows.length} are shown.</p>}
                  <DataTable columns={riskColumns} rows={o.delivery_dates_at_risk.rows} rowKey={(r) => r.booking_id} caption="Delivery dates at risk" />
                </>
              ) : (
                <Empty title="No delivery date is at risk" />
              )}
            </Card>
          </div>
        </>
      )}
    </Async>
  );
}

// ---------------------------------------------------------------- out-of-turn allocations
function OutOfTurn() {
  const { can } = useSession();
  const load = useLoad(() => api.outOfTurn(), "owner:out-of-turn");
  const action = useAction();
  const [reviewing, setReviewing] = useState<OutOfTurnRow | null>(null);

  const columns: Column<OutOfTurnRow>[] = [
    {
      header: "Given to",
      primary: true,
      cell: (r) => (
        <Link to={`/bookings/${r.booking_id}`} className="cell-link">
          <span className="strong nowrap">{r.given_to}</span>
          <span className="sub">
            {r.customer_name} · booked {fmtDate(r.booking_date)}
          </span>
        </Link>
      ),
    },
    {
      header: "State",
      status: true,
      cell: (r) => (r.state === "APPROVED" ? <Chip tone="green">Approved</Chip> : r.state === "REVIEWED" ? <Chip tone="blue">Reviewed</Chip> : <Chip tone="red">Under review</Chip>),
    },
    {
      header: "Car",
      cell: (r) => (
        <span>
          <span>
            {r.model} {r.variant}, {r.colour}
          </span>
          <span className="sub">
            <span className="mono">{r.vin}</span> · {r.outlet} · {fmtDate(r.allocated_at)}
          </span>
        </span>
      ),
    },
    {
      header: "Bypassed",
      cell: (r) =>
        r.bypassed ? (
          <span>
            {r.bypassed_booking_id ? <Link to={`/bookings/${r.bypassed_booking_id}`}>{r.bypassed}</Link> : r.bypassed}
            {r.bypassed_count > 1 ? ` +${r.bypassed_count - 1} more` : ""}
            {r.bypassed_booking_date && <span className="sub">Booked {fmtDate(r.bypassed_booking_date)}</span>}
          </span>
        ) : (
          <span className="muted">—</span>
        ),
    },
    { header: "How", cell: (r) => r.how },
    {
      header: "Approved by and reason",
      cell: (r) =>
        r.state === "APPROVED" ? (
          <span>
            <span>{r.approved_by_name ?? "—"}</span>
            <span className="sub">{r.exception_reason ?? "—"}</span>
          </span>
        ) : r.state === "REVIEWED" ? (
          <span>
            <span>
              Reviewed by {r.reviewed_by_name ?? "—"}
              {r.reviewed_at ? `, ${fmtDateTime(r.reviewed_at)}` : ""}
            </span>
            <span className="sub">{r.review_note ?? "—"}</span>
          </span>
        ) : (
          <span className="danger">Not approved · under review</span>
        ),
    },
    ...(can("owner.review")
      ? [
          {
            header: "Actions",
            actions: true,
            hideIfEmpty: (r: OutOfTurnRow) => r.state !== "UNDER_REVIEW",
            cell: (r: OutOfTurnRow) =>
              r.state === "UNDER_REVIEW" ? (
                <Button size="sm" onClick={() => setReviewing(r)}>
                  Record review
                </Button>
              ) : null,
          } satisfies Column<OutOfTurnRow>,
        ]
      : []),
  ];

  return (
    <>
      <DataSource />
      <Card title="Out-of-turn allocations" note="Cars given ahead of an earlier waiting booking in the last 90 days: who got the car, who was passed over, and who approved it." flush>
        <Async load={load} empty={<Empty title="No out-of-turn allocation in the last 90 days" />}>
          {(rows) => (
            <>
              <p className="list-count">{plural(rows.length, "allocation")}</p>
              <DataTable columns={columns} rows={rows} rowKey={(r) => r.allocation_id} caption="Out-of-turn allocations" />
            </>
          )}
        </Async>
      </Card>
      {reviewing && (
        <ConfirmDialog
          title={`Record the review of ${reviewing.given_to}?`}
          message={`Car ${reviewing.vin} was given to booking ${reviewing.given_to}${reviewing.bypassed ? ` ahead of ${reviewing.bypassed}` : ""} without prior approval. The review is recorded against your name.`}
          confirmLabel="Record review"
          reason="required"
          reasonLabel="What was found"
          busy={action.busy}
          error={plainText(action.error) || null}
          onCancel={() => {
            action.clearError();
            setReviewing(null);
          }}
          onConfirm={async (note) => {
            const res = await action.run(() => api.reviewOutOfTurn(reviewing.allocation_id, note), { quiet: true, success: "Review recorded." });
            if (res) {
              setReviewing(null);
              await load.reload();
            }
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------- measures
/** A measured value with its unit. Never called with null. */
function measureValue(value: number, unit: Measure["unit"]): string {
  switch (unit) {
    case "%":
      return `${fmtNumber(value)}%`;
    case "days":
      return `${fmtNumber(value)} ${value === 1 ? "day" : "days"}`;
    case "cars":
      return `${fmtNumber(value)} ${value === 1 ? "car" : "cars"}`;
    case "bookings":
      return `${fmtNumber(value)} ${value === 1 ? "booking" : "bookings"}`;
    case "INR":
      return fmtMoney(value);
    default:
      return fmtNumber(value);
  }
}

function Measures() {
  const day = today();
  const [from, setFrom] = useState(`${day.slice(0, 7)}-01`);
  const [to, setTo] = useState(day);
  const valid = Boolean(from && to && from <= to && to <= day);
  const load = useLoad(() => api.measures(from, to), `owner:measures:${valid ? `${from}:${to}` : "invalid"}`);

  return (
    <>
      <DataSource />
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
      {valid && (
        <Async load={load} isEmpty={() => false}>
          {(m) => {
            const groups = [...new Set(m.measures.map((x) => x.group))];
            return (
              <>
                <p className="muted measure-period">
                  {fmtDate(m.period.from)} to {fmtDate(m.period.to)}, compared with {fmtDate(m.previous.from)} to {fmtDate(m.previous.to)}.
                </p>
                {groups.map((g) => (
                  <Card key={g} title={g}>
                    <ul className="measure-list">
                      {m.measures
                        .filter((x) => x.group === g)
                        .map((x) => (
                          <li key={x.key} className="measure">
                            <div className="measure-head">
                              <span className="measure-label">{x.label}</span>
                              <span className="meta">Should {x.should}</span>
                            </div>
                            <p className={`measure-value${x.value === null ? " measure-none" : ""}`}>{x.value === null ? "Not measured" : measureValue(x.value, x.unit)}</p>
                            <p className="meta">Previous period: {x.previous === null ? "no figure" : measureValue(x.previous, x.unit)}</p>
                            {x.basis !== "Not measured" && <p className="measure-basis">{x.basis}</p>}
                            {x.note && <p className="hint">{x.note}</p>}
                          </li>
                        ))}
                    </ul>
                  </Card>
                ))}
              </>
            );
          }}
        </Async>
      )}
    </>
  );
}
