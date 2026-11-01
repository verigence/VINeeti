import { useState } from "react";
import { api } from "../api";
import { ConfirmDialog } from "../components/Dialog";
import { carItems } from "../components/CarSpec";
import { DataSource } from "../components/DataSource";
import { Async, Button, Card, Chip, Empty, KeyValues, LinkButton, Notice, PageHeader, StatusChip } from "../components/ui";
import { fmtDate, fmtDateTime, fmtMobile, fmtMoney } from "../format";
import { useAction, useLoad } from "../hooks";
import { allocationMessage, bookingSource, bookingStatus, holdReason, NO_CUSTOMER_DETAILS, paymentStateOf, plainText } from "../labels";
import { useSession } from "../session";
import type { BookingDetail } from "../types";
import { AllocationCard, ChecklistCard, ContactDialog, EarlierAllocations, MessagesCard, PaymentCard, TimelineCard } from "./BookingParts";
import { ExceptionItem, RaiseRequestDialog } from "./Exceptions";
import { PaymentButtons } from "./PaymentParts";

type DialogKind = "approve" | "reject" | "cancel" | "invoice" | "deliver" | "ready" | "request" | "contact" | null;

export function BookingDetailPage({ id }: { id: string }) {
  const load = useLoad(() => api.booking(id), `booking:${id}`);
  return (
    <Async load={load} isEmpty={() => false} loadingLabel="Loading booking">
      {(d) => <BookingView d={d} reload={load.reload} />}
    </Async>
  );
}

