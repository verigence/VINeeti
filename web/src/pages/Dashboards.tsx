import { useState } from "react";
import { api } from "../api";
import { configInput, configReady, ConfigSelects, useCatalog, type CarConfig } from "../components/ConfigPicker";
import { DataSource } from "../components/DataSource";
import { Dialog } from "../components/Dialog";
import { RunAllocationButton } from "../components/RunAllocation";
import { Async, Button, Card, Chip, DataTable, Empty, Field, Notice, PageHeader, Select, StatusChip, Tabs, type Column } from "../components/ui";
import { fmtDate, fmtNumber, plural, today } from "../format";
import { useAction, useLoad } from "../hooks";
import { allocationType, bookingStatus, ORDER_STATUS_OPTIONS, orderQueueStatus, orderStatus, plainText, vehicleStatus } from "../labels";
import { Link } from "../router";
import { useSession } from "../session";
import type { AllocationDashRow, DelayedRow, MatchRow, OrderQueueRow, OrderRow, OrderStatus, PaymentWindow } from "../types";

type Tab = "allocation" | "orders" | "delayed" | "alternatives";

export function DashboardsPage({ tab }: { tab: Tab }) {
  return (
    <>
      <PageHeader title="Day's work" subtitle="Who is waiting, what to order, and which deliveries are running late." />
      <DataSource />
      <Tabs
        current={`/dashboards/${tab}`}
        tabs={[
          { to: "/dashboards/allocation", label: "Stock allocation" },
          { to: "/dashboards/orders", label: "Order queue" },
          { to: "/dashboards/delayed", label: "Delayed deliveries" },
          { to: "/dashboards/alternatives", label: "Alternatives available" },
        ]}
      />
      {tab === "allocation" && <AllocationDashboard />}
      {tab === "orders" && <OrderQueueDashboard />}
      {tab === "delayed" && <DelayedDashboard />}
      {tab === "alternatives" && <AlternativesDashboard />}
    </>
  );
}

const BookingCell = ({ id, no, customer }: { id: string; no: string; customer: string }) => (
  <Link to={`/bookings/${id}`} className="cell-link">
    <span className="strong nowrap">{no}</span>
    <span className="sub">{customer}</span>
  </Link>
);
const CarCell = ({ r }: { r: { model: string; variant: string; colour: string } }) => (
  <>
    <span>
      {r.model} {r.variant}
    </span>
    <span className="sub">{r.colour}</span>
  </>
);

function windowSummary(w: PaymentWindow | null, r: AllocationDashRow) {
  if (r.payment_received_at) return <Chip tone="green">Payment verified</Chip>;
  if (r.booking_status === "INVOICED") return <Chip tone="indigo">Invoiced</Chip>;
  if (!w) return <span className="muted">Starts when the car arrives</span>;
  const tone = w.stage === "ESCALATED" ? "red" : w.stage === "REMINDED" ? "amber" : "grey";
  const text = w.stage === "ESCALATED" ? "Escalated" : w.stage === "REMINDED" ? "Reminder sent" : "Waiting for payment";
  return (
    <>
      <Chip tone={tone}>
        Day {w.day} · {text}
      </Chip>
      <span className="sub">Re-allocated on {fmtDate(w.release_on)}</span>
    </>
  );
}

