// Special requests: the list item, the approve / reject dialog and the "Raise a request" form.
// Used on the booking page and on the Approvals screen.

import { useState } from "react";
import { api } from "../api";
import { ConfirmDialog, Dialog } from "../components/Dialog";
import { Button, Field, Loading, Notice, RadioGroup, Select, StatusChip } from "../components/ui";
import { addDays, fmtDate, fmtDateTime, today, zonedToIso } from "../format";
import { useAction, useLoad } from "../hooks";
import { EXCEPTION_HELP, exceptionDetail, exceptionStatus, exceptionType, plainText } from "../labels";
import { Link } from "../router";
import { useSession } from "../session";
import type { Booking, ExceptionInput, ExceptionRow, ExceptionType } from "../types";

export function ExceptionItem({ e, showBooking, onChanged }: { e: ExceptionRow; showBooking?: boolean; onChanged: () => void }) {
  const { can, outletName, me } = useSession();
  const [decision, setDecision] = useState<"approve" | "reject" | null>(null);
  const detail = exceptionDetail(e, outletName);
  const payload = e.payload ?? {};
  const own = e.requested_by === me.user.id;

  return (
    <li className="request">
      <div className="request-head">
        <span className="strong">{exceptionType(e.type)}</span>
        <StatusChip label={exceptionStatus(e.status)} />
      </div>
      {showBooking && e.booking_no && (
        <p>
          {/* A request from another billing centre is readable here, but its booking is not this
              person's to open, so the number is shown plainly rather than as a dead link. */}
          Booking {e.can_decide === false ? <span className="strong">{e.booking_no}</span> : <Link to={`/bookings/${e.booking_id}`}>{e.booking_no}</Link>} · {e.customer_name} · {e.model} {e.variant}, {e.colour}
          {e.outlet ? ` · ${e.outlet}` : ""}
        </p>
      )}
      {detail && (
        <p>
          {detail}
          {e.type === "PRIORITY_CHANGE" && payload.before_booking_id ? (
            <>
              {" "}
              <Link to={`/bookings/${String(payload.before_booking_id)}`}>Open that booking</Link>
            </>
          ) : null}
          {e.type === "MANUAL_ALLOCATION" && e.vehicle_id && can("stock.view") ? (
            <>
              {" "}
              <Link to={`/stock/cars/${e.vehicle_id}`}>Open the car</Link>
            </>
          ) : null}
        </p>
      )}
      <p>
        <span className="muted">Reason: </span>
        {e.reason}
      </p>
      <p className="meta">
        Raised by {e.requested_by_name ?? "a former user"} on {fmtDateTime(e.requested_at)}
        {e.decided_at ? ` · ${e.status === "APPROVED" ? "Approved" : "Rejected"} by ${e.decided_by_name ?? "a former user"} on ${fmtDateTime(e.decided_at)}` : ""}
      </p>
      {e.decision_remarks && (
        <p>
          <span className="muted">Approver's remarks: </span>
          {e.decision_remarks}
        </p>
      )}
      {/* Taking a car back answers to its own, narrower list of approvers, so the buttons follow the
          type rather than one blanket permission. */}
      {e.status === "PENDING" && e.can_decide === false && can(e.type === "RELEASE_ALLOCATION" ? "release.decide" : "exception.decide") && (
        <p className="hint">{e.outlet ? `This is ${e.outlet}'s request: its own GM decides it.` : "This request belongs to another billing centre, whose own GM decides it."}</p>
      )}
      {e.status === "PENDING" && e.can_decide !== false && can(e.type === "RELEASE_ALLOCATION" ? "release.decide" : "exception.decide") && (
        <div className="request-actions">
          <Button size="sm" variant="primary" onClick={() => setDecision("approve")}>
            Approve
          </Button>
          <Button size="sm" variant="danger" onClick={() => setDecision("reject")}>
            Reject
          </Button>
          {own && <span className="hint">You raised this request, so another approver has to decide it.</span>}
        </div>
      )}
      {decision && (
        <DecideExceptionDialog
          exception={e}
          decision={decision}
          onClose={() => setDecision(null)}
          onDone={() => {
            setDecision(null);
            onChanged();
          }}
        />
      )}
    </li>
  );
}

