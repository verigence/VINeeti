// Home: what this person needs first, decided by what they are allowed to do. Every number is read
// from the server; nothing here is worked out or assumed on the device.

import { api } from "../api";
import { DataSource } from "../components/DataSource";
import { InstallHint } from "../components/InstallHint";
import { Async, Button, Card, Chip, DataTable, Disclosure, Empty, ErrorBox, Loading, PageHeader, Stat, StatusChip, type Column } from "../components/ui";
import { fmtDate, fmtDateTime, fmtMoney, fmtNumber, plural, today } from "../format";
import { useAction, useHashScroll, useLoad } from "../hooks";
import { bookingStatus, personName, plainText } from "../labels";
import { canLoadFiles } from "../nav";
import { Link } from "../router";
import { useAlerts, useSession } from "../session";
import type { AlertRow, BookingListRow, DataStatus, MatchRow, Overview, OwnerView, PaymentRow, Permission } from "../types";
import { MyDesk } from "./MyDesk";
import { CapitalBoard, HeadlineBand, MessagesBoard, MoneyBoard, OutletLeague, OwnerBoard, PaceCard, QueueBoard, TrendBoard } from "./HomeBoards";

/**
 * The three or four figures that go across the top, chosen for the person looking at them: an owner
 * wants the business, finance wants the money, a sales executive wants their own customers. Only
 * figures the server has already sent are used; nothing is worked out here.
 */
