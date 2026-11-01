// Exception requests: anything that departs from the standard queue goes through request,
// independent approval and a permanent record (step 10 of the process: change in priority / skip
// allocation, plus deferrals, outlet changes, manual allocation and payment-window extensions).

import type { Ctx, SessionUser } from "../env";
import { all, alertStmt, auditStmt, doneAlertStmt, first, isGuardFailure, stmt, type Guard } from "../lib/db";
import { bad, conflict, forbidden, HttpError, iso, localParts, newId, notFound, parseDate, parseDateTime, safeJson } from "../lib/util";
import { activeAllocationForBooking, allocateConfig, bookingsPassedOver, manualAllocate, reallocateToBooking, releaseAllocation, type BookingRow, type Config } from "./allocation";
import { getBooking } from "./bookings";
import { DEFERRAL_KEEP_DAYS, requestable } from "./release-reasons";

/** Whole days from one business date to another, both `YYYY-MM-DD`. */
const daysApart = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
import { queueFor, type Waiting } from "./queue";
import { queueCompare, queueValues, type QueueBooking } from "./rules";
import { windowSchedule } from "./timers";

/**
 * Every type ever written, because the rows that carry them have to keep reading. MANUAL_ALLOCATION
 * is retired — see TYPES — but its history stays, and a request raised before it was retired can
 * still be decided.
 */
export type ExceptionType = "PRIORITY_CHANGE" | "SKIP_ALLOCATION" | "DEFER_DELIVERY" | "OUTLET_CHANGE" | "MANUAL_ALLOCATION" | "WINDOW_EXTENSION" | "RELEASE_ALLOCATION" | "OTHER";

/**
 * What may be raised now. MANUAL_ALLOCATION is deliberately absent: pairing a free car with a
 * booking of someone's choosing is what the queue is for, and a dealership that can do it by hand
 * has no queue. Taking a car away from the customer holding it is a different act and is what
 * RELEASE_ALLOCATION is for — it names a loser, not just a winner.
 */
const TYPES: ExceptionType[] = ["PRIORITY_CHANGE", "SKIP_ALLOCATION", "DEFER_DELIVERY", "OUTLET_CHANGE", "WINDOW_EXTENSION", "RELEASE_ALLOCATION", "OTHER"];

export interface ExceptionRow {
  id: string;
  type: ExceptionType;
  booking_id: string;
  vehicle_id: string | null;
  payload_json: string;
  reason: string;
  status: string;
  requested_by: string;
  requested_at: string;
  decided_by: string | null;
}

export interface ExceptionInput {
  type: ExceptionType;
  booking_id: string;
  vehicle_id?: string | null;
  payload?: Record<string, unknown>;
  reason: string;
}

/** The car being taken off a booking, as much of it as the checks need. */
interface ReleaseCar {
  id: string;
  vin: string;
  model: string;
  variant: string;
  colour: string;
  status: string;
  is_blocked: number;
}

/** The booking that is to receive it, with what the queue rules need to rank it. */
interface Receiving {
  id: string;
  booking_no: string;
  customer_name: string;
  outlet_id: string;
  model: string;
  variant: string;
  colour: string;
  status: string;
  on_hold: number;
  priority_ts: string;
  booking_date: string;
  priority_override_json: string | null;
  expected_delivery_date: string | null;
  booking_amount: number;
}

/**
 * "Move ahead of booking X" under any queue rules: the booking takes X's ranking values (delivery
 * commitment, booking amount) and a queue date one second earlier, so whatever order the dealership's
 * rules give, it stands immediately before X and nowhere further up.
 */
function aheadOf(other: QueueBooking): { priority_ts: string; priority_override_json: string } {
  const v = queueValues(other);
  return { priority_ts: new Date(new Date(v.date).getTime() - 1000).toISOString(), priority_override_json: JSON.stringify({ expected_delivery_date: v.commitment, booking_amount: v.amount }) };
}

/**
 * The booking a release request names as the one to receive the car, checked, and described for the
 * approver. Returns nothing when none was named: only REALLOCATED_TO_BOOKING has to name one, and the
 * other reasons may, in which case the car goes there instead of back to the queue.
 *
 * It lives here rather than in each reason's branch because the checks are the same whatever the
 * reason: who is giving the car up does not change what the booking taking it has to be.
 */
