// Sections of the booking page: the checklist, the allocated car, the payment, messages and timeline.

import { useState } from "react";
import { api } from "../api";
import { Dialog } from "../components/Dialog";
import { Icon } from "../components/icons";
import { Button, Card, Check, Chip, Empty, Field, KeyValues, Notice, StatusChip } from "../components/ui";
import { fmtDate, fmtDateTime, fmtMobile, fmtMoney, today } from "../format";
import { useAction } from "../hooks";
import { actorName, allocationRule, allocationType, auditSentence, paymentState, paymentStateOf, plainText, releaseReason, vehicleStatus, waEvent, waStatus } from "../labels";
import { Link } from "../router";
import { useSession } from "../session";
import type { Booking, BookingDetail, ChecklistKey, PaymentWindow } from "../types";

// ---------------------------------------------------------------- booking checklist (step 3: four ticks, nothing is uploaded)
export function ChecklistCard({ d, reload }: { d: BookingDetail; reload: () => Promise<void> }) {
  const { can } = useSession();
  const action = useAction();
  const b = d.booking;
  if (!d.checklist.length) return null;
  const open = ["DRAFT", "REJECTED"].includes(b.status);
  const editable = open && can("booking.create");

  // A tick shows at once and is then confirmed by the server; if the server refuses, it goes back.
  const [pending, setPending] = useState<Partial<Record<ChecklistKey, boolean>>>({});
  const tick = async (key: ChecklistKey, on: boolean) => {
    setPending((p) => ({ ...p, [key]: on }));
    await action.run(() => api.setChecklist(b.id, { [key]: on }), { quiet: true });
    await reload();
    setPending((p) => {
      const next = { ...p };
      delete next[key];
      return next;
    });
  };

  return (
    <Card title="Checklist" note="Tick each item once it is on file at the dealership. Nothing is uploaded here.">
      {open &&
        (d.checklist_missing.length ? (
          <Notice tone="warn">Tick every item before the booking can be submitted.</Notice>
        ) : (
          <Notice tone="ok">Every item is confirmed. The booking can be submitted.</Notice>
        ))}
      <ul className="tick-list">
        {d.checklist.map((item) => (
          <li key={item.key}>
            <Check checked={pending[item.key] ?? item.ticked} onChange={(on) => void tick(item.key, on)} disabled={!editable || item.key in pending} hint={item.ticked && item.by ? `Confirmed by ${item.by}${item.at ? `, ${fmtDateTime(item.at)}` : ""}` : undefined}>
              {item.label}
            </Check>
          </li>
        ))}
      </ul>
      {action.error && <Notice tone="error">{plainText(action.error)}</Notice>}
      {!open && <p className="hint">The checklist can only be changed before the booking is submitted.</p>}
    </Card>
  );
}

// ---------------------------------------------------------------- allocated car
export function AllocationCard({ d }: { d: BookingDetail }) {
  const { can } = useSession();
  const a = d.allocation;
  const b = d.booking;
  if (!a) return null;
  const where =
    a.vehicle_status === "IN_TRANSIT"
      ? `In transit to ${a.vehicle_outlet}${a.expected_arrival_date ? `, expected by ${fmtDate(a.expected_arrival_date)}` : ", no arrival date known"}`
      : a.vehicle_status === "RECEIVED"
        ? `In the yard at ${a.vehicle_outlet}`
        : `${vehicleStatus(a.vehicle_status).text}, ${a.vehicle_outlet}`;
  const rule = allocationRule(a.rule_trace?.rule);

  return (
    <Card title="Car reserved">
      <div className="chips chips-row">
        <Chip tone="teal">{a.source === "DMS" ? "Allotted in DMS" : allocationType(a.type)}</Chip>
        <StatusChip label={vehicleStatus(a.vehicle_status)} />
        {a.needs_transfer ? <Chip tone="amber">Transfer needed</Chip> : null}
      </div>
      <KeyValues
        items={[
          ["Chassis (VIN)", can("stock.view") ? <Link to={`/stock/cars/${a.vehicle_id}`} className="mono">{a.vin}</Link> : <span className="mono">{a.vin}</span>],
          ["Where the car is", where],
          a.needs_transfer ? ["Transfer", `The car has to be moved to ${b.outlet ?? "the customer's outlet"} before delivery.`] : null,
          ["Allocated on", fmtDateTime(a.allocated_at)],
          rule ? ["Why this car", `${rule}${a.rule_trace?.queue_position ? ` (queue position ${a.rule_trace.queue_position})` : ""}`] : null,
        ]}
      />
    </Card>
  );
}

