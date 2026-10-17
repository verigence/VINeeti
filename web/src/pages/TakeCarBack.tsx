// Taking a car back from the customer who holds it.
//
// This is the only way a named car reaches a named booking: allocation by hand is closed, because
// pairing a free car with a booking of someone's choosing is what the queue is for. What can still
// be done is taking a car off the customer holding it and saying what becomes of it — which names a
// loser as well as a winner, and so goes to an approver with its reason and its evidence.
//
// The reasons and what each one demands come from the server, not from here, so this form cannot
// drift from the rule it is collecting for.

import { useMemo, useState } from "react";
import { api } from "../api";
import { Dialog } from "../components/Dialog";
import { Async, Button, Card, Chip, DataTable, Empty, Field, Filter, Notice, PageHeader, RadioGroup, type Column } from "../components/ui";
import { addDays, fmtDate, fmtDateTime, today } from "../format";
import { useAction, useLoad } from "../hooks";
import { plainText } from "../labels";
import { Link } from "../router";
import { useSession } from "../session";
import type { BookingListRow, HeldCar } from "../types";

export function TakeCarBackPage() {
  const { can } = useSession();
  const [search, setSearch] = useState("");
  const [asked, setAsked] = useState("");
  const [target, setTarget] = useState<HeldCar | null>(null);
  const load = useLoad(() => (asked.trim() ? api.heldCars(asked) : Promise.resolve([] as HeldCar[])), `held:${asked}`);

  const columns: Column<HeldCar>[] = [
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
      header: "Car",
      cell: (r) => (
        <span>
          <span>
            {r.model} {r.variant}
          </span>
          <span className="sub">
            {r.colour} · <span className="mono">{r.vin}</span>
          </span>
        </span>
      ),
    },
    { header: "Outlet", cell: (r) => r.outlet },
    { header: "Held since", cell: (r) => fmtDateTime(r.allocated_at) },
    {
      header: "",
      actions: true,
      cell: (r) =>
        r.pending_request_id ? (
          // Somebody has already asked. A second request would leave an approver holding two, only
          // one of which can be true.
          <Chip tone="amber">Already asked, waiting for approval</Chip>
        ) : (
          <Button size="sm" variant="danger" onClick={() => setTarget(r)}>
            Take it back
          </Button>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Take a car back"
        subtitle="Find the car by whatever you have in front of you, then say why it is being taken off the customer. An approver decides; nothing moves until they do."
      />
      <div className="filterbar">
        <div className="filterbar-top">
          <Filter label="Find a held car" grow>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setAsked(search.trim());
              }}
            >
              <input
                type="search"
                inputMode="search"
                enterKeyHint="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Booking number, customer, model, trim, colour, VIN or chassis"
              />
            </form>
          </Filter>
          <Button onClick={() => setAsked(search.trim())}>Search</Button>
        </div>
      </div>

      {!asked.trim() ? (
        <Card flush>
          <Empty title="Search for the car you mean." hint="A chassis read off a printed form works too — punctuation and spacing are ignored." />
        </Card>
      ) : (
        <Async load={load} isEmpty={(rows) => rows.length === 0} empty={<Empty title="No car standing in a customer's name matches that." />}>
          {(rows) => (
            <Card title={`Held cars (${rows.length})`} note="Only cars a customer currently holds appear here. A free car is allocated by the queue, not by hand." flush>
              <DataTable columns={columns} rows={rows} rowKey={(r) => r.booking_id} caption="Held cars" />
            </Card>
          )}
        </Async>
      )}

      {target && can("exception.request") && (
        <TakeBackDialog
          car={target}
          onClose={() => setTarget(null)}
          onDone={() => {
            setTarget(null);
            void load.reload();
          }}
        />
      )}
    </>
  );
}