async function namedReceiver(ctx: Ctx, p: Record<string, unknown>, from: BookingRow, car: ReleaseCar): Promise<Record<string, unknown>> {
  const id = String(p.to_booking_id ?? "").trim();
  if (!id) return {};
  const to = await first<Receiving>(
    ctx.db,
    `SELECT id, booking_no, customer_name, outlet_id, model, variant, colour, status, on_hold, priority_ts, booking_date, priority_override_json, expected_delivery_date, booking_amount
     FROM bookings WHERE id = ? AND tenant_id = ?`,
    id, ctx.tenantId,
  );
  if (!to) throw bad("The booking to give the car to was not found");
  if (to.id === from.id) throw bad("That is the booking the car is already held for");
  // These three are about the state of the receiving booking, which can change between the request
  // being raised and an approver reaching it, so they are conflicts rather than bad input: the
  // request stays pending and can be approved once it is true again.
  if (to.status !== "APPROVED") throw conflict("The car can only go to a booking that is waiting for one");
  if (to.on_hold) throw conflict("That booking is on hold, so it is not waiting for a car");
  if (await activeAllocationForBooking(ctx, to.id)) throw conflict("That booking already holds a car");
  // A customer gets the car they booked. Handing them a different colour or trim is a different sale
  // and belongs in a changed booking, not in a release request.
  if (car.model !== to.model || car.variant !== to.variant || car.colour !== to.colour) {
    throw bad(`Booking ${to.booking_no} is for a ${to.colour} ${to.model} ${to.variant}, and this car is a ${car.colour} ${car.model} ${car.variant}. Change the booking first if the customer has agreed to this car.`);
  }
  // What the approver has to see: taking this car off one customer and giving it to another may also
  // step over people who have waited longer than either of them.
  const passed = await bookingsPassedOver(ctx, to as unknown as BookingRow, car, true);
  return {
    to_booking_id: to.id,
    to_booking_no: to.booking_no,
    to_customer_name: to.customer_name,
    jumped: passed.length,
    jumped_booking_nos: passed.slice(0, 10).map((x) => x.booking_no),
  };
}