function DecideExceptionDialog({ exception: e, decision, onClose, onDone }: { exception: ExceptionRow; decision: "approve" | "reject"; onClose: () => void; onDone: () => void }) {
  const { outletName } = useSession();
  const action = useAction();
  const approve = decision === "approve";
  const what = exceptionType(e.type).toLowerCase();
  return (
    <ConfirmDialog
      title={approve ? `Approve this request (${what})?` : `Reject this request (${what})?`}
      message={
        <>
          <p>{exceptionDetail(e, outletName) || e.reason}</p>
          <p className="muted">{approve ? "Approving applies the change straight away and is recorded against your name." : "The booking stays as it is. The person who raised the request sees your reason."}</p>
        </>
      }
      confirmLabel={approve ? "Approve request" : "Reject request"}
      danger={!approve}
      reason={approve ? "optional" : "required"}
      reasonLabel={approve ? "Remarks" : "Reason for rejecting"}
      busy={action.busy}
      error={plainText(action.error)}
      onCancel={onClose}
      onConfirm={async (remarks) => {
        const res = await action.run(() => api.decideException(e.id, decision, remarks), { quiet: true, success: approve ? "Request approved and applied." : "Request rejected." });
        if (res) onDone();
      }}
    />
  );
}

type RaiseBooking = Pick<Booking, "id" | "booking_no" | "status" | "model" | "variant" | "colour" | "outlet_id">;

export function RaiseRequestDialog({ booking, hasAllocation, onClose, onDone }: { booking: RaiseBooking; hasAllocation: boolean; onClose: () => void; onDone: () => void }) {
  const action = useAction();
  const types: ExceptionType[] = ["PRIORITY_CHANGE", "SKIP_ALLOCATION", "DEFER_DELIVERY", "OUTLET_CHANGE"];
  if (hasAllocation) types.push("WINDOW_EXTENSION");
  types.push("OTHER");

  const [type, setType] = useState<ExceptionType | "">("");
  const [reason, setReason] = useState("");
  const [priorityMode, setPriorityMode] = useState<"before" | "date">("before");
  const [beforeId, setBeforeId] = useState("");
  const [priorityDate, setPriorityDate] = useState("");
  const [priorityTime, setPriorityTime] = useState("09:00");
  const [until, setUntil] = useState("");
  const [outletId, setOutletId] = useState("");
  const [days, setDays] = useState("2");
  const [problem, setProblem] = useState<string | null>(null);
  const tomorrow = addDays(today(), 1);

  const submit = async () => {
    if (!type) return setProblem("Choose what you are asking for.");
    const input: ExceptionInput = { type, booking_id: booking.id, reason: reason.trim(), payload: {} };
    if (type === "PRIORITY_CHANGE") {
      if (priorityMode === "before") {
        if (!beforeId) return setProblem("Choose the booking to move ahead of.");
        input.payload = { before_booking_id: beforeId };
      } else {
        if (!priorityDate) return setProblem("Enter the new priority date.");
        input.payload = { new_priority_ts: zonedToIso(priorityDate, priorityTime || "00:00") };
      }
    } else if (type === "SKIP_ALLOCATION") {
      if (until && until <= today()) return setProblem("The date must be in the future.");
      input.payload = until ? { until } : {};
    } else if (type === "DEFER_DELIVERY") {
      if (!until) return setProblem("Enter the date the customer wants delivery from.");
      if (until <= today()) return setProblem("The date must be in the future.");
      input.payload = { until };
    } else if (type === "OUTLET_CHANGE") {
      if (!outletId) return setProblem("Choose the outlet to move the booking to.");
      input.payload = { outlet_id: outletId };
    } else if (type === "WINDOW_EXTENSION") {
      const n = Number(days);
      if (!Number.isInteger(n) || n < 1 || n > 30) return setProblem("The extension must be a whole number of days between 1 and 30.");
      input.payload = { days: n };
    }
    if (!input.reason) return setProblem("Give the reason. The approver decides on this.");
    setProblem(null);
    const res = await action.run(() => api.requestException(input), { quiet: true, success: "Request sent for approval." });
    if (res) onDone();
  };

  return (
    <Dialog
      title={`Raise a request on booking ${booking.booking_no}`}
      wide
      onClose={() => !action.busy && onClose()}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button onClick={onClose} disabled={action.busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={action.busy}>
            Send for approval
          </Button>
        </>
      }
    >
      <div className="form-stack">
        <Field label="What are you asking for?" hint={type ? EXCEPTION_HELP[type] : "Anything outside the normal queue order needs an approver's decision."}>
          <Select
            value={type}
            onChange={(v) => {
              setType(v as ExceptionType | "");
              setProblem(null);
              setUntil("");
            }}
            options={types.map((t) => ({ value: t, label: exceptionType(t) }))}
            placeholder="Choose a request type"
          />
        </Field>

        {type === "PRIORITY_CHANGE" && (
          <>
            <RadioGroup
              legend="How should the priority change?"
              value={priorityMode}
              onChange={setPriorityMode}
              options={[
                { value: "before", label: "Move ahead of another booking for the same car" },
                { value: "date", label: "Set a new priority date", help: "Bookings are served in order of this date. An earlier date moves the booking up." },
              ]}
            />
            {priorityMode === "before" ? (
              <WaitingBookingPicker booking={booking} value={beforeId} onChange={setBeforeId} />
            ) : (
              <div className="form-grid">
                <Field label="New priority date">
                  <input type="date" value={priorityDate} onChange={(e) => setPriorityDate(e.target.value)} max={today()} />
                </Field>
                <Field label="Time">
                  <input type="time" value={priorityTime} onChange={(e) => setPriorityTime(e.target.value)} />
                </Field>
              </div>
            )}
          </>
        )}

        {type === "SKIP_ALLOCATION" && (
          <Field label="Skip until" optional hint="Leave blank to keep the booking on hold until someone marks the customer as ready.">
            <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} min={tomorrow} />
          </Field>
        )}
        {type === "DEFER_DELIVERY" && (
          <Field label="Customer wants delivery from" hint="The booking is put on hold and rejoins the queue on this date. This also becomes the expected delivery date.">
            <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} min={tomorrow} />
          </Field>
        )}
        {type === "OUTLET_CHANGE" && <OutletPicker currentOutletId={booking.outlet_id} value={outletId} onChange={setOutletId} />}
        {type === "WINDOW_EXTENSION" && (
          <Field label="Extra days to pay" hint="Between 1 and 30. The reminder, escalation and re-allocation dates all move by this many days.">
            <input type="number" min={1} max={30} step={1} value={days} onChange={(e) => setDays(e.target.value)} inputMode="numeric" />
          </Field>
        )}

        <Field label="Reason" hint="Required. It is shown to the approver and kept on the booking's record.">
          <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </Field>
        {(problem || action.error) && <Notice tone="error">{problem ?? plainText(action.error)}</Notice>}
      </div>
    </Dialog>
  );
}

