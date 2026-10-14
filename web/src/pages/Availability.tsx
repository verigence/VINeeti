// Stock check: the customer asks for a car, this says what can be promised — and, when it cannot be
// promised, what else is actually there. Its own screen, because it is the job, not a panel beside one.

import { useState } from "react";
import { api } from "../api";
import { catalogEmpty, configInput, configReady, ConfigSelects, EMPTY_CONFIG, useCatalog, type CarConfig } from "../components/ConfigPicker";
import { Async, Button, Card, Chip, DataTable, Empty, Field, Loading, Notice, Select, Stat } from "../components/ui";
import { fmtDate, fmtNumber, plural } from "../format";
import { useAction, useLoad } from "../hooks";
import { plainText, vehicleStatus } from "../labels";
import { useSession } from "../session";
import type { Alternative, Availability, AvailabilityAnswer } from "../types";

/** The four answers, in the dealership's words. */
const ANSWERS: Record<AvailabilityAnswer, { text: string; tone: "green" | "blue" | "amber" | "red" }> = {
  AVAILABLE_NOW: { text: "In the yard, free", tone: "green" },
  IN_TRANSIT: { text: "Coming, with a date", tone: "blue" },
  INVOICED_NOT_DISPATCHED: { text: "In transit, date not firm", tone: "amber" },
  NEEDS_ORDER: { text: "Needs a new order", tone: "red" },
};

export function AvailabilityCheck({ compact }: { compact?: boolean }) {
  const { myOutlets } = useSession();
  const catalog = useCatalog();
  const action = useAction();
  const [config, setConfig] = useState<CarConfig>(EMPTY_CONFIG);
  const [outletId, setOutletId] = useState(myOutlets.length === 1 ? myOutlets[0].id : "");
  const [result, setResult] = useState<Availability | null>(null);
  const ready = configReady(config);

  const check = async () => {
    if (!ready) return;
    const data = await action.run(() => api.availability({ ...configInput(config), outlet_id: outletId || undefined }), { quiet: true });
    if (data) setResult(data);
  };

  return (
    <div className={compact ? "answer-stack" : "split"}>
      <Card title="Which car is the customer asking for?" note="Pick the model, variant and colour. The answer is written so you can read it out.">
        <form
          className="form-stack"
          onSubmit={(e) => {
            e.preventDefault();
            void check();
          }}
        >
          <Async load={catalog} isEmpty={catalogEmpty} empty={<Empty title="No cars to pick from yet" hint="The lists fill up once the DMS files are loaded." />}>
            {(cat) => (
              <>
                <ConfigSelects
                  catalog={cat}
                  value={config}
                  onChange={(c) => {
                    setConfig(c);
                    setResult(null);
                  }}
                />
                <Field label="Customer's outlet" optional hint="Used to say whether the car is at the same outlet.">
                  <Select value={outletId} onChange={setOutletId} options={myOutlets.map((o) => ({ value: o.id, label: o.name }))} placeholder="Any outlet" />
                </Field>
                {action.error && <Notice tone="error">{plainText(action.error)}</Notice>}
                <div className="form-actions">
                  <Button type="submit" variant="primary" busy={action.busy} disabled={!ready} icon="search">
                    Show the answer
                  </Button>
                </div>
              </>
            )}
          </Async>
        </form>
      </Card>

      <div aria-live="polite">
        {result ? (
          <>
            <AvailabilityAnswerCard r={result} />
            {/* When the car asked for cannot be given today, what else is actually there. */}
            {result.answer !== "AVAILABLE_NOW" && <WhatElse want={{ model: result.model, variant: result.variant, colour: result.colour }} outletId={outletId} />}
          </>
        ) : compact ? null : (
          <Card>
            <Empty title="The answer appears here" hint="It is written so you can read it out to the customer." />
          </Card>
        )}
      </div>
    </div>
  );
}

