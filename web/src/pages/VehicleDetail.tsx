import { useState } from "react";
import { api } from "../api";
import { ConfirmDialog } from "../components/Dialog";
import { carItems } from "../components/CarSpec";
import { Async, Button, Card, Chip, DataTable, Empty, KeyValues, Notice, PageHeader, StatusChip } from "../components/ui";
import { daysBetween, fmtDate, fmtDateTime, fmtMoney, plural, today } from "../format";
import { useAction, useLoad } from "../hooks";
import { actorName, allocationMessage, allocationStatus, allocationType, dmsStockType, plainText, releaseReason, vehicleEventText, vehicleStatus } from "../labels";
import { Link } from "../router";
import { useSession } from "../session";
import type { VehicleDetail, WithAllocations } from "../types";
import { EditVehicleDialog, TransferDialog } from "./VehicleDialogs";

type DialogKind = "transfer" | "edit" | "block" | "remove" | "receive" | null;

export function VehicleDetailPage({ id }: { id: string }) {
  const load = useLoad(() => api.vehicle(id), `vehicle:${id}`);
  return (
    <Async load={load} isEmpty={() => false} loadingLabel="Loading car">
      {(d) => <VehicleView d={d} reload={load.reload} />}
    </Async>
  );
}

function VehicleView({ d, reload }: { d: VehicleDetail; reload: () => Promise<void> }) {
  const { can, worksAt, outletName } = useSession();
  const action = useAction();
  const [dialog, setDialog] = useState<DialogKind>(null);
  const v = d.vehicle;
  const inStock = v.status === "IN_TRANSIT" || v.status === "RECEIVED";
  const manage = can("stock.manage") && worksAt(v.outlet_id);
  const current = d.allocations.find((a) => a.status === "ACTIVE");
  const history = d.allocations.filter((a) => a.status !== "ACTIVE");
  // Days since the manufacturer's invoice, counted the way the cars list counts it.
  const ageDays = v.wholesale_invoice_date ? Math.max(0, daysBetween(v.wholesale_invoice_date, today())) : null;
  const stockType = dmsStockType(v.dms_stock_type);
  const bookingRef = (a: { booking_id: string | null; booking_no: string | null }) => (a.booking_id && a.booking_no ? can("booking.view") ? <Link to={`/bookings/${a.booking_id}`}>{a.booking_no}</Link> : a.booking_no : "Allocated");

  const act = async (fn: () => Promise<WithAllocations>, done: string) => {
    const res = await action.run(fn, { quiet: dialog !== null, success: (r) => `${done} ${allocationMessage(r.allocations)}`.trim() });
    if (res) {
      setDialog(null);
      await reload();
    }
  };

  return (
    <>
      <PageHeader
        back={{ to: "/stock/cars", label: "Cars" }}
        title={<span className="mono">{v.vin}</span>}
        subtitle={`${v.model} ${v.variant}, ${v.colour}`}
        primary={
          manage && v.status === "IN_TRANSIT" ? (
            <Button variant="primary" disabled={action.busy} onClick={() => setDialog("receive")}>
              Mark received
            </Button>
          ) : undefined
        }
        actions={
          manage && inStock ? (
            <>
              <Button disabled={action.busy} onClick={() => setDialog("transfer")}>
                Transfer
              </Button>
              <Button disabled={action.busy} onClick={() => setDialog("edit")}>
                Edit details
              </Button>
              {v.is_blocked ? (
                <Button busy={action.busy && dialog === null} onClick={() => void act(() => api.unblockVehicle(v.id), "Block removed.")}>
                  Unblock
                </Button>
              ) : (
                <Button disabled={action.busy} onClick={() => setDialog("block")}>
                  Block
                </Button>
              )}
              <Button variant="danger" disabled={action.busy} onClick={() => setDialog("remove")}>
                Remove from stock
              </Button>
            </>
          ) : undefined
        }
      />

      {v.is_blocked ? (
        <Notice tone="warn" title="This car is blocked and cannot be allocated. ">
          {v.block_reason ?? ""}
        </Notice>
      ) : null}
      {can("stock.manage") && inStock && !worksAt(v.outlet_id) && <Notice>This car belongs to an outlet you do not work in, so you can view it but not change it.</Notice>}

      <div className="detail-grid">
        <div className="detail-main">
          <Card title="Car">
            <div className="chips chips-row">
              <StatusChip label={vehicleStatus(v.status)} />
              {v.is_demo ? <Chip tone="purple">Demo</Chip> : null}
              {v.is_blocked ? <Chip tone="red">Blocked</Chip> : null}
              {inStock && !v.is_blocked && (current ? <Chip tone="teal">Allocated</Chip> : <Chip tone="green">Free</Chip>)}
            </div>
            <KeyValues
              columns={3}
              items={[
                ...carItems(v),
                ["DMS stock type", stockType?.text],
                ["Where it is", vehicleStatus(v.status).text],
                ["Outlet", v.outlet ?? outletName(v.outlet_id)],
                ["Age", ageDays === null ? null : plural(ageDays, "day")],
                ["Demo car", v.is_demo ? "Yes" : "No"],
                v.dms_booking_no ? ["Order number", <span className="mono">{v.dms_booking_no}</span>] : null,
                ["OEM model code", v.oem_model_code],
                ["OEM colour code", v.oem_colour_code],
                ["DMS description", v.description],
                v.net_dealer_price !== undefined && v.net_dealer_price !== null ? ["Net dealer price", fmtMoney(v.net_dealer_price)] : null,
                ["Engine number", v.engine_no],
                ["Manufacturer invoice", v.wholesale_invoice_no ? `${v.wholesale_invoice_no}${v.wholesale_invoice_date ? ` · ${fmtDate(v.wholesale_invoice_date)}` : ""}` : v.wholesale_invoice_date ? fmtDate(v.wholesale_invoice_date) : null],
                ["Dispatched from plant", v.dispatch_date ? fmtDate(v.dispatch_date) : null],
                ["Expected arrival", v.expected_arrival_date ? fmtDate(v.expected_arrival_date) : null],
                ["Received", v.received_at ? fmtDateTime(v.received_at) : null],
                v.invoiced_at ? ["Invoiced to customer", fmtDateTime(v.invoiced_at)] : null,
                v.delivered_at ? ["Delivered", fmtDateTime(v.delivered_at)] : null,
              ]}
            />
          </Card>

          <Card title="Allocation">
            {current ? (
              <KeyValues
                items={[
                  ["Allocated to booking", bookingRef(current)],
                  ["Type", allocationType(current.type)],
                  ["Allocated on", fmtDateTime(current.allocated_at)],
                  ["Transfer", current.needs_transfer ? "Needs a transfer to the customer's outlet" : "Not needed"],
                ]}
              />
            ) : (
              <p className="muted">{inStock ? (v.is_blocked ? "Blocked cars are not allocated." : "This car is free. It goes to the next waiting booking for this model, variant and colour.") : "No current allocation."}</p>
            )}
            {history.length > 0 && (
              <>
                <h3 className="section-title">Earlier allocations</h3>
                <DataTable
                  columns={[
                    { header: "Booking", primary: true, cell: (a) => bookingRef(a) },
                    { header: "Type", cell: (a) => allocationType(a.type) },
                    { header: "Allocated", cell: (a) => fmtDateTime(a.allocated_at) },
                    { header: "Outcome", status: true, cell: (a) => <StatusChip label={allocationStatus(a.status)} /> },
                    { header: "Released", cell: (a) => (a.released_at ? `${fmtDateTime(a.released_at)}: ${releaseReason(a.release_reason)}` : "—"), hideIfEmpty: (a) => !a.released_at },
                  ]}
                  rows={history}
                  rowKey={(a) => a.id}
                  caption="Earlier allocations of this car"
                />
              </>
            )}
          </Card>
        </div>

        <Card title="Movement history" className="detail-side">
          {d.events.length ? (
            <ol className="timeline">
              {d.events.map((e, i) => (
                <li key={i}>
                  <p>{vehicleEventText(e, outletName)}</p>
                  <p className="meta">
                    {fmtDateTime(e.at)} · {actorName(e.actor, e.actor_name)}
                  </p>
                </li>
              ))}
            </ol>
          ) : (
            <Empty title="No movements recorded" />
          )}
        </Card>
      </div>

      {dialog === "receive" && (
        <ConfirmDialog
          title="Mark this car as received?"
          message={
            current
              ? `The customer on ${current.booking_no ? `booking ${current.booking_no}` : "the booking that holds it"} will be told the car has arrived, and the payment window starts today.`
              : "The car moves to the yard and is offered to the next waiting booking."
          }
          confirmLabel="Mark received"
          busy={action.busy}
          error={plainText(action.error)}
          onCancel={() => setDialog(null)}
          onConfirm={() => void act(() => api.receiveVehicle(v.id), "Car marked as received.")}
        />
      )}
      {dialog === "block" && (
        <ConfirmDialog
          title="Block this car?"
          message={current ? "A blocked car cannot be allocated. The booking that holds this car will lose it and go back to the queue." : "A blocked car cannot be allocated until it is unblocked."}
          confirmLabel="Block car"
          danger
          reason="required"
          reasonLabel="Reason"
          reasonHint="For example: transit damage, held for inspection."
          busy={action.busy}
          error={plainText(action.error)}
          onCancel={() => setDialog(null)}
          onConfirm={(reason) => void act(() => api.blockVehicle(v.id, reason), "Car blocked.")}
        />
      )}
      {dialog === "remove" && (
        <ConfirmDialog
          title="Remove this car from stock?"
          message={`This cannot be undone here.${current ? " The booking that holds this car will lose it and go back to the queue." : ""} Use it when a car is returned to the manufacturer, sold to another dealer or was entered by mistake.`}
          confirmLabel="Remove from stock"
          danger
          reason="required"
          busy={action.busy}
          error={plainText(action.error)}
          onCancel={() => setDialog(null)}
          onConfirm={(reason) => void act(() => api.removeVehicle(v.id, reason), "Car removed from stock.")}
        />
      )}
      {dialog === "transfer" && (
        <TransferDialog
          vehicle={v}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            void reload();
          }}
        />
      )}
      {dialog === "edit" && (
        <EditVehicleDialog
          vehicle={v}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            void reload();
          }}
        />
      )}
    </>
  );
}