// ---------------------------------------------------------------- payment (bookings that hold a car)
export function PaymentCard({ d }: { d: BookingDetail }) {
  const b = d.booking;
  const a = d.allocation;
  if (b.status !== "ALLOCATED") return null;
  const state = paymentStateOf(b);
  return (
    <Card title="Payment">
      <div className="chips chips-row">
        <StatusChip label={paymentState(state)} />
      </div>
      {state === "AWAITING_PAYMENT" && <p className="muted">No payment has been reported for this booking yet.</p>}
      {state !== "AWAITING_PAYMENT" && (
        <KeyValues
          items={[
            ["Reported by", b.payment_reported_at ? `${b.payment_reported_by_name ?? "—"}, ${fmtDateTime(b.payment_reported_at)}` : null],
            ["Amount", b.payment_amount === null ? null : fmtMoney(b.payment_amount)],
            ["Reference", b.payment_ref],
            b.payment_note ? ["Note", b.payment_note] : null,
            state === "VERIFIED" ? ["Verified by", `${b.payment_verified_by_name ?? "—"}, ${fmtDateTime(b.payment_received_at)}`] : null,
          ]}
        />
      )}
      {state === "VERIFIED" ? (
        <Notice tone="ok">Finance has verified the payment. The car stays with this booking.</Notice>
      ) : a?.window ? (
        <>
          <h3 className="section-title">Payment window</h3>
          {a.window.held_for_finance && <Notice>The car will not be re-allocated while Finance checks the reported payment.</Notice>}
          <WindowTimeline w={a.window} extension={a.window_extension_days} />
        </>
      ) : (
        <p className="muted">The payment window starts on the day the car reaches the dealership. Until then there is no deadline.</p>
      )}
    </Card>
  );
}

function WindowTimeline({ w, extension }: { w: PaymentWindow; extension: number }) {
  const day = today();
  const steps = [
    { title: "Reminder to the customer", date: w.reminder_on, done: w.stage !== "OPEN", doneText: "Sent" },
    { title: "Escalation", date: w.escalation_on, done: w.stage === "ESCALATED", doneText: "Raised" },
    { title: "Car re-allocated to the next customer", date: w.release_on, done: false, doneText: "" },
  ];
  const nextIndex = steps.findIndex((s) => !s.done);
  return (
    <>
      <p>
        <strong>Day {w.day}</strong> since the car reached the dealership. The payment is not verified yet.
        {extension > 0 ? ` Includes ${extension} extra day${extension === 1 ? "" : "s"} approved by request.` : ""}
      </p>
      <ol className="steps">
        {steps.map((s, i) => {
          const passed = s.done || s.date < day;
          const state = s.done ? s.doneText : s.date < day ? "Overdue" : s.date === day ? "Due today" : "Upcoming";
          return (
            <li key={s.title} className={`step${passed ? " step-passed" : ""}${i === nextIndex ? " step-next" : ""}`}>
              <span className="step-marker" aria-hidden="true">
                {s.done ? <Icon name="check" size={14} /> : i + 1}
              </span>
              <span className="step-title">{s.title}</span>
              <span className="step-date">{fmtDate(s.date)}</span>
              <span className="step-state">{state}</span>
            </li>
          );
        })}
      </ol>
    </>
  );
}