function headlines({ o, owner, payments, failed, can, ownOnly }: { o: Overview | null; owner: OwnerView | null; payments: PaymentRow[] | null; failed: number; can: (p: Permission) => boolean; ownOnly: boolean }) {
  const items: { label: string; value: string; sub?: string; to?: string; tone?: "warn" | "danger" }[] = [];
  if (can("booking.payment") && payments) {
    const toVerify = payments.filter((p) => p.state === "TO_VERIFY").length;
    const awaiting = payments.filter((p) => p.state === "AWAITING_PAYMENT").length;
    items.push({ label: "Payments to check", value: fmtNumber(toVerify), to: "/payments", tone: toVerify ? "warn" : undefined });
    items.push({ label: "Customers yet to pay", value: fmtNumber(awaiting), to: "/payments" });
    if (owner) items.push({ label: "Checked, waiting to be billed", value: fmtNumber(owner.payments.verified_not_invoiced), to: "/payments" });
    return items;
  }
  if (can("owner.view") && owner) {
    items.push({ label: "Customers waiting for a car", value: fmtNumber(owner.customers_waiting), to: "/bookings?view=waiting" });
    items.push({ label: "Cars nobody has booked", value: fmtNumber(owner.unsold_by_age.total), sub: `${fmtNumber(owner.unsold_by_age.buckets.at(-1)?.cars ?? 0)} here the longest`, to: "/owner/unsold" });
    items.push({ label: "Delivery dates at risk", value: fmtNumber(owner.delivery_dates_at_risk.count), sub: `${fmtNumber(owner.delivery_dates_at_risk.overdue)} already past`, to: "/dashboards/delayed", tone: owner.delivery_dates_at_risk.overdue ? "danger" : undefined });
    items.push({ label: "Given out of turn this month", value: fmtNumber(owner.out_of_turn.this_month), sub: `${fmtNumber(owner.out_of_turn.under_review)} not looked at`, to: "/owner/out-of-turn", tone: owner.out_of_turn.under_review ? "warn" : undefined });
    return items;
  }
  if (!o) return items;
  if (ownOnly) {
    items.push({ label: "My customers waiting for a car", value: fmtNumber(o.bookings.waiting), to: "/bookings?view=waiting" });
    items.push({ label: "Cars reserved for my customers", value: fmtNumber(o.bookings.allocated), to: "/bookings?status=ALLOCATED" });
    items.push({ label: "Billed, still to hand over", value: fmtNumber(o.bookings.invoiced), to: "/bookings?status=INVOICED" });
    return items;
  }
  if (can("wa.resend") || can("wa.manage")) {
    items.push({ label: "Messages that did not go", value: fmtNumber(failed), to: "/whatsapp/log?status=FAILED", tone: failed ? "danger" : undefined });
    items.push({ label: "Bookings on hold", value: fmtNumber(o.bookings.on_hold), to: "/bookings?view=hold", tone: o.bookings.on_hold ? "warn" : undefined });
    items.push({ label: "Deliveries running late", value: fmtNumber(o.bookings.delivery_overdue), to: "/dashboards/delayed", tone: o.bookings.delivery_overdue ? "danger" : undefined });
    return items;
  }
  items.push({ label: "Customers waiting for a car", value: fmtNumber(o.bookings.waiting), to: "/bookings?view=waiting" });
  items.push({ label: "Cars free in the yard", value: fmtNumber(o.stock.yard_free), to: can("stock.view") ? "/stock/cars?status=RECEIVED&commitment=FREE" : undefined });
  items.push({ label: "Waiting for your approval", value: fmtNumber(o.bookings.awaiting_approval + o.approvals.exceptions_pending), to: "/approvals", tone: o.bookings.awaiting_approval + o.approvals.exceptions_pending ? "warn" : undefined });
  items.push({ label: "Deliveries running late", value: fmtNumber(o.bookings.delivery_overdue), to: "/dashboards/delayed", tone: o.bookings.delivery_overdue ? "danger" : undefined });
  return items;
}

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
  // The two people who answer for the month: the Dealer Principal and the Business Head / CEO.
  const isCeo = me.user.role === "BUSINESS_HEAD";
  const runsTheBusiness = can("owner.view") && !verifies && (isCeo || me.user.role === "DEALER_PRINCIPAL");
  const month = useLoad(() => (runsTheBusiness ? api.monthPace() : Promise.resolve(null)), "home:month");
  const o = overview.data ?? null;
  const stockLink = (q: string) => (can("stock.view") ? `/stock/cars?${q}` : undefined);
  const bookingLink = (q: string) => (can("booking.view") ? `/bookings?${q}` : undefined);

  return (
    <>
      <PageHeader title={`Good ${partOfDay()}, ${personName(me.user.name).split(" ")[0]}`} subtitle={`${fmtDate(today())} · ${me.tenant.name}`} />
      <InstallHint />
      {status.data && <DataSource status={status.data} />}
      {me.receives_alarms && <AlarmsCard />}
      <HeadlineBand items={headlines({ o, owner: owner.data ?? null, payments: payments.data ?? null, failed: failed.data?.counts.find((c) => c.status === "FAILED")?.n ?? 0, can, ownOnly })} />
      <NeedsYou overview={o} payments={payments.data ?? null} owner={owner.data ?? null} status={status.data ?? null} failed={failed.data?.counts.find((c) => c.status === "FAILED")?.n ?? 0} />

      {/* The Dealer Principal answers for this month and for this dealership's blockers; the Business
          Head / CEO answers for the trend and for the money tied up in the yard. Same permission, two
          different jobs, so two different screens. */}
      {runsTheBusiness && month.data && <PaceCard m={month.data} />}
      {runsTheBusiness && month.data && (
        <div className="board">
          {isCeo ? <TrendBoard m={month.data} /> : <OutletLeague m={month.data} owner={owner.data ?? null} />}
          {isCeo ? <CapitalBoard m={month.data} owner={owner.data ?? null} /> : null}
        </div>
      )}
      {can("owner.view") && !verifies && <OwnerBoard owner={owner.data ?? null} />}
      {verifies && payments.data && <MoneyBoard awaiting={payments.data.filter((p) => p.state === "AWAITING_PAYMENT").length} toVerify={payments.data.filter((p) => p.state === "TO_VERIFY").length} verifiedNotInvoiced={owner.data?.payments.verified_not_invoiced ?? 0} />}
      {followsMessages && failed.data && <MessagesBoard counts={failed.data.counts} />}
      {o && !ownOnly && !can("owner.view") && can("dashboards.view") && <QueueBoard o={o} />}

      {verifies && (
        <Async load={payments} isEmpty={() => false}>
          {(rows) => (rows ? <PaymentsToVerify rows={rows} /> : null)}
        </Async>
      )}

      {/* A customer walking in is the job; the bookings already made are the follow-up. So the stock
          check is a door to its own screen here, not a form squeezed in above a list. */}
      {ownOnly && <MyDesk />}
      {ownOnly && <MyBookings />}
      {ownOnly && can("dashboards.view") && <MyOffers />}

      {overview.loading ? (
        <Loading />
      ) : !o ? (
        overview.error ? <ErrorBox message={overview.error} onRetry={() => void overview.reload()} /> : null
      ) : (
        <div className="tile-groups">
          {canApprove && (
            <TileGroup
              id="approvals"
              title="Waiting for your approval"
              clear="Nothing is waiting for your approval."
              tiles={[
                can("booking.approve") && { label: "Bookings", n: o.bookings.awaiting_approval, to: "/approvals", tone: "warn" as const },
                { label: "Special requests", n: o.approvals.exceptions_pending, to: "/approvals", tone: "warn" as const },
              ]}
            />
          )}

          {followsMessages && (
            <TileGroup
              id="contact"
              title="Customers to contact"
              clear="Every customer has been told what they need to know."
              tiles={[
                failed.data && { label: "Messages that did not go", n: failed.data.counts.find((c) => c.status === "FAILED")?.n ?? 0, to: "/whatsapp/log?status=FAILED", tone: "danger" as const },
                can("booking.ready") && { label: "Bookings on hold", n: o.bookings.on_hold, to: bookingLink("view=hold"), tone: "warn" as const },
                { label: "Deliveries running late", n: o.bookings.delivery_overdue, to: "/dashboards/delayed", tone: "danger" as const },
              ]}
            />
          )}

          {can("booking.view") && !ownOnly && (
            <TileGroup
              id="bookings"
              title={ownOnly ? "My bookings" : me.user.allOutlets ? "Bookings" : "Team bookings"}
              clear="No open bookings."
              tiles={[
                { label: "Still being written", n: o.bookings.draft, to: bookingLink("status=DRAFT") },
                !canApprove && { label: "Waiting for approval", n: o.bookings.awaiting_approval, to: bookingLink("status=SUBMITTED") },
                { label: "Waiting for a car", n: o.bookings.waiting, to: bookingLink("view=waiting") },
                !followsMessages && { label: "On hold", n: o.bookings.on_hold, to: bookingLink("view=hold") },
                { label: "Car reserved", n: o.bookings.allocated, to: bookingLink("status=ALLOCATED") },
                { label: "Billed, to deliver", n: o.bookings.invoiced, to: bookingLink("status=INVOICED") },
                !followsMessages && { label: "Past the promised date", n: o.bookings.delivery_overdue, to: can("dashboards.view") ? "/dashboards/delayed" : undefined, tone: "danger" as const },
              ]}
            />
          )}

          {reports && payments.data && (
            <TileGroup
              id="payments"
              title="Payments"
              clear="No payment is outstanding."
              tiles={[
                { label: "Paid, waiting for Finance", n: payments.data.filter((p) => p.state === "TO_VERIFY").length, to: "/payments" },
                { label: "Waiting for payment", n: payments.data.filter((p) => p.state === "AWAITING_PAYMENT").length, to: "/payments" },
              ]}
            />
          )}

          {can("stock.view") && !ownOnly && (
            <TileGroup
              id="stock"
              title="Cars in stock"
              clear="No car in the latest stock report."
              tiles={[
                { label: "Free in the yard", n: o.stock.yard_free, to: stockLink("status=RECEIVED&commitment=FREE") },
                { label: "Reserved in the yard", n: o.stock.yard_allocated, to: stockLink("status=RECEIVED&commitment=ALLOCATED") },
                { label: "Free, on the way", n: o.stock.transit_free, to: stockLink("status=IN_TRANSIT&commitment=FREE") },
                { label: "Reserved, on the way", n: o.stock.transit_allocated, to: stockLink("status=IN_TRANSIT&commitment=ALLOCATED") },
                { label: "Blocked or demo", n: o.stock.blocked, to: stockLink("commitment=BLOCKED"), tone: "warn" as const },
                { label: "Late in transit", n: o.stock.transit_overdue, to: stockLink("status=IN_TRANSIT&overdue=1"), tone: "danger" as const },
              ]}
            />
          )}
        </div>
      )}

      {canLoadFiles(can) && status.data && <DmsFilesCard status={status.data} />}
      <AlertsCard />
    </>
  );
}