/** Checks the request up front so an approver never sees one that cannot be applied. */
async function validate(ctx: Ctx, input: ExceptionInput, deciding?: string): Promise<Record<string, unknown>> {
  const p = input.payload ?? {};
  const b = await getBooking(ctx, input.booking_id);
  if (["CANCELLED", "DELIVERED", "INVOICED", "DRAFT", "REJECTED"].includes(b.status)) throw conflict(`An exception cannot be raised on a booking that is ${b.status.toLowerCase()}`);
  const today = localParts(ctx.now, ctx.tenant.timezone).date;
  switch (input.type) {
    case "PRIORITY_CHANGE": {
      // What the change would do to the queue is worked out now and shown to the approver.
      const effect = async (change: Partial<Waiting>) => {
        if (b.status !== "APPROVED" || b.on_hold) return {};
        const q = await queueFor(ctx, b);
        const from = q.findIndex((x) => x.id === b.id) + 1;
        const moved = q.map((x) => (x.id === b.id ? { ...x, ...change } : x)).sort(queueCompare(ctx.settings));
        return from ? { from_position: from, to_position: moved.findIndex((x) => x.id === b.id) + 1, waiting: q.length } : {};
      };
      if (p.before_booking_id) {
        const other = await first<Waiting>(ctx.db, `SELECT id, booking_no, outlet_id, model, variant, colour, priority_ts, expected_delivery_date, booking_amount, priority_override_json FROM bookings WHERE id = ? AND tenant_id = ?`, String(p.before_booking_id), ctx.tenantId);
        if (!other) throw bad("The booking to move ahead of was not found");
        if (other.id === b.id) throw bad("Choose a different booking to move ahead of");
        if (other.model !== b.model || other.variant !== b.variant || other.colour !== b.colour) throw bad("Both bookings must be for the same model, variant and colour");
        return { before_booking_id: other.id, ...(await effect(aheadOf(other))) };
      }
      const ts = parseDateTime(p.new_priority_ts, ctx.tenant.timezone);
      if (!ts) throw bad("Give the booking to move ahead of, or a new priority date");
      return { new_priority_ts: ts, ...(await effect({ priority_ts: ts })) };
    }
    case "SKIP_ALLOCATION":
    case "DEFER_DELIVERY": {
      const until = p.until ? parseDate(p.until) : null;
      if (p.until && !until) throw bad("The date is not valid");
      if (input.type === "DEFER_DELIVERY" && !until) throw bad("A deferral needs the date the customer wants delivery from");
      if (until && until <= today) throw bad("The date must be in the future");
      return { until };
    }
    case "OUTLET_CHANGE": {
      const o = await first(ctx.db, `SELECT id FROM outlets WHERE id = ? AND tenant_id = ? AND is_active = 1`, String(p.outlet_id ?? ""), ctx.tenantId);
      if (!o) throw bad("Outlet not found");
      if (p.outlet_id === b.outlet_id) throw bad("The booking is already at this outlet");
      return { outlet_id: String(p.outlet_id) };
    }
    case "RELEASE_ALLOCATION": {
      const alloc = await activeAllocationForBooking(ctx, b.id);
      if (!alloc) throw conflict("This booking is not holding a car");
      // One at a time. Two people asking for the same car in different directions would leave an
      // approver holding two requests only one of which can be true, and the loser's reason recorded
      // against a release that never happened.
      // `deciding` is the request being approved right now, which is itself pending and so has to be
      // left out of its own check.
      const open = await first<{ id: string }>(ctx.db, `SELECT id FROM exceptions WHERE tenant_id = ? AND booking_id = ? AND type = 'RELEASE_ALLOCATION' AND status = 'PENDING' AND id <> ?`, ctx.tenantId, b.id, deciding ?? "");
      if (open) throw conflict("Someone has already asked for this car to be taken off this booking, and it is waiting for approval");
      const code = String(p.release_reason ?? "");
      if (!requestable(code)) throw bad("Say why the car is being taken off this booking");
      const car = await first<ReleaseCar>(ctx.db, `SELECT id, vin, model, variant, colour, status, is_blocked FROM vehicles WHERE id = ? AND tenant_id = ?`, alloc.vehicle_id, ctx.tenantId);
      if (!car) throw conflict("The car on this booking is no longer in stock");
      const out: Record<string, unknown> = { release_reason: code, vehicle_id: car.id, vin: car.vin };
      switch (code) {
        case "BOOKING_CANCELLED": {
          // The DMS cancellation comes first, and its reference travels with the request, so the two
          // records agree rather than having to be reconciled later.
          const ref = String(p.cancellation_ref ?? "").trim();
          if (!ref) throw bad("Give the cancellation reference already raised in the DMS");
          return { ...out, cancellation_ref: ref.slice(0, 60), ...(await namedReceiver(ctx, p, b, car)) };
        }
        case "REALLOCATED_TO_BOOKING":
          // The one reason that is nothing but the move, so here the booking is not optional.
          if (!String(p.to_booking_id ?? "").trim()) throw bad("Choose the booking the car is going to");
          return { ...out, ...(await namedReceiver(ctx, p, b, car)) };
        case "CUSTOMER_DEFERRED": {
          const until = parseDate(p.until);
          if (!until) throw bad("Give the date the customer wants delivery from");
          if (until <= today) throw bad("The date must be in the future");
          // Without the customer's own words this is a priority change wearing a kinder name, and the
          // two are reported differently, so the document is not optional.
          const doc = String(p.document_id ?? "").trim();
          if (!doc) throw bad("Attach the customer's own email or letter asking for a later date");
          const away = daysApart(today, until);
          // A short deferral never frees the car, so there is nothing to give anybody. Honouring one
          // half of a request that says both would take a car off a customer who asked politely to
          // wait for it, which is the opposite of what the reason is for.
          if (away <= DEFERRAL_KEEP_DAYS && String(p.to_booking_id ?? "").trim()) {
            throw bad(`A deferral of ${away} day${away === 1 ? "" : "s"} keeps the car with this customer, so it cannot also go to another booking. Past ${DEFERRAL_KEEP_DAYS} days the car is freed and another booking can be named.`);
          }
          // Decided here rather than at approval so the approver is told which of the two this is
          // before they agree to it: the customer keeps the car, or the customer loses the car.
          return { ...out, until, document_id: doc.slice(0, 120), days_away: away, ...(away <= DEFERRAL_KEEP_DAYS ? { keep_days: away } : await namedReceiver(ctx, p, b, car)) };
        }
        case "MANAGEMENT_PRIORITY": {
          // A car taken off the front of the queue is handed straight back by the queue unless the
          // booking stands down, so a date is not optional here: without one this reason does nothing
          // at all. The booking keeps its place and returns on that date.
          const until = parseDate(p.until);
          if (!until) throw bad("Give the date this booking stands down until, so the car is genuinely free");
          if (until <= today) throw bad("The date must be in the future");
          return { ...out, until, ...(await namedReceiver(ctx, p, b, car)) };
        }
        default:
          return { ...out, ...(await namedReceiver(ctx, p, b, car)) };
      }
    }
    case "MANUAL_ALLOCATION": {
      if (!input.vehicle_id) throw bad("Choose the car to allocate");
      const v = await first<{ id: string; model: string; variant: string; colour: string; status: string }>(ctx.db, `SELECT id, model, variant, colour, status FROM vehicles WHERE id = ? AND tenant_id = ?`, input.vehicle_id, ctx.tenantId);
      if (!v) throw bad("Vehicle not found");
      if (v.model !== b.model || v.variant !== b.variant || v.colour !== b.colour) throw bad("The car does not match the booking's model, variant and colour");
      if (!["APPROVED", "ALLOCATED"].includes(b.status)) throw conflict("Only an approved booking can be allocated a car");
      return {};
    }
    case "WINDOW_EXTENSION": {
      const days = Number(p.days);
      if (!Number.isInteger(days) || days < 1 || days > 30) throw bad("Extension must be between 1 and 30 days");
      if (!(await activeAllocationForBooking(ctx, b.id))) throw conflict("This booking has no allocated car to extend");
      return { days };
    }
    default:
      return p;
  }
}

