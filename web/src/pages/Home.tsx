// Home: what this person needs first, decided by what they are allowed to do. Every number is read
// from the server; nothing here is worked out or assumed on the device.

import { api } from "../api";
import { DataSource } from "../components/DataSource";
import { InstallHint } from "../components/InstallHint";
import { Async, Button, Card, Chip, DataTable, Disclosure, Empty, ErrorBox, Loading, PageHeader, Stat, StatusChip, type Column } from "../components/ui";
import { fmtDate, fmtDateTime, fmtMoney, fmtNumber, plural, today } from "../format";
import { useAction, useHashScroll, useLoad } from "../hooks";
import { bookingStatus, plainText } from "../labels";
import { canLoadFiles } from "../nav";
import { Link } from "../router";
import { useAlerts, useSession } from "../session";
import type { AlertRow, BookingListRow, DataStatus, MatchRow, Overview, PaymentRow } from "../types";
import { AvailabilityCheck } from "./Availability";
import { OwnerTiles } from "./Owner";

export function HomePage() {
  const { me, can } = useSession();
  const canApprove = can("booking.approve") || can("exception.decide");
  const ownOnly = can("booking.view") && !can("booking.view_all"); // sees only their own bookings: answers the customer, books
  const verifies = can("booking.payment");
  const reports = can("booking.payment_report") && can("booking.view_all") && !verifies;
  const followsMessages = can("wa.resend") || can("wa.manage");

  const status = useLoad(() => api.dataStatus(), "home:data-status");
  const overview = useLoad(() => (can("dashboards.view") ? api.overview() : Promise.resolve(null)), "home:overview");
  const owner = useLoad(() => (can("owner.view") ? api.ownerView() : Promise.resolve(null)), "home:owner");
  const payments = useLoad(() => (verifies || reports ? api.payments() : Promise.resolve(null)), "home:payments");
  const failed = useLoad(() => (followsMessages ? api.waMessages({ status: "FAILED" }) : Promise.resolve(null)), "home:wa-failed");
  const o = overview.data ?? null;
  const stockLink = (q: string) => (can("stock.view") ? `/stock/cars?${q}` : undefined);
  const bookingLink = (q: string) => (can("booking.view") ? `/bookings?${q}` : undefined);

  return (
    <>
      <PageHeader title="Home" subtitle={`${fmtDate(today())} · ${me.tenant.name} ${me.tenant.oem}`} />
      <InstallHint />
      {status.data && <DataSource status={status.data} />}
      {me.receives_alarms && <AlarmsCard />}

      {verifies && (
        <Async load={payments} isEmpty={() => false}>
          {(rows) => (rows ? <PaymentsToVerify rows={rows} /> : null)}
        </Async>
      )}

      {ownOnly && can("stock.view") && <AvailabilityCheck compact />}
      {ownOnly && <MyBookings />}
      {ownOnly && can("dashboards.view") && <MyOffers />}

      {can("owner.view") && (
        <section className="tile-group home-group" aria-labelledby="tg-owner">
          <h2 id="tg-owner" className="group-title">
            Owner's numbers
          </h2>
          <Async load={owner} isEmpty={() => false}>
            {(v) => (v ? <OwnerTiles o={v} /> : null)}
          </Async>
        </section>
      )}

      {overview.loading ? (
        <Loading />
      ) : !o ? (
        overview.error ? <ErrorBox message={overview.error} onRetry={() => void overview.reload()} /> : null
      ) : (
        <div className="tile-groups">
          {canApprove && (
            <section className="tile-group" aria-labelledby="tg-approvals">
              <h2 id="tg-approvals" className="group-title">
                Approvals waiting
              </h2>
              <div className="tiles">
                {can("booking.approve") && <Stat label="Bookings awaiting approval" value={fmtNumber(o.bookings.awaiting_approval)} to="/approvals" tone={o.bookings.awaiting_approval ? "warn" : undefined} />}
                <Stat label="Exception requests pending" value={fmtNumber(o.approvals.exceptions_pending)} to="/approvals" tone={o.approvals.exceptions_pending ? "warn" : undefined} />
              </div>
            </section>
          )}

          {followsMessages && (
            <section className="tile-group" aria-labelledby="tg-contact">
              <h2 id="tg-contact" className="group-title">
                Customer contact
              </h2>
              <div className="tiles">
                {failed.data && <Stat label="Failed customer messages" value={fmtNumber(failed.data.counts.find((c) => c.status === "FAILED")?.n ?? 0)} to="/whatsapp/log?status=FAILED" tone={failed.data.counts.find((c) => c.status === "FAILED")?.n ? "danger" : undefined} />}
                {can("booking.ready") && <Stat label="Bookings on hold" value={fmtNumber(o.bookings.on_hold)} to={bookingLink("view=hold")} tone={o.bookings.on_hold ? "warn" : undefined} />}
                <Stat label="Delayed deliveries" value={fmtNumber(o.bookings.delivery_overdue)} to="/dashboards/delayed" tone={o.bookings.delivery_overdue ? "danger" : undefined} />
              </div>
            </section>
          )}

          {can("booking.view") && <BookingTiles o={o} title={ownOnly ? "My bookings" : me.user.allOutlets ? "Bookings" : "Team bookings"} bookingLink={bookingLink} hideContact={followsMessages} showApproval={!canApprove} />}

          {reports && payments.data && (
            <section className="tile-group" aria-labelledby="tg-payments">
              <h2 id="tg-payments" className="group-title">
                Payments
              </h2>
              <div className="tiles">
                <Stat label="Reported, waiting for Finance" value={fmtNumber(payments.data.filter((p) => p.state === "TO_VERIFY").length)} to="/payments" />
                <Stat label="Awaiting payment" value={fmtNumber(payments.data.filter((p) => p.state === "AWAITING_PAYMENT").length)} to="/payments" />
              </div>
            </section>
          )}

          {can("stock.view") && (
            <section className="tile-group" aria-labelledby="tg-stock">
              <h2 id="tg-stock" className="group-title">
                Stock
              </h2>
              <div className="tiles">
                <Stat label="Free in yard" value={fmtNumber(o.stock.yard_free)} to={stockLink("status=RECEIVED&commitment=FREE")} />
                <Stat label="Reserved in yard" value={fmtNumber(o.stock.yard_allocated)} to={stockLink("status=RECEIVED&commitment=ALLOCATED")} />
                <Stat label="Free in transit" value={fmtNumber(o.stock.transit_free)} to={stockLink("status=IN_TRANSIT&commitment=FREE")} />
                <Stat label="Reserved in transit" value={fmtNumber(o.stock.transit_allocated)} to={stockLink("status=IN_TRANSIT&commitment=ALLOCATED")} />
                <Stat label="Blocked" value={fmtNumber(o.stock.blocked)} to={stockLink("commitment=BLOCKED")} tone={o.stock.blocked ? "warn" : undefined} />
                <Stat label="Overdue in transit" value={fmtNumber(o.stock.transit_overdue)} to={stockLink("status=IN_TRANSIT&overdue=1")} tone={o.stock.transit_overdue ? "danger" : undefined} />
              </div>
            </section>
          )}
        </div>
      )}

      {canLoadFiles(can) && status.data && <DmsFilesCard status={status.data} />}
      <AlertsCard />
    </>
  );
}

