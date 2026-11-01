import { useState, type FormEvent } from "react";
import { api } from "../api";
import { configInput, configReady, ConfigSelects, useCatalog, type CarConfig } from "../components/ConfigPicker";
import { ActionBar, Async, Button, Card, Check, Field, KeyValues, LinkButton, Notice, PageHeader, Select } from "../components/ui";
import { fmtMoney, localDate, today } from "../format";
import { useAction, useLoad } from "../hooks";
import { plainText } from "../labels";
import { useRouter } from "../router";
import { useSession } from "../session";
import type { Booking } from "../types";

/** New booking, or editing one that is still a draft (or was rejected). */
export function BookingFormPage({ id }: { id?: string }) {
  if (!id) {
    return (
      <>
        <PageHeader back={{ to: "/bookings", label: "Bookings" }} title="New booking" subtitle="Saved as a draft. Tick the checklist next, then submit it for approval." />
        <BookingForm />
      </>
    );
  }
  return <EditBooking id={id} />;
}

function EditBooking({ id }: { id: string }) {
  const load = useLoad(() => api.booking(id), `booking-edit:${id}`);
  return (
    <Async load={load} isEmpty={() => false} loadingLabel="Loading booking">
      {(d) => (
        <>
          <PageHeader back={{ to: `/bookings/${id}`, label: `Booking ${d.booking.booking_no}` }} title={`Edit booking ${d.booking.booking_no}`} />
          {["DRAFT", "REJECTED"].includes(d.booking.status) ? (
            <BookingForm booking={d.booking} />
          ) : (
            <Notice tone="warn">
              This booking has been submitted, so it can no longer be edited here. Raise a request from the booking page to change it.
            </Notice>
          )}
        </>
      )}
    </Async>
  );
}