export async function requestException(ctx: Ctx, input: ExceptionInput, user: SessionUser): Promise<ExceptionRow> {
  if (!TYPES.includes(input.type)) throw bad("Unknown exception type");
  if (!input.reason?.trim()) throw bad("A reason is required");
  const payload = await validate(ctx, input);
  const b = await getBooking(ctx, input.booking_id);
  const id = newId("exc");
  await ctx.db.batch([
    stmt(
      ctx.db,
      `INSERT INTO exceptions (id, tenant_id, type, booking_id, vehicle_id, payload_json, reason, status, requested_by, requested_at) VALUES (?,?,?,?,?,?,?,'PENDING',?,?)`,
      // A release names the car it is about, so the request reads on its own and on the car's own page.
      id, ctx.tenantId, input.type, input.booking_id, input.type === "MANUAL_ALLOCATION" ? input.vehicle_id ?? null : (payload.vehicle_id as string | undefined) ?? null, JSON.stringify(payload), input.reason.trim().slice(0, 1000), user.id, iso(ctx.now),
    ),
    auditStmt(ctx, "EXCEPTION_REQUESTED", "booking", input.booking_id, { exception_id: id, type: input.type, payload, reason: input.reason.trim().slice(0, 1000) }),
    ...ctx.settings.exception_approver_roles.map((role) =>
      alertStmt(ctx, { targetRole: role, outletId: b.outlet_id, kind: "EXCEPTION_APPROVAL", title: "Exception waiting for approval", body: `${input.type.replace(/_/g, " ").toLowerCase()} on booking ${b.booking_no}: ${input.reason.trim().slice(0, 300)}`, entityType: "exception", entityId: id }),
    ),
  ]);
  return (await first<ExceptionRow>(ctx.db, `SELECT * FROM exceptions WHERE id = ?`, id))!;
}

/**
 * Approves or rejects a request. The decision and the change it authorises are written in one batch,
 * guarded on the request still being pending: a request is never marked approved without its effect,
 * and never takes effect twice.
 */