function BookingTiles({ o, title, bookingLink, hideContact, showApproval }: { o: Overview; title: string; bookingLink: (q: string) => string | undefined; hideContact: boolean; showApproval: boolean }) {
  const { can } = useSession();
  return (
    <section className="tile-group" aria-labelledby="tg-bookings">
      <h2 id="tg-bookings" className="group-title">
        {title}
      </h2>
      <div className="tiles">
        <Stat label="Drafts" value={fmtNumber(o.bookings.draft)} to={bookingLink("status=DRAFT")} />
        {showApproval && <Stat label="Awaiting approval" value={fmtNumber(o.bookings.awaiting_approval)} to={bookingLink("status=SUBMITTED")} />}
        <Stat label="Waiting for a car" value={fmtNumber(o.bookings.waiting)} to={bookingLink("view=waiting")} />
        {!hideContact && <Stat label="On hold" value={fmtNumber(o.bookings.on_hold)} to={bookingLink("view=hold")} />}
        <Stat label="Allocated" value={fmtNumber(o.bookings.allocated)} to={bookingLink("status=ALLOCATED")} />
        <Stat label="Invoiced, to deliver" value={fmtNumber(o.bookings.invoiced)} to={bookingLink("status=INVOICED")} />
        {!hideContact && <Stat label="Past delivery date" value={fmtNumber(o.bookings.delivery_overdue)} to={can("dashboards.view") ? "/dashboards/delayed" : undefined} tone={o.bookings.delivery_overdue ? "danger" : undefined} />}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- Finance: payments to verify
function PaymentsToVerify({ rows }: { rows: PaymentRow[] }) {
  const list = rows.filter((r) => r.state === "TO_VERIFY");
  const columns: Column<PaymentRow>[] = [
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
    { header: "Flag", status: true, hideIfEmpty: (r) => !r.overdue, cell: (r) => (r.overdue ? <Chip tone="red">Overdue</Chip> : null) },
    { header: "Amount", num: true, cell: (r) => (r.payment_amount === null ? <span className="muted">—</span> : fmtMoney(r.payment_amount)) },
    { header: "Reference", cell: (r) => r.payment_ref ?? <span className="muted">—</span> },
    {
      header: "Reported",
      cell: (r) => (
        <span>
          <span>{r.payment_reported_by_name ?? "—"}</span>
          <span className="sub">{fmtDateTime(r.payment_reported_at)}</span>
        </span>
      ),
    },
  ];
  return (
    <Card
      title={`Payments to verify (${fmtNumber(list.length)})`}
      note="Reported by sales and waiting for Finance."
      actions={
        <Link to="/payments" className="btn btn-secondary btn-sm">
          <span>Open Payments</span>
        </Link>
      }
      flush
    >
      {list.length ? <DataTable columns={columns} rows={list.slice(0, 8)} rowKey={(r) => r.booking_id} caption="Payments to verify" /> : <Empty title="No reported payment is waiting for Finance" />}
      {list.length > 8 && <p className="list-count">The first 8 are shown. Open Payments for the rest.</p>}
    </Card>
  );
}

// ---------------------------------------------------------------- sales executive: own bookings and offers
function MyBookings() {
  const { can } = useSession();
  const load = useLoad(() => api.bookings({ view: "open" }), "home:my-bookings");
  const columns: Column<BookingListRow>[] = [
    {
      header: "Booking",
      primary: true,
      cell: (b) => (
        <Link to={`/bookings/${b.id}`} className="cell-link">
          <span className="strong nowrap">{b.booking_no}</span>
          <span className="sub">{b.customer_name}</span>
        </Link>
      ),
    },
    { header: "Status", status: true, cell: (b) => <StatusChip label={bookingStatus(b.status, b.on_hold)} /> },
    {
      header: "Car",
      cell: (b) => (
        <span>
          <span>
            {b.model} {b.variant}
          </span>
          <span className="sub">{b.colour}</span>
        </span>
      ),
    },
    {
      header: "Queue / car",
      hideIfEmpty: (b) => !b.vin && !b.queue_position,
      cell: (b) => (b.vin ? <span className="mono">{b.vin}</span> : b.queue_position ? `No. ${b.queue_position} in queue` : <span className="muted">—</span>),
    },
  ];
  return (
    <Card
      title="My bookings"
      note="Open bookings you created or that are assigned to you."
      actions={
        <span className="row-actions">
          {can("booking.create") && (
            <Link to="/bookings/new" className="btn btn-primary btn-sm">
              <span>New booking</span>
            </Link>
          )}
          <Link to="/bookings" className="btn btn-secondary btn-sm">
            <span>All my bookings</span>
          </Link>
        </span>
      }
      flush
    >
      <Async load={load} empty={<Empty title="You have no open bookings" />}>
        {(rows) => (
          <>
            <DataTable columns={columns} rows={rows.slice(0, 8)} rowKey={(b) => b.id} caption="My bookings" />
            {rows.length > 8 && <p className="list-count">The first 8 of {fmtNumber(rows.length)} are shown.</p>}
          </>
        )}
      </Async>
    </Card>
  );
}

function MyOffers() {
  const load = useLoad(() => api.matches(), "home:offers");
  const columns: Column<MatchRow>[] = [
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
    {
      header: "Booked car",
      cell: (r) => (
        <span>
          <span>
            {r.model} {r.variant}
          </span>
          <span className="sub">{r.colour}</span>
        </span>
      ),
    },
    { header: "Free in another colour", cell: (r) => r.options.map((x) => `${x.colour} (${fmtNumber(x.in_yard)} in yard, ${fmtNumber(x.in_transit)} in transit)`).join("; ") },
  ];
  return (
    <Card
      title="Offers for my waiting customers"
      note="The same model and variant is free in another colour. Nothing is allocated unless the booking is changed in the DMS."
      actions={
        <Link to="/dashboards/offers" className="btn btn-secondary btn-sm">
          <span>All offers</span>
        </Link>
      }
      flush
    >
      <Async load={load} empty={<Empty title="No offers to make" />}>
        {(rows) => (
          <>
            <DataTable columns={columns} rows={rows.slice(0, 5)} rowKey={(r) => r.booking_id} caption="Offers" />
            {rows.length > 5 && <p className="list-count">The first 5 of {fmtNumber(rows.length)} are shown.</p>}
          </>
        )}
      </Async>
    </Card>
  );
}

// ---------------------------------------------------------------- the state of the DMS files, for those who load them
function DmsFilesCard({ status: s }: { status: DataStatus }) {
  const rows: { name: string; file: DataStatus["stock"]; stale: boolean; dated: (d: string) => string }[] = [
    { name: "Booking sheet", file: s.bookings, stale: s.stale_files.includes("BOOKINGS"), dated: (d) => `Loaded ${fmtDate(d)}` },
    { name: "Stock report", file: s.stock, stale: s.stale_files.includes("STOCK"), dated: (d) => `As on ${fmtDate(d)}` },
  ];
  return (
    <Card
      title="DMS files"
      note={`Expected every ${plural(s.expected_every_days, "day")}.`}
      actions={
        <Link to="/eod" className="btn btn-secondary btn-sm">
          <span>Open End of day</span>
        </Link>
      }
    >
      <ul className="file-states">
        {rows.map((r) => (
          <li key={r.name}>
            <span className="strong">{r.name}</span>
            {r.file ? <Chip tone={r.stale ? "red" : "green"}>{r.stale ? "Out of date" : "Up to date"}</Chip> : <Chip tone="amber">Not loaded</Chip>}
            <span className="sub">{r.file ? `${r.dated(r.file.report_date)} · ${plural(r.file.age_days, "day")} old${r.file.loaded_by ? ` · ${r.file.loaded_by}` : ""}` : "No file has been loaded."}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ---------------------------------------------------------------- alarms and alerts
const sentenceCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function alertLink(a: AlertRow, can: (p: "booking.view" | "stock.view" | "recon.view" | "admin.settings") => boolean, canApprove: boolean): { to: string; label: string } | null {
  if (a.kind === "STALE_DATA") return { to: "/eod", label: "Open End of day" };
  if (a.kind === "RECON_HIGH" && can("recon.view")) return { to: "/recon", label: "Open reconciliation" };
  if (!a.entity_id) return null;
  if (a.entity_type === "booking" && can("booking.view")) return { to: `/bookings/${a.entity_id}`, label: "Open booking" };
  if (a.entity_type === "vehicle" && can("stock.view")) return { to: `/stock/cars/${a.entity_id}`, label: "Open car" };
  if (a.entity_type === "exception" && canApprove) return { to: "/approvals", label: "Open approvals" };
  if (a.entity_type === "tenant" && a.kind === "RULES_CHANGED" && can("admin.settings")) return { to: "/admin/rules", label: "Open rules" };
  return null;
}

function AlertItems({ rows, busy, onRead }: { rows: AlertRow[]; busy: boolean; onRead: (ids: string[], message: string) => void }) {
  const { can } = useSession();
  const canApprove = can("booking.approve") || can("exception.decide");
  return (
    <ul className="alert-list">
      {rows.map((a) => {
        const link = alertLink(a, can, canApprove);
        return (
          <li key={a.id} className={`alert-item${a.read_at ? "" : " alert-unread"}`}>
            <div className="alert-main">
              <p className="alert-title">
                {!a.read_at && <span className="unread-tag">New</span>}
                {a.title}
              </p>
              <p className="alert-body">{sentenceCase(plainText(a.body))}</p>
              <p className="meta">{fmtDateTime(a.created_at)}</p>
            </div>
            <div className="alert-actions">
              {link && (
                <Link to={link.to} className="btn btn-secondary btn-sm">
                  <span>{link.label}</span>
                </Link>
              )}
              {!a.read_at && (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => onRead([a.id], a.is_alarm ? "Alarm marked as read." : "Alert marked as read.")}>
                  Mark as read
                </Button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** For the people who receive alarms: the few events that need them, unread first. */
function AlarmsCard() {
  const load = useLoad(() => api.alarms(), "home:alarms");
  const action = useAction();
  useHashScroll(!load.loading);
  const rows = load.data ?? [];
  const unread = rows.filter((a) => !a.read_at);
  const read = rows.filter((a) => a.read_at);

  const markRead = (ids: string[], message: string) =>
    void action
      .run(async () => {
        for (const id of ids) await api.markAlertRead(id);
      }, { success: message })
      .then(() => load.reload());

  return (
    <div id="alarms" className="anchor">
      <Card
        title={`Alarms${unread.length ? ` (${unread.length} unread)` : ""}`}
        className={unread.length ? "card-alarm" : undefined}
        actions={
          unread.length > 1 ? (
            <Button size="sm" busy={action.busy} onClick={() => markRead(unread.map((a) => a.id), "All alarms marked as read.")}>
              Mark all as read
            </Button>
          ) : undefined
        }
        flush
      >
        {load.loading ? (
          <Loading label="Loading alarms" />
        ) : load.data === undefined ? (
          <ErrorBox message={load.error ?? "Could not load the alarms."} onRetry={() => void load.reload()} />
        ) : !rows.length ? (
          <Empty title="No alarms" />
        ) : (
          <>
            {unread.length ? <AlertItems rows={unread} busy={action.busy} onRead={markRead} /> : <Empty title="No unread alarms" />}
            {read.length > 0 && (
              <Disclosure summary={`Alarms already read (${read.length})`}>
                <AlertItems rows={read} busy={action.busy} onRead={markRead} />
              </Disclosure>
            )}
          </>
        )}
      </Card>
    </div>
  );
}

function AlertsCard() {
  const { me } = useSession();
  const { alerts: all, loading, error, reload } = useAlerts();
  const action = useAction();
  // The bell in the top bar links to /#alerts: bring the list into view.
  useHashScroll(!loading);
  // People who receive alarms see them in their own panel above, not twice.
  const alerts = me.receives_alarms ? all.filter((a) => !a.is_alarm) : all;
  const unread = alerts.filter((a) => !a.read_at).length;

  const markRead = (ids: string[], message: string) =>
    void action
      .run(async () => {
        for (const id of ids) await api.markAlertRead(id);
      }, { success: message })
      .then(() => reload());

  return (
    <div id="alerts" className="anchor">
      <Card
        title={`Your alerts${unread ? ` (${unread} unread)` : ""}`}
        actions={
          unread > 1 ? (
            <Button size="sm" busy={action.busy} onClick={() => markRead(alerts.filter((a) => !a.read_at).map((a) => a.id), "All alerts marked as read.")}>
              Mark all as read
            </Button>
          ) : undefined
        }
        flush
      >
        {loading ? <Loading label="Loading alerts" /> : error && !alerts.length ? <ErrorBox message={error} onRetry={() => void reload()} /> : !alerts.length ? <Empty title="No alerts" /> : <AlertItems rows={alerts} busy={action.busy} onRead={markRead} />}
      </Card>
    </div>
  );
}
