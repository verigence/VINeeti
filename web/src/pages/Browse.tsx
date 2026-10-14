// "What have we got?" — the yard, browsed the way a shop is browsed. Pick a model, then narrow by
// whatever the customer in front of you cares about: trim, transmission, fuel, seats, colour, outlet.
// Every choice carries the number of cars behind it, so nothing has to be tried to find out it is empty.
//
// Nothing on this screen reserves anything. It answers one question — what is standing there today —
// from the latest stock report, and says what it was worked out from.

import { useMemo, useState } from "react";
import { api } from "../api";
import { Button, Card, Chip, Empty, ErrorBox, Loading } from "../components/ui";
import { fmtDate, fmtNumber, plural } from "../format";
import { useLoad } from "../hooks";
import { Link } from "../router";
import { useSession } from "../session";
import type { BrowseGroup, StockFacet } from "../types";

/** The questions a customer is asked, in the order they are usually asked on the floor. */
const STEPS: { key: StockFacet; title: string; hint?: string }[] = [
  { key: "model", title: "Which model?" },
  { key: "trim_level", title: "Which trim?" },
  { key: "fuel", title: "Petrol or diesel?" },
  { key: "transmission", title: "Manual or automatic?" },
  { key: "seater", title: "How many seats?" },
  { key: "drive", title: "Two or four wheel drive?" },
  { key: "variant", title: "Which exact variant?" },
  { key: "colour", title: "Which colour?" },
  { key: "outlet", title: "At which outlet?" },
];
const WORD: Record<StockFacet, string> = {
  model: "Model",
  trim_level: "Trim",
  fuel: "Fuel",
  transmission: "Transmission",
  seater: "Seats",
  drive: "Drive",
  variant: "Variant",
  colour: "Colour",
  outlet: "Outlet",
};

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
      // A narrower choice made under an older one is dropped when that one changes, so the chips on
      // screen always describe a set of cars that exists.
      const order = STEPS.map((s) => s.key);
      if (next[f] !== p[f]) for (const later of order.slice(order.indexOf(f) + 1)) delete next[later];
      return next;
    });

  const chosen = STEPS.filter((s) => pick[s.key]);
  // Only the next question worth asking is shown: one with something to choose between, and not one
  // the cars found have already settled by themselves.
  const open = STEPS.filter((s) => !pick[s.key] && (d?.facets[s.key]?.length ?? 0) > 1);

  return (
    <>
      <p className="browse-lead">Narrow down what is in stock, the way the customer asks for it. Nothing here reserves a car.</p>

      {chosen.length > 0 && (
        <div className="picked">
          {chosen.map((s) => (
            <button key={s.key} type="button" className="picked-chip" onClick={() => choose(s.key, pick[s.key]!)}>
              <span className="picked-what">{WORD[s.key]}</span>
              <span className="picked-value">{pick[s.key]}</span>
              <span aria-hidden="true">×</span>
              <span className="sr-only">Remove this choice</span>
            </button>
          ))}
          <Button size="sm" variant="ghost" onClick={() => setPick({})}>
            Start again
          </Button>
        </div>
      )}

      <div className="browse-count">
        {load.loading && !d ? (
          <Loading label="Looking in the yard" />
        ) : load.error && !d ? (
          <ErrorBox message={load.error} onRetry={() => void load.reload()} />
        ) : d ? (
          <>
            <p className="browse-total">
              <strong>{fmtNumber(d.total)}</strong> {plural(d.total, "car").replace(/^\d+\s/, "")}
              {d.total > 0 && (
                <span className="browse-split">
                  {" "}
                  — {fmtNumber(d.in_yard)} in the yard, {fmtNumber(d.in_transit)} on the way
                </span>
              )}
            </p>
            <div className="browse-switch">
              <button type="button" className={show === "FREE" ? "on" : undefined} onClick={() => setShow("FREE")}>
                Free to offer
              </button>
              <button type="button" className={show === "ALL" ? "on" : undefined} onClick={() => setShow("ALL")}>
                Everything in stock
              </button>
            </div>
          </>
        ) : null}
      </div>

      {d && (
        <>
          {open.length > 0 && (
            <Card title="Narrow it down" className="facet-card">
              {open.map((s) => (
                <div key={s.key} className="facet-row">
                  <p className="facet-q">{s.title}</p>
                  <div className="facet-options">
                    {d.facets[s.key].map((o) => (
                      <button key={o.value} type="button" className="facet-option" onClick={() => choose(s.key, o.value)}>
                        <span className="facet-value">{o.value}</span>
                        <span className="facet-n">{fmtNumber(o.cars)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </Card>
          )}

          <Card title={`What is standing there`} note={`${fmtNumber(d.groups.length)} ${d.groups.length === 1 ? "model, variant and colour" : "different model, variant and colour combinations"}. ${d.basis}`}>
            {d.groups.length === 0 ? (
              <Empty title="Nothing matches that" hint="Remove one of the choices above, or ask the ordering desk what is on order." />
            ) : (
              <ul className="cars">
                {d.groups.map((g) => (
                  <CarCard key={`${g.model}|${g.variant}|${g.colour}`} g={g} canBook={can("booking.create")} />
                ))}
              </ul>
            )}
          </Card>

          <p className="browse-asof">
            Stock as the last report has it{d.source.stock_as_on ? `, as on ${fmtDate(d.source.stock_as_on)}` : ""}.{d.source.stale ? " That report is out of date — load today's file before answering a customer." : ""}
          </p>
        </>
      )}
    </>
  );
}

/** One model, variant and colour: how many there are, where they are, and when the next one lands. */
function CarCard({ g, canBook }: { g: BrowseGroup; canBook: boolean }) {
  const specs = [g.trim_level, g.fuel, g.transmission, g.seater && `${g.seater} seats`].filter(Boolean);
  const outlets = Object.entries(g.outlets).sort((a, b) => b[1] - a[1]);
  return (
    <li className="car">
      <div className="car-head">
        <p className="car-name">
          {g.model} <span className="car-variant">{g.variant}</span>
        </p>
        <p className="car-colour">{g.colour}</p>
        {specs.length > 0 && <p className="car-specs">{specs.join(" · ")}</p>}
      </div>
      <div className="car-counts">
        {g.in_yard > 0 && <Chip tone="green">{fmtNumber(g.in_yard)} in the yard</Chip>}
        {g.in_transit > 0 && <Chip tone="blue">{fmtNumber(g.in_transit)} on the way</Chip>}
        {g.in_yard === 0 && g.soonest && (
          <span className="car-eta">
            {g.soonest_indicative ? "around " : "expected "}
            {fmtDate(g.soonest)}
            {g.soonest_indicative ? " (indicative)" : ""}
          </span>
        )}
      </div>
      <p className="car-where">{outlets.map(([name, n]) => `${name} (${fmtNumber(n)})`).join(" · ")}</p>
      {canBook && (
        <Link to={`/bookings/new?model=${encodeURIComponent(g.model)}&variant=${encodeURIComponent(g.variant)}&colour=${encodeURIComponent(g.colour)}`} className="btn btn-secondary btn-sm">
          <span>Book this for a customer</span>
        </Link>
      )}
    </li>
  );
}