/** Morning, afternoon or evening at the dealership, for the greeting. */
function partOfDay(): string {
  const h = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }).format(new Date()));
  return h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
}

interface Todo {
  text: string;
  to: string;
  action: string;
  tone?: "warn" | "danger";
}

/**
 * What this person has to do today, in one short list and in plain words. Only what is actually waiting
 * is shown, most pressing first; the numbers below are for looking things up, this is for acting.
 */
function NeedsYou({ overview, payments, owner, status, failed }: { overview: Overview | null; payments: PaymentRow[] | null; owner: OwnerView | null; status: DataStatus | null; failed: number }) {
  const { can } = useSession();
  const items: Todo[] = [];
  const add = (n: number, one: string, many: string, to: string, action: string, tone?: Todo["tone"]) => {
    if (n > 0) items.push({ text: n === 1 ? one : many.replace("{n}", fmtNumber(n)), to, action, tone });
  };

  if (status?.stale && (canLoadFiles(can) || can("recon.view"))) {
    const which = status.stale_files.length === 2 ? "The stock report and the booking sheet are" : status.stale_files[0] === "STOCK" ? "The stock report is" : "The booking sheet is";
    items.push({ text: `${which} out of date. Until today's file is loaded, nobody's place in the queue can change.`, to: "/eod", action: "Load the files", tone: "danger" });
  }
  if (can("booking.payment") && payments) add(payments.filter((p) => p.state === "TO_VERIFY").length, "One payment is waiting for you to check it against the bank.", "{n} payments are waiting for you to check them against the bank.", "/payments", "Check payments", "warn");
  if (can("booking.approve") && overview) add(overview.bookings.awaiting_approval, "One booking is waiting for your approval.", "{n} bookings are waiting for your approval.", "/approvals", "Approve bookings", "warn");
  if (can("exception.decide") && overview) add(overview.approvals.exceptions_pending, "One special request is waiting for your decision.", "{n} special requests are waiting for your decision.", "/approvals", "Decide", "warn");
  if (can("owner.view") && owner) add(owner.out_of_turn.under_review, "One car was given out of turn and nobody has looked at it yet.", "{n} cars were given out of turn and nobody has looked at them yet.", "/owner/out-of-turn", "Look at them", "warn");
  if (can("booking.payment_report") && !can("booking.payment") && payments) add(payments.filter((p) => p.state === "AWAITING_PAYMENT").length, "One customer has a car reserved and has not paid yet.", "{n} customers have a car reserved and have not paid yet.", "/payments", "See who");
  if (can("wa.resend")) add(failed, "One message to a customer did not go through.", "{n} messages to customers did not go through.", "/whatsapp/log?status=FAILED", "See the messages", "warn");
  if (can("dashboards.view") && overview) add(overview.bookings.delivery_overdue, "One delivery is past the date promised to the customer.", "{n} deliveries are past the date promised to the customer.", "/dashboards/delayed", "See them", "danger");
  if (can("stock.manage") && overview) add(overview.stock.transit_overdue, "One car in transit is later than expected.", "{n} cars in transit are later than expected.", "/stock/cars?status=IN_TRANSIT&overdue=1", "See the cars");

  if (!overview && !payments && !owner) return null;
  // Nothing waiting is good news, and good news does not need a card of its own: one line says it.
  if (!items.length) return <p className="todo-clear-line">Nothing is waiting for you right now. The numbers below show how the day stands.</p>;
  return (
    <Card title="What needs you today" className="needs-you">
      {items.length ? (
        <ul className="todo-list">
          {items.slice(0, 5).map((t) => (
            <li key={`${t.to}:${t.text}`} className={`todo${t.tone ? ` todo-${t.tone}` : ""}`}>
              <span className="todo-text">{t.text}</span>
              <Link to={t.to} className="btn btn-secondary btn-sm">
                <span>{t.action}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="todo-clear">Nothing is waiting for you right now. The numbers below show how the day stands.</p>
      )}
    </Card>
  );
}

interface Tile {
  label: string;
  n: number;
  to?: string;
  tone?: "warn" | "danger";
}

/**
 * A group of figures. A figure at zero is left out: a screen of zeroes tells nobody anything, and the
 * eye has to read every one of them to find the one that is not. When the whole group is at zero that
 * is itself the news, so it is said in one line instead of six empty boxes.
 */
function TileGroup({ id, title, tiles, clear }: { id: string; title: string; tiles: (Tile | false | null | undefined)[]; clear: string }) {
  const shown = tiles.filter((x): x is Tile => Boolean(x) && (x as Tile).n > 0);
  return (
    <section className="tile-group" aria-labelledby={`tg-${id}`}>
      <h2 id={`tg-${id}`} className="group-title">
        {title}
      </h2>
      {shown.length ? (
        <div className="tiles">
          {shown.map((s) => (
            <Stat key={s.label} label={s.label} value={fmtNumber(s.n)} to={s.to} tone={s.tone} />
          ))}
        </div>
      ) : (
        <p className="group-clear">{clear}</p>
      )}
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
      title={`Payments to check (${fmtNumber(list.length)})`}
      note="Sales says the customer has paid; check it against the bank."
      actions={
        <Link to="/payments" className="btn btn-secondary btn-sm">
          <span>Open Payments</span>
        </Link>
      }
      flush
    >
      {list.length ? <DataTable columns={columns} rows={list.slice(0, 8)} rowKey={(r) => r.booking_id} caption="Payments to check" /> : <Empty title="No payment is waiting to be checked" />}
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
  // The same thing happening eight times is one piece of news, not eight: identical alerts are shown
  // once, with how many times it happened and when it last did. Marking that one as read marks them all.
  const groups: { key: string; rows: AlertRow[] }[] = [];
  for (const a of rows) {
    const key = `${a.title}\u0000${a.body}`;
    const g = groups.find((x) => x.key === key);
    if (g) g.rows.push(a);
    else groups.push({ key, rows: [a] });
  }
  return (
    <ul className="alert-list">
      {groups.map(({ key, rows: same }) => {
        const a = same[0];
        const link = alertLink(a, can, canApprove);
        const unread = same.filter((x) => !x.read_at);
        return (
          <li key={key} className={`alert-item${a.read_at ? "" : " alert-unread"}`}>
            <div className="alert-main">
              <p className="alert-title">
                {!a.read_at && <span className="unread-tag">New</span>}
                {a.title}
                {same.length > 1 && <span className="alert-count">{fmtNumber(same.length)} times</span>}
              </p>
              <p className="alert-body">{sentenceCase(plainText(a.body))}</p>
              <p className="meta">{same.length > 1 ? `Last at ${fmtDateTime(a.created_at)}` : fmtDateTime(a.created_at)}</p>
            </div>
            <div className="alert-actions">
              {link && (
                <Link to={link.to} className="btn btn-secondary btn-sm">
                  <span>{link.label}</span>
                </Link>
              )}
              {unread.length > 0 && (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => onRead(unread.map((x) => x.id), a.is_alarm ? "Alarm marked as read." : "Alert marked as read.")}>
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
  // An empty alarms card at the top of every morning is noise: it appears only when there is something in it.
  if (!load.loading && !load.error && rows.length === 0) return null;

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
  // Nothing to say is not worth a card: an empty alerts box at the foot of every screen is furniture.
  if (!loading && !error && !alerts.length) return null;

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


