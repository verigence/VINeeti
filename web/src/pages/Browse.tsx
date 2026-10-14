// "What have we got?" — the yard browsed the way a shop is browsed, in the shape every shop uses:
// the filters down one side, the cars down the other, and the count of what is left at the top. Each
// pane scrolls on its own, so narrowing a search never pushes the results off the screen and reading
// the results never loses the filters.
//
// Every number is of real cars in the latest stock report. A choice that would leave nothing is still
// listed, with zero beside it, because "we have none in that colour" is an answer too. Nothing here
// reserves anything: a car is matched to a booking by the rules, never by a person choosing one.

import { useMemo, useState } from "react";
import { api } from "../api";
import { Chip, Empty, ErrorBox, Loading } from "../components/ui";
import { fmtDate, fmtNumber } from "../format";
import { useLoad } from "../hooks";
import { Link } from "../router";
import { useSession } from "../session";
import type { BrowseGroup, StockFacet } from "../types";

/** The questions, in the order a customer is asked them on the floor. */
const FACETS: { key: StockFacet; label: string }[] = [
  { key: "model", label: "Model" },
  { key: "trim_level", label: "Trim" },
  { key: "fuel", label: "Fuel" },
  { key: "transmission", label: "Transmission" },
  { key: "seater", label: "Seats" },
  { key: "drive", label: "Drive" },
  { key: "variant", label: "Variant" },
  { key: "colour", label: "Colour" },
  { key: "outlet", label: "Outlet" },
];

export function BrowseTab() {
  const { can } = useSession();
  const [pick, setPick] = useState<Partial<Record<StockFacet, string>>>({});
  const [show, setShow] = useState<"FREE" | "ALL">("FREE");
  const key = useMemo(() => JSON.stringify({ pick, show }), [pick, show]);
  const load = useLoad(() => api.browse({ ...pick, show }), `browse:${key}`);
  const d = load.data ?? null;

  const choose = (f: StockFacet, v: string) =>
    setPick((p) => {
      const next = { ...p };
      if (next[f] === v) delete next[f];
      else next[f] = v;
      // Choices do not cascade. Picking a colour leaves the outlet alone, and unpicking one puts its
      // cars back — the way every shop filter behaves. The one exception is the model: a trim, variant
      // or colour belongs to the model it was chosen under, so changing the model drops those three
      // rather than leaving a filter on screen that matches nothing.
      if (f === "model" && next.model !== p.model) for (const dependent of ["trim_level", "variant", "colour"] as const) delete next[dependent];
      return next;
    });

  const chosen = FACETS.filter((s) => pick[s.key]);

  return (
    <div className="finder">
      <div className="finder-head">
        <p className="finder-count">
          {d ? (
            <>
              <strong>{fmtNumber(d.total)}</strong> {d.total === 1 ? "car" : "cars"}
              {d.total > 0 && (
                <span className="finder-split">
                  {fmtNumber(d.in_yard)} in the yard · {fmtNumber(d.in_transit)} on the way
                </span>
              )}
            </>
          ) : (
            <span className="muted">Looking in the yard…</span>
          )}
        </p>
        <div className="finder-switch">
          <button type="button" className={show === "FREE" ? "on" : undefined} onClick={() => setShow("FREE")}>
            Free to offer
          </button>
          <button type="button" className={show === "ALL" ? "on" : undefined} onClick={() => setShow("ALL")}>
            Everything in stock
          </button>
        </div>
      </div>

      {chosen.length > 0 && (
        <div className="finder-chips">
          {chosen.map((s) => (
            <button key={s.key} type="button" className="picked-chip" onClick={() => choose(s.key, pick[s.key]!)}>
              <span className="picked-what">{s.label}</span>
              <span className="picked-value">{pick[s.key]}</span>
              <span aria-hidden="true">×</span>
              <span className="sr-only">Remove this choice</span>
            </button>
          ))}
          <button type="button" className="finder-clear" onClick={() => setPick({})}>
            Clear all
          </button>
        </div>
      )}

      <div className="finder-body">
        <aside className="finder-rail" aria-label="Narrow the search">
          {load.error && !d ? (
            <ErrorBox message={load.error} onRetry={() => void load.reload()} />
          ) : (
            FACETS.map((f) => {
              const options = d?.facets[f.key] ?? [];
              if (!options.length) return null;
              // A question the cars have already settled by themselves is not worth asking.
              if (options.length < 2 && !pick[f.key]) return null;
              return <RailGroup key={f.key} label={f.label} options={options} chosen={pick[f.key]} onChoose={(v) => choose(f.key, v)} />;
            })
          )}
        </aside>

        <div className="finder-results">
          {load.loading && !d ? (
            <Loading label="Looking in the yard" />
          ) : !d ? null : d.groups.length === 0 ? (
            <Empty title="Nothing matches that" hint="Remove one of the choices, or ask the ordering desk what is on order." />
          ) : (
            <ul className="finder-cars">
              {d.groups.map((g) => (
                <CarCard key={`${g.model}|${g.variant}|${g.colour}`} g={g} canBook={can("booking.create")} />
              ))}
            </ul>
          )}
        </div>
      </div>

      {d && (
        <p className="finder-foot">
          {d.basis} Stock as the last report has it{d.source.stock_as_on ? `, as on ${fmtDate(d.source.stock_as_on)}` : ""}.
          {d.source.stale ? " That report is out of date — load today's file before answering a customer." : ""}
        </p>
      )}
    </div>
  );
}

