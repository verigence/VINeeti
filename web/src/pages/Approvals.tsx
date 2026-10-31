import { useState } from "react";
import { api } from "../api";
import { ConfirmDialog } from "../components/Dialog";
import { Async, Button, Card, DataTable, Empty, PageHeader, Segments, type Column } from "../components/ui";
import { fmtDate, fmtMobile, fmtMoney } from "../format";
import { useAction, useLoad } from "../hooks";
import { allocationMessage, plainText } from "../labels";
import { Link } from "../router";
import { useSession } from "../session";
import type { BookingListRow } from "../types";
import { ExceptionItem } from "./Exceptions";

export function ApprovalsPage() {
  const { can } = useSession();
  return (
    <>
      <PageHeader title="Approvals" subtitle="Bookings and special requests waiting for a decision. You cannot decide something you created or raised yourself." />
      {can("booking.approve") && <BookingApprovals />}
      {(can("exception.decide") || can("release.decide") || can("exception.request")) && <ExceptionApprovals />}
    </>
  );
}

function BookingApprovals() {
  const load = useLoad(() => api.bookings({ status: "SUBMITTED" }), "approvals:bookings");
  const action = useAction();
  const [target, setTarget] = useState<{ booking: BookingListRow; decision: "approve" | "reject" } | null>(null);

  const decide = async (remarks: string) => {
    if (!target) return;
    const { booking, decision } = target;
    const res =
      decision === "approve"
        ? await action.run(() => api.approveBooking(booking.id, remarks), { quiet: true, success: (r) => `Booking ${booking.booking_no} approved. ${allocationMessage(r.allocations) || "It is now waiting for a car."}` })
        : await action.run(() => api.rejectBooking(booking.id, remarks), { quiet: true, success: `Booking ${booking.booking_no} rejected.` });
    if (res) {
      setTarget(null);
      await load.reload();
    }
  };

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
      header: "Customer",
      cell: (b) => (
        <>
          <span>{b.customer_name}</span>
          <span className="sub">{fmtMobile(b.customer_mobile)}</span>
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
    { header: "Amount", num: true, cell: (b) => fmtMoney(b.booking_amount) },
    { header: "Sales consultant", cell: (b) => b.sales_exec ?? b.sc_name ?? <span className="muted">—</span>, hideIfEmpty: (b) => !(b.sales_exec ?? b.sc_name) },
    {
      header: "Decision",
      actions: true,
      cell: (b) => (
        <span className="row-actions">
          <Link to={`/bookings/${b.id}`} className="btn btn-ghost btn-sm">
            <span>Open booking</span>
          </Link>
          <Button size="sm" variant="primary" onClick={() => setTarget({ booking: b, decision: "approve" })}>
            Approve
          </Button>
          <Button size="sm" variant="danger" onClick={() => setTarget({ booking: b, decision: "reject" })}>
            Reject
          </Button>
        </span>
      ),
    },
  ];

  return (
    <Card title="Bookings waiting for approval" flush>
      <Async load={load} empty={<Empty title="No bookings are waiting for approval" />}>
        {(rows) => <DataTable columns={columns} rows={rows} rowKey={(b) => b.id} caption="Bookings waiting for approval" />}
      </Async>
      {target && (
        <ConfirmDialog
          title={`${target.decision === "approve" ? "Approve" : "Reject"} booking ${target.booking.booking_no}?`}
          message={
            <>
              <p>
                {target.booking.customer_name} · {target.booking.model} {target.booking.variant}, {target.booking.colour} · {fmtMoney(target.booking.booking_amount)}
              </p>
              <p className="muted">
                {target.decision === "approve"
                  ? "The booking joins the queue. If a matching car is free, it is allocated straight away and the customer is messaged."
                  : "The booking goes back to the person who created it, who can correct it and submit it again."}
              </p>
            </>
          }
          confirmLabel={target.decision === "approve" ? "Approve booking" : "Reject booking"}
          danger={target.decision === "reject"}
          reason={target.decision === "approve" ? "optional" : "required"}
          reasonLabel={target.decision === "approve" ? "Remarks" : "Reason for rejecting"}
          busy={action.busy}
          error={plainText(action.error) || null}
          onCancel={() => {
            action.clearError();
            setTarget(null);
          }}
          onConfirm={(remarks) => void decide(remarks)}
        />
      )}
    </Card>
  );
}

function ExceptionApprovals() {
  const { can } = useSession();
  const [view, setView] = useState<"PENDING" | "DECIDED">("PENDING");
  const load = useLoad(() => api.exceptions(), "approvals:exceptions");
  const all = load.data ?? [];
  const pending = all.filter((e) => e.status === "PENDING");
  const decided = all.filter((e) => e.status !== "PENDING");
  const rows = view === "PENDING" ? pending : decided;

  return (
    <Card
      title="Special requests"
      note={can("exception.decide") ? "Approving a request applies the change immediately. Requests from another billing centre are shown here, for that centre\u2019s own GM to decide." : "Requests you have raised."}
      actions={
        <Segments
          label="Which requests"
          value={view}
          onChange={setView}
          options={[
            { value: "PENDING", label: "Pending", count: pending.length },
            { value: "DECIDED", label: "Decided", count: decided.length },
          ]}
        />
      }
    >
      <Async load={load} isEmpty={() => rows.length === 0} empty={<Empty title={view === "PENDING" ? "No requests are waiting for a decision" : "No requests have been decided yet"} />}>
        {() => (
          <ul className="request-list">
            {rows.map((e) => (
              <ExceptionItem key={e.id} e={e} showBooking onChanged={() => void load.reload()} />
            ))}
          </ul>
        )}
      </Async>
    </Card>
  );
}
