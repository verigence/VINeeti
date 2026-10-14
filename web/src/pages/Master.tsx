// The vehicle master: every variant with its attributes, each model's colours, and which colour names
// the dealership treats as the same. Variants are registered from the DMS files as they appear; what a
// DMS description does not state is blank until it is filled in here or from the master sheet.

import { useMemo, useRef, useState } from "react";
import { api } from "../api";
import { ConfirmDialog, Dialog } from "../components/Dialog";
import { Icon } from "../components/icons";
import { Async, Button, Card, Check, Chip, DataTable, Disclosure, Empty, Field, Filter, FilterBar, Notice, PageHeader, RadioGroup, Select, Tabs, type Column } from "../components/ui";
import { fmtDateTime, fmtNumber, orDash, plural } from "../format";
import { useAction, useLoad } from "../hooks";
import { plainText } from "../labels";
import { useQuery } from "../router";
import type { ColourReviewRow, MasterName, MasterResponse, MasterUploadResult, MasterVariantRow, VariantPatch } from "../types";

const ATTRS = ["category", "trim", "transmission", "fuel", "drive", "seater"] as const;
const hasBlanks = (v: MasterVariantRow) => ATTRS.some((a) => !String(v[a] ?? "").trim());

export function MasterPage({ tab }: { tab: "variants" | "colours" }) {
  const load = useLoad(() => api.master(), "master");
  return (
    <>
      <PageHeader title="Vehicle master" subtitle="Variants are registered from the DMS files. What a DMS description does not state stays blank until it is filled in." />
      <Tabs
        current={tab === "variants" ? "/master" : "/master/colours"}
        tabs={[
          { to: "/master", label: "Variants" },
          { to: "/master/colours", label: "Colours" },
        ]}
      />
      <Async load={load} isEmpty={() => false}>
        {(m) => (tab === "variants" ? <VariantsTab m={m} reload={load.reload} /> : <ColoursTab m={m} reload={load.reload} />)}
      </Async>
    </>
  );
}