/** One model, variant and colour: how many there are, where they are, and when the next one lands. */
function CarCard({ g, canBook }: { g: BrowseGroup; canBook: boolean }) {
  const specs = [g.trim_level, g.fuel, g.transmission, g.seater && `${g.seater} seats`].filter(Boolean);
  const outlets = Object.entries(g.outlets).sort((a, b) => b[1] - a[1]);
  return (
    <li className="finder-car">
      <p className="finder-car-name">
        {g.model} <span className="finder-car-variant">{g.variant}</span>
      </p>
      <p className="finder-car-colour">{g.colour}</p>
      {specs.length > 0 && <p className="finder-car-specs">{specs.join(" · ")}</p>}
      <p className="finder-car-counts">
        {g.in_yard > 0 && <Chip tone="green">{fmtNumber(g.in_yard)} in the yard</Chip>}
        {g.in_transit > 0 && <Chip tone="blue">{fmtNumber(g.in_transit)} on the way</Chip>}
        {g.in_yard === 0 && g.soonest && (
          <span className="finder-car-eta">
            {g.soonest_indicative ? "around " : "expected "}
            {fmtDate(g.soonest)}
          </span>
        )}
      </p>
      <p className="finder-car-where">{outlets.map(([name, n]) => `${name} (${fmtNumber(n)})`).join(" · ")}</p>
      {canBook && (
        <Link to={`/bookings/new?model=${encodeURIComponent(g.model)}&variant=${encodeURIComponent(g.variant)}&colour=${encodeURIComponent(g.colour)}`} className="finder-car-book">
          Book this for a customer
        </Link>
      )}
    </li>
  );
}


/**
 * One question in the rail. Only the first few choices are shown: a dealership with sixteen models
 * would otherwise push every other question — fuel, gearbox, colour — off the bottom of the rail, and
 * the whole point of the rail is that every question is in view at once. The rest are one press away,
 * and a choice already made is always shown whether or not it is in the first few.
 */
function RailGroup({ label, options, chosen, onChoose }: { label: string; options: { value: string; cars: number }[]; chosen?: string; onChoose: (v: string) => void }) {
  const [all, setAll] = useState(false);
  const FEW = 6;
  const shown = all || options.length <= FEW + 1 ? options : [...options.slice(0, FEW), ...(chosen && !options.slice(0, FEW).some((o) => o.value === chosen) ? options.filter((o) => o.value === chosen) : [])];
  return (
    <section className="rail-group">
      <h3>{label}</h3>
      <ul>
        {shown.map((o) => {
          const on = chosen === o.value;
          return (
            <li key={o.value}>
              <button type="button" className={`rail-option${on ? " on" : ""}`} onClick={() => onChoose(o.value)} aria-pressed={on}>
                <span className="rail-name">{o.value}</span>
                <span className="rail-n">{fmtNumber(o.cars)}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {options.length > FEW + 1 && (
        <button type="button" className="rail-more" onClick={() => setAll((x) => !x)}>
          {all ? "Show fewer" : `Show all ${options.length}`}
        </button>
      )}
    </section>
  );
}
