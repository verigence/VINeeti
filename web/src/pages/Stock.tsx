import { useMemo } from "react";
import { api, withQuery } from "../api";
import { CarName, SpecLine } from "../components/CarSpec";
import { useCatalog } from "../components/ConfigPicker";
import { DataSource } from "../components/DataSource";
import { Async, Card, Chip, DataTable, Empty, Filter, FilterBar, PageHeader, Select, Tabs, type Column } from "../components/ui";
import { fmtDate, fmtNumber, plural } from "../format";
import { useLoad } from "../hooks";
import { Link, useQuery } from "../router";
import { useSession } from "../session";
import type { StockSummaryRow } from "../types";
import { AvailabilityCheck } from "./Availability";
import { CarsTab } from "./StockCars";

export function StockPage({ tab }: { tab: "summary" | "availability" | "cars" }) {
  const current = tab === "summary" ? "/stock" : `/stock/${tab}`;
  return (
    <>
      <PageHeader title="Stock" subtitle="Cars in transit and in the yard, and what is free for a new customer." />
      <DataSource />
      <Tabs
        current={current}
        tabs={[
          { to: "/stock", label: "Summary" },
          { to: "/stock/availability", label: "Availability" },
          { to: "/stock/cars", label: "Cars" },
        ]}
      />
      {tab === "summary" && <SummaryTab />}
      {tab === "availability" && <AvailabilityCheck />}
      {tab === "cars" && <CarsTab />}
    </>
  );
}

function SummaryTab() {
  const { me } = useSession();
  const catalog = useCatalog();
  const [query, setQuery] = useQuery();
  const outlet = query.get("outlet_id") ?? "";
  const model = query.get("model") ?? "";
  const load = useLoad(() => api.stockSummary({ outlet_id: outlet, model }), `summary:${outlet}:${model}`);
  const models = useMemo(() => [...new Set((catalog.data?.variants ?? []).map((v) => v.model))].sort(), [catalog.data]);

  const columns: Column<StockSummaryRow>[] = [
    {
      header: "Car",
      primary: true,
      cell: (r) => (
        <Link to={withQuery("/stock/cars", { model: r.model, variant: r.variant, colour: r.colour, outlet_id: outlet })} className="cell-link">
          <CarName car={r} />
        </Link>
      ),
    },
    { header: "Specification", cell: (r) => <SpecLine car={r} /> },
    { header: "Free in yard", num: true, cell: (r) => <span className={r.yard_free ? "strong" : "muted"}>{fmtNumber(r.yard_free)}</span> },
    { header: "Reserved in yard", num: true, cell: (r) => fmtNumber(r.yard_allocated) },
    { header: "Free in transit", num: true, cell: (r) => <span className={r.transit_free ? "strong" : "muted"}>{fmtNumber(r.transit_free)}</span> },
    { header: "Reserved in transit", num: true, cell: (r) => fmtNumber(r.transit_allocated) },
    { header: "Blocked", num: true, hideIfEmpty: (r) => !r.blocked, cell: (r) => (r.blocked ? <Chip tone="red">{fmtNumber(r.blocked)} blocked</Chip> : <span className="muted">0</span>) },
    { header: "Earliest free arrival", cell: (r) => (r.earliest_free_arrival ? fmtDate(r.earliest_free_arrival) : <span className="muted">—</span>), hideIfEmpty: (r) => !r.earliest_free_arrival },
  ];

  return (
    <>
      <FilterBar active={[outlet, model].filter(Boolean).length} onClear={() => setQuery({ outlet_id: null, model: null })}>
        <Filter label="Model">
          <Select value={model} onChange={(v) => setQuery({ model: v })} options={(model && !models.includes(model) ? [model, ...models] : models).map((m) => ({ value: m, label: m }))} placeholder="All models" />
        </Filter>
        <Filter label="Outlet">
          <Select value={outlet} onChange={(v) => setQuery({ outlet_id: v })} options={me.all_outlets.map((o) => ({ value: o.id, label: o.name }))} placeholder="All outlets" />
        </Filter>
      </FilterBar>
      <Card flush>
        <Async load={load} empty={<Empty title="No cars in stock" hint={outlet || model ? "Nothing in transit or in the yard matches these filters." : "Cars appear here once the DMS stock report is loaded."} />}>
          {(rows) => (
            <>
              <p className="list-count">{plural(rows.length, "model, variant and colour combination")}</p>
              <DataTable columns={columns} rows={rows} rowKey={(r) => `${r.model}|${r.variant}|${r.colour}`} caption="Stock by model, variant and colour" />
            </>
          )}
        </Async>
      </Card>
    </>
  );
}