function BookingView({ d, reload }: { d: BookingDetail; reload: () => Promise<void> }) {
  const { can, me } = useSession();
  const action = useAction();
  const [dialog, setDialog] = useState<DialogKind>(null);
  const b = d.booking;
  const status = bookingStatus(b.status, b.on_hold);
  const editable = ["DRAFT", "REJECTED"].includes(b.status);
  const mine = b.created_by === me.user.id || b.sales_exec_id === me.user.id;
  const canCancel = ["DRAFT", "SUBMITTED", "APPROVED", "ALLOCATED", "REJECTED"].includes(b.status) && (can("booking.cancel") || (["DRAFT", "SUBMITTED", "REJECTED"].includes(b.status) && mine));
  const canRequest = can("exception.request") && ["SUBMITTED", "APPROVED", "ALLOCATED"].includes(b.status);
  const canContact = can("booking.contact") && !["CANCELLED", "DELIVERED"].includes(b.status);
  const carReceived = d.allocation?.vehicle_status === "RECEIVED";
  const checklistOpen = d.checklist_missing.length > 0;
  const fromStockOnly = b.source === "DMS_STOCK";
  const payment = b.status === "ALLOCATED" ? paymentStateOf(b) : null;
  const paymentTarget = { ...b, customer_name: b.customer_name };
  const mayPay = payment !== null && ((can("booking.payment_report") && payment === "AWAITING_PAYMENT") || (can("booking.payment") && payment !== "VERIFIED"));

  /** Runs an action from a dialog: the error stays in the dialog, success closes it and refreshes the page. */
  const run = async <R,>(fn: () => Promise<R>, success: string | ((r: R) => string)) => {
    const res = await action.run(fn, { quiet: dialog !== null, success });
    if (res !== undefined) {
      setDialog(null);
      await reload();
    }
  };
  const close = () => {
    action.clearError();
    setDialog(null);
  };
  const dialogProps = { busy: action.busy, error: plainText(action.error) || null, onCancel: close };

  // The step that moves the booking forward. On a phone these sit in the bar above the tabs.
  const stepButtons = (
    <>
      {editable && can("booking.create") && (
        <Button variant="primary" busy={action.busy && dialog === null} disabled={checklistOpen} title={checklistOpen ? "Tick every checklist item first" : undefined} onClick={() => void run(() => api.submitBooking(b.id), "Booking submitted for approval.")}>
          {checklistOpen ? "Submit (checklist incomplete)" : "Submit for approval"}
        </Button>
      )}
      {b.status === "SUBMITTED" && can("booking.approve") && (
        <>
          <Button variant="primary" disabled={action.busy} onClick={() => setDialog("approve")}>
            Approve
          </Button>
          <Button variant="danger" disabled={action.busy} onClick={() => setDialog("reject")}>
            Reject
          </Button>
        </>
      )}
      {b.status === "APPROVED" && b.on_hold && can("booking.ready") ? (
        <Button variant="primary" disabled={action.busy} onClick={() => setDialog("ready")}>
          Customer is ready
        </Button>
      ) : null}
      {mayPay && <PaymentButtons booking={paymentTarget} onDone={() => void reload()} primary />}
      {b.status === "ALLOCATED" && can("booking.payment") && payment === "VERIFIED" && (
        <Button variant="primary" disabled={action.busy || !carReceived} title={carReceived ? undefined : "The car has not reached the dealership yet"} onClick={() => setDialog("invoice")}>
          Invoice
        </Button>
      )}
      {b.status === "INVOICED" && can("booking.deliver") && (
        <Button variant="primary" disabled={action.busy} onClick={() => setDialog("deliver")}>
          Mark delivered
        </Button>
      )}
    </>
  );
  const hasStep =
    (editable && can("booking.create")) ||
    (b.status === "SUBMITTED" && can("booking.approve")) ||
    Boolean(b.status === "APPROVED" && b.on_hold && can("booking.ready")) ||
    mayPay ||
    (b.status === "ALLOCATED" && can("booking.payment") && payment === "VERIFIED") ||
    (b.status === "INVOICED" && can("booking.deliver"));
  const otherButtons = (
    <>
      {editable && can("booking.create") && <LinkButton to={`/bookings/${b.id}/edit`}>Edit</LinkButton>}
      {b.status === "ALLOCATED" && can("booking.payment") && payment !== "VERIFIED" && (
        <Button disabled={action.busy || !carReceived} title={carReceived ? undefined : "The car has not reached the dealership yet"} onClick={() => setDialog("invoice")}>
          Invoice
        </Button>
      )}
      {canContact && (
        <Button disabled={action.busy} onClick={() => setDialog("contact")}>
          Edit contact
        </Button>
      )}
      {canRequest && (
        <Button disabled={action.busy} onClick={() => setDialog("request")}>
          Raise a request
        </Button>
      )}
      {canCancel && (
        <Button variant="danger" disabled={action.busy} onClick={() => setDialog("cancel")}>
          Cancel booking
        </Button>
      )}
    </>
  );

  return (
    <>
      <PageHeader
        back={{ to: "/bookings", label: "Bookings" }}
        title={
          <span className="title-with-chip">
            Booking {b.booking_no} <StatusChip label={status} />
          </span>
        }
        subtitle={`${b.customer_name} · ${b.model} ${b.variant}, ${b.colour}`}
        primary={hasStep ? stepButtons : undefined}
        actions={(editable && can("booking.create")) || canRequest || canCancel || canContact || (b.status === "ALLOCATED" && can("booking.payment") && payment !== "VERIFIED") ? otherButtons : undefined}
      />
      <DataSource />

      {b.status === "REJECTED" && (
        <Notice tone="error" title="Rejected. ">
          {b.decision_remarks ?? "No reason was given."} {can("booking.create") ? "Correct the booking and submit it again." : ""}
        </Notice>
      )}
      {b.status === "CANCELLED" && (
        <Notice tone="error" title="Cancelled. ">
          {b.cancel_reason ?? ""} {b.cancelled_at ? `(${fmtDateTime(b.cancelled_at)})` : ""}
        </Notice>
      )}
      {b.status === "APPROVED" && b.on_hold ? (
        <Notice tone="warn" title="On hold. ">
          {holdReason(b.hold_reason)}. {b.hold_until ? `The booking rejoins the queue on ${fmtDate(b.hold_until)}.` : "The booking rejoins the queue when someone marks the customer as ready."} It keeps its original place.
        </Notice>
      ) : null}
      {d.queue && (
        <Notice title={`Number ${d.queue.position} in the queue. `}>
          {d.queue.waiting > 1 ? `${d.queue.waiting} bookings are waiting for this model, variant and colour.` : "This is the only booking waiting for this model, variant and colour."} A car is allocated automatically as soon as one is free.
        </Notice>
      )}
      {["DRAFT", "SUBMITTED"].includes(b.status) && (b.backdated_days ?? 0) > 0 && (
        <Notice tone="warn" title="Check the booking date. ">
          It is {fmtDate(b.booking_date)}, {b.backdated_days} day{b.backdated_days === 1 ? "" : "s"} before this booking was entered. The place in the queue follows the booking date.
        </Notice>
      )}
      {b.status === "SUBMITTED" && !can("booking.approve") && <Notice>Waiting for approval. It joins the queue for a car as soon as it is approved.</Notice>}
      {fromStockOnly && <Notice tone="warn">{NO_CUSTOMER_DETAILS}. This order is known only from the DMS stock report.</Notice>}

      <div className="detail-grid">
        <div className="detail-main">
          <Card title="Booking">
            <div className="chips chips-row">
              <Chip tone={bookingSource(b.source).tone}>{bookingSource(b.source).text}</Chip>
              {b.dms_stage ? <Chip tone="grey">DMS stage: {b.dms_stage}</Chip> : null}
            </div>
            <KeyValues
              columns={3}
              items={[
                ["Customer", b.customer_name],
                ["Mobile", b.customer_mobile ? fmtMobile(b.customer_mobile) : fromStockOnly ? NO_CUSTOMER_DETAILS : null],
                me.settings.whatsapp_enabled ? ["WhatsApp messages", b.wa_opt_in ? "Customer has agreed" : "Customer has not agreed"] : null,
                ...carItems(b),
                ["Outlet", b.outlet],
                ["Booked on", fmtDateTime(b.booking_date)],
                ["Booking amount", fmtMoney(b.booking_amount)],
                ["Expected delivery", b.expected_delivery_date ? fmtDate(b.expected_delivery_date) : "Not committed"],
                ["Sales consultant", b.sales_exec ?? b.sc_name ?? "Not assigned"],
                ["Entered by", b.created_by_name],
                b.priority_ts !== b.booking_date ? ["Queue priority date", fmtDateTime(b.priority_ts)] : null,
                b.submitted_at ? ["Submitted", fmtDateTime(b.submitted_at)] : null,
                b.approved_at && b.status !== "REJECTED" ? ["Approved", `${fmtDateTime(b.approved_at)}${b.approved_by_name ? ` by ${b.approved_by_name}` : ""}`] : null,
                b.approved_at && b.status !== "REJECTED" && b.decision_remarks ? ["Approver's remarks", b.decision_remarks] : null,
                b.payment_received_at && b.status !== "ALLOCATED" ? ["Payment verified", `${fmtDateTime(b.payment_received_at)}${b.payment_verified_by_name ? ` by ${b.payment_verified_by_name}` : ""}`] : null,
                b.invoiced_at ? ["Invoiced", fmtDateTime(b.invoiced_at)] : null,
                b.delivered_at ? ["Delivered", fmtDateTime(b.delivered_at)] : null,
              ]}
            />
          </Card>

          <ChecklistCard d={d} reload={reload} />
          <AllocationCard d={d} />
          <PaymentCard d={d} />

          <Card
            title="Special requests"
            note="Anything outside the normal queue order: priority, skipping, deferring, outlet change, manual allocation, more time to pay."
            actions={
              canRequest ? (
                <Button size="sm" onClick={() => setDialog("request")}>
                  Raise a request
                </Button>
              ) : undefined
            }
          >
            {d.exceptions.length ? (
              <ul className="request-list">
                {d.exceptions.map((e) => (
                  <ExceptionItem key={e.id} e={e} onChanged={() => void reload()} />
                ))}
              </ul>
            ) : (
              <Empty title="No requests on this booking" hint={editable ? "Requests can be raised once the booking has been submitted." : undefined} />
            )}
          </Card>

          {me.settings.whatsapp_enabled && <MessagesCard d={d} />}
          <EarlierAllocations d={d} />
        </div>
        <TimelineCard d={d} />
      </div>

      {dialog === "approve" && (
        <ConfirmDialog
          title={`Approve booking ${b.booking_no}?`}
          message={
            <>
              <p>
                {b.customer_name} · {b.model} {b.variant}, {b.colour} · {fmtMoney(b.booking_amount)}
              </p>
              <p className="muted">The booking joins the queue with its booking date as priority. If a matching car is free, it is allocated straight away and the customer is messaged.</p>
            </>
          }
          confirmLabel="Approve booking"
          reason="optional"
          reasonLabel="Remarks"
          {...dialogProps}
          onConfirm={(remarks) => void run(() => api.approveBooking(b.id, remarks), (r) => `Booking approved. ${allocationMessage(r.allocations) || "It is now waiting for a car."}`)}
        />
      )}
      {dialog === "reject" && (
        <ConfirmDialog
          title={`Reject booking ${b.booking_no}?`}
          message="The booking goes back to the person who created it, who can correct it and submit it again."
          confirmLabel="Reject booking"
          danger
          reason="required"
          reasonLabel="Reason for rejecting"
          {...dialogProps}
          onConfirm={(remarks) => void run(() => api.rejectBooking(b.id, remarks), "Booking rejected.")}
        />
      )}
      {dialog === "cancel" && (
        <ConfirmDialog
          title={`Cancel booking ${b.booking_no}?`}
          message={`This cannot be undone.${d.allocation ? ` Car ${d.allocation.vin} is released and goes to the next customer in the queue.` : ""}`}
          confirmLabel="Cancel booking"
          danger
          reason="required"
          reasonLabel="Reason for cancelling"
          {...dialogProps}
          onConfirm={(reason) => void run(() => api.cancelBooking(b.id, reason), (r) => `Booking cancelled. ${allocationMessage(r.allocations)}`.trim())}
        />
      )}
      {dialog === "invoice" && (
        <ConfirmDialog
          title={`Invoice car ${d.allocation?.vin ?? ""} to this booking?`}
          message={`The car is marked as invoiced to ${b.customer_name} and leaves free stock for good.${b.payment_received_at ? "" : " The payment is recorded as received at the same time."} This cannot be undone here.`}
          confirmLabel="Invoice"
          {...dialogProps}
          onConfirm={() => void run(() => api.invoiceBooking(b.id), "Booking invoiced.")}
        />
      )}
      {dialog === "deliver" && (
        <ConfirmDialog
          title="Mark the car as delivered?"
          message={`Confirm that the car has been handed over to ${b.customer_name}. This closes the booking and cannot be undone here.`}
          confirmLabel="Mark delivered"
          {...dialogProps}
          onConfirm={() => void run(() => api.deliverBooking(b.id), "Car delivered. Booking closed.")}
        />
      )}
      {dialog === "ready" && (
        <ConfirmDialog
          title="Is the customer ready to take delivery?"
          message="The hold is lifted and the booking returns to the queue at its original place. If a matching car is free it is allocated now."
          confirmLabel="Customer is ready"
          {...dialogProps}
          onConfirm={() => void run(() => api.markReady(b.id), (r) => `Hold lifted. ${allocationMessage(r.allocations) || "The booking is back in the queue."}`)}
        />
      )}
      {dialog === "contact" && (
        <ContactDialog
          booking={b}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            void reload();
          }}
        />
      )}
      {dialog === "request" && (
        <RaiseRequestDialog
          booking={b}
          hasAllocation={Boolean(d.allocation)}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            void reload();
          }}
        />
      )}
    </>
  );
}