function AllocationDashboard() {
  const { can } = useSession();
  const load = useLoad(() => api.allocationDashboard(), "dash:allocation");
  const columns: Column<AllocationDashRow>[] = [
    { header: "Booking", primary: true, cell: (r) => <BookingCell id={r.booking_id} no={r.booking_no} customer={r.customer_name} /> },
    { header: "Car", cell: (r) => <CarCell r={r} /> },
    { header: "Outlet", cell: (r) => r.outlet },
    {
      header: "Car reserved",
      cell: (r) => (
        <>
          {can("stock.view") ? (
            <Link to={`/stock/cars/${r.vehicle_id}`} className="mono">
              {r.vin}
            </Link>
          ) : (
            <span className="mono">{r.vin}</span>
          )}
          <span className="sub">
            {r.allocated_by === "DMS" ? "Allotted in DMS" : allocationType(r.type)} · {fmtDate(r.allocated_at)}
          </span>
        </>
      ),
    },
    {
      header: "Where the car is",
      cell: (r) => (
        <>
          <span className="chips">
            <StatusChip label={vehicleStatus(r.vehicle_status)} />
            {r.needs_transfer ? <Chip tone="amber">Transfer needed</Chip> : null}
          </span>
          <span className="sub">
            {r.vehicle_outlet}
            {r.vehicle_status === "IN_TRANSIT" ? (r.expected_arrival_date ? `, expected ${fmtDate(r.expected_arrival_date)}` : ", no arrival date known") : ""}
          </span>
        </>
      ),
    },
    { header: "Payment window", cell: (r) => windowSummary(r.window, r) },
    { header: "Delivery by", cell: (r) => (r.expected_delivery_date ? fmtDate(r.expected_delivery_date) : <span className="muted">—</span>), hideIfEmpty: (r) => !r.expected_delivery_date },
  ];
  return (
    <Card title="Bookings holding a car" note="Every active allocation, with where the car is and where the customer stands in the payment window." actions={can("allocation.run") ? <RunAllocationButton onDone={() => void load.reload()} /> : undefined} flush>
      <Async load={load} empty={<Empty title="No car is allocated right now" hint="Allocations appear here as soon as an approved booking is matched to a car." />}>
        {(rows) => (
          <>
            <p className="list-count">{plural(rows.length, "allocation")}</p>
            <DataTable columns={columns} rows={rows} rowKey={(r) => r.allocation_id} caption="Active allocations" />
          </>
        )}
      </Async>
    </Card>
  );
}

function OrderQueueDashboard() {
  const { can } = useSession();
  const queue = useLoad(() => api.orderQueue(), "dash:order-queue");
  const orders = useLoad(() => api.orders(), "dash:orders");
  const [dialog, setDialog] = useState<{ prefill?: OrderQueueRow; order?: OrderRow } | null>(null);
  const manage = can("orders.manage");
  const reload = () => {
    void queue.reload();
    void orders.reload();
  };

  const queueColumns: Column<OrderQueueRow>[] = [
    { header: "Car", primary: true, cell: (r) => <CarCell r={r} /> },
    { header: "Waiting", num: true, cell: (r) => <span className="strong">{fmtNumber(r.waiting)}</span> },
    { header: "On hold", num: true, cell: (r) => fmtNumber(r.on_hold) },
    { header: "Earliest booking", cell: (r) => fmtDate(r.earliest_booking) },
    { header: "Earliest promised delivery", cell: (r) => (r.earliest_commitment ? <span className={r.earliest_commitment < today() ? "danger" : undefined}>{fmtDate(r.earliest_commitment)}</span> : <span className="muted">—</span>), hideIfEmpty: (r) => !r.earliest_commitment },
    { header: "On order", num: true, cell: (r) => fmtNumber(r.on_order) },
    { header: "Still to order", num: true, cell: (r) => <span className={r.to_order ? "strong danger" : "muted"}>{fmtNumber(r.to_order)}</span> },
    { header: "Order expected", cell: (r) => (r.expected_date ? fmtDate(r.expected_date) : <span className="muted">—</span>), hideIfEmpty: (r) => !r.expected_date },
    { header: "Status", status: true, cell: (r) => <StatusChip label={orderQueueStatus(r.status)} /> },
    ...(manage
      ? [
          {
            header: "Actions",
            actions: true,
            cell: (r: OrderQueueRow) => (
              <Button size="sm" onClick={() => setDialog({ prefill: r })}>
                Record order
              </Button>
            ),
          } satisfies Column<OrderQueueRow>,
        ]
      : []),
  ];

  const orderColumns: Column<OrderRow>[] = [
    { header: "Car", primary: true, cell: (r) => <CarCell r={r} /> },
    { header: "Quantity", num: true, cell: (r) => fmtNumber(r.quantity) },
    { header: "Status", status: true, cell: (r) => <StatusChip label={orderStatus(r.status)} /> },
    { header: "Manufacturer reference", cell: (r) => r.oem_reference ?? <span className="muted">—</span>, hideIfEmpty: (r) => !r.oem_reference },
    { header: "Expected", cell: (r) => (r.expected_date ? fmtDate(r.expected_date) : <span className="muted">—</span>), hideIfEmpty: (r) => !r.expected_date },
    { header: "Notes", cell: (r) => r.notes ?? <span className="muted">—</span>, hideIfEmpty: (r) => !r.notes },
    {
      header: "Recorded",
      cell: (r) => (
        <>
          <span>{fmtDate(r.created_at)}</span>
          <span className="sub">{r.created_by_name ?? "A former user"}</span>
        </>
      ),
    },
    ...(manage
      ? [
          {
            header: "Actions",
            actions: true,
            cell: (r: OrderRow) => (
              <Button size="sm" onClick={() => setDialog({ order: r })}>
                Update
              </Button>
            ),
          } satisfies Column<OrderRow>,
        ]
      : []),
  ];

  return (
    <>
      <Card title="What needs ordering" note="Waiting bookings with no free car, less what is already on order with the manufacturer." flush>
        <Async load={queue} empty={<Empty title="Nothing to order" hint="No approved booking is waiting for a car." />}>
          {(rows) => <DataTable columns={queueColumns} rows={rows} rowKey={(r) => `${r.model}|${r.variant}|${r.colour}`} caption="Order queue" />}
        </Async>
      </Card>
      <Card
        title="Orders placed with the manufacturer"
        note="Orders marked placed or confirmed count as on order above."
        actions={
          manage ? (
            <Button variant="primary" icon="plus" onClick={() => setDialog({})}>
              Record an order
            </Button>
          ) : undefined
        }
        flush
      >
        <Async load={orders} empty={<Empty title="No orders recorded yet" hint={manage ? "Record an order when it is placed with the manufacturer, so the order queue stays accurate." : undefined} />}>
          {(rows) => <DataTable columns={orderColumns} rows={rows} rowKey={(r) => r.id} caption="Manufacturer orders" />}
        </Async>
      </Card>
      {dialog && (
        <OrderDialog
          prefill={dialog.prefill}
          order={dialog.order}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            reload();
          }}
        />
      )}
    </>
  );
}

