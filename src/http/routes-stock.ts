import { all, first } from "../lib/db";
import { can } from "../lib/permissions";
import { bad, forbidden, likeText, norm, notFound, parseDate, safeJson } from "../lib/util";
import { allocateAll } from "../domain/allocation";
import { FACETS, browseStock } from "../domain/browse";
import { availabilityAnswer } from "../domain/dashboards";
import { dataStatus } from "../domain/data-status";
import { importBookingSheet, importStockReport } from "../domain/dms-import";
import { STOCK_ISSUES } from "../dms/reports";
import { resolveConfig } from "../domain/master";
import {
  addVehicle,
  blockVehicle,
  getVehicle,
  receiveVehicle,
  removeVehicle,
  stockSummary,
  transferVehicle,
  unblockVehicle,
  updateVehicleDetails,
} from "../domain/inventory";
import { jsonBody, need, needOutlet, outletScope, type App, type C } from "./app";

const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

/** Reads an uploaded DMS export from a multipart form (field "file") or a raw body. Options come from the form or the query string. */
async function readUpload(c: C): Promise<{ bytes: Uint8Array; filename?: string; opt: (name: string) => string | undefined }> {
  const type = c.req.header("Content-Type") ?? "";
  // Refused on the declared size, before the body is read into memory.
  if (Number(c.req.header("Content-Length") ?? "0") > MAX_UPLOAD_BYTES + 64 * 1024) throw bad("The file is larger than 12 MB");
  const q = c.req.query();
  if (type.includes("multipart/form-data")) {
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file") as unknown;
    if (!file || typeof file === "string") throw bad("Attach the Excel file in the field named file");
    const f = file as File;
    if (f.size > MAX_UPLOAD_BYTES) throw bad("The file is larger than 12 MB");
    return { bytes: new Uint8Array(await f.arrayBuffer()), filename: f.name, opt: (name) => { const v = form!.get(name); return typeof v === "string" && v !== "" ? v : q[name] || undefined; } };
  }
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.length > MAX_UPLOAD_BYTES) throw bad("The file is larger than 12 MB");
  return { bytes, filename: q.filename || undefined, opt: (name) => q[name] || undefined };
}

