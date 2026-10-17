import { all, audit, auditStmt, first, run, stmt } from "../lib/db";
import { can } from "../lib/permissions";
import { bad, forbidden, iso, likeText, newId, norm, normMobile, notFound, parseDate, safeJson } from "../lib/util";
import { activeAllocationForBooking, heldCars } from "../domain/allocation";
import { REQUESTABLE, REQUESTABLE_ORDER } from "../domain/release-reasons";
import {
  approveBooking,
  backdatedDays,
  cancelBooking,
  createBooking,
  deliverBooking,
  getBooking,
  invoiceBooking,
  markReady,
  CHECKLIST_LABELS,
  checklistOf,
  missingChecklist,
  queuePosition,
  rejectBooking,
  rejectPayment,
  reportPayment,
  setChecklist,
  submitBooking,
  verifyPayment,
  updateBooking,
  type Booking,
} from "../domain/bookings";
import { decideException, listExceptions, requestException } from "../domain/exceptions";
import { resolveConfig } from "../domain/master";
import { queueFor, queuePositions } from "../domain/queue";
import { windowSchedule } from "../domain/timers";
import { jsonBody, need, needOutlet, outletScope, type App, type C } from "./app";

/** A sales executive sees only their own bookings; everyone else sees bookings of their outlets. */
function canSeeBooking(c: C, b: Pick<Booking, "outlet_id" | "sales_exec_id" | "created_by">): boolean {
  const user = c.get("user");
  const ctx = c.get("ctx");
  if (!can(user, ctx.settings, "booking.view")) return false;
  if (!can(user, ctx.settings, "booking.view_all")) return b.sales_exec_id === user.id || b.created_by === user.id;
  return user.allOutlets || user.outletIds.includes(b.outlet_id);
}

async function bookingFor(c: C, id: string): Promise<Booking> {
  const b = await getBooking(c.get("ctx"), id);
  if (!canSeeBooking(c, b)) throw forbidden("This booking is outside your access");
  return b;
}

