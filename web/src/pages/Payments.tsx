// Finance's queue: bookings that hold a car and are not yet invoiced. Payments reported by sales and
// waiting for Finance come first, then those still awaiting payment, then those already verified.

import { api } from "../api";
import { DataSource } from "../components/DataSource";
import { Async, Card, Chip, DataTable, Empty, PageHeader, StatusChip, type Column } from "../components/ui";
import { fmtDate, fmtDateTime, fmtMoney, plural } from "../format";
import { useLoad } from "../hooks";
import { vehicleStatus, windowStage } from "../labels";
import { Link } from "../router";
import { useSession } from "../session";
import type { PaymentRow, PaymentState } from "../types";
import { PaymentButtons } from "./PaymentParts";

const GROUPS: { state: PaymentState; title: string; note: string; empty: string }[] = [
  { state: "TO_VERIFY", title: "To verify", note: "Reported by sales and waiting for Finance. The car is not re-allocated while Finance checks.", empty: "No reported payment is waiting for Finance." },
  { state: "AWAITING_PAYMENT", title: "Awaiting payment", note: "The booking holds a car and no payment has been reported yet.", empty: "No booking is awaiting payment." },
  { state: "VERIFIED", title: "Verified, not yet invoiced", note: "Finance has verified the payment. The next step is the retail invoice.", empty: "No verified payment is waiting for an invoice." },
];

export function PaymentsPage() {
  const { can } = useSession();
  const load = useLoad(() => api.payments(), "payments");
  /** Finance acts on a payment until it is verified; sales reports one only while none has been reported. */
  const mayAct = (state: PaymentState) => state !== "VERIFIED" && (can("booking.payment") || (can("booking.payment_report") && state === "AWAITING_PAYMENT"));

  const columns = (state: PaymentState): Column<PaymentRow>[] => [
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
    ...(state === "TO_VERIFY" ? [{ header: "Flag", status: true, hideIfEmpty: (r: PaymentRow) => !r.overdue, cell: (r: PaymentRow) => (r.overdue ? <Chip tone="red">Overdue</Chip> : null) } satisfies Column<PaymentRow>] : []),
    {
      header: "Car",
      cell: (r) => (
        <span>
          <span>
            {r.model} {r.variant}
          </span>
          <span className="sub">
            {r.colour} · <span className="mono">{r.vin}</span> · {vehicleStatus(r.vehicle_status).text.toLowerCase()}
          </span>
        </span>
      ),
    },
    { header: "Outlet", cell: (r) => r.outlet },
    ...(state !== "AWAITING_PAYMENT"
      ? [
          {
            header: "Reported",
            cell: (r: PaymentRow) =>
              r.payment_reported_at ? (
                <span>
                  <span>{r.payment_reported_by_name ?? "—"}</span>
                  <span className="sub">{fmtDateTime(r.payment_reported_at)}</span>
                </span>
              ) : (
                <span className="muted">—</span>
              ),
          } satisfies Column<PaymentRow>,
          { header: "Amount", num: true, cell: (r: PaymentRow) => (r.payment_amount === null ? <span className="muted">—</span> : fmtMoney(r.payment_amount)) } satisfies Column<PaymentRow>,
          { header: "Reference", cell: (r: PaymentRow) => r.payment_ref ?? <span className="muted">—</span> } satisfies Column<PaymentRow>,
        ]
      : []),
    ...(state === "VERIFIED"
      ? [
          {
            header: "Verified",
            cell: (r: PaymentRow) => (
              <span>
                <span>{r.payment_verified_by_name ?? "—"}</span>
                <span className="sub">{fmtDateTime(r.payment_received_at)}</span>
              </span>
            ),
          } satisfies Column<PaymentRow>,
        ]
      : [
          {
            header: "Payment window",
            cell: (r: PaymentRow) =>
              r.window ? (
                <span>
                  <StatusChip label={windowStage(r.window.stage)} />
                  <span className="sub">
                    Day {r.window.day} · re-allocation on {fmtDate(r.window.release_on)}
                  </span>
                </span>
              ) : (
                <span className="muted">Starts when the car arrives</span>
              ),
          } satisfies Column<PaymentRow>,
        ]),
    ...(mayAct(state)
      ? [
          {
            header: "Actions",
            actions: true,
            cell: (r: PaymentRow) => (
              <span className="row-actions">
                <PaymentButtons booking={{ ...r, id: r.booking_id }} onDone={() => void load.reload()} size="sm" primary={state === "TO_VERIFY"} />
              </span>
            ),
          } satisfies Column<PaymentRow>,
        ]
      : []),
  ];

  return (
    <>
      <PageHeader title="Payments" subtitle="Sales reports a payment; Finance verifies that it has been received. Only verification stops the payment window." />
      <DataSource />
      <Async load={load} isEmpty={() => false}>
        {(rows) =>
          GROUPS.map((g) => {
            const list = rows.filter((r) => r.state === g.state);
            const overdue = list.filter((r) => r.overdue).length;
            return (
              <Card key={g.state} title={`${g.title} (${list.length})`} note={g.note} flush>
                {list.length ? (
                  <>
                    {g.state === "TO_VERIFY" && overdue > 0 && <p className="list-count danger">{plural(overdue, "payment has", "payments have")} waited longer than the time agreed for Finance to verify.</p>}
                    <DataTable columns={columns(g.state)} rows={list} rowKey={(r) => r.booking_id} caption={g.title} />
                  </>
                ) : (
                  <Empty title={g.empty} />
                )}
              </Card>
            );
          })
        }
      </Async>
    </>
  );
}