export function stockRoutes(app: App) {
  // ------------------------------------------------------------ stock visibility
  app.get("/api/stock/summary", async (c) => {
    need(c, "stock.view");
    const q = c.req.query();
    // Sales teams see stock across the dealership so they can offer what is available elsewhere.
    return c.json(await stockSummary(c.get("ctx"), q.outlet_id ? [q.outlet_id] : null, { category: q.category, model: q.model, fuel: q.fuel, transmission: q.transmission }));
  });

  /**
   * Browsing what is in stock, narrowing a choice at a time. The sales team browses across the whole
   * dealership, as they do with the availability answer, so they can offer a car standing at another outlet.
   */
  app.get("/api/stock/browse", async (c) => {
    need(c, "stock.view");
    const q = c.req.query();
    const pick: Record<string, string> = {};
    for (const f of FACETS) if (q[f]) pick[f] = String(q[f]);
    return c.json(await browseStock(c.get("ctx"), { ...pick, show: q.show === "ALL" ? "ALL" : "FREE" }, null));
  });

  app.get("/api/stock/availability", async (c) => {
    need(c, "stock.view");
    // The car is named by master variant (or by model and variant name) and colour.
    const q = c.req.query();
    const cfg = await resolveConfig(c.get("ctx"), { variant_id: q.variant_id, model: q.model, variant: q.variant, colour: q.colour }, { allowInactive: true });
    return c.json({ ...(await availabilityAnswer(c.get("ctx"), cfg, q.outlet_id ?? null)), ...cfg });
  });

  app.get("/api/vehicles", async (c) => {
    need(c, "stock.view");
    const ctx = c.get("ctx");
    const q = c.req.query();
    const where = ["v.tenant_id = ?"];
    const params: unknown[] = [ctx.tenantId];
    if (q.model) (where.push("v.model = ?"), params.push(norm(q.model)));
    if (q.variant_id) (where.push("v.variant_id = ?"), params.push(q.variant_id));
    // Filters on the vehicle-master attributes.
    for (const [param, column] of [["category", "category"], ["trim", "trim_level"], ["transmission", "transmission"], ["fuel", "fuel"], ["drive", "drive"], ["seater", "seater"]] as const) {
      if (q[param]) (where.push(`vm.${column} = ?`), params.push(q[param]));
    }
    if (q.variant) (where.push("v.variant = ?"), params.push(norm(q.variant)));
    if (q.colour) (where.push("v.colour = ?"), params.push(norm(q.colour)));
    if (q.outlet_id) (where.push("v.outlet_id = ?"), params.push(q.outlet_id));
    if (q.status) (where.push("v.status = ?"), params.push(q.status));
    else where.push("v.status IN ('IN_TRANSIT','RECEIVED','INVOICED')");
    if (q.commitment === "FREE") where.push("a.id IS NULL AND v.is_blocked = 0 AND v.status IN ('IN_TRANSIT','RECEIVED')");
    if (q.commitment === "ALLOCATED") where.push("a.id IS NOT NULL");
    if (q.commitment === "BLOCKED") where.push("v.is_blocked = 1");
    // As the DMS has it: UNALLOTED, ALLOTED or IBND.
    if (q.dms_stock_type) (where.push("v.dms_stock_type = ?"), params.push(norm(q.dms_stock_type)));
    if (q.min_age && Number(q.min_age) > 0) (where.push("v.wholesale_invoice_date IS NOT NULL AND v.wholesale_invoice_date <= ?"), params.push(new Date(ctx.now.getTime() - Number(q.min_age) * 86_400_000).toISOString().slice(0, 10)));
    if (q.q) {
      const like = `%${likeText(norm(q.q))}%`;
      (where.push("(v.vin LIKE ? OR v.model LIKE ? OR b.booking_no LIKE ?)"), params.push(like, like, like));
    }
    const rows = await all(
      ctx.db,
      `SELECT v.id, v.vin, v.variant_id, vm.category, vm.trim_level AS trim, vm.transmission, vm.fuel, vm.drive, vm.seater, v.model, v.variant, v.colour, v.status, v.is_blocked, v.block_reason, v.outlet_id, o.name AS outlet, v.wholesale_invoice_no, v.wholesale_invoice_date,
              v.dispatch_date, v.expected_arrival_date, v.received_at, v.invoiced_at, v.updated_at,
              v.description, v.oem_model_code, v.oem_colour_code, v.dms_colour, v.seating, v.is_demo, v.dms_stock_type, v.dms_booking_no, v.dms_invoice_id, v.report_date, v.net_dealer_price,
              a.id AS allocation_id, a.type AS allocation_type, a.source AS allocation_source, a.needs_transfer, b.id AS booking_id, b.booking_no, b.customer_name, b.outlet_id AS booking_outlet_id
       FROM vehicles v JOIN outlets o ON o.id = v.outlet_id LEFT JOIN vehicle_variants vm ON vm.id = v.variant_id
       LEFT JOIN allocations a ON a.vehicle_id = v.id AND a.status = 'ACTIVE' LEFT JOIN bookings b ON b.id = a.booking_id
       WHERE ${where.join(" AND ")}
       ORDER BY v.model, v.variant, v.colour, CASE v.status WHEN 'RECEIVED' THEN 0 WHEN 'IN_TRANSIT' THEN 1 ELSE 2 END, v.expected_arrival_date LIMIT 1000`,
      ...params,
    );
    // Everyone sees that a car is committed. Whose it is, is shown only to people who may see that booking:
    // not to sales executives, and not to staff of another outlet.
    const user = c.get("user");
    const scope = outletScope(c);
    const showValue = can(user, ctx.settings, "stock.value");
    const today = Date.parse(`${new Intl.DateTimeFormat("en-CA", { timeZone: ctx.tenant.timezone }).format(ctx.now)}T00:00:00Z`);
    for (const r of rows as any[]) {
      if (r.booking_id && (user.role === "SALES_EXEC" || (scope && !scope.includes(r.booking_outlet_id)))) {
        r.customer_name = "Allocated";
        r.booking_no = null;
        r.booking_id = null;
        r.dms_booking_no = null;
      }
      if (!showValue) r.net_dealer_price = undefined;
      // Days since the manufacturer's invoice: how long the dealership has been carrying the car.
      r.age_days = r.wholesale_invoice_date ? Math.max(0, Math.round((today - Date.parse(`${r.wholesale_invoice_date}T00:00:00Z`)) / 86_400_000)) : null;
      r.is_demo = Boolean(r.is_demo);
    }
    return c.json(rows);
  });

  app.get("/api/vehicles/:id", async (c) => {
    need(c, "stock.view");
    const ctx = c.get("ctx");
    const v = await getVehicle(ctx, c.req.param("id"));
    const outlet = await first<{ name: string }>(ctx.db, `SELECT name FROM outlets WHERE id = ?`, v.outlet_id);
    const events = await all<any>(ctx.db, `SELECT e.type, e.from_status, e.to_status, e.detail_json, e.actor, e.at, u.name AS actor_name FROM vehicle_events e LEFT JOIN users u ON u.id = e.actor WHERE e.tenant_id = ? AND e.vehicle_id = ? ORDER BY e.at DESC`, ctx.tenantId, v.id);
    const allocations = await all<any>(ctx.db, `SELECT a.id, a.type, a.status, a.allocated_at, a.allocated_by, a.released_at, a.release_reason, a.needs_transfer, b.id AS booking_id, b.booking_no, b.outlet_id AS booking_outlet_id FROM allocations a JOIN bookings b ON b.id = a.booking_id WHERE a.tenant_id = ? AND a.vehicle_id = ? ORDER BY a.allocated_at DESC`, ctx.tenantId, v.id);
    // As in the list: the car's commitments are visible, the bookings behind them only to those who may see them.
    const user = c.get("user");
    const scope = outletScope(c);
    for (const a of allocations) {
      if (user.role === "SALES_EXEC" || (scope && !scope.includes(a.booking_outlet_id))) (a.booking_id = null), (a.booking_no = null);
    }
    const master = v.variant_id ? await first<Record<string, unknown>>(ctx.db, `SELECT category, trim_level AS trim, transmission, fuel, drive, seater FROM vehicle_variants WHERE id = ? AND tenant_id = ?`, v.variant_id, ctx.tenantId) : null;
    const showValue = can(user, ctx.settings, "stock.value");
    const hideOrder = user.role === "SALES_EXEC" || Boolean(scope && !scope.includes(v.outlet_id));
    const dms = v as unknown as Record<string, unknown>;
    return c.json({
      vehicle: { ...v, ...(master ?? {}), outlet: outlet?.name, net_dealer_price: showValue ? dms.net_dealer_price : undefined, dms_customer_name: hideOrder ? undefined : dms.dms_customer_name, dms_issues: safeJson(String(dms.dms_issues_json ?? "[]"), []), dms_issues_json: undefined },
      events: events.map((e) => ({ ...e, actor_name: e.actor_name ?? (String(e.actor).startsWith("UPLOAD:") ? "DMS file" : e.actor === "EOD" ? "End-of-day feed" : e.actor === "SYSTEM" ? "System" : e.actor), detail: safeJson(e.detail_json, {}) })),
      allocations,
    });
  });

  // ------------------------------------------------------------ stock changes during the day
  app.post("/api/vehicles", async (c) => {
    need(c, "stock.manage");
    const b = await jsonBody(c);
    needOutlet(c, String(b.outlet_id ?? ""));
    return c.json(await addVehicle(c.get("ctx"), b as any), 201);
  });

  app.patch("/api/vehicles/:id", async (c) => {
    need(c, "stock.manage");
    const ctx = c.get("ctx");
    const v = await getVehicle(ctx, c.req.param("id"));
    needOutlet(c, v.outlet_id);
    return c.json(await updateVehicleDetails(ctx, v.id, await jsonBody(c)));
  });

  app.post("/api/vehicles/:id/receive", async (c) => {
    need(c, "stock.manage");
    const ctx = c.get("ctx");
    const v = await getVehicle(ctx, c.req.param("id"));
    needOutlet(c, v.outlet_id);
    return c.json(await receiveVehicle(ctx, v.id));
  });

  /** Receive several cars at once by chassis number, for example when a carrier load arrives. */
  app.post("/api/vehicles/receive-bulk", async (c) => {
    need(c, "stock.manage");
    const ctx = c.get("ctx");
    const body = await jsonBody<{ vins?: string[] }>(c);
    const vins = (body.vins ?? []).map(norm).filter(Boolean).slice(0, 60);
    if (!vins.length) throw bad("Give at least one chassis number");
    const done: string[] = [];
    const errors: { vin: string; message: string }[] = [];
    for (const vin of vins) {
      const v = await first<{ id: string; outlet_id: string }>(ctx.db, `SELECT id, outlet_id FROM vehicles WHERE tenant_id = ? AND vin = ?`, ctx.tenantId, vin);
      try {
        if (!v) throw notFound(`Chassis ${vin}`);
        needOutlet(c, v.outlet_id);
        await receiveVehicle(ctx, v.id);
        done.push(vin);
      } catch (e) {
        errors.push({ vin, message: (e as Error).message });
      }
    }
    return c.json({ received: done, errors });
  });

  app.post("/api/vehicles/:id/transfer", async (c) => {
    need(c, "stock.manage");
    const ctx = c.get("ctx");
    const v = await getVehicle(ctx, c.req.param("id"));
    needOutlet(c, v.outlet_id);
    const b = await jsonBody<{ outlet_id?: string }>(c);
    return c.json(await transferVehicle(ctx, v.id, String(b.outlet_id ?? "")));
  });

  app.post("/api/vehicles/:id/block", async (c) => {
    need(c, "stock.manage");
    const ctx = c.get("ctx");
    const v = await getVehicle(ctx, c.req.param("id"));
    needOutlet(c, v.outlet_id);
    return c.json(await blockVehicle(ctx, v.id, String((await jsonBody(c)).reason ?? "")));
  });

  app.post("/api/vehicles/:id/unblock", async (c) => {
    need(c, "stock.manage");
    const ctx = c.get("ctx");
    const v = await getVehicle(ctx, c.req.param("id"));
    needOutlet(c, v.outlet_id);
    return c.json(await unblockVehicle(ctx, v.id));
  });

  app.post("/api/vehicles/:id/remove", async (c) => {
    need(c, "stock.manage");
    const ctx = c.get("ctx");
    const v = await getVehicle(ctx, c.req.param("id"));
    needOutlet(c, v.outlet_id);
    return c.json(await removeVehicle(ctx, v.id, String((await jsonBody(c)).reason ?? "")));
  });

  app.post("/api/allocations/run", async (c) => {
    need(c, "allocation.run");
    const out = await allocateAll(c.get("ctx"));
    return c.json({ allocated: out.length, allocations: out });
  });

  // ------------------------------------------------------------ the two DMS files
  /**
   * The DMS stock report (.xlsx as exported, or .csv with the same headings). Options: report_date (YYYY-MM-DD;
   * otherwise read from the file name, otherwise today), mode (COMPLETE, the default, or PARTIAL),
   * confirm_missing=1, and continue=<upload id> when the previous answer said `more`.
   */
  app.post("/api/uploads/stock", async (c) => {
    need(c, "upload.stock");
    const { bytes, filename, opt } = await readUpload(c);
    const reportDate = opt("report_date") ? parseDate(opt("report_date")) : null;
    if (opt("report_date") && !reportDate) throw bad("The report date is not valid");
    return c.json(await importStockReport(c.get("ctx"), bytes, { filename, reportDate, mode: opt("mode") === "PARTIAL" ? "PARTIAL" : "COMPLETE", outletScope: outletScope(c), confirmMissing: opt("confirm_missing") === "1", continueUpload: opt("continue") ?? null }));
  });

  /** The DMS booking sheet. Option: continue=<upload id> when the previous answer said `more`. */
  app.post("/api/uploads/bookings", async (c) => {
    need(c, "upload.bookings");
    const { bytes, filename, opt } = await readUpload(c);
    return c.json(await importBookingSheet(c.get("ctx"), bytes, { filename, outletScope: outletScope(c), continueUpload: opt("continue") ?? null }));
  });

  app.get("/api/uploads", async (c) => {
    const ctx = c.get("ctx");
    const user = c.get("user");
    if (!(["upload.stock", "upload.bookings", "recon.view"] as const).some((p) => can(user, ctx.settings, p))) throw forbidden();
    const rows = await all<any>(ctx.db, `SELECT u.*, us.name AS uploaded_by_name FROM uploads u LEFT JOIN users us ON us.id = u.uploaded_by WHERE u.tenant_id = ? ORDER BY u.at DESC LIMIT 60`, ctx.tenantId);
    return c.json({
      issue_labels: STOCK_ISSUES,
      uploads: rows.map((r) => {
        const summary = safeJson<Record<string, unknown>>(r.summary_json, {});
        return { ...r, allocations: summary._allocations ?? 0, summary, errors: safeJson<{ errors?: unknown[] }>(r.errors_json, {}).errors ?? [], errors_json: undefined, summary_json: undefined, outlets_json: undefined };
      }),
    });
  });

  /** Which stock report and booking sheet the screens are showing, and whether they are out of date. Anyone signed in may ask. */
  app.get("/api/data-status", async (c) => c.json(await dataStatus(c.get("ctx"))));

  void notFound;
}