export function bookingRoutes(app: App) {
  app.get("/api/bookings", async (c) => {
    need(c, "booking.view");
    const ctx = c.get("ctx");
    const user = c.get("user");
    const q = c.req.query();
    const where = ["b.tenant_id = ?"];
    const params: unknown[] = [ctx.tenantId];
    const scope = outletScope(c);
    if (!can(user, ctx.settings, "booking.view_all")) (where.push("(b.sales_exec_id = ? OR b.created_by = ?)"), params.push(user.id, user.id));
    else if (scope) (where.push(`b.outlet_id IN (${scope.map(() => "?").join(",") || "''"})`), params.push(...scope));
    if (q.outlet_id) (where.push("b.outlet_id = ?"), params.push(q.outlet_id));
    if (q.status) (where.push("b.status = ?"), params.push(q.status));
    if (q.view === "waiting") where.push("b.status = 'APPROVED' AND b.on_hold = 0");
    if (q.view === "hold") where.push("b.status = 'APPROVED' AND b.on_hold = 1");
    if (q.view === "open") where.push("b.status IN ('DRAFT','SUBMITTED','APPROVED','ALLOCATED','INVOICED')");
    if (q.source) (where.push("b.source = ?"), params.push(q.source));
    if (q.model) (where.push("b.model = ?"), params.push(norm(q.model)));
    if (q.variant_id) (where.push("b.variant_id = ?"), params.push(q.variant_id));
    if (q.category) (where.push("b.variant_id IN (SELECT id FROM vehicle_variants WHERE tenant_id = ? AND category = ?)"), params.push(ctx.tenantId, q.category));
    if (q.q) (where.push("(b.booking_no LIKE ? OR b.customer_name LIKE ? OR b.customer_mobile LIKE ?)"), params.push(`%${likeText(norm(q.q))}%`, `%${likeText(q.q)}%`, `%${likeText(q.q.replace(/\D/g, "")) || "~"}%`));
    const rows = await all<any>(
      ctx.db,
      `SELECT b.id, b.booking_no, b.booking_date, b.priority_ts, b.customer_name, b.customer_mobile, b.variant_id, b.model, b.variant, b.colour, b.status, b.on_hold, b.hold_reason, b.hold_until,
              b.booking_amount, b.expected_delivery_date, b.outlet_id, o.name AS outlet, b.sales_exec_id, se.name AS sales_exec, b.sc_name, b.source, b.dms_stage, b.payment_reported_at, b.payment_received_at, b.created_at,
              vm.category, vm.trim_level AS trim, vm.transmission, vm.fuel, vm.drive, vm.seater,
              v.vin, v.status AS vehicle_status, v.expected_arrival_date, a.type AS allocation_type, a.needs_transfer
       FROM bookings b JOIN outlets o ON o.id = b.outlet_id LEFT JOIN users se ON se.id = b.sales_exec_id
       LEFT JOIN vehicle_variants vm ON vm.id = b.variant_id
       LEFT JOIN allocations a ON a.booking_id = b.id AND a.status = 'ACTIVE' LEFT JOIN vehicles v ON v.id = a.vehicle_id
       WHERE ${where.join(" AND ")} ORDER BY ${q.view === "waiting" ? "b.model, b.variant, b.colour, b.priority_ts ASC" : "b.priority_ts DESC"} LIMIT 2000`,
      ...params,
    );
    // Queue positions follow the dealership's queue rules, the same comparison allocation uses.
    const positions = rows.some((r) => r.status === "APPROVED" && !r.on_hold) ? await queuePositions(ctx) : new Map();
    for (const r of rows) r.queue_position = positions.get(r.id)?.position ?? null;
    if (q.view === "waiting") rows.sort((x, y) => (x.model + x.variant + x.colour).localeCompare(y.model + y.variant + y.colour) || (x.queue_position ?? 0) - (y.queue_position ?? 0));
    return c.json(rows);
  });

  app.post("/api/bookings", async (c) => {
    need(c, "booking.create");
    const body = await jsonBody(c);
    needOutlet(c, String(body.outlet_id ?? ""));
    return c.json(await createBooking(c.get("ctx"), body as any, c.get("user")), 201);
  });

  app.get("/api/bookings/:id", async (c) => {
    const ctx = c.get("ctx");
    const b = await bookingFor(c, c.req.param("id"));
    const outlet = await first<{ name: string }>(ctx.db, `SELECT name FROM outlets WHERE id = ?`, b.outlet_id);
    const names = await all<{ id: string; name: string }>(ctx.db, `SELECT id, name FROM users WHERE tenant_id = ?`, ctx.tenantId);
    const nameOf = (id: string | null) => (id ? names.find((n) => n.id === id)?.name ?? (id.startsWith("UPLOAD:") ? "Data upload" : id === "SYSTEM" ? "System" : id) : null);
    const ticks = checklistOf(b);
    const allocations = await all<any>(
      ctx.db,
      `SELECT a.*, v.vin, v.status AS vehicle_status, v.expected_arrival_date, v.outlet_id AS vehicle_outlet_id, vo.name AS vehicle_outlet FROM allocations a JOIN vehicles v ON v.id = a.vehicle_id JOIN outlets vo ON vo.id = v.outlet_id
       WHERE a.tenant_id = ? AND a.booking_id = ? ORDER BY a.allocated_at DESC`,
      ctx.tenantId,
      b.id,
    );
    const active = allocations.find((a) => a.status === "ACTIVE") ?? null;
    let window = null;
    if (active?.clock_started_at && b.status === "ALLOCATED" && !b.payment_received_at) {
      window = { ...windowSchedule(ctx, active.clock_started_at, active.window_extension_days), stage: active.escalated_at ? "ESCALATED" : active.reminder_sent_at ? "REMINDED" : "OPEN", held_for_finance: Boolean(b.payment_reported_at) };
    }
    const exceptions = await all<any>(ctx.db, `SELECT * FROM exceptions WHERE tenant_id = ? AND booking_id = ? ORDER BY requested_at DESC`, ctx.tenantId, b.id);
    const messages = await all(ctx.db, `SELECT id, event_key, audience, to_mobile, status, rendered_text, error, created_at, sent_at, delivered_at, read_at, provider FROM wa_messages WHERE tenant_id = ? AND booking_id = ? ORDER BY created_at DESC`, ctx.tenantId, b.id);
    const timeline = await all<any>(ctx.db, `SELECT action, actor, detail_json, at FROM audit_log WHERE tenant_id = ? AND entity_type = 'booking' AND entity_id = ? ORDER BY at DESC LIMIT 200`, ctx.tenantId, b.id);
    const queue = b.status === "APPROVED" && !b.on_hold ? await queuePosition(ctx, b) : null;
    const masterAttrs = b.variant_id ? await first<Record<string, unknown>>(ctx.db, `SELECT category, trim_level AS trim, transmission, fuel, drive, seater FROM vehicle_variants WHERE id = ? AND tenant_id = ?`, b.variant_id, ctx.tenantId) : null;
    // Names for what each request points at, so the screen does not show internal ids.
    const refs = { bookings: new Map<string, string>(), vehicles: new Map<string, string>(), outlets: new Map<string, string>() };
    for (const e of exceptions) {
      const p = safeJson<Record<string, any>>(e.payload_json, {});
      if (p.before_booking_id && !refs.bookings.has(p.before_booking_id)) refs.bookings.set(p.before_booking_id, (await first<{ booking_no: string }>(ctx.db, `SELECT booking_no FROM bookings WHERE id = ? AND tenant_id = ?`, p.before_booking_id, ctx.tenantId))?.booking_no ?? "");
      if (p.outlet_id && !refs.outlets.has(p.outlet_id)) refs.outlets.set(p.outlet_id, (await first<{ name: string }>(ctx.db, `SELECT name FROM outlets WHERE id = ? AND tenant_id = ?`, p.outlet_id, ctx.tenantId))?.name ?? "");
      if (e.vehicle_id && !refs.vehicles.has(e.vehicle_id)) refs.vehicles.set(e.vehicle_id, (await first<{ vin: string }>(ctx.db, `SELECT vin FROM vehicles WHERE id = ? AND tenant_id = ?`, e.vehicle_id, ctx.tenantId))?.vin ?? "");
    }
    return c.json({
      booking: {
        ...b, priority_override_json: undefined, checklist_json: undefined, moved_ahead: Boolean(b.priority_override_json), ...(masterAttrs ?? {}), outlet: outlet?.name, sales_exec: nameOf(b.sales_exec_id), approved_by_name: nameOf(b.approved_by), created_by_name: nameOf(b.created_by),
        payment_reported_by_name: nameOf(b.payment_reported_by), payment_verified_by_name: nameOf(b.payment_verified_by), backdated_days: b.source === "APP" ? backdatedDays(ctx, b) : 0,
      },
      // The submission checklist applies to bookings entered in the app; a booking from the DMS was documented there.
      checklist: b.source === "APP" ? ctx.settings.required_documents.map((k) => ({ key: k, label: CHECKLIST_LABELS[k] ?? k, ticked: Boolean(ticks[k]), by: ticks[k] ? nameOf(ticks[k].by) : null, at: ticks[k]?.at ?? null })) : [],
      checklist_missing: b.source === "APP" && ["DRAFT", "REJECTED"].includes(b.status) ? missingChecklist(ctx, b) : [],
      allocation: active ? { ...active, rule_trace: safeJson(active.rule_trace_json, {}), window } : null,
      allocation_history: allocations.filter((a) => a.status !== "ACTIVE").map((a) => ({ id: a.id, vin: a.vin, type: a.type, status: a.status, allocated_at: a.allocated_at, released_at: a.released_at, release_reason: a.release_reason })),
      exceptions: exceptions.map((e) => {
        const p = safeJson<Record<string, any>>(e.payload_json, {});
        return { ...e, payload_json: undefined, payload: p, before_booking_no: refs.bookings.get(p.before_booking_id) || null, to_outlet: refs.outlets.get(p.outlet_id) || null, vin: refs.vehicles.get(e.vehicle_id) || null, requested_by_name: nameOf(e.requested_by), decided_by_name: nameOf(e.decided_by) };
      }),
      messages,
      timeline: timeline.map((t) => ({ action: t.action, actor: nameOf(t.actor), detail: safeJson(t.detail_json, {}), at: t.at })),
      queue,
    });
  });

  /**
   * The queue this booking stands in: every booking waiting for the same model, variant and colour, in
   * order. Booking numbers and dates only, no customer details, so that anyone who can see the booking can
   * see where it stands and ask to be moved ahead of a named booking.
   */
  app.get("/api/bookings/:id/queue", async (c) => {
    const ctx = c.get("ctx");
    const b = await bookingFor(c, c.req.param("id"));
    const outlets = new Map((await all<{ id: string; name: string }>(ctx.db, `SELECT id, name FROM outlets WHERE tenant_id = ?`, ctx.tenantId)).map((o) => [o.id, o.name]));
    return c.json((await queueFor(ctx, b)).slice(0, 500).map((r, i) => ({ id: r.id, booking_no: r.booking_no, booking_date: r.booking_date, priority_ts: r.priority_ts, expected_delivery_date: r.expected_delivery_date ?? null, outlet: outlets.get(r.outlet_id) ?? "", position: i + 1, is_this_booking: r.id === b.id })));
  });

  app.patch("/api/bookings/:id", async (c) => {
    need(c, "booking.create");
    const b = await bookingFor(c, c.req.param("id"));
    const body = await jsonBody(c);
    if (body.outlet_id) needOutlet(c, String(body.outlet_id));
    return c.json(await updateBooking(c.get("ctx"), b.id, body as any));
  });

  app.post("/api/bookings/:id/submit", async (c) => {
    need(c, "booking.create");
    const b = await bookingFor(c, c.req.param("id"));
    return c.json(await submitBooking(c.get("ctx"), b.id));
  });

  app.post("/api/bookings/:id/approve", async (c) => {
    need(c, "booking.approve");
    const b = await bookingFor(c, c.req.param("id"));
    return c.json(await approveBooking(c.get("ctx"), b.id, c.get("user"), (await jsonBody(c).catch(() => ({}) as any)).remarks));
  });

  app.post("/api/bookings/:id/reject", async (c) => {
    need(c, "booking.approve");
    const b = await bookingFor(c, c.req.param("id"));
    return c.json(await rejectBooking(c.get("ctx"), b.id, c.get("user"), String((await jsonBody(c)).remarks ?? "")));
  });

  app.post("/api/bookings/:id/cancel", async (c) => {
    const b = await bookingFor(c, c.req.param("id"));
    const user = c.get("user");
    // The creator may withdraw a booking that has not been approved yet; after that it needs a manager.
    const own = ["DRAFT", "SUBMITTED", "REJECTED"].includes(b.status) && (b.created_by === user.id || b.sales_exec_id === user.id);
    if (!own) need(c, "booking.cancel");
    return c.json(await cancelBooking(c.get("ctx"), b.id, String((await jsonBody(c)).reason ?? "")));
  });

  // Sales reports a payment; Finance verifies it (or finds it has not come in). Only verification stops the payment window.
  app.post("/api/bookings/:id/payment-reported", async (c) => {
    need(c, "booking.payment_report");
    const b = await bookingFor(c, c.req.param("id"));
    return c.json(await reportPayment(c.get("ctx"), b.id, await jsonBody(c)));
  });

  app.post("/api/bookings/:id/payment-received", async (c) => {
    need(c, "booking.payment");
    const b = await bookingFor(c, c.req.param("id"));
    return c.json(await verifyPayment(c.get("ctx"), b.id, c.get("user"), await jsonBody(c).catch(() => ({}) as any)));
  });

  app.post("/api/bookings/:id/payment-not-received", async (c) => {
    need(c, "booking.payment");
    const b = await bookingFor(c, c.req.param("id"));
    return c.json(await rejectPayment(c.get("ctx"), b.id, String((await jsonBody(c)).note ?? "")));
  });

  /** Finance's queue: bookings that hold a car and are not yet paid for, reported payments first. */
  app.get("/api/payments", async (c) => {
    const ctx = c.get("ctx");
    const user = c.get("user");
    if (!can(user, ctx.settings, "booking.payment") && !can(user, ctx.settings, "booking.view_all")) throw forbidden();
    const scope = outletScope(c);
    const rows = await all<any>(
      ctx.db,
      `SELECT b.id AS booking_id, b.booking_no, b.customer_name, b.model, b.variant, b.colour, b.outlet_id, o.name AS outlet, b.sales_exec_id, COALESCE(se.name, b.sc_name) AS sales_exec,
              b.payment_reported_at, rb.name AS payment_reported_by_name, b.payment_amount, b.payment_ref, b.payment_note, b.payment_received_at, vb.name AS payment_verified_by_name,
              b.status, v.vin, v.status AS vehicle_status, v.net_dealer_price, a.clock_started_at, a.window_extension_days, a.reminder_sent_at, a.escalated_at, a.allocated_at
       FROM bookings b JOIN outlets o ON o.id = b.outlet_id JOIN allocations a ON a.booking_id = b.id AND a.status = 'ACTIVE' JOIN vehicles v ON v.id = a.vehicle_id
       LEFT JOIN users se ON se.id = b.sales_exec_id LEFT JOIN users rb ON rb.id = b.payment_reported_by LEFT JOIN users vb ON vb.id = b.payment_verified_by
       WHERE b.tenant_id = ? AND b.status = 'ALLOCATED' ${scope ? `AND b.outlet_id IN (${scope.map(() => "?").join(",") || "''"})` : ""}
       ORDER BY CASE WHEN b.payment_received_at IS NOT NULL THEN 2 WHEN b.payment_reported_at IS NOT NULL THEN 0 ELSE 1 END, COALESCE(b.payment_reported_at, a.clock_started_at, a.allocated_at) LIMIT 1000`,
      ctx.tenantId,
      ...(scope ?? []),
    );
    const showValue = can(user, ctx.settings, "stock.value");
    return c.json(
      rows.map((r) => ({
        ...r,
        net_dealer_price: showValue ? r.net_dealer_price : undefined,
        state: r.payment_received_at ? "VERIFIED" : r.payment_reported_at ? "TO_VERIFY" : "AWAITING_PAYMENT",
        overdue: Boolean(r.payment_reported_at && !r.payment_received_at && Date.parse(r.payment_reported_at) <= ctx.now.getTime() - ctx.settings.payment_verify_hours * 3_600_000),
        window: r.clock_started_at && !r.payment_received_at ? { ...windowSchedule(ctx, r.clock_started_at, r.window_extension_days), stage: r.escalated_at ? "ESCALATED" : r.reminder_sent_at ? "REMINDED" : "OPEN" } : null,
      })),
    );
  });

  /** CRM corrects how the customer can be reached. The car, the date and the place in the queue are not touched here. */
  app.post("/api/bookings/:id/contact", async (c) => {
    need(c, "booking.contact");
    const ctx = c.get("ctx");
    const b = await bookingFor(c, c.req.param("id"));
    const body = await jsonBody(c);
    const mobile = body.customer_mobile === undefined ? b.customer_mobile : normMobile(body.customer_mobile);
    if (!mobile) throw bad("The mobile number is not valid");
    const optIn = body.wa_opt_in === undefined ? b.wa_opt_in : body.wa_opt_in ? 1 : 0;
    if (mobile === b.customer_mobile && optIn === b.wa_opt_in) return c.json({ changed: false });
    await ctx.db.batch([
      stmt(ctx.db, `UPDATE bookings SET customer_mobile = ?, wa_opt_in = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`, mobile, optIn, iso(ctx.now), b.id, ctx.tenantId),
      auditStmt(ctx, "CUSTOMER_CONTACT_CHANGED", "booking", b.id, { mobile_changed: mobile !== b.customer_mobile, wa_opt_in: Boolean(optIn) }),
    ]);
    return c.json({ changed: true });
  });

  app.post("/api/bookings/:id/invoice", async (c) => {
    need(c, "booking.payment");
    const b = await bookingFor(c, c.req.param("id"));
    return c.json(await invoiceBooking(c.get("ctx"), b.id));
  });

  app.post("/api/bookings/:id/deliver", async (c) => {
    need(c, "booking.deliver");
    const b = await bookingFor(c, c.req.param("id"));
    return c.json(await deliverBooking(c.get("ctx"), b.id));
  });

  app.post("/api/bookings/:id/ready", async (c) => {
    need(c, "booking.ready");
    const b = await bookingFor(c, c.req.param("id"));
    return c.json(await markReady(c.get("ctx"), b.id));
  });

  // ------------------------------------------------------------ booking submission checklist (docket, KYC, PAN and Aadhaar, proof of booking amount)
  app.put("/api/bookings/:id/checklist", async (c) => {
    need(c, "booking.create");
    const b = await bookingFor(c, c.req.param("id"));
    const updated = await setChecklist(c.get("ctx"), b.id, await jsonBody(c));
    return c.json({ checklist_missing: missingChecklist(c.get("ctx"), updated) });
  });

  // ------------------------------------------------------------ taking a car back from a customer
  //
  // Finding the car is the first step, and the only one that is a search: by booking number,
  // customer, model, trim, colour, VIN or chassis. What may then be asked for, and what each choice
  // has to bring with it, comes from the server so the form cannot drift from the rules.
  app.get("/api/held-cars", async (c) => {
    need(c, "exception.request");
    const ctx = c.get("ctx");
    return c.json(await heldCars(ctx, c.req.query("q") ?? "", can(c.get("user"), ctx.settings, "booking.view_all") ? outletScope(c) : null));
  });

  app.get("/api/release-reasons", async (c) => {
    need(c, "exception.request");
    return c.json(REQUESTABLE_ORDER.map((code) => ({ code, ...REQUESTABLE[code] })));
  });

  // ------------------------------------------------------------ exception requests
  app.get("/api/exceptions", async (c) => {
    const ctx = c.get("ctx");
    const user = c.get("user");
    if (!can(user, ctx.settings, "exception.decide") && !can(user, ctx.settings, "release.decide") && !can(user, ctx.settings, "exception.request")) throw forbidden();
    let rows = (await listExceptions(ctx, c.req.query("status") ?? null, outletScope(c))) as any[];
    if (!can(user, ctx.settings, "booking.view_all")) rows = rows.filter((r) => r.requested_by === user.id);
    return c.json(rows.map((r) => ({ ...r, payload: safeJson(r.payload_json, {}), payload_json: undefined })));
  });

  app.post("/api/exceptions", async (c) => {
    need(c, "exception.request");
    const body = await jsonBody(c);
    await bookingFor(c, String(body.booking_id ?? ""));
    return c.json(await requestException(c.get("ctx"), body as any, c.get("user")), 201);
  });

  app.post("/api/exceptions/:id/:decision{approve|reject}", async (c) => {
    const ctx = c.get("ctx");
    // Somebody who may decide nothing at all is turned away before being told whether the request
    // exists; which of the two permissions is needed depends on the type, so that is checked after.
    if (!can(c.get("user"), ctx.settings, "exception.decide") && !can(c.get("user"), ctx.settings, "release.decide")) throw forbidden();
    const ex = await first<{ booking_id: string; type: string }>(ctx.db, `SELECT booking_id, type FROM exceptions WHERE id = ? AND tenant_id = ?`, c.req.param("id"), ctx.tenantId);
    if (!ex) throw notFound("Exception request");
    // Taking a car back from the customer holding it answers to a narrower list of approvers than
    // the rest, because allocation by hand is closed and this is the one way a named car moves.
    need(c, ex.type === "RELEASE_ALLOCATION" ? "release.decide" : "exception.decide");
    await bookingFor(c, ex.booking_id);
    const body = await jsonBody(c).catch(() => ({}) as any);
    return c.json(await decideException(ctx, c.req.param("id"), c.req.param("decision") === "approve", c.get("user"), body.remarks));
  });

  // ------------------------------------------------------------ orders placed with the manufacturer
  app.get("/api/orders", async (c) => {
    need(c, "dashboards.view");
    const ctx = c.get("ctx");
    return c.json(await all(ctx.db, `SELECT o.*, u.name AS created_by_name FROM order_requests o LEFT JOIN users u ON u.id = o.created_by WHERE o.tenant_id = ? ORDER BY o.created_at DESC LIMIT 500`, ctx.tenantId));
  });

  app.post("/api/orders", async (c) => {
    need(c, "orders.manage");
    const ctx = c.get("ctx");
    const b = await jsonBody(c);
    const { model, variant, colour } = await resolveConfig(ctx, b);
    const qty = Number(b.quantity);
    if (!Number.isInteger(qty) || qty < 1 || qty > 500) throw bad("Quantity must be a whole number between 1 and 500");
    const expected = b.expected_date ? parseDate(b.expected_date) : null;
    if (b.expected_date && !expected) throw bad("Expected date is not valid");
    const id = newId("ord");
    await run(ctx.db, `INSERT INTO order_requests (id, tenant_id, model, variant, colour, quantity, status, oem_reference, expected_date, notes, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,'PLACED',?,?,?,?,?,?)`, id, ctx.tenantId, model, variant, colour, qty, b.oem_reference?.trim() || null, expected, b.notes?.trim() || null, ctx.actor, iso(ctx.now), iso(ctx.now));
    await audit(ctx, "ORDER_PLACED", "order", id, { model, variant, colour, quantity: qty, expected_date: expected });
    return c.json({ id }, 201);
  });

  app.patch("/api/orders/:id", async (c) => {
    need(c, "orders.manage");
    const ctx = c.get("ctx");
    const o = await first<any>(ctx.db, `SELECT * FROM order_requests WHERE id = ? AND tenant_id = ?`, c.req.param("id"), ctx.tenantId);
    if (!o) throw notFound("Order");
    const b = await jsonBody(c);
    if (b.status && !["PLACED", "CONFIRMED", "CLOSED", "CANCELLED"].includes(b.status)) throw bad("Status is not valid");
    const expected = b.expected_date === undefined ? o.expected_date : b.expected_date ? parseDate(b.expected_date) : null;
    if (b.expected_date && !expected) throw bad("Expected date is not valid");
    const qty = b.quantity === undefined ? o.quantity : Number(b.quantity);
    if (!Number.isInteger(qty) || qty < 1) throw bad("Quantity is not valid");
    await run(ctx.db, `UPDATE order_requests SET status = ?, quantity = ?, oem_reference = ?, expected_date = ?, notes = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`, b.status ?? o.status, qty, b.oem_reference === undefined ? o.oem_reference : b.oem_reference || null, expected, b.notes === undefined ? o.notes : b.notes || null, iso(ctx.now), o.id, ctx.tenantId);
    await audit(ctx, "ORDER_UPDATED", "order", o.id, b);
    return c.json({ ok: true });
  });

  void activeAllocationForBooking;
}