function OrderDialog({ prefill, order, onClose, onDone }: { prefill?: OrderQueueRow; order?: OrderRow; onClose: () => void; onDone: () => void }) {
  const catalog = useCatalog();
  const action = useAction();
  const [config, setConfig] = useState<CarConfig>({ variant_id: "", model: order?.model ?? prefill?.model ?? "", variant: order?.variant ?? prefill?.variant ?? "", colour: order?.colour ?? prefill?.colour ?? "" });
  const [quantity, setQuantity] = useState(String(order?.quantity ?? (prefill?.to_order || 1)));
  const [status, setStatus] = useState<OrderStatus>(order?.status ?? "PLACED");
  const [reference, setReference] = useState(order?.oem_reference ?? "");
  const [expected, setExpected] = useState(order?.expected_date ?? "");
  const [notes, setNotes] = useState(order?.notes ?? "");
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async () => {
    const qty = Number(quantity);
    if (!order && !configReady(config)) return setProblem("Choose the model, variant and colour.");
    if (!Number.isInteger(qty) || qty < 1 || qty > 500) return setProblem("The quantity must be a whole number between 1 and 500.");
    setProblem(null);
    const res = order
      ? await action.run(() => api.updateOrder(order.id, { status, quantity: qty, oem_reference: reference.trim(), expected_date: expected || null, notes: notes.trim() }), { quiet: true, success: "Order updated." })
      : await action.run(() => api.createOrder({ ...configInput(config), quantity: qty, oem_reference: reference.trim() || undefined, expected_date: expected || undefined, notes: notes.trim() || undefined }), { quiet: true, success: "Order recorded." });
    if (res) onDone();
  };

  return (
    <Dialog
      title={order ? "Update manufacturer order" : "Record an order placed with the manufacturer"}
      wide
      onClose={() => !action.busy && onClose()}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button onClick={onClose} disabled={action.busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={action.busy}>
            {order ? "Save" : "Record order"}
          </Button>
        </>
      }
    >
      <div className="form-grid">
        {order ? (
          <p className="field-wide">
            <span className="strong">
              {order.model} {order.variant}
            </span>
            , {order.colour}
          </p>
        ) : catalog.data ? (
          <ConfigSelects catalog={catalog.data} value={config} onChange={setConfig} />
        ) : (
          <p className="muted field-wide">{catalog.error ?? "Loading the vehicle master…"}</p>
        )}
        <Field label="Quantity">
          <input type="number" min={1} max={500} step={1} value={quantity} onChange={(e) => setQuantity(e.target.value)} inputMode="numeric" />
        </Field>
        {order && (
          <Field label="Status" hint="Closed and cancelled orders no longer count as on order.">
            <Select value={status} onChange={(v) => setStatus(v as OrderStatus)} options={ORDER_STATUS_OPTIONS} />
          </Field>
        )}
        <Field label="Expected date" optional>
          <input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} />
        </Field>
        <Field label="Manufacturer reference" optional>
          <input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={80} />
        </Field>
        <Field label="Notes" optional wide>
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
        </Field>
      </div>
      {(problem || action.error) && <Notice tone="error">{problem ?? plainText(action.error)}</Notice>}
    </Dialog>
  );
}