function AvailabilityAnswerCard({ r }: { r: Availability }) {
  const car = r.car;
  const a = ANSWERS[r.answer];
  let detail: string;
  if (r.answer === "AVAILABLE_NOW") {
    detail = car ? (car.same_outlet === false ? `A free car is in the yard at ${car.outlet}. It needs a transfer to the customer's outlet.` : `A free car is in the yard at ${car.outlet}.`) : "A free car is in the yard.";
  } else if (r.answer === "IN_TRANSIT") {
    detail = car?.expected_arrival_date
      ? car.arrival_overdue
        ? `A free car is on its way to ${car.outlet}. It was expected on ${fmtDate(car.expected_arrival_date)} and has not been received yet, so check before promising a date.`
        : `A free car is on its way to ${car.outlet}, expected by ${fmtDate(car.expected_arrival_date)}.`
      : "A free car is on its way.";
  } else if (r.answer === "INVOICED_NOT_DISPATCHED") {
    detail = `A free car has been invoiced by the manufacturer${car ? ` for ${car.outlet}` : ""} and is in transit.`;
  } else {
    detail =
      r.on_order > 0
        ? `No free car is in the yard or in transit. ${plural(r.on_order, "car is", "cars are")} on order with the manufacturer${r.order_expected_date ? `, expected by ${fmtDate(r.order_expected_date)}` : ""}.`
        : "No free car is in the yard or in transit, and none is on order.";
  }
  const ahead = r.waiting_bookings;

  return (
    <Card className={`answer answer-${a.tone}`}>
      <p className="answer-car">
        {r.model} {r.variant}, {r.colour}
      </p>
      <p className="answer-headline">{a.text}</p>
      <p className="answer-detail">{detail}</p>
      {r.answer === "INVOICED_NOT_DISPATCHED" && (
        <p className="answer-detail">
          {car?.indicative_arrival_date ? (
            <>
              Arrival around <strong>{fmtDate(car.indicative_arrival_date)}</strong> <Chip tone="amber">Indicative</Chip>
              <span className="hint">Worked out from the manufacturer's invoice date and the usual transit time. It is not a confirmed date.</span>
            </>
          ) : (
            "No arrival date is known."
          )}
        </p>
      )}
      <p className="answer-queue">
        A new booking would be <strong>number {r.queue_position_for_new_booking}</strong> in the queue for this car. {ahead ? `${plural(ahead, "booking is", "bookings are")} ahead.` : "No booking is ahead."}
      </p>
      <div className="tiles tiles-compact">
        <Stat label="Free in yard" value={fmtNumber(r.free_in_yard)} />
        <Stat label="Reserved in yard" value={fmtNumber(r.committed_in_yard)} />
        <Stat label="Free in transit" value={fmtNumber(r.free_in_transit)} />
        <Stat label="Reserved in transit" value={fmtNumber(r.committed_in_transit)} />
      </div>
      <p className="hint">Reserved cars are held for other bookings and are not offered.</p>
      {r.free_cars.length > 0 && (
        <>
          <h3 className="section-title">Free cars</h3>
          <DataTable
            columns={[
              { header: "Chassis", primary: true, cell: (c) => <span className="mono">{c.vin}</span> },
              { header: "Outlet", cell: (c) => c.outlet },
              { header: "Where", status: true, cell: (c) => <Chip tone={vehicleStatus(c.status).tone}>{vehicleStatus(c.status).text}</Chip> },
              {
                header: "Arrival",
                hideIfEmpty: (c) => c.status !== "IN_TRANSIT",
                cell: (c) => (c.status !== "IN_TRANSIT" ? "—" : c.expected_arrival_date ? fmtDate(c.expected_arrival_date) : c.indicative_arrival_date ? `${fmtDate(c.indicative_arrival_date)} (indicative)` : "No date known"),
              },
            ]}
            rows={r.free_cars}
            rowKey={(c) => c.vin}
            caption="Free cars of this model, variant and colour"
          />
          {ahead > 0 && <p className="hint">The first {Math.min(ahead, r.free_cars.length)} of these go to bookings already waiting.</p>}
        </>
      )}
      <p className="answer-source">
        {r.source.stock_as_on ? `Stock as on ${fmtDate(r.source.stock_as_on)}` : "No stock report loaded"} · {r.source.bookings_as_on ? `bookings as on ${fmtDate(r.source.bookings_as_on)}` : "no booking sheet loaded"}
        {r.source.stale ? " · out of date" : ""}
      </p>
    </Card>
  );
}


/**
 * What else can be offered when the car asked for cannot be given today. Every card here is a real car
 * in the stock report that is spare after everyone already waiting for it, with what is different about
 * it spelled out so the consultant can say it rather than work it out.
 */
function WhatElse({ want, outletId }: { want: { model: string; variant: string; colour: string }; outletId: string }) {
  const load = useLoad(() => api.alternatives({ ...want, outlet_id: outletId || undefined }), `alt:${want.model}|${want.variant}|${want.colour}|${outletId}`);
  const d = load.data ?? null;
  if (load.loading) return <Card title="What else can I offer?"><Loading label="Looking at what is free" /></Card>;
  if (!d) return null;
  if (!d.can_give_now.length && !d.on_the_way.length) {
    return (
      <Card title="What else can I offer?">
        <Empty title="Nothing else is free to offer" hint="Every other car in stock is either held for a customer already waiting, or is a different kind of vehicle. The ordering desk can say what is on order." />
      </Card>
    );
  }
  return (
    <Card title="What else can I offer?" note="Closest to what the customer asked for, first. Nothing here is reserved.">
      {d.can_give_now.length > 0 && (
        <>
          <h3 className="section-title">Can be given now</h3>
          <ul className="alts">
            {d.can_give_now.map((a) => (
              <AltCard key={`${a.model}|${a.variant}|${a.colour}`} a={a} />
            ))}
          </ul>
        </>
      )}
      {d.on_the_way.length > 0 && (
        <>
          <h3 className="section-title">On the way</h3>
          <ul className="alts">
            {d.on_the_way.map((a) => (
              <AltCard key={`${a.model}|${a.variant}|${a.colour}`} a={a} />
            ))}
          </ul>
        </>
      )}
      <details className="chart-basis">
        <summary>How these were chosen</summary>
        <p>{d.basis}</p>
      </details>
    </Card>
  );
}

function AltCard({ a }: { a: Alternative }) {
  const spare = a.spare_in_yard + a.spare_in_transit;
  return (
    <li className="alt">
      <p className="alt-car">
        {a.model} <span className="alt-variant">{a.variant}</span>
      </p>
      <p className="alt-colour">{a.colour}</p>
      <ul className="alt-differs">
        {a.differs.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
      <p className="alt-have">
        {a.spare_in_yard > 0 ? (
          <Chip tone="green">{plural(a.spare_in_yard, "car")} free in the yard</Chip>
        ) : (
          <Chip tone="blue">
            {plural(a.spare_in_transit, "car")} on the way
            {a.soonest_arrival ? `, ${a.soonest_indicative ? "around" : "expected"} ${fmtDate(a.soonest_arrival)}` : ", no date yet"}
          </Chip>
        )}
        {a.soonest_indicative && <Chip tone="amber">Indicative</Chip>}
      </p>
      <p className="alt-where">
        {a.outlets.map((o) => `${o.outlet} (${o.cars})`).join(" · ")}
        {a.waiting > 0 ? ` · ${plural(a.waiting, "customer is", "customers are")} already waiting for this one, and ${spare === 1 ? "this is the one" : `these ${spare} are the ones`} left over` : ""}
      </p>
    </li>
  );
}