export async function decideException(ctx: Ctx, id: string, approve: boolean, approver: SessionUser, remarks?: string): Promise<ExceptionRow> {
  const ex = await first<ExceptionRow>(ctx.db, `SELECT * FROM exceptions WHERE id = ? AND tenant_id = ?`, id, ctx.tenantId);
  if (!ex) throw notFound("Exception request");
  if (ex.status !== "PENDING") throw conflict("This request has already been decided");
  if (ex.requested_by === approver.id) throw forbidden("The person who raised a request cannot decide it");
  if (!approve && !remarks?.trim()) throw bad("A reason is required to reject a request");

  const at = iso(ctx.now);
  const note = remarks?.trim().slice(0, 1000) || null;
  const pending: Guard = { sql: `SELECT 1 FROM exceptions WHERE id = ? AND tenant_id = ? AND status = 'PENDING'`, params: [id, ctx.tenantId] };
  const decision = [
    auditStmt(ctx, approve ? "EXCEPTION_APPROVED" : "EXCEPTION_REJECTED", "booking", ex.booking_id, { exception_id: id, type: ex.type, remarks: note }, pending),
    stmt(ctx.db, `UPDATE exceptions SET status = ?, decided_by = ?, decided_at = ?, decision_remarks = ? WHERE id = ? AND tenant_id = ? AND status = 'PENDING'`, approve ? "APPROVED" : "REJECTED", approver.id, at, note, id, ctx.tenantId),
    doneAlertStmt(ctx, "EXCEPTION_APPROVAL", id),
    alertStmt(ctx, { targetUser: ex.requested_by, kind: "EXCEPTION_DECIDED", title: approve ? "Your request was approved" : "Your request was not approved", body: `${ex.type.replace(/_/g, " ").toLowerCase()}${note ? `: ${note}` : ""}`, entityType: "booking", entityId: ex.booking_id }),
  ];
  let rerun: Config | null = null;
  try {
    if (approve) rerun = await applyException(ctx, ex, approver, decision);
    else await ctx.db.batch(decision);
  } catch (e) {
    if (isGuardFailure(e)) throw conflict("This request was decided, or the booking changed, a moment ago. Refresh and check.");
    throw e;
  }
  // The new order applies from the next car; allocations other customers already hold are not taken away.
  if (rerun) await allocateConfig(ctx, rerun);
  return (await first<ExceptionRow>(ctx.db, `SELECT * FROM exceptions WHERE id = ?`, id))!;
}