// ---------------------------------------------------------------- variants
function VariantsTab({ m, reload }: { m: MasterResponse; reload: () => Promise<void> }) {
  const [query, setQuery] = useQuery();
  const model = query.get("model") ?? "";
  const blanks = query.get("blanks") === "1";
  const [editing, setEditing] = useState<MasterVariantRow | null>(null);
  const models = useMemo(() => [...new Set(m.variants.map((v) => v.model))].sort(), [m.variants]);
  const rows = m.variants.filter((v) => (!model || v.model === model) && (!blanks || hasBlanks(v)));
  const blank = <span className="muted">—</span>;
  const attr = (v: string) => (v.trim() ? v : blank);

  const columns: Column<MasterVariantRow>[] = [
    { header: "Category", cell: (v) => attr(v.category) },
    { header: "Model", cell: (v) => v.model },
    { header: "Trim", cell: (v) => attr(v.trim) },
    { header: "Transmission", cell: (v) => attr(v.transmission) },
    { header: "Fuel", cell: (v) => attr(v.fuel) },
    { header: "Drive", cell: (v) => attr(v.drive) },
    { header: "Seater", cell: (v) => attr(v.seater) },
    { header: "Variant", primary: true, cell: (v) => <span className="strong">{v.variant}</span> },
    { header: "OEM model code", cell: (v) => (v.oem_model_code ? <span className="mono">{v.oem_model_code}</span> : blank) },
    { header: "Origin", cell: (v) => (v.origin === "DMS" ? "DMS" : "Entered") },
    { header: "Cars in stock", num: true, cell: (v) => fmtNumber(v.cars_in_stock) },
    { header: "Open bookings", num: true, cell: (v) => fmtNumber(v.open_bookings) },
    { header: "Active", status: true, cell: (v) => (v.is_active ? <Chip tone="green">Active</Chip> : <Chip tone="grey">Discontinued</Chip>) },
    {
      header: "Actions",
      actions: true,
      cell: (v) => (
        <Button size="sm" onClick={() => setEditing(v)}>
          Edit
        </Button>
      ),
    },
  ];

  return (
    <>
      <SheetCard reload={reload} />
      <FilterBar active={(model ? 1 : 0) + (blanks ? 1 : 0)} onClear={() => setQuery({ model: null, blanks: null })}>
        <Filter label="Model">
          <Select value={model} onChange={(v) => setQuery({ model: v })} options={models.map((x) => ({ value: x, label: x }))} placeholder="All models" />
        </Filter>
        <div className="filter">
          <span className="filter-label">Blanks</span>
          <Check checked={blanks} onChange={(on) => setQuery({ blanks: on ? "1" : null })}>
            Has blanks
          </Check>
        </div>
      </FilterBar>
      <Card flush>
        {rows.length ? (
          <>
            <p className="list-count">
              {plural(rows.length, "variant")}
              {rows.length !== m.variants.length ? ` of ${fmtNumber(m.variants.length)}` : ""}
            </p>
            <DataTable columns={columns} rows={rows} rowKey={(v) => v.id} caption="Variants" />
          </>
        ) : (
          <Empty title={m.variants.length ? "No variant matches" : "No variants yet"} hint={m.variants.length ? "Change the filters." : "Variants appear here once a DMS file is loaded."} />
        )}
      </Card>
      {editing && (
        <VariantDialog
          variant={editing}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}
    </>
  );
}

function VariantDialog({ variant: v, onClose, onDone }: { variant: MasterVariantRow; onClose: () => void; onDone: () => void }) {
  const action = useAction();
  const fromDms = v.origin === "DMS";
  const [f, setF] = useState({ category: v.category, model: v.model, trim: v.trim, transmission: v.transmission, fuel: v.fuel, drive: v.drive, seater: v.seater, variant: v.variant });
  const [active, setActive] = useState(Boolean(v.is_active));
  const set = (k: keyof typeof f, value: string) => setF((cur) => ({ ...cur, [k]: value }));

  const submit = async () => {
    // A variant from the DMS keeps its model and name; they are not sent.
    const patch: VariantPatch = { category: f.category, trim: f.trim, transmission: f.transmission, fuel: f.fuel, drive: f.drive, seater: f.seater, is_active: active };
    if (!fromDms) {
      patch.model = f.model;
      patch.variant = f.variant;
    }
    const res = await action.run(() => api.updateVariant(v.id, patch), { quiet: true, success: `${v.variant} saved.` });
    if (res) onDone();
  };
  const text = (k: keyof typeof f, label: string, disabled?: boolean) => (
    <Field label={label}>
      <input value={f[k]} onChange={(e) => set(k, e.target.value)} disabled={disabled} maxLength={120} autoComplete="off" />
    </Field>
  );

  return (
    <Dialog
      title="Edit variant"
      wide
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
      <div className="form-grid">
        {fromDms && (
          <div className="field-wide">
            <Notice>This variant comes from the DMS files, so its model and name follow the DMS. The other attributes can be edited.</Notice>
          </div>
        )}
        {text("variant", "Variant", fromDms)}
        {text("model", "Model", fromDms)}
        {text("category", "Category")}
        {text("trim", "Trim")}
        {text("transmission", "Transmission")}
        {text("fuel", "Fuel")}
        {text("drive", "Drive")}
        {text("seater", "Seater")}
        <div className="field-wide">
          <Check checked={active} onChange={setActive} hint="A discontinued variant cannot take new bookings. Cars and bookings that already use it are not affected.">
            Active
          </Check>
        </div>
      </div>
      {action.error && <Notice tone="error">{plainText(action.error)}</Notice>}
    </Dialog>
  );
}

/** Download the master as a sheet, fill in what the DMS does not state, and load it back. */
function SheetCard({ reload }: { reload: () => Promise<void> }) {
  const action = useAction();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<{ result: MasterUploadResult; filename: string } | null>(null);

  const submit = async () => {
    if (!file) return;
    const res = await action.run(() => api.uploadMaster(file), { quiet: true, success: `${file.name} loaded.` });
    if (res) {
      setResult({ result: res, filename: file.name });
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
      await reload();
    }
  };

  return (
    <Card
      title="Master sheet"
      note="Download the master, fill the blanks from the manufacturer's catalogue, and load it back. A blank cell leaves the value as it is; nothing is ever deleted."
      actions={
        <a className="btn btn-secondary" href={api.masterExportUrl} download>
          <Icon name="download" size={16} />
          <span>Download master (CSV)</span>
        </a>
      }
    >
      <form
        className="form-stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="field">
          <span className="field-label">Filled-in master sheet</span>
          <input ref={inputRef} type="file" accept=".csv,text/csv" disabled={action.busy} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <span className="hint">CSV with the columns Category, Model, Trim, Transmission, Fuel, Drive, Seater and Variant.</span>
        </label>
        {action.error && <Notice tone="error">{plainText(action.error)}</Notice>}
        <div className="form-actions">
          <Button type="submit" variant="primary" icon="upload" busy={action.busy} disabled={!file}>
            Load master sheet
          </Button>
        </div>
      </form>
      {result && (
        <div className="result" aria-live="polite">
          <h3 className="section-title">Result for {result.filename}</h3>
          <p>
            {plural(result.result.row_count, "row")} read · {fmtNumber(result.result.created)} added · {fmtNumber(result.result.updated)} updated · {fmtNumber(result.result.unchanged)} unchanged · {plural(result.result.colours_added, "colour")} added
          </p>
          {result.result.errors.length > 0 ? (
            <Disclosure summary={`Rows with errors (${fmtNumber(result.result.errors.length)})`} open>
              <ul className="plain-list">
                {result.result.errors.map((e) => (
                  <li key={`${e.row}:${e.key}`}>
                    Row {e.row}, <span className="mono">{e.key}</span>: {plainText(e.message)}
                  </li>
                ))}
              </ul>
            </Disclosure>
          ) : (
            <p className="meta">No row had an error.</p>
          )}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- colours
function ColoursTab({ m, reload }: { m: MasterResponse; reload: () => Promise<void> }) {
  const action = useAction();
  const [review, setReview] = useState<ColourReviewRow | null>(null);
  const [removing, setRemoving] = useState<MasterName | null>(null);
  const mappings = m.names.filter((n) => n.kind === "COLOUR" && n.colour);
  const models = Object.keys(m.colours).sort();

  const reviewColumns: Column<ColourReviewRow>[] = [
    { header: "Model", primary: true, cell: (r) => <span className="strong">{r.model}</span> },
    { header: "State", status: true, hideIfEmpty: (r) => !r.mapped, cell: (r) => (r.mapped ? <Chip tone="green">Mapped</Chip> : null) },
    { header: "Booking sheet says", cell: (r) => r.booking_says },
    { header: "Stock report says", cell: (r) => r.stock_says },
    { header: "Cars", num: true, cell: (r) => fmtNumber(r.cars) },
    {
      header: "Actions",
      actions: true,
      hideIfEmpty: (r) => r.mapped,
      cell: (r) =>
        r.mapped ? null : (
          <Button size="sm" onClick={() => setReview(r)}>
            Treat as the same colour
          </Button>
        ),
    },
  ];
  const mappingColumns: Column<MasterName>[] = [
    { header: "Model", primary: true, cell: (n) => <span className="strong">{n.model}</span> },
    { header: "This name", cell: (n) => n.alias },
    { header: "Is the colour", cell: (n) => orDash(n.colour) },
    { header: "Set", cell: (n) => (n.mapped_at ? `${n.mapped_by_name ?? "—"}, ${fmtDateTime(n.mapped_at)}` : <span className="muted">—</span>) },
    {
      header: "Actions",
      actions: true,
      cell: (n) => (
        <Button size="sm" variant="danger" onClick={() => setRemoving(n)}>
          Remove
        </Button>
      ),
    },
  ];

  return (
    <>
      <Card title="Review" note="Colours the booking sheet and the stock report name differently, for cars the DMS itself has allotted to those bookings." flush>
        {m.colour_review.length ? <DataTable columns={reviewColumns} rows={m.colour_review} rowKey={(r) => `${r.model}|${r.booking_says}|${r.stock_says}`} caption="Colour names to review" /> : <Empty title="Nothing to review" hint="The two DMS files name every colour the same way." />}
      </Card>
      <Card title="Same colour" note="Names the dealership has said are the same colour for a model. They apply to cars and bookings alike." flush>
        {mappings.length ? <DataTable columns={mappingColumns} rows={mappings} rowKey={(n) => n.id} caption="Same-colour mappings" /> : <Empty title="No names have been mapped" />}
      </Card>
      <Card title="Colours by model" note="Colour names are added from the DMS files as they appear." flush>
        {models.length ? (
          <ul className="colour-list">
            {models.map((model) => (
              <li key={model}>
                <span className="strong">{model}</span>
                <span className="colour-names">{m.colours[model].join(", ")}</span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title="No colours yet" />
        )}
      </Card>
      {review && (
        <SameColourDialog
          row={review}
          onClose={() => setReview(null)}
          onDone={() => {
            setReview(null);
            void reload();
          }}
        />
      )}
      {removing && (
        <ConfirmDialog
          title="Remove this mapping?"
          message={`${removing.model}: "${removing.alias}" will no longer be treated as ${removing.colour}. Cars in stock and waiting bookings of this model go back to the names the DMS gives them.`}
          confirmLabel="Remove mapping"
          danger
          busy={action.busy}
          error={plainText(action.error) || null}
          onCancel={() => {
            action.clearError();
            setRemoving(null);
          }}
          onConfirm={async () => {
            const res = await action.run(() => api.removeName(removing.id), { quiet: true, success: "Mapping removed." });
            if (res) {
              setRemoving(null);
              await reload();
            }
          }}
        />
      )}
    </>
  );
}

function SameColourDialog({ row, onClose, onDone }: { row: ColourReviewRow; onClose: () => void; onDone: () => void }) {
  const action = useAction();
  const [keep, setKeep] = useState<"booking" | "stock">("stock");
  const kept = keep === "stock" ? row.stock_says : row.booking_says;
  const other = keep === "stock" ? row.booking_says : row.stock_says;

  const submit = async () => {
    const res = await action.run(() => api.mapColour(row.model, other, kept), {
      quiet: true,
      success: (r) => `${row.model}: "${other}" is now treated as ${kept}.${r.recoloured ? ` ${plural(r.recoloured.cars, "car")} and ${plural(r.recoloured.bookings, "waiting booking")} updated.` : ""}`,
    });
    if (res) onDone();
  };

  return (
    <Dialog
      title={`${row.model}: treat as the same colour`}
      onClose={() => !action.busy && onClose()}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button onClick={onClose} disabled={action.busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={action.busy}>
            Treat as the same colour
          </Button>
        </>
      }
    >
      <div className="form-stack">
        <RadioGroup
          legend="Which name should be kept?"
          value={keep}
          onChange={setKeep}
          options={[
            { value: "stock", label: row.stock_says, help: "The stock report's name" },
            { value: "booking", label: row.booking_says, help: "The booking sheet's name" },
          ]}
        />
        <p className="muted">
          For {row.model}, "{other}" will be treated as {kept}, for cars and bookings alike.
        </p>
        {action.error && <Notice tone="error">{plainText(action.error)}</Notice>}
      </div>
    </Dialog>
  );
}
