// Payment against a booking that holds a car: sales reports it, Finance verifies it (or finds that it
// has not come in). Only Finance's verification stops the payment window. Used on the booking page and
// on the Payments screen.

import { useState } from "react";
import { api } from "../api";
import { ConfirmDialog, Dialog } from "../components/Dialog";
import { Button, Field, Notice } from "../components/ui";
import { useAction } from "../hooks";
import { paymentStateOf, plainText } from "../labels";
import { useSession } from "../session";

export interface PaymentTarget {
  id: string;
  booking_no: string;
  customer_name: string;
  payment_reported_at: string | null;
  payment_received_at: string | null;
  payment_amount: number | null;
  payment_ref: string | null;
  payment_note: string | null;
}

/** The payment buttons this person may use on this booking, with their dialogs. Renders nothing when there is none. */
export function PaymentButtons({ booking: b, onDone, size = "md", primary }: { booking: PaymentTarget; onDone: () => void; size?: "md" | "sm"; primary?: boolean }) {
  const { can } = useSession();
  const [dialog, setDialog] = useState<"report" | "verify" | "reject" | null>(null);
  const action = useAction();
  const state = paymentStateOf(b);
  const mayReport = can("booking.payment_report") && state === "AWAITING_PAYMENT";
  const mayVerify = can("booking.payment") && state !== "VERIFIED";
  const mayReject = can("booking.payment") && state === "TO_VERIFY";
  if (!mayReport && !mayVerify && !mayReject) return null;
  const done = () => {
    setDialog(null);
    onDone();
  };

  return (
    <>
      {mayVerify && (
        <Button size={size} variant={primary ? "primary" : "secondary"} onClick={() => setDialog("verify")}>
          Verify as received
        </Button>
      )}
      {mayReject && (
        <Button size={size} variant="danger" onClick={() => setDialog("reject")}>
          Not received
        </Button>
      )}
      {mayReport && (
        <Button size={size} variant={primary && !mayVerify ? "primary" : "secondary"} onClick={() => setDialog("report")}>
          Report payment
        </Button>
      )}
      {dialog === "report" && <PaymentDialog mode="report" booking={b} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === "verify" && <PaymentDialog mode="verify" booking={b} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === "reject" && (
        <ConfirmDialog
          title={`Payment not received for booking ${b.booking_no}?`}
          message={`The reported payment${b.payment_ref ? ` (reference ${b.payment_ref})` : ""} is cleared and the person who reported it is told. The payment window carries on from where it was.`}
          confirmLabel="Not received"
          danger
          reason="required"
          reasonLabel="Note"
          reasonHint="Say what was checked and not found."
          busy={action.busy}
          error={plainText(action.error) || null}
          onCancel={() => {
            action.clearError();
            setDialog(null);
          }}
          onConfirm={async (note) => {
            const res = await action.run(() => api.paymentNotReceived(b.id, note), { quiet: true, success: `Booking ${b.booking_no}: recorded as not received.` });
            if (res) done();
          }}
        />
      )}
    </>
  );
}

function PaymentDialog({ mode, booking: b, onClose, onDone }: { mode: "report" | "verify"; booking: PaymentTarget; onClose: () => void; onDone: () => void }) {
  const action = useAction();
  const verify = mode === "verify";
  const [amount, setAmount] = useState(verify && b.payment_amount ? String(b.payment_amount) : "");
  const [reference, setReference] = useState(verify ? b.payment_ref ?? "" : "");
  const [note, setNote] = useState(verify ? b.payment_note ?? "" : "");
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async () => {
    if (!reference.trim()) return setProblem("Enter the payment reference (UTR, receipt or cheque number).");
    if (amount.trim() !== "" && !(Number(amount) > 0)) return setProblem("The amount is not a valid number.");
    setProblem(null);
    const body = { amount: amount.trim() === "" ? null : Number(amount), reference: reference.trim(), note: note.trim() };
    const res = verify
      ? await action.run(() => api.verifyPayment(b.id, body), { quiet: true, success: `Booking ${b.booking_no}: payment verified. The car stays with this customer.` })
      : await action.run(() => api.reportPayment(b.id, body), { quiet: true, success: `Booking ${b.booking_no}: payment reported. Finance has been told to verify it.` });
    if (res) onDone();
  };

  return (
    <Dialog
      title={verify ? `Verify payment for booking ${b.booking_no}` : `Report payment for booking ${b.booking_no}`}
      onClose={() => !action.busy && onClose()}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button onClick={onClose} disabled={action.busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={action.busy}>
            {verify ? "Verify as received" : "Report payment"}
          </Button>
        </>
      }
    >
      <div className="form-stack">
        <p className="muted">
          {b.customer_name}.{" "}
          {verify
            ? "Confirm only when the payment has reached the dealership. This stops the reminder, the escalation and the re-allocation of the car."
            : "Finance checks the payment against this reference. The car is not re-allocated while Finance checks; the payment window stops only when Finance verifies."}
        </p>
        <Field label="Payment reference" hint="UTR, receipt or cheque number.">
          <input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={80} autoComplete="off" />
        </Field>
        <Field label="Amount (₹)" optional>
          <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} inputMode="decimal" autoComplete="off" />
        </Field>
        <Field label="Note" optional>
          <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
        </Field>
        {(problem || action.error) && <Notice tone="error">{problem ?? plainText(action.error)}</Notice>}
      </div>
    </Dialog>
  );
}