/** Commits an approved request together with `decision`. Returns a configuration to re-run allocation for, if any. */
async function applyException(ctx: Ctx, ex: ExceptionRow, approver: SessionUser, decision: D1PreparedStatement[]): Promise<Config | null> {
  const p = safeJson<Record<string, any>>(ex.payload_json, {});
  // The booking may have moved on since the request was raised (invoiced, cancelled, car gone): check again now.
  await validate(ctx, { type: ex.type, booking_id: ex.booking_id, vehicle_id: ex.vehicle_id, payload: p, reason: ex.reason }, ex.id);
  const b = await getBooking(ctx, ex.booking_id);
  const at = iso(ctx.now);
  switch (ex.type) {
    case "PRIORITY_CHANGE": {
      let change: { priority_ts: string; priority_override_json: string | null } = { priority_ts: p.new_priority_ts, priority_override_json: b.priority_override_json };
      if (p.before_booking_id) {
        const other = await first<Waiting>(ctx.db, `SELECT id, booking_no, outlet_id, priority_ts, expected_delivery_date, booking_amount, priority_override_json FROM bookings WHERE id = ? AND tenant_id = ?`, p.before_booking_id, ctx.tenantId);
        if (!other) throw conflict("The booking to move ahead of no longer exists");
        change = aheadOf(other);
      }
      await ctx.db.batch([...decision, stmt(ctx.db, `UPDATE bookings SET priority_ts = ?, priority_override_json = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`, change.priority_ts, change.priority_override_json, at, b.id, ctx.tenantId)]);
      return b.status === "APPROVED" ? b : null;
    }
    case "SKIP_ALLOCATION":
    case "DEFER_DELIVERY": {
      const hold = { reason: ex.type === "DEFER_DELIVERY" ? "CUSTOMER_DEFERRED" : "ALLOCATION_SKIPPED", until: (p.until as string | null) ?? null };
      const extra = ex.type === "DEFER_DELIVERY" && p.until ? [stmt(ctx.db, `UPDATE bookings SET expected_delivery_date = ? WHERE id = ? AND tenant_id = ?`, p.until, b.id, ctx.tenantId)] : [];
      const alloc = await activeAllocationForBooking(ctx, b.id);
      if (alloc) {
        await releaseAllocation(ctx, alloc, ex.type, { hold, also: [...extra, ...decision] }); // the freed car goes to the next customer
      } else {
        await ctx.db.batch([...decision, stmt(ctx.db, `UPDATE bookings SET on_hold = 1, hold_reason = ?, hold_until = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`, hold.reason, hold.until, at, b.id, ctx.tenantId), ...extra]);
      }
      return null;
    }
    case "OUTLET_CHANGE": {
      const move = stmt(ctx.db, `UPDATE bookings SET outlet_id = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`, p.outlet_id, at, b.id, ctx.tenantId);
      const alloc = await activeAllocationForBooking(ctx, b.id);
      if (!alloc) {
        await ctx.db.batch([...decision, move]);
        return b.status === "APPROVED" ? b : null;
      }
      const v = await first<{ outlet_id: string }>(ctx.db, `SELECT outlet_id FROM vehicles WHERE id = ? AND tenant_id = ?`, alloc.vehicle_id, ctx.tenantId);
      if (ctx.settings.outlet_scope === "SAME_OUTLET_ONLY" && v && v.outlet_id !== p.outlet_id) {
        await releaseAllocation(ctx, alloc, "OUTLET_CHANGE", { also: [move, ...decision] }); // the booking now queues at its new outlet
        return null;
      }
      await ctx.db.batch([...decision, move, stmt(ctx.db, `UPDATE allocations SET needs_transfer = ? WHERE id = ? AND tenant_id = ?`, v && v.outlet_id !== p.outlet_id ? 1 : 0, alloc.id, ctx.tenantId)]);
      return null;
    }
    case "RELEASE_ALLOCATION": {
      const alloc = await activeAllocationForBooking(ctx, b.id);
      if (!alloc) throw conflict("This booking is no longer holding a car");
      const code = String(p.release_reason);
      const spec = requestable(code);
      if (!spec) throw conflict("That reason is no longer one that can be asked for");
      const link = { requestId: ex.id, toBookingId: (p.to_booking_id as string | undefined) ?? null };

      // A short deferral keeps the car: the customer asked, so they do not lose it, and the payment
      // window moves out to cover the date they gave. Nothing is released, so there is no moment in
      // which the queue could hand their car to somebody else.
      if (code === "CUSTOMER_DEFERRED" && Number.isInteger(p.keep_days)) {
        const days = alloc.window_extension_days + Number(p.keep_days);
        await ctx.db.batch([
          ...decision,
          stmt(ctx.db, `UPDATE allocations SET window_extension_days = ?, reminder_sent_at = NULL, escalated_at = NULL WHERE id = ? AND tenant_id = ? AND status = 'ACTIVE'`, days, alloc.id, ctx.tenantId),
          stmt(ctx.db, `UPDATE bookings SET expected_delivery_date = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`, p.until, at, b.id, ctx.tenantId),
          auditStmt(ctx, "DEFERRAL_GRANTED", "booking", b.id, { request_id: ex.id, allocation_id: alloc.id, until: p.until, days_added: Number(p.keep_days), document_id: p.document_id ?? null }),
        ]);
        return null;
      }

      const hold = spec.holds ? { reason: code, until: (p.until as string | null) ?? null } : undefined;
      // A long deferral frees the car, and the date the customer gave is still the date we hold to.
      const extra = p.until ? [stmt(ctx.db, `UPDATE bookings SET expected_delivery_date = ? WHERE id = ? AND tenant_id = ?`, p.until, b.id, ctx.tenantId)] : [];
      // Cancelling the booking is the point of the request, not a side effect of it.
      const close = code === "BOOKING_CANCELLED"
        ? [stmt(ctx.db, `UPDATE bookings SET status = 'CANCELLED', cancelled_at = ?, cancel_reason = ?, on_hold = 0, hold_reason = NULL, hold_until = NULL, updated_at = ? WHERE id = ? AND tenant_id = ?`, at, ex.reason.slice(0, 500), at, b.id, ctx.tenantId)]
        : [];

      // A request that names the booking the car is going to -- whatever its reason -- releases and
      // re-allocates in one batch, so the car is never briefly loose for the queue to take: the
      // customer named in the request is the one who gets it, or nobody does. Without a name the car
      // goes back to the queue and whoever is next by the rules gets it.
      if (p.to_booking_id) {
        try {
          await reallocateToBooking(ctx, alloc, String(p.to_booking_id), approver.id, ex.id, { reason: code, hold, also: [...extra, ...close, ...decision] });
        } catch (e) {
          if (e instanceof HttpError || isGuardFailure(e)) throw e;
          throw conflict((e as Error).message);
        }
        return null;
      }

      await releaseAllocation(ctx, alloc, code, { hold, reallocate: spec.reallocates, also: [...extra, ...close, ...decision], link });
      return null;
    }
    case "MANUAL_ALLOCATION":
      try {
        await manualAllocate(ctx, b.id, ex.vehicle_id!, approver.id, ex.id, decision);
      } catch (e) {
        if (e instanceof HttpError || isGuardFailure(e)) throw e;
        throw conflict((e as Error).message);
      }
      return null;
    case "WINDOW_EXTENSION": {
      const alloc = await activeAllocationForBooking(ctx, b.id);
      if (!alloc) throw conflict("This booking no longer has an allocated car");
      const days = alloc.window_extension_days + Number(p.days);
      // A reminder or escalation that is still due on the new dates is not sent a second time; one that
      // now lies in the future is re-armed.
      let reminder = alloc.reminder_sent_at, escalated = alloc.escalated_at;
      if (alloc.clock_started_at) {
        const today = localParts(ctx.now, ctx.tenant.timezone).date;
        const sch = windowSchedule(ctx, alloc.clock_started_at, days);
        if (today < sch.reminder_on) reminder = null;
        if (today < sch.escalation_on) escalated = null;
      }
      await ctx.db.batch([
        ...decision,
        stmt(ctx.db, `UPDATE allocations SET window_extension_days = ?, reminder_sent_at = ?, escalated_at = ? WHERE id = ? AND tenant_id = ? AND status = 'ACTIVE'`, days, reminder, escalated, alloc.id, ctx.tenantId),
      ]);
      return null;
    }
    default:
      await ctx.db.batch(decision);
      return null;
  }
}

