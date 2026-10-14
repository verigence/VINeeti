import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { CarName, SpecLine } from "../components/CarSpec";
import { useCatalog } from "../components/ConfigPicker";
import { ActionBar, Async, Button, Card, Chip, DataTable, Empty, Filter, FilterBar, Select, StatusChip, type Column } from "../components/ui";
import { fmtDate, fmtMoney, fmtNumber, plural, today } from "../format";
import { useAction, useDebounced, useLoad } from "../hooks";
import { allocationMessage, DMS_STOCK_TYPE_OPTIONS, dmsStockType, VEHICLE_STATUS_OPTIONS, vehicleStatus } from "../labels";
import { Link, useQuery, useRouter } from "../router";
import { useSession } from "../session";
import type { VehicleListRow } from "../types";
import { AddVehicleDialog, ReceiveBulkDialog } from "./VehicleDialogs";

const COMMITMENT_OPTIONS = [
  { value: "FREE", label: "Free" },
  { value: "ALLOCATED", label: "Allocated" },
  { value: "BLOCKED", label: "Blocked" },
];
/** Cars still with the dealership: the statuses the list can be narrowed to. */
const STATUS_OPTIONS = VEHICLE_STATUS_OPTIONS.filter((o) => ["IN_TRANSIT", "RECEIVED", "INVOICED"].includes(o.value));
const withCurrent = (list: string[], current: string) => (current && !list.includes(current) ? [current, ...list] : list).map((v) => ({ value: v, label: v }));

