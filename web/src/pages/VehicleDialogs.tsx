// Dialogs for changing stock: add a car, receive several, transfer, edit dates and invoice details.

import { useState } from "react";
import { api } from "../api";
import { configInput, configReady, ConfigSelects, EMPTY_CONFIG, useCatalog, type CarConfig } from "../components/ConfigPicker";
import { Dialog } from "../components/Dialog";
import { Button, Field, Notice, RadioGroup, Select } from "../components/ui";
import { useAction, useLoad } from "../hooks";
import { allocationMessage, plainText } from "../labels";
import { useSession } from "../session";
import type { Vehicle, VehicleListRow } from "../types";

export function AddVehicleDialog({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const { myOutlets } = useSession();
  const catalog = useCatalog();
  const action = useAction();
  const [vin, setVin] = useState("");
  const [config, setConfig] = useState<CarConfig>(EMPTY_CONFIG);
  const [outletId, setOutletId] = useState(myOutlets.length === 1 ? myOutlets[0].id : "");
  const [status, setStatus] = useState<"IN_TRANSIT" | "RECEIVED">("IN_TRANSIT");
  const [invoiceNo, setInvoiceNo] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [dispatchDate, setDispatchDate] = useState("");
  const [eta, setEta] = useState("");
  const [engineNo, setEngineNo] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async () => {
    if (!vin.trim() || !configReady(config)) return setProblem("Enter the chassis number and choose the model, variant and colour.");
    if (!outletId) return setProblem("Choose the outlet the car belongs to.");
    setProblem(null);
    const res = await action.run(
      () =>
        api.addVehicle({
          vin: vin.trim(),
          ...configInput(config),
          outlet_id: outletId,
          status,
          wholesale_invoice_no: invoiceNo.trim() || null,
          wholesale_invoice_date: invoiceDate || null,
          dispatch_date: dispatchDate || null,
          expected_arrival_date: status === "IN_TRANSIT" ? eta || null : null,
          engine_no: engineNo.trim() || null,
        }),
      { quiet: true, success: (r) => `Car added to stock. ${allocationMessage(r.allocations)}`.trim() },
    );
    if (res) onDone(res.id);
  };

  return (
    <Dialog
      title="Add a car"
      wide
      onClose={() => !action.busy && onClose()}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button onClick={onClose} disabled={action.busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={action.busy}>
            Add car
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Chassis number (VIN)" wide>
          <input value={vin} onChange={(e) => setVin(e.target.value.toUpperCase())} autoCapitalize="characters" autoComplete="off" spellCheck={false} maxLength={30} />
        </Field>
        {catalog.data ? <ConfigSelects catalog={catalog.data} value={config} onChange={setConfig} /> : <p className="muted field-wide">{catalog.error ?? "Loading the vehicle master…"}</p>}
        <Field label="Outlet">
          <Select value={outletId} onChange={setOutletId} options={myOutlets.map((o) => ({ value: o.id, label: o.name }))} placeholder="Choose an outlet" />
        </Field>
        <div className="field-wide">
          <RadioGroup
            legend="Where is the car now?"
            value={status}
            onChange={setStatus}
            options={[
              { value: "IN_TRANSIT", label: "In transit from the plant" },
              { value: "RECEIVED", label: "Already in the yard" },
            ]}
          />
        </div>
        {status === "IN_TRANSIT" && (
          <Field label="Expected arrival date" optional>
            <input type="date" value={eta} onChange={(e) => setEta(e.target.value)} />
          </Field>
        )}
        <Field label="Dispatch date" optional>
          <input type="date" value={dispatchDate} onChange={(e) => setDispatchDate(e.target.value)} />
        </Field>
        <Field label="Manufacturer invoice number" optional>
          <input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} maxLength={60} />
        </Field>
        <Field label="Manufacturer invoice date" optional>
          <input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
        </Field>
        <Field label="Engine number" optional>
          <input value={engineNo} onChange={(e) => setEngineNo(e.target.value)} maxLength={40} />
        </Field>
      </div>
      {(problem || action.error) && <Notice tone="error">{problem ?? plainText(action.error)}</Notice>}
    </Dialog>
  );
}

export function ReceiveBulkDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const action = useAction();
  const [text, setText] = useState("");
  const [result, setResult] = useState<{ received: string[]; errors: { vin: string; message: string }[] } | null>(null);
  const vins = [...new Set(text.split(/[\s,;]+/).map((v) => v.trim().toUpperCase()).filter(Boolean))];

  const submit = async () => {
    if (!vins.length || result) return;
    const res = await action.run(() => api.receiveBulk(vins), { quiet: true });
    if (res) {
      setResult(res);
      onDone();
    }
  };

  return (
    <Dialog
      title="Receive several cars"
      onClose={() => !action.busy && onClose()}
      onSubmit={() => void submit()}
      footer={
        result ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={onClose} disabled={action.busy}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" busy={action.busy} disabled={!vins.length || vins.length > 60}>
              {vins.length ? `Mark ${vins.length} as received` : "Mark as received"}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="form-stack">
          <Notice tone={result.received.length ? "ok" : "warn"}>
            {result.received.length} of {result.received.length + result.errors.length} cars marked as received.
          </Notice>
          {result.errors.length > 0 && (
            <div>
              <p className="field-label">Not received</p>
              <ul className="plain-list">
                {result.errors.map((e) => (
                  <li key={e.vin}>
                    <span className="mono">{e.vin}</span>: {plainText(e.message)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <>
          <Field label="Chassis numbers" hint="One per line, or separated by commas. Up to 60 at a time, for example when a carrier load arrives.">
            <textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} className="mono" spellCheck={false} autoCapitalize="characters" />
          </Field>
          {vins.length > 60 && <Notice tone="warn">That is {vins.length} chassis numbers. Please receive at most 60 at a time.</Notice>}
          {action.error && <Notice tone="error">{plainText(action.error)}</Notice>}
        </>
      )}
    </Dialog>
  );
}

export function TransferDialog({ vehicle, onClose, onDone }: { vehicle: Pick<Vehicle | VehicleListRow, "id" | "vin" | "outlet_id">; onClose: () => void; onDone: () => void }) {
  const outlets = useLoad(() => api.outlets(), "outlets");
  const action = useAction();
  const [outletId, setOutletId] = useState("");
  const options = (outlets.data ?? []).filter((o) => o.is_active && o.id !== vehicle.outlet_id).map((o) => ({ value: o.id, label: o.name }));

  const submit = async () => {
    if (!outletId) return;
    const res = await action.run(() => api.transferVehicle(vehicle.id, outletId), {
      quiet: true,
      success: (r) => `Car moved to ${options.find((o) => o.value === outletId)?.label ?? "the outlet"}. ${allocationMessage(r.allocations)}`.trim(),
    });
    if (res) onDone();
  };

  return (
    <Dialog
      title={`Transfer ${vehicle.vin}`}
      onClose={() => !action.busy && onClose()}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button onClick={onClose} disabled={action.busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={action.busy} disabled={!outletId}>
            Transfer
          </Button>
        </>
      }
    >
      <Field label="Move the car to" hint={outlets.loading ? "Loading outlets…" : !options.length ? "There is no other active outlet to move the car to." : undefined}>
        <Select value={outletId} onChange={setOutletId} options={options} placeholder="Choose an outlet" disabled={!options.length} />
      </Field>
      {(outlets.error || action.error) && <Notice tone="error">{outlets.error ?? plainText(action.error)}</Notice>}
    </Dialog>
  );
}

export function EditVehicleDialog({ vehicle, onClose, onDone }: { vehicle: Vehicle; onClose: () => void; onDone: () => void }) {
  const action = useAction();
  const [eta, setEta] = useState(vehicle.expected_arrival_date ?? "");
  const [dispatchDate, setDispatchDate] = useState(vehicle.dispatch_date ?? "");
  const [invoiceNo, setInvoiceNo] = useState(vehicle.wholesale_invoice_no ?? "");
  const [invoiceDate, setInvoiceDate] = useState(vehicle.wholesale_invoice_date ?? "");
  const [engineNo, setEngineNo] = useState(vehicle.engine_no ?? "");

  const submit = async () => {
    const res = await action.run(
      () =>
        api.updateVehicle(vehicle.id, {
          expected_arrival_date: eta || null,
          dispatch_date: dispatchDate || null,
          wholesale_invoice_no: invoiceNo.trim() || null,
          wholesale_invoice_date: invoiceDate || null,
          engine_no: engineNo.trim() || null,
        }),
      { quiet: true, success: (r) => (r.changed ? "Car details saved." : "Nothing was changed.") },
    );
    if (res) onDone();
  };

  return (
    <Dialog
      title={`Edit details of ${vehicle.vin}`}
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
        <Field label="Expected arrival date" hint={vehicle.status === "IN_TRANSIT" ? "Customers allocated this car are told this date." : undefined}>
          <input type="date" value={eta} onChange={(e) => setEta(e.target.value)} />
        </Field>
        <Field label="Dispatch date">
          <input type="date" value={dispatchDate} onChange={(e) => setDispatchDate(e.target.value)} />
        </Field>
        <Field label="Manufacturer invoice number">
          <input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} maxLength={60} />
        </Field>
        <Field label="Manufacturer invoice date">
          <input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
        </Field>
        <Field label="Engine number">
          <input value={engineNo} onChange={(e) => setEngineNo(e.target.value)} maxLength={40} />
        </Field>
      </div>
      {action.error && <Notice tone="error">{plainText(action.error)}</Notice>}
    </Dialog>
  );
}
