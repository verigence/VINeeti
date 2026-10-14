// Exception requests: anything that departs from the standard queue goes through request,
// independent approval and a permanent record (step 10 of the process: change in priority / skip
// allocation, plus deferrals, outlet changes, manual allocation and payment-window extensions).

import type { Ctx, SessionUser } from "../env";
import { all, alertStmt, auditStmt, doneAlertStmt, first, isGuardFailure, stmt, type Guard } from "../lib/db";
import { bad, conflict, forbidden, HttpError, iso, localParts, newId, notFound, parseDate, parseDateTime, safeJson } from "../lib/util";
import { activeAllocationForBooking, allocateConfig, manualAllocate, releaseAllocation, type Config } from "./allocation";
import { getBooking } from "./bookings";
import { queueFor, type Waiting } from "./queue";
import { queueCompare, queueValues, type QueueBooking } from "./rules";
import { windowSchedule } from "./timers";

export type ExceptionType = "PRIORITY_CHANGE" | "SKIP_ALLOCATION" | "DEFER_DELIVERY" | "OUTLET_CHANGE" | "MANUAL_ALLOCATION" | "WINDOW_EXTENSION" | "OTHER";
const TYPES: ExceptionType[] = ["PRIORITY_CHANGE", "SKIP_ALLOCATION", "DEFER_DELIVERY", "OUTLET_CHANGE", "MANUAL_ALLOCATION", "WINDOW_EXTENSION", "OTHER"];

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

/**
 * "Move ahead of booking X" under any queue rules: the booking takes X's ranking values (delivery
 * commitment, booking amount) and a queue date one second earlier, so whatever order the dealership's
 * rules give, it stands immediately before X and nowhere further up.
 */
function aheadOf(other: QueueBooking): { priority_ts: string; priority_override_json: string } {
  const v = queueValues(other);
  return { priority_ts: new Date(new Date(v.date).getTime() - 1000).toISOString(), priority_override_json: JSON.stringify({ expected_delivery_date: v.commitment, booking_amount: v.amount }) };
}

/** Checks the request up front so an approver never sees one that cannot be applied. */
async function validate(ctx: Ctx, input: ExceptionInput): Promise<Record<string, unknown>> {
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
      id, ctx.tenantId, input.type, input.booking_id, input.type === "MANUAL_ALLOCATION" ? input.vehicle_id ?? null : null, JSON.stringify(payload), input.reason.trim().slice(0, 1000), user.id, iso(ctx.now),
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
  await validate(ctx, { type: ex.type, booking_id: ex.booking_id, vehicle_id: ex.vehicle_id, payload: p, reason: ex.reason });
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
    `SELECT e.*, b.booking_no, b.customer_name, b.model, b.variant, b.colour, b.outlet_id, v.vin, ru.name AS requested_by_name, du.name AS decided_by_name,
            (SELECT x.booking_no FROM bookings x WHERE x.tenant_id = e.tenant_id AND x.id = json_extract(e.payload_json, '$.before_booking_id')) AS before_booking_no,
            (SELECT o.name FROM outlets o WHERE o.tenant_id = e.tenant_id AND o.id = json_extract(e.payload_json, '$.outlet_id')) AS to_outlet
     FROM exceptions e JOIN bookings b ON b.id = e.booking_id AND b.tenant_id = e.tenant_id LEFT JOIN vehicles v ON v.id = e.vehicle_id AND v.tenant_id = e.tenant_id
     LEFT JOIN users ru ON ru.id = e.requested_by LEFT JOIN users du ON du.id = e.decided_by
     WHERE e.tenant_id = ? ${status ? "AND e.status = ?" : ""} ${scope} ORDER BY e.requested_at DESC LIMIT 300`,
    ...(status ? [ctx.tenantId, status] : [ctx.tenantId]),
    ...(outletIds ?? []),
  );
}