export function EarlierAllocations({ d }: { d: BookingDetail }) {
  if (!d.allocation_history.length) return null;
  return (
    <Card title="Cars held earlier">
      <ul className="plain-list">
        {d.allocation_history.map((h) => (
          <li key={h.id}>
            <span className="mono">{h.vin}</span> ({allocationType(h.type).toLowerCase()}), allocated {fmtDate(h.allocated_at)}
            {h.released_at ? `, released ${fmtDate(h.released_at)} because ${releaseReason(h.release_reason)}` : h.status === "FULFILLED" ? ", delivered" : ""}.
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ---------------------------------------------------------------- customer contact (mobile number and WhatsApp consent)
export function ContactDialog({ booking: b, onClose, onDone }: { booking: Booking; onClose: () => void; onDone: () => void }) {
  const action = useAction();
  const { me } = useSession();
  const wa = me.settings.whatsapp_enabled;
  const [mobile, setMobile] = useState(b.customer_mobile.replace(/^91(?=\d{10}$)/, ""));
  const [optIn, setOptIn] = useState(Boolean(b.wa_opt_in));
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async () => {
    if (mobile.replace(/\D/g, "").length < 10) return setProblem("Enter the customer's 10-digit mobile number.");
    setProblem(null);
    const res = await action.run(() => api.setContact(b.id, { customer_mobile: mobile.trim(), wa_opt_in: optIn }), { quiet: true, success: (r) => (r.changed ? "Customer contact saved." : "Nothing was changed.") });
    if (res) onDone();
  };

  return (
    <Dialog
      title={`Customer contact for booking ${b.booking_no}`}
      onClose={() => !action.busy && onClose()}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button onClick={onClose} disabled={action.busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={action.busy}>
            Save
          </Button>
        </>
      }
    >
      <div className="form-stack">
        <Field label="Customer mobile number" hint={wa ? "10 digits. Messages about the car go to this number." : "10 digits."}>
          <input value={mobile} onChange={(e) => setMobile(e.target.value)} type="tel" inputMode="numeric" autoComplete="off" maxLength={16} />
        </Field>
        {wa && (
          <Check checked={optIn} onChange={setOptIn} hint="When unticked, no WhatsApp message is sent for this booking.">
            The customer agrees to receive WhatsApp messages about this booking
          </Check>
        )}
        {(problem || action.error) && <Notice tone="error">{problem ?? plainText(action.error)}</Notice>}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- WhatsApp messages for this booking
export function MessagesCard({ d }: { d: BookingDetail }) {
  return (
    <Card title="WhatsApp messages">
      {d.messages.length ? (
        <ul className="msg-list">
          {d.messages.map((m) => (
            <li key={m.id} className="msg">
              <div className="msg-head">
                <span className="strong">{waEvent(m.event_key)}</span>
                <StatusChip label={waStatus(m.status)} />
              </div>
              <p className="bubble">{m.rendered_text}</p>
              <p className="meta">
                To {fmtMobile(m.to_mobile)} · {fmtDateTime(m.created_at)}
                {m.provider === "TEST" && m.status !== "SKIPPED" ? " · test mode, not actually sent" : ""}
                {m.read_at ? ` · read ${fmtDateTime(m.read_at)}` : m.delivered_at ? ` · delivered ${fmtDateTime(m.delivered_at)}` : ""}
              </p>
              {m.error && <p className="msg-error">{plainText(m.error)}</p>}
            </li>
          ))}
        </ul>
      ) : (
        <Empty title="No messages yet" hint={!d.booking.customer_mobile ? "No mobile number is recorded for this customer, so no message can be sent." : d.booking.wa_opt_in ? "The customer is messaged when a car is allocated, when it arrives, and if payment is late." : "The customer has not agreed to WhatsApp messages, so none will be sent."} />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- timeline (audit trail of this booking)
export function TimelineCard({ d }: { d: BookingDetail }) {
  const { outletName, roleLabel } = useSession();
  return (
    <Card title="Timeline" className="detail-side">
      {d.timeline.length ? (
        <ol className="timeline">
          {d.timeline.map((t, i) => (
            <li key={i}>
              <p>{auditSentence(t.action, t.detail, outletName, roleLabel)}</p>
              <p className="meta">
                {fmtDateTime(t.at)} · {actorName(t.actor)}
              </p>
            </li>
          ))}
        </ol>
      ) : (
        <Empty title="Nothing recorded yet" />
      )}
    </Card>
  );
}