function BookingForm({ booking }: { booking?: Booking }) {
  const { me, myOutlets } = useSession();
  const { navigate } = useRouter();
  const catalog = useCatalog();
  const directory = useLoad(() => api.directory(), "directory");
  const action = useAction();
  const editing = Boolean(booking);

  const [outletId, setOutletId] = useState(booking?.outlet_id ?? (myOutlets.length === 1 ? myOutlets[0].id : ""));
  const [name, setName] = useState(booking?.customer_name ?? "");
  const [mobile, setMobile] = useState(booking ? booking.customer_mobile.replace(/^91(?=\d{10}$)/, "") : "");
  const [optIn, setOptIn] = useState(booking ? Boolean(booking.wa_opt_in) : true);
  const [config, setConfig] = useState<CarConfig>({ variant_id: booking?.variant_id ?? "", model: booking?.model ?? "", variant: booking?.variant ?? "", colour: booking?.colour ?? "" });
  const bookedOn = booking ? localDate(booking.booking_date) : "";
  const [bookingDate, setBookingDate] = useState(bookedOn);
  const [amount, setAmount] = useState(booking ? String(booking.booking_amount) : "");
  const [delivery, setDelivery] = useState(booking?.expected_delivery_date ?? "");
  const [salesExec, setSalesExec] = useState(booking?.sales_exec_id ?? (me.user.role === "SALES_CONSULTANT" ? me.user.id : ""));
  const [bookingNo, setBookingNo] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const execs = (directory.data ?? []).filter((u) => u.role === "SALES_CONSULTANT");
  const outletOptions = myOutlets.map((o) => ({ value: o.id, label: o.name }));
  // A booking may sit at an outlet that has since been closed or that the user no longer works in.
  if (booking && !outletOptions.some((o) => o.value === booking.outlet_id)) outletOptions.unshift({ value: booking.outlet_id, label: booking.outlet ?? "Current outlet" });
  const min = me.settings.min_booking_amount;
  const wa = me.settings.whatsapp_enabled;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (action.busy) return;
    if (!outletId) return setProblem("Choose the outlet.");
    if (!name.trim()) return setProblem("Enter the customer's name.");
    if (mobile.replace(/\D/g, "").length < 10) return setProblem("Enter the customer's 10-digit mobile number.");
    if (!configReady(config)) return setProblem("Choose the model, variant and colour.");
    if (bookingDate && bookingDate > today()) return setProblem("The booking date cannot be in the future.");
    const amt = amount.trim() === "" ? 0 : Number(amount);
    if (!Number.isFinite(amt) || amt < 0) return setProblem("The booking amount is not a valid number.");
    setProblem(null);

    const common = {
      outlet_id: outletId,
      customer_name: name.trim(),
      customer_mobile: mobile.trim(),
      wa_opt_in: optIn,
      ...configInput(config),
      booking_amount: amt,
      expected_delivery_date: delivery || null,
      // The booking date decides the place in the queue. Left as it is unless a different day is chosen.
      ...(bookingDate && bookingDate !== bookedOn ? { booking_date: bookingDate } : {}),
    };
    const saved = await action.run(
      () => (booking ? api.updateBooking(booking.id, { ...common, sales_exec_id: salesExec || null }) : api.createBooking({ ...common, sales_exec_id: salesExec || null, booking_no: bookingNo.trim() || undefined })),
      { quiet: true, success: (b) => (booking ? `Booking ${b.booking_no} saved.` : `Booking ${b.booking_no} created as a draft. Tick the checklist next.`) },
    );
    if (saved) navigate(`/bookings/${saved.id}`);
  };

  return (
    <form onSubmit={submit} noValidate className="form-page">
      <Card title="Customer">
        <div className="form-grid">
          <Field label="Customer name">
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" autoCapitalize="words" maxLength={120} />
          </Field>
          <Field label="Mobile number" hint={wa ? "10 digits. Messages about the car go to this number." : "10 digits."}>
            <input value={mobile} onChange={(e) => setMobile(e.target.value)} type="tel" inputMode="numeric" autoComplete="off" maxLength={16} />
          </Field>
          {wa && (
            <div className="field-wide">
              <Check checked={optIn} onChange={setOptIn} hint="Untick only if the customer has said they do not want WhatsApp messages. No allocation or reminder messages will be sent.">
                The customer agrees to receive WhatsApp messages about this booking
              </Check>
            </div>
          )}
        </div>
      </Card>

      <Card title="Car" note="Picked from the vehicle master, so the booking matches stock exactly.">
        <div className="form-grid form-grid-3">{catalog.data ? <ConfigSelects catalog={catalog.data} value={config} onChange={setConfig} /> : <p className="muted field-wide">{catalog.error ?? "Loading the vehicle master…"}</p>}</div>
      </Card>

      <Card title="Booking">
        <div className="form-grid">
          <Field label="Outlet">
            <Select value={outletId} onChange={setOutletId} options={outletOptions} placeholder="Choose an outlet" />
          </Field>
          <Field label="Booking amount (₹)" hint={min > 0 ? `The minimum to submit a booking is ${fmtMoney(min)}.` : undefined}>
            <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} inputMode="decimal" autoComplete="off" placeholder="0" />
          </Field>
          <Field label="Booking date" optional hint="Leave blank for today. The place in the queue follows this date.">
            <input type="date" value={bookingDate} onChange={(e) => setBookingDate(e.target.value)} max={today()} />
          </Field>
          <Field label="Expected delivery date" optional hint="The date committed to the customer.">
            <input type="date" value={delivery} onChange={(e) => setDelivery(e.target.value)} min={today()} />
          </Field>
          <Field label="Sales executive" hint={directory.error ? "The list of sales executives could not be loaded." : undefined}>
            <Select value={salesExec} onChange={setSalesExec} options={execs.map((u) => ({ value: u.id, label: u.name }))} placeholder="Not assigned" />
          </Field>
          {editing ? (
            <div>
              <KeyValues items={[["Booking number", booking?.booking_no]]} />
              <p className="hint">The booking number is fixed once the booking is created.</p>
            </div>
          ) : (
            <Field label="Booking number" optional hint="The DMS booking number, if known. Leave blank to have one generated.">
              <input value={bookingNo} onChange={(e) => setBookingNo(e.target.value.toUpperCase())} autoComplete="off" maxLength={40} />
            </Field>
          )}
        </div>
      </Card>

      {(problem || action.error) && <Notice tone="error">{problem ?? plainText(action.error)}</Notice>}
      <ActionBar>
        <Button type="submit" variant="primary" busy={action.busy}>
          {editing ? "Save changes" : "Save as draft"}
        </Button>
        <LinkButton to={booking ? `/bookings/${booking.id}` : "/bookings"} variant="ghost">
          Cancel
        </LinkButton>
      </ActionBar>
    </form>
  );
}