export function CarsTab() {
  const { can, me, worksAt } = useSession();
  const { navigate } = useRouter();
  const catalog = useCatalog();
  const [query, setQuery] = useQuery();
  const q = {
    q: query.get("q") ?? "",
    outlet_id: query.get("outlet_id") ?? "",
    status: query.get("status") ?? "",
    commitment: query.get("commitment") ?? "",
    dms_stock_type: query.get("dms_stock_type") ?? "",
    min_age: query.get("min_age") ?? "",
    model: query.get("model") ?? "",
    variant: query.get("variant") ?? "",
    colour: query.get("colour") ?? "",
  };
  const overdueOnly = query.get("overdue") === "1";
  const [search, setSearch] = useState(q.q);
  const debounced = useDebounced(search);
  useEffect(() => {
    if (debounced !== q.q) setQuery({ q: debounced });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);
  const [age, setAge] = useState(q.min_age);
  const debouncedAge = useDebounced(age, 500);
  useEffect(() => {
    if (debouncedAge !== q.min_age) setQuery({ min_age: debouncedAge });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedAge]);

  const load = useLoad(() => api.vehicles(q), `vehicles:${JSON.stringify(q)}`);
  const action = useAction();
  const [dialog, setDialog] = useState<"add" | "bulk" | null>(null);
  const manage = can("stock.manage");
  const day = today();
  const models = useMemo(() => [...new Set((catalog.data?.variants ?? []).map((v) => v.model))].sort(), [catalog.data]);
  const variants = useMemo(() => (catalog.data?.variants ?? []).filter((v) => v.model === q.model).map((v) => v.variant).sort(), [catalog.data, q.model]);
  const colours = catalog.data?.colours[q.model] ?? [];
  const showValue = can("stock.value");

  const receive = async (v: VehicleListRow) => {
    const res = await action.run(() => api.receiveVehicle(v.id), { success: (r) => `${v.vin} marked as received. ${allocationMessage(r.allocations)}`.trim() });
    if (res) void load.reload();
  };

  const columns: Column<VehicleListRow>[] = [
    {
      header: "Chassis (VIN)",
      primary: true,
      cell: (v) => (
        <Link to={`/stock/cars/${v.id}`} className="cell-link">
          <span className="mono strong">{v.vin}</span>
        </Link>
      ),
    },
    {
      header: "Car",
      cell: (v) => (
        <span>
          <CarName car={v} />
          <SpecLine car={v} />
        </span>
      ),
    },
    {
      header: "Where it is",
      status: true,
      cell: (v) => (
        <span className="chips">
          <StatusChip label={vehicleStatus(v.status)} />
          {v.is_demo ? <Chip tone="purple">Demo</Chip> : null}
          {v.is_blocked ? <Chip tone="red">Blocked</Chip> : null}
        </span>
      ),
    },
    { header: "Outlet", cell: (v) => v.outlet },
    { header: "DMS stock type", cell: (v) => dmsStockType(v.dms_stock_type)?.text ?? <span className="muted">—</span> },
    {
      header: "Commitment",
      cell: (v) =>
        v.allocation_id ? (
          <span>
            {v.booking_id && v.booking_no ? (
              <span>
                Allocated to{" "}
                {can("booking.view") ? (
                  <Link to={`/bookings/${v.booking_id}`} className="nowrap">
                    {v.booking_no}
                  </Link>
                ) : (
                  v.booking_no
                )}
              </span>
            ) : (
              <Chip tone="teal">Allocated</Chip>
            )}
            {(v.customer_name && v.customer_name !== "Allocated") || v.needs_transfer ? (
              <span className="sub">
                {v.customer_name && v.customer_name !== "Allocated" ? v.customer_name : ""}
                {v.needs_transfer ? `${v.customer_name && v.customer_name !== "Allocated" ? " · " : ""}needs transfer` : ""}
              </span>
            ) : null}
          </span>
        ) : v.is_blocked ? (
          <span>Blocked{v.block_reason ? `: ${v.block_reason}` : ""}</span>
        ) : v.status === "IN_TRANSIT" || v.status === "RECEIVED" ? (
          <Chip tone="green">Free</Chip>
        ) : (
          <span className="muted">—</span>
        ),
    },
    { header: "Order number", hideIfEmpty: (v) => !v.dms_booking_no, cell: (v) => (v.dms_booking_no ? <span className="mono">{v.dms_booking_no}</span> : <span className="muted">—</span>) },
    { header: "Age", num: true, cell: (v) => (v.age_days === null ? <span className="muted">—</span> : plural(v.age_days, "day")) },
    {
      header: "Arrival",
      hideIfEmpty: (v) => v.status !== "IN_TRANSIT" && !v.received_at,
      cell: (v) =>
        v.status === "IN_TRANSIT" ? (
          v.expected_arrival_date ? (
            <>
              <span>Expected {fmtDate(v.expected_arrival_date)}</span>
              {v.expected_arrival_date < day && <span className="sub danger">Overdue</span>}
            </>
          ) : (
            <span className="muted">No date known</span>
          )
        ) : v.received_at ? (
          <span>Received {fmtDate(v.received_at)}</span>
        ) : (
          <span className="muted">—</span>
        ),
    },
    ...(showValue
      ? [
          {
            header: "Net dealer price",
            num: true,
            hideIfEmpty: (v: VehicleListRow) => v.net_dealer_price === null || v.net_dealer_price === undefined,
            cell: (v: VehicleListRow) => (v.net_dealer_price === null || v.net_dealer_price === undefined ? <span className="muted">—</span> : fmtMoney(v.net_dealer_price)),
          } satisfies Column<VehicleListRow>,
        ]
      : []),
    ...(manage
      ? [
          {
            header: "Actions",
            actions: true,
            hideIfEmpty: (v: VehicleListRow) => !(v.status === "IN_TRANSIT" && worksAt(v.outlet_id)),
            cell: (v: VehicleListRow) =>
              v.status === "IN_TRANSIT" && worksAt(v.outlet_id) ? (
                <Button size="sm" disabled={action.busy} onClick={() => void receive(v)}>
                  Mark received
                </Button>
              ) : null,
          } satisfies Column<VehicleListRow>,
        ]
      : []),
  ];

  const filterCount = [q.model, q.variant, q.colour, q.outlet_id, q.status, q.commitment, q.dms_stock_type, q.min_age].filter(Boolean).length;

  return (
    <>
      <div className="list-head">
        <FilterBar
          active={filterCount}
          onClear={() => {
            setAge("");
            setQuery({ model: null, variant: null, colour: null, outlet_id: null, status: null, commitment: null, dms_stock_type: null, min_age: null, overdue: null });
          }}
          search={
            <Filter label="Search" grow>
              <input type="search" inputMode="search" enterKeyHint="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Chassis number (VIN)" />
            </Filter>
          }
        >
          <Filter label="Model">
            <Select value={q.model} onChange={(v) => setQuery({ model: v, variant: null, colour: null })} options={withCurrent(models, q.model)} placeholder="All models" />
          </Filter>
          <Filter label="Variant">
            <Select value={q.variant} onChange={(v) => setQuery({ variant: v })} options={withCurrent(variants, q.variant)} placeholder={q.model ? "All variants" : "Choose a model first"} disabled={!q.model && !q.variant} />
          </Filter>
          <Filter label="Colour">
            <Select value={q.colour} onChange={(v) => setQuery({ colour: v })} options={withCurrent(colours, q.colour)} placeholder={q.model ? "All colours" : "Choose a model first"} disabled={!q.model && !q.colour} />
          </Filter>
          <Filter label="Outlet">
            <Select value={q.outlet_id} onChange={(v) => setQuery({ outlet_id: v })} options={me.all_outlets.map((o) => ({ value: o.id, label: o.name }))} placeholder="All outlets" />
          </Filter>
          <Filter label="Status">
            <Select value={q.status} onChange={(v) => setQuery({ status: v, overdue: v === "IN_TRANSIT" ? query.get("overdue") : null })} options={STATUS_OPTIONS} placeholder="Any" />
          </Filter>
          <Filter label="Commitment">
            <Select value={q.commitment} onChange={(v) => setQuery({ commitment: v })} options={COMMITMENT_OPTIONS} placeholder="Any" />
          </Filter>
          <Filter label="DMS stock type">
            <Select value={q.dms_stock_type} onChange={(v) => setQuery({ dms_stock_type: v })} options={DMS_STOCK_TYPE_OPTIONS} placeholder="Any" />
          </Filter>
          <Filter label="Minimum age (days)">
            <input type="number" min={0} step={1} inputMode="numeric" value={age} onChange={(e) => setAge(e.target.value.replace(/[^\d]/g, ""))} placeholder="Any" />
          </Filter>
        </FilterBar>
        {manage && (
          <ActionBar>
            <Button onClick={() => setDialog("bulk")}>Receive several</Button>
            <Button variant="primary" icon="plus" onClick={() => setDialog("add")}>
              Add a car
            </Button>
          </ActionBar>
        )}
      </div>
      {overdueOnly && (
        <div className="active-filters">
          <span className="filter-tag">
            Overdue in transit only
            <button type="button" onClick={() => setQuery({ overdue: null })} aria-label="Remove the overdue filter">
              ×
            </button>
          </span>
        </div>
      )}
      <Card flush>
        <Async load={load} isEmpty={() => false}>
          {(all) => {
            const rows = overdueOnly ? all.filter((v) => v.status === "IN_TRANSIT" && v.expected_arrival_date && v.expected_arrival_date < day) : all;
            if (!rows.length) return <Empty title="No cars match" hint="Change the filters or the search." />;
            return (
              <>
                {/* The numbers first, then the detail. A list of several hundred chassis numbers cannot
                    answer "where have I piled up", and that is the first thing anybody opening this list
                    wants to know. Each model is a filter: press it and the list below narrows to it. */}
                <ByModel rows={rows} chosen={q.model} onChoose={(m) => setQuery({ model: m, variant: null, colour: null })} />
                <p className="list-count">
                  {plural(rows.length, "car")}
                  {q.model ? ` · ${q.model}` : ""}
                  {all.length >= 1000 ? " (first 1,000 shown; narrow the filters to see the rest)" : ""}
                </p>
                <DataTable columns={columns} rows={rows} rowKey={(v) => v.id} caption="Cars" />
              </>
            );
          }}
        </Async>
      </Card>
      {dialog === "add" && (
        <AddVehicleDialog
          onClose={() => setDialog(null)}
          onDone={(id) => {
            setDialog(null);
            navigate(`/stock/cars/${id}`);
          }}
        />
      )}
      {dialog === "bulk" && <ReceiveBulkDialog onClose={() => setDialog(null)} onDone={() => void load.reload()} />}
    </>
  );
}


/**
 * Where the cars have piled up, worked out from the rows on screen so it always agrees with the filters
 * above it. Biggest first, with the oldest car in each model beside it, because a hundred of a model is
 * one problem and a hundred of a model whose oldest has been standing ninety days is another.
 *
 * Pressing a model filters the list below; pressing it again clears it.
 */
function ByModel({ rows, chosen, onChoose }: { rows: VehicleListRow[]; chosen: string; onChoose: (model: string | null) => void }) {
  if (rows.length < 2) return null;
  // The money is shown only where the price is shown: the server leaves it out for roles that may not
  // see stock value, and a total built from missing prices would be a lie told confidently.
  const withValue = rows.some((v) => v.net_dealer_price !== undefined && v.net_dealer_price !== null);
  const by = new Map<string, { model: string; cars: number; yard: number; transit: number; oldest: number | null; value: number; priced: number; old60: number; old60Value: number }>();
  let total = 0;
  let priced = 0;
  let old60 = 0;
  let old60Value = 0;
  for (const v of rows) {
    const g = by.get(v.model) ?? { model: v.model, cars: 0, yard: 0, transit: 0, oldest: null, value: 0, priced: 0, old60: 0, old60Value: 0 };
    g.cars += 1;
    if (v.status === "RECEIVED") g.yard += 1;
    else if (v.status === "IN_TRANSIT") g.transit += 1;
    if (v.age_days !== null && (g.oldest === null || v.age_days > g.oldest)) g.oldest = v.age_days;
    const price = v.net_dealer_price ?? null;
    if (price !== null) {
      g.value += price;
      g.priced += 1;
      total += price;
      priced += 1;
    }
    if (v.age_days !== null && v.age_days > 60) {
      g.old60 += 1;
      old60 += 1;
      if (price !== null) {
        g.old60Value += price;
        old60Value += price;
      }
    }
    by.set(v.model, g);
  }
  const groups = [...by.values()].sort((a, b) => b.value - a.value || b.cars - a.cars || a.model.localeCompare(b.model));
  if (groups.length < 2 && !chosen) return null;
  const max = Math.max(...groups.map((g) => g.cars));
  const unpriced = rows.length - priced;
  return (
    <div className="by-model">
      {withValue && (
        <p className="by-model-money">
          <strong>{fmtMoney(total)}</strong> is sitting in {plural(rows.length, "car")}
          {old60 > 0 && (
            <>
              {" · "}
              <strong className="danger-text">{fmtMoney(old60Value)}</strong> of it in {plural(old60, "car")} here more than 60 days
            </>
          )}
          {unpriced > 0 && <span className="hint"> {plural(unpriced, "car has", "cars have")} no price in the stock report and {unpriced === 1 ? "is" : "are"} not in these totals.</span>}
        </p>
      )}
      <p className="by-model-head">
        {withValue ? "Where the money is, by model" : "Where these cars are, by model"}
        {chosen && (
          <button type="button" className="by-model-clear" onClick={() => onChoose(null)}>
            Show every model
          </button>
        )}
      </p>
      <ul className="by-model-list">
        {groups.map((g) => (
          <li key={g.model}>
            <button type="button" className={`by-model-row${chosen === g.model ? " on" : ""}`} onClick={() => onChoose(chosen === g.model ? null : g.model)} aria-pressed={chosen === g.model}>
              <span className="by-model-n">{fmtNumber(g.cars)}</span>
              <span className="by-model-name">
                {g.model}
                {withValue && g.priced > 0 && <span className="by-model-value">{fmtMoney(g.value)}</span>}
              </span>
              <span className="by-model-bar" aria-hidden="true">
                <span style={{ width: `${Math.round((g.cars / max) * 100)}%` }} />
              </span>
              <span className="by-model-sub">
                {g.yard > 0 ? `${fmtNumber(g.yard)} in the yard` : ""}
                {g.yard > 0 && g.transit > 0 ? " · " : ""}
                {g.transit > 0 ? `${fmtNumber(g.transit)} on the way` : ""}
                {g.oldest !== null ? ` · oldest ${plural(g.oldest, "day")}` : ""}
                {g.old60 > 0 ? ` · ${fmtNumber(g.old60)} over 60 days` : ""}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