function DelayedDashboard() {
  const load = useLoad(() => api.delayed(), "dash:delayed");
  const columns: Column<DelayedRow>[] = [
    { header: "Booking", primary: true, cell: (r) => <BookingCell id={r.booking_id} no={r.booking_no} customer={r.customer_name} /> },
    { header: "Car", cell: (r) => <CarCell r={r} /> },
    { header: "Outlet", cell: (r) => r.outlet },
    { header: "Promised delivery", cell: (r) => fmtDate(r.expected_delivery_date) },
    { header: "Delay", num: true, cell: (r) => <span className="strong danger">{plural(r.delay_days, "day")}</span> },
    { header: "Reason", cell: (r) => r.reason },
    { header: "Status", status: true, cell: (r) => <StatusChip label={bookingStatus(r.status, r.on_hold)} /> },
    { header: "Car reserved", cell: (r) => (r.vin ? <span className="mono">{r.vin}</span> : <span className="muted">None</span>), hideIfEmpty: (r) => !r.vin },
  ];
  return (
    <Card title="Bookings past their promised delivery date" note="Open bookings that are late, and cars delivered late in the last 45 days." flush>
      <Async load={load} empty={<Empty title="No delayed deliveries" hint="Every open booking is within its promised delivery date." />}>
        {(rows) => (
          <>
            <p className="list-count">{plural(rows.length, "booking")}</p>
            <DataTable columns={columns} rows={rows} rowKey={(r) => r.booking_id} caption="Delayed deliveries" />
          </>
        )}
      </Async>
    </Card>
  );
}

/** Waiting customers who could be offered the same model and variant in another colour that is free. */
function AlternativesDashboard() {
  const load = useLoad(() => api.matches(), "dash:alternatives");
  const columns: Column<MatchRow>[] = [
    { header: "Booking", primary: true, cell: (r) => <BookingCell id={r.booking_id} no={r.booking_no} customer={r.customer_name} /> },
    {
      header: "Booked car",
      cell: (r) => (
        <span>
          <span>
            {r.model} {r.variant}
          </span>
          <span className="sub">
            {r.colour} · booked {fmtDate(r.booking_date)}
          </span>
        </span>
      ),
    },
    {
      // Counted to the dealership's today on the server, so it reads the same for everyone.
      header: "Waiting",
      num: true,
      cell: (r) => (r.days_waiting === null ? <span className="muted">—</span> : <span className={r.days_waiting >= 60 ? "strong danger" : undefined}>{plural(r.days_waiting, "day")}</span>),
    },
    { header: "Outlet", cell: (r) => r.outlet },
    { header: "Sales consultant", cell: (r) => r.sales_exec ?? <span className="muted">—</span>, hideIfEmpty: (r) => !r.sales_exec },
    {
      header: "Free in another colour",
      cell: (r) => (
        <ul className="plain-list">
          {r.options.map((o) => (
            <li key={o.colour}>
              <span className="strong">{o.colour}</span>
              <span className="sub">
                {fmtNumber(o.in_yard)} in yard · {fmtNumber(o.in_transit)} in transit
              </span>
            </li>
          ))}
        </ul>
      ),
    },
  ];
  return (
    <>
      <Notice>What the sales team can honestly offer instead. Nothing is allocated unless the booking is changed in the DMS.</Notice>
      <Card title="Alternatives available" note="Waiting customers with no free car in their colour, where the same model and variant is free in another colour. Longest wait first." flush>
        <Async load={load} empty={<Empty title="No alternative to offer anyone" hint="No waiting customer has the same model and variant free in another colour." />}>
          {(rows) => (
            <>
              <p className="list-count">{plural(rows.length, "customer")}</p>
              <DataTable columns={columns} rows={rows} rowKey={(r) => r.booking_id} caption="Alternatives available" />
            </>
          )}
        </Async>
      </Card>
    </>
  );
}
