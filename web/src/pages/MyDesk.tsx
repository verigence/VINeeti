// The sales consultant's desk. Four things, in the order the day uses them.
//
//   1. What the customer in front of you can have — the stock check and the browser, one press away.
//   2. Your own bookings: how many are waiting, how many have a car, how many are billed.
//   3. The cars held for your customers, so you know what to chase and what to collect.
//   4. What the dealership has, model by model, because "do we have any Thars?" is asked all day.
//
// Nothing here reserves or allocates anything: a car is matched to a booking by the rules, never by a
// person choosing one.

import { api } from "../api";
import { Async, Card, Chip, DataTable, Empty, Loading, Stat, type Column } from "../components/ui";
import { fmtNumber, plural } from "../format";
import { useLoad } from "../hooks";
import { Link } from "../router";
import { useSession } from "../session";
import type { HoldingRow, ModelRow } from "../types";

export function MyDesk() {
  const { me } = useSession();
  const mine = useLoad(() => api.myWork(), "desk:mine");
  const c = mine.data?.counts ?? null;

  return (
    <>
      <div className="desk-doors">
        <Link to="/stock/check" className="door-btn door-btn-main">
          <span className="door-title">Stock check</span>
          <span className="door-sub">They have asked for a car. Say what you can promise — and what else you can offer if it is not there.</span>
        </Link>
        <Link to="/stock/browse" className="door-btn">
          <span className="door-title">Browse stock</span>
          <span className="door-sub">They are still deciding. Narrow by model, fuel, gearbox, seats and colour.</span>
        </Link>
      </div>

      {c && (
        <section className="tile-group" aria-labelledby="desk-mine">
          <h2 id="desk-mine" className="group-title">
            My customers
          </h2>
          <div className="tiles">
            <Stat label="Waiting for a car" value={fmtNumber(c.waiting)} to="/bookings?view=waiting" tone={c.waiting ? "warn" : undefined} />
            <Stat label="Car reserved" value={fmtNumber(c.allocated)} to="/bookings?status=ALLOCATED" />
            <Stat label="Billed, to hand over" value={fmtNumber(c.invoiced)} to="/bookings?status=INVOICED" />
            <Stat label="Handed over, last 30 days" value={fmtNumber(c.delivered_30)} to="/bookings?status=DELIVERED" />
            {c.no_car_coming > 0 && <Stat label="Nothing coming for them" value={fmtNumber(c.no_car_coming)} to="/bookings?view=waiting" tone="danger" hint="Not in the yard, not on the way, not on order" />}
          </div>
        </section>
      )}

      <MyHeldCars userName={me.user.name} />
      <WhatWeHave />
    </>
  );
}

/** The cars held for this consultant's customers: what to chase, and what is ready to hand over. */
function MyHeldCars({ userName }: { userName: string }) {
  const load = useLoad(() => api.holding(), "desk:holding");
  const rows = (load.data?.rows ?? []).filter((r) => r.sales_exec === userName);
  if (load.loading) return <Card title="Cars held for my customers"><Loading /></Card>;
  if (!rows.length) return null;
  const columns: Column<HoldingRow>[] = [
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
    { header: "Car", cell: (r) => (<span><span>{r.model} {r.variant}</span><span className="sub">{r.colour}</span></span>) },
    { header: "Where", status: true, cell: (r) => (r.at_dealership ? <Chip tone="green">At the dealership</Chip> : <Chip tone="blue">On the way</Chip>) },
    { header: "Held", num: true, cell: (r) => plural(r.held_days, "day") },
    {
      header: "Payment",
      status: true,
      cell: (r) => (r.payment === "RECEIVED" ? <Chip tone="green">Received</Chip> : r.payment === "REPORTED" ? <Chip tone="amber">Reported, not checked</Chip> : <Chip tone="red">Not paid</Chip>),
    },
    { header: "Next", cell: (r) => (r.invoiced ? "Hand it over" : r.payment === "RECEIVED" ? "Raise the invoice" : r.at_dealership ? "Collect the payment" : "Wait for the car") },
  ];
  return (
    <Card title={`Cars held for my customers (${fmtNumber(rows.length)})`} note="A car is held from the day it is allocated. The payment window starts when the car is at the dealership." flush>
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.booking_id} caption="Cars held for my customers" />
    </Card>
  );
}

/** What the dealership has, model by model — the question a consultant is asked all day. */
function WhatWeHave() {
  const load = useLoad(() => api.models(), "desk:models");
  return (
    <Card title="What we have, model by model" note={load.data ? `${fmtNumber(load.data.totals.free)} free to offer, ${fmtNumber(load.data.totals.held)} held for customers, as on ${load.data.as_of}.` : undefined} flush>
      <Async load={load} isEmpty={(d) => d.rows.length === 0} empty={<Empty title="No stock" hint="Load the DMS stock report under Daily update." />}>
        {(d) => <DataTable columns={deskColumns} rows={d.rows} rowKey={(r) => r.model} caption="Stock by model" />}
      </Async>
    </Card>
  );
}

const deskColumns: Column<ModelRow>[] = [
  { header: "Model", primary: true, cell: (r) => <Link to={`/stock/cars?commitment=FREE&model=${encodeURIComponent(r.model)}`} className="cell-link"><span className="strong">{r.model}</span></Link> },
  { header: "Free in the yard", num: true, cell: (r) => fmtNumber(r.yard_free) },
  { header: "Free, on the way", num: true, cell: (r) => fmtNumber(r.transit_free) },
  { header: "Held for customers", num: true, cell: (r) => fmtNumber(r.yard_held + r.transit_held) },
  { header: "Customers waiting", num: true, cell: (r) => (r.waiting ? <span className="strong">{fmtNumber(r.waiting)}</span> : <span className="muted">—</span>) },
  { header: "On order", num: true, cell: (r) => (r.on_order ? fmtNumber(r.on_order) : <span className="muted">—</span>), hideIfEmpty: (r) => !r.on_order },
];