function WaitingBookingPicker({ booking, value, onChange }: { booking: RaiseBooking; value: string; onChange: (v: string) => void }) {
  // The queue for this car: booking numbers and dates only, so anyone who can see the booking can use it.
  const load = useLoad(() => api.bookingQueue(booking.id), `queue:${booking.id}`);
  if (load.loading) return <Loading label="Loading the queue" />;
  if (load.data === undefined) return <Notice tone="error">{load.error ?? "Could not load the queue."}</Notice>;
  const mine = load.data.find((q) => q.is_this_booking);
  const rows = load.data.filter((q) => !q.is_this_booking && (!mine || q.position < mine.position));
  if (!rows.length) {
    return <Notice tone="warn">{mine ? "This booking is already first in the queue for this model, variant and colour." : "No other booking is waiting for this model, variant and colour. Set a new priority date instead."}</Notice>;
  }
  return (
    <Field
      label="Move ahead of"
      hint={`${mine ? `This booking is no. ${mine.position} in the queue. ` : ""}It takes a place just before the one you choose. Cars already allocated to other customers are not taken away.`}
    >
      <Select value={value} onChange={onChange} placeholder="Choose a waiting booking" options={rows.map((q) => ({ value: q.id, label: `No. ${q.position}: ${q.booking_no} · booked ${fmtDate(q.booking_date)} · ${q.outlet}` }))} />
    </Field>
  );
}

function OutletPicker({ currentOutletId, value, onChange }: { currentOutletId: string; value: string; onChange: (v: string) => void }) {
  const load = useLoad(() => api.outlets(), "outlets");
  if (load.loading) return <Loading label="Loading outlets" />;
  if (load.data === undefined) return <Notice tone="error">{load.error ?? "Could not load the outlets."}</Notice>;
  const options = load.data.filter((o) => o.is_active && o.id !== currentOutletId).map((o) => ({ value: o.id, label: o.city && o.city !== o.name ? `${o.name} (${o.city})` : o.name }));
  if (!options.length) return <Notice tone="warn">There is no other active outlet to move this booking to.</Notice>;
  return (
    <Field label="Move the booking to">
      <Select value={value} onChange={onChange} options={options} placeholder="Choose an outlet" />
    </Field>
  );
}
