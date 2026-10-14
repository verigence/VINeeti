import { useEffect, useState } from "react";
import { api } from "../api";
import { DataSource } from "../components/DataSource";
import { Async, Card, Chip, DataTable, Empty, Filter, FilterBar, LinkButton, PageHeader, Segments, Select, StatusChip, type Column } from "../components/ui";
import { fmtDate, fmtMobile, plural } from "../format";
import { useDebounced, useLoad } from "../hooks";
import { BOOKING_SOURCE_OPTIONS, BOOKING_STATUS_OPTIONS, bookingSource, bookingStatus, holdReason, NO_CUSTOMER_DETAILS, vehicleStatus } from "../labels";
import { Link, useQuery } from "../router";
import { useSession } from "../session";
import type { BookingListRow } from "../types";

type View = "open" | "waiting" | "hold" | "all";
const VIEWS: { value: View; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "waiting", label: "Waiting for a car" },
  { value: "hold", label: "On hold" },
  { value: "all", label: "All" },
];

export function BookingsPage() {
  const { can, me, myOutlets } = useSession();
  const [query, setQuery] = useQuery();
  const status = query.get("status") ?? "";
  const rawView = query.get("view");
  // A status filter always applies to the full list; without one the list opens on "Open".
  const view: View = status ? "all" : rawView === "waiting" || rawView === "hold" || rawView === "all" ? rawView : "open";
  const outletId = query.get("outlet_id") ?? "";
  const source = query.get("source") ?? "";
  const q = query.get("q") ?? "";
  const [search, setSearch] = useState(q);
  const debounced = useDebounced(search);
  useEffect(() => {
    if (debounced !== q) setQuery({ q: debounced });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const params = { view: view === "all" ? undefined : view, status: status || undefined, outlet_id: outletId || undefined, source: source || undefined, q: q || undefined };
  const load = useLoad(() => api.bookings(params), `bookings:${JSON.stringify(params)}`);
  const onlyOwn = !can("booking.view_all");

  const columns: Column<BookingListRow>[] = [
    {
      header: "Booking",
      primary: true,
      cell: (b) => (
        <Link to={`/bookings/${b.id}`} className="cell-link">
          <span className="strong nowrap">{b.booking_no}</span>
          <span className="sub">Booked {fmtDate(b.booking_date)}</span>
        </Link>
      ),
    },
    {
      header: "Status",
      status: true,
      cell: (b) => (
        <span className="chips">
          <StatusChip label={bookingStatus(b.status, b.on_hold)} />
        </span>
      ),
    },
    {
      header: "Customer",
      cell: (b) => (
        <>
          <span>{b.customer_name}</span>
          <span className="sub">{b.customer_mobile ? fmtMobile(b.customer_mobile) : b.source === "DMS_STOCK" ? NO_CUSTOMER_DETAILS : "—"}</span>
        </>
      ),
    },
    {
      header: "Car",
      cell: (b) => (
        <>
          <span>
            {b.model} {b.variant}
          </span>
          <span className="sub">{b.colour}</span>
        </>
      ),
    },
    { header: "Outlet", cell: (b) => b.outlet },
    { header: "Source", cell: (b) => <Chip tone={bookingSource(b.source).tone}>{bookingSource(b.source).text}</Chip> },
    { header: "DMS stage", hideIfEmpty: (b) => !b.dms_stage, cell: (b) => b.dms_stage ?? <span className="muted">—</span> },
    {
      header: "Queue / car",
      hideIfEmpty: (b) => !b.vin && !b.queue_position && !(b.status === "APPROVED" && b.on_hold),
      cell: (b) =>
        b.vin ? (
          <>
            <span className="mono">{b.vin}</span>
            <span className="sub">
              {vehicleStatus(b.vehicle_status).text}
              {b.vehicle_status === "IN_TRANSIT" && b.expected_arrival_date ? `, expected ${fmtDate(b.expected_arrival_date)}` : ""}
              {b.needs_transfer ? " · needs transfer" : ""}
            </span>
          </>
        ) : b.queue_position ? (
          <Chip tone="blue">No. {b.queue_position} in queue</Chip>
        ) : b.status === "APPROVED" && b.on_hold ? (
          <span>
            {holdReason(b.hold_reason)}
            {b.hold_until ? `, until ${fmtDate(b.hold_until)}` : ""}
          </span>
        ) : (
          <span className="muted">—</span>
        ),
    },
    { header: "Delivery by", cell: (b) => (b.expected_delivery_date ? fmtDate(b.expected_delivery_date) : <span className="muted">—</span>), hideIfEmpty: (b) => !b.expected_delivery_date },
    { header: "Sales consultant", cell: (b) => b.sales_exec ?? b.sc_name ?? <span className="muted">—</span>, hideIfEmpty: (b) => !(b.sales_exec ?? b.sc_name) },
  ];

  return (
    <>
      <PageHeader
        title="Bookings"
        subtitle={onlyOwn ? "Bookings you created or that are assigned to you." : `Bookings at ${me.user.allOutlets ? "every outlet" : "your outlets"}.`}
        primary={
          can("booking.create") ? (
            <LinkButton to="/bookings/new" variant="primary" icon="plus">
              New booking
            </LinkButton>
          ) : undefined
        }
      />
      <DataSource />
      <Segments label="Which bookings" options={VIEWS} value={view} onChange={(v) => setQuery({ view: v === "open" ? null : v, status: null })} />
      <FilterBar
        active={[status, outletId, source].filter(Boolean).length}
        onClear={() => setQuery({ status: null, outlet_id: null, source: null })}
        search={
          <Filter label="Search" grow>
            <input type="search" inputMode="search" enterKeyHint="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Booking number, customer name or mobile" />
          </Filter>
        }
      >
        <Filter label="Status">
          <Select value={status} onChange={(v) => setQuery({ status: v, view: v ? null : "all" })} options={BOOKING_STATUS_OPTIONS} placeholder="Any status" />
        </Filter>
        <Filter label="Source">
          <Select value={source} onChange={(v) => setQuery({ source: v })} options={BOOKING_SOURCE_OPTIONS} placeholder="Any source" />
        </Filter>
        {myOutlets.length > 1 && (
          <Filter label="Outlet">
            <Select value={outletId} onChange={(v) => setQuery({ outlet_id: v })} options={myOutlets.map((o) => ({ value: o.id, label: o.name }))} placeholder="All my outlets" />
          </Filter>
        )}
      </FilterBar>
      <Card flush>
        <Async
          load={load}
          empty={
            <Empty
              title={q || status || outletId || source || view !== "open" ? "No bookings match" : "No bookings yet"}
              hint={q || status || outletId || source || view !== "open" ? "Try another tab or clear the filters." : "Bookings appear here once the DMS booking sheet is loaded."}
            />
          }
        >
          {(rows) => (
            <>
              <p className="list-count">
                {plural(rows.length, "booking")}
                {rows.length >= 2000 ? " (first 2,000 shown; narrow the filters to see the rest)" : ""}
              </p>
              <DataTable columns={columns} rows={rows} rowKey={(b) => b.id} caption="Bookings" />
            </>
          )}
        </Async>
      </Card>
    </>
  );
}