/** The form. Which fields appear is decided by the reason, and the reason list comes from the server. */
function TakeBackDialog({ car, onClose, onDone }: { car: HeldCar; onClose: () => void; onDone: () => void }) {
  const action = useAction();
  const reasons = useLoad(() => api.releaseReasons(), "release-reasons");
  const [code, setCode] = useState("");
  const [reason, setReason] = useState("");
  const [ref, setRef] = useState("");
  const [until, setUntil] = useState("");
  const [documentId, setDocumentId] = useState("");
  const [pick, setPick] = useState("");
  const [chosen, setChosen] = useState<BookingListRow | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const tomorrow = addDays(today(), 1);

  const spec = useMemo(() => (reasons.data ?? []).find((r) => r.code === code) ?? null, [reasons.data, code]);

  const submit = async () => {
    if (!spec) return setProblem("Say why the car is being taken off this customer.");
    const payload: Record<string, unknown> = { release_reason: spec.code };
    if (spec.evidence === "reference") {
      if (!ref.trim()) return setProblem(`${spec.evidenceLabel} is needed.`);
      payload.cancellation_ref = ref.trim();
    }
    if (spec.evidence === "booking") {
      if (!chosen) return setProblem("Choose the booking that is to receive the car.");
      payload.to_booking_id = chosen.id;
    }
    if (spec.evidence === "document") {
      if (!documentId.trim()) return setProblem("Attach the customer's own email or letter.");
      payload.document_id = documentId.trim();
    }
    // Both of these need a date, for different reasons: one is the customer's own, one is how long
    // the booking stands down so the car is genuinely free.
    if (spec.evidence === "document" || spec.code === "MANAGEMENT_PRIORITY") {
      if (!until) return setProblem("Give the date.");
      if (until <= today()) return setProblem("The date must be in the future.");
      payload.until = until;
    }
    if (!reason.trim()) return setProblem("Give the justification. The approver decides on this.");
    setProblem(null);
    const res = await action.run(() => api.requestException({ type: "RELEASE_ALLOCATION", booking_id: car.booking_id, payload, reason: reason.trim() }), {
      quiet: true,
      success: "Sent for approval. The customer keeps the car until it is approved.",
    });
    if (res) onDone();
  };

  return (
    <Dialog
      title={`Take ${car.vin} back from booking ${car.booking_no}`}
      wide
      onClose={() => !action.busy && onClose()}
      onSubmit={submit}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={action.busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={submit} busy={action.busy}>
            Send for approval
          </Button>
        </>
      }
    >
      <p className="muted">
        {car.customer_name} is holding {car.model} {car.variant} in {car.colour}. Nothing happens to it until an approver agrees.
      </p>

      <Async load={reasons} isEmpty={() => false}>
        {(list) => (
          <RadioGroup
            legend="Why is the car being taken back?"
            value={code}
            onChange={(v) => {
              setCode(v);
              setProblem(null);
            }}
            options={list.map((r) => ({ value: r.code, label: r.label, help: r.hint }))}
            disabled={action.busy}
          />
        )}
      </Async>

      {spec?.evidence === "reference" && (
        <Field label={spec.evidenceLabel} hint={spec.evidenceHint}>
          <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="CAN27A000123" disabled={action.busy} />
        </Field>
      )}

      {spec?.evidence === "booking" && (
        <ReceivingBooking car={car} query={pick} onQuery={setPick} chosen={chosen} onChoose={setChosen} hint={spec.evidenceHint} busy={action.busy} />
      )}

      {spec?.evidence === "document" && (
        <Field label={spec.evidenceLabel} hint={spec.evidenceHint}>
          <input value={documentId} onChange={(e) => setDocumentId(e.target.value)} placeholder="Reference of the uploaded email or letter" disabled={action.busy} />
        </Field>
      )}

      {(spec?.evidence === "document" || spec?.code === "MANAGEMENT_PRIORITY") && (
        <Field
          label={spec.code === "MANAGEMENT_PRIORITY" ? "This booking stands down until" : "The customer wants delivery from"}
          hint={
            spec.code === "MANAGEMENT_PRIORITY"
              ? "Without a date the queue hands the car straight back to this booking and nothing changes."
              : "Inside a fortnight the customer keeps the car and their payment window moves with it. Further out, the car is freed and they keep their place in the queue."
          }
        >
          <input type="date" min={tomorrow} value={until} onChange={(e) => setUntil(e.target.value)} disabled={action.busy} />
        </Field>
      )}

      {spec && (
        <Field label="Justification" hint="The approver decides on this, and it is kept whether they agree or not." wide>
          <textarea rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} disabled={action.busy} />
        </Field>
      )}

      {spec?.code === "MANAGEMENT_PRIORITY" && (
        <Notice tone="warn">
          This is the one reason with nothing to attach, so it is counted and reported by who asked for it. If the car is going to a particular customer, say so instead — that choice shows the approver
          how many people are being stepped over.
        </Notice>
      )}

      {problem && <Notice tone="error">{problem}</Notice>}
      {action.error && <Notice tone="error">{plainText(action.error)}</Notice>}
    </Dialog>
  );
}

/**
 * The booking that is to receive the car. Only bookings waiting for this exact car can take it, so
 * the search is narrowed to them rather than offering every booking and refusing later.
 */
function ReceivingBooking({
  car,
  query,
  onQuery,
  chosen,
  onChoose,
  hint,
  busy,
}: {
  car: HeldCar;
  query: string;
  onQuery: (v: string) => void;
  chosen: BookingListRow | null;
  onChoose: (b: BookingListRow | null) => void;
  hint: string;
  busy?: boolean;
}) {
  const found = useLoad(
    () => (query.trim().length < 2 ? Promise.resolve([] as BookingListRow[]) : api.bookings({ view: "waiting", model: car.model, q: query.trim() })),
    `receiving:${car.model}:${query.trim()}`,
  );
  const eligible = (found.data ?? []).filter((b) => b.id !== car.booking_id && b.variant === car.variant && b.colour === car.colour);

  // The list of candidates sits outside the Field rather than inside it. A label wraps one control:
  // put buttons inside it and the browser forwards their clicks to the labelled input, so choosing
  // never registers.
  if (chosen) {
    return (
      <div className="field field-wide">
        <span className="field-label">Booking that receives the car</span>
        <div className="row-actions">
          <span>
            <span className="strong">{chosen.booking_no}</span>
            <span className="sub">
              {chosen.customer_name} · booked {fmtDate(chosen.booking_date)}
            </span>
          </span>
          <Button size="sm" variant="ghost" onClick={() => onChoose(null)} disabled={busy}>
            Change
          </Button>
        </div>
        <span className="hint">The approver is shown how many earlier bookings this steps over.</span>
      </div>
    );
  }

  return (
    <div className="field field-wide">
      <Field label="Booking that receives the car" hint={hint}>
        <input value={query} onChange={(e) => onQuery(e.target.value)} placeholder="Booking number or customer name" disabled={busy} />
      </Field>
      {query.trim().length >= 2 && (
        <Async load={found} isEmpty={() => eligible.length === 0} empty={<Empty title={`No booking waiting for a ${car.colour} ${car.model} ${car.variant} matches that.`} />}>
          {() => (
            <ul className="request-list">
              {eligible.slice(0, 8).map((b) => (
                <li key={b.id} className="request">
                  <div className="request-head">
                    <span>
                      <span className="strong">{b.booking_no}</span>
                      <span className="sub">
                        {b.customer_name} · booked {fmtDate(b.booking_date)}
                      </span>
                    </span>
                    <Button size="sm" onClick={() => onChoose(b)} disabled={busy}>
                      Choose
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Async>
      )}
    </div>
  );
}