export async function listExceptions(ctx: Ctx, status: string | null, outletIds: string[] | null) {
  const scope = outletIds ? `AND b.outlet_id IN (${outletIds.map(() => "?").join(",") || "''"})` : "";
  return all(
    ctx.db,
    `SELECT e.*, b.booking_no, b.customer_name, b.model, b.variant, b.colour, b.outlet_id, bo.name AS outlet, v.vin, COALESCE(ru.name, CASE WHEN e.requested_by IS NULL THEN NULL ELSE 'Removed account' END) AS requested_by_name, COALESCE(du.name, CASE WHEN e.decided_by IS NULL THEN NULL ELSE 'Removed account' END) AS decided_by_name,
            (SELECT x.booking_no FROM bookings x WHERE x.tenant_id = e.tenant_id AND x.id = json_extract(e.payload_json, '$.before_booking_id')) AS before_booking_no,
            (SELECT o.name FROM outlets o WHERE o.tenant_id = e.tenant_id AND o.id = json_extract(e.payload_json, '$.outlet_id')) AS to_outlet
     FROM exceptions e JOIN bookings b ON b.id = e.booking_id AND b.tenant_id = e.tenant_id JOIN outlets bo ON bo.id = b.outlet_id LEFT JOIN vehicles v ON v.id = e.vehicle_id AND v.tenant_id = e.tenant_id
     LEFT JOIN users ru ON ru.id = e.requested_by LEFT JOIN users du ON du.id = e.decided_by
     WHERE e.tenant_id = ? ${status ? "AND e.status = ?" : ""} ${scope} ORDER BY e.requested_at DESC LIMIT 300`,
    ...(status ? [ctx.tenantId, status] : [ctx.tenantId]),
    ...(outletIds ?? []),
  );
}
