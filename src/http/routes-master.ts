import { all } from "../lib/db";
import { bad, toCsv } from "../lib/util";
import { addVariant, catalog, exportMaster, importMaster, loadMaster, mapAlias, removeAlias, setColours, updateVariant } from "../domain/master";
import { jsonBody, need, type App } from "./app";

/** The vehicle master: variants with their attributes, colours per model, and the mapping of DMS names. */
export function masterRoutes(app: App) {
  /** For the pickers on every screen: active variants and each model's colours. Open to every signed-in user. */
  app.get("/api/catalog", async (c) => {
    const ctx = c.get("ctx");
    const cat = await catalog(ctx);
    if (cat.master) return c.json({ ...cat, legacy: [] });
    // A dealership without a master picks from the combinations it already has in stock and bookings.
    const legacy = await all<{ model: string; variant: string; colour: string }>(
      ctx.db,
      `SELECT DISTINCT model, variant, colour FROM vehicles WHERE tenant_id = ? UNION SELECT DISTINCT model, variant, colour FROM bookings WHERE tenant_id = ? ORDER BY 1, 2, 3 LIMIT 2000`,
      ctx.tenantId,
      ctx.tenantId,
    );
    return c.json({ ...cat, legacy });
  });

  /** The whole master for the maintenance screen, with how much stock and how many open bookings use each variant. */
  app.get("/api/master", async (c) => {
    need(c, "master.manage");
    const ctx = c.get("ctx");
    const m = await loadMaster(ctx);
    const usage = new Map<string, { cars: number; bookings: number }>();
    for (const r of await all<{ variant_id: string; n: number }>(ctx.db, `SELECT variant_id, COUNT(*) AS n FROM vehicles WHERE tenant_id = ? AND variant_id IS NOT NULL AND status IN ('IN_TRANSIT','RECEIVED') GROUP BY variant_id`, ctx.tenantId)) usage.set(r.variant_id, { cars: r.n, bookings: 0 });
    for (const r of await all<{ variant_id: string; n: number }>(ctx.db, `SELECT variant_id, COUNT(*) AS n FROM bookings WHERE tenant_id = ? AND variant_id IS NOT NULL AND status IN ('DRAFT','SUBMITTED','APPROVED','ALLOCATED') GROUP BY variant_id`, ctx.tenantId)) usage.set(r.variant_id, { cars: usage.get(r.variant_id)?.cars ?? 0, bookings: r.n });
    const colours: Record<string, string[]> = {};
    for (const [model, list] of m.colours) colours[model] = [...list.values()].sort();
    const names = await all<any>(
      ctx.db,
      `SELECT a.id, a.kind, a.alias, a.model, a.variant_id, v.variant, a.colour, a.seen_count, a.last_seen_at, a.mapped_at, u.name AS mapped_by_name
       FROM vehicle_aliases a LEFT JOIN vehicle_variants v ON v.id = a.variant_id LEFT JOIN users u ON u.id = a.mapped_by
       WHERE a.tenant_id = ? ORDER BY (a.variant_id IS NULL AND a.colour IS NULL) DESC, a.last_seen_at DESC LIMIT 1000`,
      ctx.tenantId,
    );
    const untied = {
      cars: (await all<{ n: number }>(ctx.db, `SELECT COUNT(*) AS n FROM vehicles WHERE tenant_id = ? AND variant_id IS NULL AND status IN ('IN_TRANSIT','RECEIVED')`, ctx.tenantId))[0].n,
      bookings: (await all<{ n: number }>(ctx.db, `SELECT COUNT(*) AS n FROM bookings WHERE tenant_id = ? AND variant_id IS NULL AND status IN ('DRAFT','SUBMITTED','APPROVED','ALLOCATED')`, ctx.tenantId))[0].n,
    };
    // Colours the two DMS reports name differently for cars the DMS itself has allotted to those bookings:
    // the evidence for saying "these two names are the same colour for this model".
    const colourReview = await all<{ model: string; booking_says: string; stock_says: string; cars: number }>(
      ctx.db,
      `SELECT b.model, b.dms_colour AS booking_says, v.dms_colour AS stock_says, COUNT(*) AS cars FROM allocations a JOIN bookings b ON b.id = a.booking_id JOIN vehicles v ON v.id = a.vehicle_id
       WHERE a.tenant_id = ? AND a.source = 'DMS' AND b.dms_colour IS NOT NULL AND v.dms_colour IS NOT NULL AND b.dms_colour <> v.dms_colour AND v.paint_alias = ''
       GROUP BY 1, 2, 3 ORDER BY cars DESC LIMIT 100`,
      ctx.tenantId,
    );
    const mapped = (model: string, name: string) => m.colourAlias.has(`${model}|${name.replace(/[^A-Z0-9]/g, "")}`);
    return c.json({
      colour_review: colourReview.map((r) => ({ ...r, mapped: mapped(r.model, r.booking_says) || mapped(r.model, r.stock_says) })),
      enforced: m.enforced,
      variants: m.variants.map((v) => ({ ...v, is_active: Boolean(v.is_active), cars_in_stock: usage.get(v.id)?.cars ?? 0, open_bookings: usage.get(v.id)?.bookings ?? 0 })),
      colours,
      names: names.map((n) => ({ ...n, pending: !n.variant_id && !n.colour })),
      pending_names: names.filter((n) => !n.variant_id && !n.colour).length,
      // Cars and bookings entered before the master was loaded; they are tied to it the next time a file names them.
      not_tied_to_master: untied,
    });
  });

  app.post("/api/master/variants", async (c) => {
    need(c, "master.manage");
    return c.json(await addVariant(c.get("ctx"), await jsonBody(c)), 201);
  });

  app.patch("/api/master/variants/:id", async (c) => {
    need(c, "master.manage");
    return c.json(await updateVariant(c.get("ctx"), c.req.param("id"), await jsonBody(c)));
  });

  app.put("/api/master/colours", async (c) => {
    need(c, "master.manage");
    const b = await jsonBody<{ model?: string; colours?: unknown[] }>(c);
    return c.json({ model: b.model, colours: await setColours(c.get("ctx"), String(b.model ?? ""), b.colours ?? []) });
  });

  /** Maps a DMS name to a master variant or colour: an existing pending name by id, or a new one. */
  app.post("/api/master/names", async (c) => {
    need(c, "master.manage");
    return c.json(await mapAlias(c.get("ctx"), await jsonBody(c)));
  });

  app.delete("/api/master/names/:id", async (c) => {
    need(c, "master.manage");
    await removeAlias(c.get("ctx"), c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/api/uploads/master", async (c) => {
    need(c, "master.manage");
    if (Number(c.req.header("Content-Length") ?? "0") > 6 * 1024 * 1024) throw bad("The file is larger than 5 MB");
    const type = c.req.header("Content-Type") ?? "";
    let text: string, filename: string | undefined;
    if (type.includes("multipart/form-data")) {
      const form = await c.req.formData();
      const file = form.get("file") as unknown;
      if (!file || typeof file === "string") throw bad("Attach the CSV file in the field named file");
      text = await (file as File).text();
      filename = (file as File).name;
    } else {
      text = await c.req.text();
      filename = c.req.query("filename") ?? undefined;
    }
    return c.json(await importMaster(c.get("ctx"), text, { filename }));
  });

  /** The current vehicle master as a CSV sheet, to fill in and load back. */
  app.get("/api/master/export", async (c) => {
    need(c, "master.manage");
    return new Response(toCsv(await exportMaster(c.get("ctx"))), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="vehicle-master.csv"`, "Cache-Control": "private, no-store" } });
  });
}
