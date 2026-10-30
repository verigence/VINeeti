// The vehicle master: the manufacturer's product list as this dealership sells it.
//
// For Mahindra a car is identified by Category, Model, Trim, Transmission, Fuel, Drive, Seater and
// Variant. The variant name is the key. Every car in stock, every booking and every order is tied to one
// master variant, so "does this car fit this booking" is never a matter of how somebody typed a name.
//
// Names in DMS exports rarely match the master letter for letter. Three things take care of that:
//   1. matching ignores case, spacing and punctuation ("AX7 L - Diesel AT" is "AX7L DIESEL AT");
//   2. a row may give the attributes (model, trim, transmission, fuel, drive, seater) instead of the name;
//   3. a name that still does not match is remembered as "to be mapped"; the administrator points it at
//      the right master variant once, and every later file resolves it.
//
// The DMS stock report and booking sheet register their variants here as they appear (registerDmsCars):
// the description parser reads model, trim, transmission, fuel, drive and seater, and the variant name
// carries the OEM model code, "AX5 PM MT (M1024)". What the description does not state stays blank until
// the dealership fills it on the Vehicle master screen or loads its reviewed catalogue.
//
// Colour. The two DMS reports do not always name a paint the same way ("WHITE" in one, "DIAMOND WHITE"
// in the other). Two things settle it without guessing:
//   - where the description ends in a paint alias ("... WQ"), a booking takes the colour name that cars
//     of the same model and alias carry in the stock report (vehicle_paints);
//   - otherwise names must be equal, unless the dealership has said two names are the same colour for a
//     model (a colour mapping), which then applies to cars and bookings alike.
//
// A dealership with no master loaded keeps working on free-text model / variant / colour.

import type { Ctx } from "../env";
import { all, audit, chunk, first, run, stmt } from "../lib/db";
import { bad, conflict, iso, newId, norm, notFound, parseCsv } from "../lib/util";

export const keyOf = (s: unknown) => norm(s).replace(/[^A-Z0-9]/g, "");
const clean = (s: unknown) => String(s ?? "").trim().replace(/\s+/g, " ");

export interface Variant {
  id: string;
  category: string;
  model: string;
  trim: string;
  transmission: string;
  fuel: string;
  drive: string;
  seater: string;
  variant: string;
  variant_key: string;
  is_active: number;
  oem_model_code: string;
  origin: string;
  fuel_source: string | null;
}

export interface Master {
  /** True once the dealership has a master: from then on every car and booking must name a master variant. */
  enforced: boolean;
  variants: Variant[];
  byId: Map<string, Variant>;
  byKey: Map<string, Variant>;
  /** DMS name (key) -> master variant id. */
  variantAlias: Map<string, string>;
  /** model -> colour key -> colour name. Empty for a model that accepts any colour. */
  colours: Map<string, Map<string, string>>;
  /** `${model}|${colour key}` -> colour name. */
  colourAlias: Map<string, string>;
  /** `${model}|${paint alias}` -> the colour names cars of that model and paint alias carry. */
  paints: Map<string, Set<string>>;
}

const VARIANT_COLS = `id, category, model, trim_level AS trim, transmission, fuel, drive, seater, variant, variant_key, is_active, oem_model_code, origin, fuel_source`;

export async function loadMaster(ctx: Ctx, fresh = false): Promise<Master> {
  const cached = ctx.cache.get("master") as Master | undefined;
  if (cached && !fresh) return cached;
  const variants = await all<Variant>(ctx.db, `SELECT ${VARIANT_COLS} FROM vehicle_variants WHERE tenant_id = ? ORDER BY category, model, trim_level, fuel, transmission, drive, seater, variant`, ctx.tenantId);
  const colourRows = await all<{ model: string; colour: string; colour_key: string }>(ctx.db, `SELECT model, colour, colour_key FROM vehicle_colours WHERE tenant_id = ? ORDER BY model, colour`, ctx.tenantId);
  const aliasRows = await all<{ kind: string; alias_key: string; model: string; variant_id: string | null; colour: string | null }>(ctx.db, `SELECT kind, alias_key, model, variant_id, colour FROM vehicle_aliases WHERE tenant_id = ? AND (variant_id IS NOT NULL OR colour IS NOT NULL)`, ctx.tenantId);
  const paintRows = await all<{ model: string; paint_alias: string; colour: string }>(ctx.db, `SELECT DISTINCT model, paint_alias, colour FROM vehicle_paints WHERE tenant_id = ? AND paint_alias <> ''`, ctx.tenantId);
  const m: Master = {
    enforced: variants.length > 0,
    variants,
    byId: new Map(variants.map((v) => [v.id, v])),
    byKey: new Map(variants.map((v) => [v.variant_key, v])),
    variantAlias: new Map(),
    colours: new Map(),
    colourAlias: new Map(),
    paints: new Map(),
  };
  for (const p of paintRows) {
    const k = `${p.model}|${p.paint_alias}`;
    if (!m.paints.has(k)) m.paints.set(k, new Set());
    m.paints.get(k)!.add(p.colour);
  }
  for (const c of colourRows) {
    if (!m.colours.has(c.model)) m.colours.set(c.model, new Map());
    m.colours.get(c.model)!.set(c.colour_key, c.colour);
  }
  for (const a of aliasRows) {
    if (a.kind === "VARIANT" && a.variant_id) m.variantAlias.set(a.alias_key, a.variant_id);
    if (a.kind === "COLOUR" && a.colour) m.colourAlias.set(`${a.model}|${a.alias_key}`, a.colour);
  }
  ctx.cache.set("master", m);
  return m;
}

export interface ConfigInput {
  variant_id?: string | null;
  variant?: string | null;
  model?: string | null;
  trim?: string | null;
  transmission?: string | null;
  fuel?: string | null;
  drive?: string | null;
  seater?: string | null;
  colour?: string | null;
}

export type Resolved<T> = { ok: true; value: T } | { ok: false; message: string; unmapped?: { kind: "VARIANT" | "COLOUR"; alias: string; model: string } };

/** Finds the master variant a row means: by id, by name, by a mapped DMS name, or by its attributes. */
export function resolveVariant(m: Master, input: ConfigInput, opts: { allowInactive?: boolean } = {}): Resolved<Variant> {
  let v: Variant | undefined;
  const name = clean(input.variant);
  if (input.variant_id) {
    v = m.byId.get(String(input.variant_id));
    if (!v) return { ok: false, message: "The variant chosen is not in the vehicle master" };
  } else if (name) {
    const key = keyOf(name);
    v = m.byKey.get(key) ?? m.byId.get(m.variantAlias.get(key) ?? "");
    // Many DMS exports give model and variant in separate columns ("XUV700" + "AX7 L DIESEL AT"), while the master name carries both.
    if (!v && input.model) {
      const joined = keyOf(`${input.model} ${name}`);
      v = m.byKey.get(joined) ?? m.byId.get(m.variantAlias.get(joined) ?? "");
    }
    if (!v) return { ok: false, message: `Variant "${name}" is not in the vehicle master. Map it on the Vehicle master screen, or correct the name.`, unmapped: { kind: "VARIANT", alias: input.model && !keyOf(name).startsWith(keyOf(input.model)) ? `${clean(input.model)} ${name}` : name, model: "" } };
  } else {
    const want = { model: keyOf(input.model), trim: keyOf(input.trim), transmission: keyOf(input.transmission), fuel: keyOf(input.fuel), drive: keyOf(input.drive), seater: keyOf(input.seater) };
    if (!want.model) return { ok: false, message: "Give the variant, or the model with its trim, transmission, fuel, drive and seater" };
    const hits = m.variants.filter(
      (x) => keyOf(x.model) === want.model && (!want.trim || keyOf(x.trim) === want.trim) && (!want.transmission || keyOf(x.transmission) === want.transmission) && (!want.fuel || keyOf(x.fuel) === want.fuel) && (!want.drive || keyOf(x.drive) === want.drive) && (!want.seater || keyOf(x.seater) === want.seater),
    );
    const live = hits.filter((x) => x.is_active);
    const pool = live.length ? live : hits;
    if (pool.length === 0) return { ok: false, message: `No variant in the vehicle master matches ${[input.model, input.trim, input.fuel, input.transmission, input.drive, input.seater].map(clean).filter(Boolean).join(" / ")}` };
    if (pool.length > 1) return { ok: false, message: `${pool.length} variants in the vehicle master match ${[input.model, input.trim, input.fuel, input.transmission, input.drive, input.seater].map(clean).filter(Boolean).join(" / ")}; give the variant name` };
    v = pool[0];
  }
  if (!v.is_active && !opts.allowInactive) return { ok: false, message: `Variant "${v.variant}" is marked discontinued in the vehicle master and cannot take new bookings` };
  return { ok: true, value: v };
}

export function resolveColour(m: Master, model: string, colour: unknown): Resolved<string> {
  const name = norm(colour);
  if (!name) return { ok: false, message: "Colour is required" };
  const list = m.colours.get(model);
  if (!list || list.size === 0) return { ok: true, value: name }; // no colour list for this model: any colour name is accepted
  const key = keyOf(name);
  const hit = list.get(key) ?? m.colourAlias.get(`${model}|${key}`);
  if (hit) return { ok: true, value: hit };
  return { ok: false, message: `Colour "${clean(colour)}" is not in the colour list for ${model}. Map it on the Vehicle master screen, or correct the name.`, unmapped: { kind: "COLOUR", alias: clean(colour), model } };
}

export interface ResolvedConfig {
  variant_id: string | null;
  model: string;
  variant: string;
  colour: string;
}

/** Resolves model / variant / colour against the master (or, with no master loaded, tidies the free text). */
export function resolveConfigIn(m: Master, input: ConfigInput, opts: { allowInactive?: boolean; colourOptional?: boolean } = {}): Resolved<ResolvedConfig> {
  if (!m.enforced) {
    const model = norm(input.model), variant = norm(input.variant), colour = norm(input.colour);
    if (!model || !variant || (!colour && !opts.colourOptional)) return { ok: false, message: "Model, variant and colour are required" };
    return { ok: true, value: { variant_id: null, model, variant, colour } };
  }
  const v = resolveVariant(m, input, opts);
  if (!v.ok) return v;
  if (opts.colourOptional && !norm(input.colour)) return { ok: true, value: { variant_id: v.value.id, model: v.value.model, variant: v.value.variant, colour: "" } };
  const c = resolveColour(m, v.value.model, input.colour);
  if (!c.ok) return c;
  return { ok: true, value: { variant_id: v.value.id, model: v.value.model, variant: v.value.variant, colour: c.value } };
}

/** For single entries from the screens: throws a readable error instead of returning one. */
export async function resolveConfig(ctx: Ctx, input: ConfigInput, opts: { allowInactive?: boolean } = {}): Promise<ResolvedConfig> {
  const r = resolveConfigIn(await loadMaster(ctx), input, opts);
  if (!r.ok) throw bad(r.message, "NOT_IN_MASTER");
  return r.value;
}

/** Remembers names from an upload that could not be matched, so they can be mapped once on the screen. */
export async function notePending(ctx: Ctx, items: { kind: "VARIANT" | "COLOUR"; alias: string; model: string }[]): Promise<number> {
  const seen = new Map<string, { kind: string; alias: string; model: string; n: number }>();
  for (const it of items) {
    const k = `${it.kind}|${it.model}|${keyOf(it.alias)}`;
    const cur = seen.get(k);
    if (cur) cur.n++;
    else seen.set(k, { ...it, n: 1 });
  }
  const at = iso(ctx.now);
  const stmts = [...seen.values()].slice(0, 200).map((s) =>
    stmt(
      ctx.db,
      `INSERT INTO vehicle_aliases (id, tenant_id, kind, alias, alias_key, model, seen_count, last_seen_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT (tenant_id, kind, model, alias_key) DO UPDATE SET seen_count = seen_count + excluded.seen_count, last_seen_at = excluded.last_seen_at`,
      newId("als"), ctx.tenantId, s.kind, s.alias.slice(0, 200), keyOf(s.alias), s.model, s.n, at, at,
    ),
  );
  for (let i = 0; i < stmts.length; i += 40) await ctx.db.batch(stmts.slice(i, i + 40));
  return seen.size;
}

// ---------------------------------------------------------------- colour

/** The name a colour is matched by for a model: the dealership's mapping if it has one, otherwise the name itself. */
export function canonColour(m: Master, model: string, name: unknown): string {
  const n = norm(name);
  if (!n) return "";
  return m.colourAlias.get(`${model}|${keyOf(n)}`) ?? n;
}

/**
 * The colour of a booking. Where its description ends in a paint alias and the stock reports have shown
 * cars of that model and alias under one colour name, that name; otherwise the booking sheet's own name.
 */
export function bookingColour(m: Master, b: { model: string; paint_alias: string; dms_colour: string }): string {
  if (b.paint_alias) {
    const names = m.paints.get(`${b.model}|${b.paint_alias}`);
    if (names?.size === 1) return [...names][0];
  }
  return canonColour(m, b.model, b.dms_colour);
}

// ---------------------------------------------------------------- variants, colours and paints from the DMS files

export interface DmsCarInput {
  category?: string;
  model: string;
  variant: string;
  trim: string;
  transmission: string;
  fuel: string;
  drive: string;
  seater: string;
  oem_model_code: string;
  /** Where the fuel came from, when it is not in the description itself. */
  fuel_source?: string;
}

const DMS_ATTRS = ["category", "trim", "transmission", "fuel", "drive", "seater", "oem_model_code"] as const;

/**
 * Makes sure every car named in a DMS file is a master variant. A new name is added with what the file
 * states; an existing variant only has its blanks filled, never a value replaced. Returns the variant
 * for each name (by variant key), how many were added, and where the file disagrees with the master.
 */
export async function registerDmsCars(ctx: Ctx, cars: DmsCarInput[]): Promise<{ byKey: Map<string, Variant>; added: number; filled: number; conflicts: string[] }> {
  const m = await loadMaster(ctx, true);
  const at = iso(ctx.now);
  // One entry per variant name, taking for each attribute the first value any row states.
  const wanted = new Map<string, DmsCarInput & { key: string }>();
  for (const c of cars) {
    const key = keyOf(c.variant);
    if (!key || !c.model) continue;
    const cur = wanted.get(key);
    if (!cur) wanted.set(key, { ...c, category: clean(c.category), key });
    else for (const a of DMS_ATTRS) if (!cur[a] && c[a]) (cur[a] = clean(c[a])), a === "fuel" && (cur.fuel_source = c.fuel_source);
  }
  // A model's category (segment) is the same for all its variants; a booking sheet does not carry it.
  const categoryOf = new Map<string, string>();
  for (const v of m.variants) if (v.category && !categoryOf.has(v.model)) categoryOf.set(v.model, v.category);
  for (const w of wanted.values()) if (w.category && !categoryOf.has(w.model)) categoryOf.set(w.model, w.category);

  const inserts: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const conflicts: string[] = [];
  for (const w of wanted.values()) {
    if (!w.category) w.category = categoryOf.get(w.model) ?? "";
    const cur = m.byKey.get(w.key);
    if (!cur) {
      inserts.push({ id: newId("var"), category: w.category, model: w.model, trim: w.trim, transmission: w.transmission, fuel: w.fuel, drive: w.drive, seater: w.seater, variant: w.variant, key: w.key, code: w.oem_model_code, fuel_source: w.fuel ? w.fuel_source ?? "Description" : null });
      continue;
    }
    if (cur.model !== w.model) { conflicts.push(`${w.variant}: the master has it under model ${cur.model}, the file under ${w.model}`); continue; }
    const fill: Record<string, string> = {};
    for (const a of DMS_ATTRS) {
      const have = (cur as unknown as Record<string, string>)[a] ?? "";
      const want = w[a] ?? "";
      if (!have && want) fill[a] = want;
      else if (have && want && keyOf(have) !== keyOf(want) && a !== "category") conflicts.push(`${w.variant}: ${a.replace("_", " ")} is "${have}" in the master and "${want}" in the file`);
    }
    if (Object.keys(fill).length) updates.push({ id: cur.id, ...Object.fromEntries(DMS_ATTRS.map((a) => [a, fill[a] ?? null])), fuel_source: fill.fuel ? w.fuel_source ?? "Description" : null });
  }
  const stmts: D1PreparedStatement[] = [];
  for (const part of chunk(inserts)) {
    stmts.push(
      stmt(
        ctx.db,
        `INSERT INTO vehicle_variants (id, tenant_id, category, model, trim_level, transmission, fuel, drive, seater, variant, variant_key, oem_model_code, origin, fuel_source, is_active, created_at, updated_at)
         SELECT json_extract(j.value,'$.id'), ?2, json_extract(j.value,'$.category'), json_extract(j.value,'$.model'), json_extract(j.value,'$.trim'), json_extract(j.value,'$.transmission'), json_extract(j.value,'$.fuel'),
                json_extract(j.value,'$.drive'), json_extract(j.value,'$.seater'), json_extract(j.value,'$.variant'), json_extract(j.value,'$.key'), json_extract(j.value,'$.code'), 'DMS', json_extract(j.value,'$.fuel_source'), 1, ?3, ?3
         FROM json_each(?1) AS j WHERE true
         ON CONFLICT (tenant_id, variant_key) DO NOTHING`,
        JSON.stringify(part), ctx.tenantId, at,
      ),
    );
  }
  for (const part of chunk(updates)) {
    stmts.push(
      stmt(
        ctx.db,
        `UPDATE vehicle_variants SET
           category = COALESCE(json_extract(j.value,'$.category'), category), trim_level = COALESCE(json_extract(j.value,'$.trim'), trim_level),
           transmission = COALESCE(json_extract(j.value,'$.transmission'), transmission), fuel = COALESCE(json_extract(j.value,'$.fuel'), fuel),
           drive = COALESCE(json_extract(j.value,'$.drive'), drive), seater = COALESCE(json_extract(j.value,'$.seater'), seater),
           oem_model_code = COALESCE(json_extract(j.value,'$.oem_model_code'), oem_model_code), fuel_source = COALESCE(json_extract(j.value,'$.fuel_source'), fuel_source), updated_at = ?3
         FROM json_each(?1) AS j WHERE vehicle_variants.id = json_extract(j.value,'$.id') AND vehicle_variants.tenant_id = ?2`,
        JSON.stringify(part), ctx.tenantId, at,
      ),
    );
  }
  if (stmts.length) {
    // A model's category (its segment) is the same for all its variants. A variant that came from a booking
    // sheet has none; once any sibling from a stock report has one, the blanks take it.
    stmts.push(
      stmt(
        ctx.db,
        `UPDATE vehicle_variants SET category = (SELECT s.category FROM vehicle_variants s WHERE s.tenant_id = ?1 AND s.model = vehicle_variants.model AND s.category <> '' ORDER BY s.origin DESC, s.created_at LIMIT 1), updated_at = ?2
         WHERE tenant_id = ?1 AND category = '' AND EXISTS (SELECT 1 FROM vehicle_variants s WHERE s.tenant_id = ?1 AND s.model = vehicle_variants.model AND s.category <> '')`,
        ctx.tenantId, at,
      ),
    );
    await ctx.db.batch(stmts);
  }
  const fresh = stmts.length ? await loadMaster(ctx, true) : m;
  return { byKey: fresh.byKey, added: inserts.length, filled: updates.length, conflicts: conflicts.slice(0, 50) };
}

/** Adds colour names seen in a DMS file to their model's colour list, and records the paint codes a stock report shows. */
export async function registerColours(ctx: Ctx, seen: { model: string; colour: string }[], paints: { model: string; oem_colour_code: string; paint_alias: string; colour: string; dms_colour: string }[] = []): Promise<void> {
  const m = await loadMaster(ctx);
  const at = iso(ctx.now);
  const colours = new Map<string, { id: string; model: string; colour: string; key: string }>();
  for (const s of seen) {
    const key = keyOf(s.colour);
    if (!key || !s.model || m.colours.get(s.model)?.has(key)) continue;
    colours.set(`${s.model}|${key}`, { id: newId("col"), model: s.model, colour: s.colour, key });
  }
  const paintRows = new Map<string, (typeof paints)[number]>();
  for (const p of paints) if (p.model && p.oem_colour_code && p.colour) paintRows.set(`${p.model}|${p.oem_colour_code}|${p.paint_alias}`, p);
  const stmts: D1PreparedStatement[] = [];
  for (const part of chunk([...colours.values()])) {
    stmts.push(stmt(ctx.db, `INSERT OR IGNORE INTO vehicle_colours (id, tenant_id, model, colour, colour_key, created_at) SELECT json_extract(j.value,'$.id'), ?2, json_extract(j.value,'$.model'), json_extract(j.value,'$.colour'), json_extract(j.value,'$.key'), ?3 FROM json_each(?1) AS j`, JSON.stringify(part), ctx.tenantId, at));
  }
  for (const part of chunk([...paintRows.values()])) {
    stmts.push(
      stmt(
        ctx.db,
        `INSERT INTO vehicle_paints (tenant_id, model, oem_colour_code, paint_alias, colour, dms_colour, updated_at)
         SELECT ?2, json_extract(j.value,'$.model'), json_extract(j.value,'$.oem_colour_code'), json_extract(j.value,'$.paint_alias'), json_extract(j.value,'$.colour'), json_extract(j.value,'$.dms_colour'), ?3 FROM json_each(?1) AS j WHERE true
         ON CONFLICT (tenant_id, model, oem_colour_code, paint_alias) DO UPDATE SET colour = excluded.colour, dms_colour = excluded.dms_colour, updated_at = excluded.updated_at
           WHERE vehicle_paints.colour <> excluded.colour OR vehicle_paints.dms_colour <> excluded.dms_colour`,
        JSON.stringify(part), ctx.tenantId, at,
      ),
    );
  }
  if (stmts.length) {
    await ctx.db.batch(stmts);
    ctx.cache.delete("master");
  }
}

/**
 * Brings the colour name of bookings up to date after the paint codes or the colour mappings changed
 * (a stock report has shown a paint for the first time, or the dealership has mapped a name). A booking
 * that holds a car keeps the colour it has, exactly as when its row in the booking sheet is read again;
 * every other booking gets the name the sheet would give it now, so the result does not depend on which
 * of the two files was loaded first. Returns how many changed.
 */
export async function refreshBookingColours(ctx: Ctx, model?: string): Promise<number> {
  const m = await loadMaster(ctx, true);
  const rows = await all<{ id: string; model: string; colour: string; paint_alias: string; dms_colour: string }>(
    ctx.db,
    `SELECT id, model, colour, paint_alias, dms_colour FROM bookings b WHERE tenant_id = ? AND dms_colour IS NOT NULL ${model ? "AND model = ?" : ""}
       AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.booking_id = b.id AND a.status = 'ACTIVE') LIMIT 5000`,
    ...(model ? [ctx.tenantId, model] : [ctx.tenantId]),
  );
  const changed = rows.map((b) => ({ id: b.id, colour: bookingColour(m, b) })).filter((x, i) => x.colour && x.colour !== rows[i].colour);
  for (const part of chunk(changed)) {
    await run(ctx.db, `UPDATE bookings SET colour = json_extract(j.value,'$.colour'), updated_at = ?3 FROM json_each(?1) AS j WHERE bookings.id = json_extract(j.value,'$.id') AND bookings.tenant_id = ?2`, JSON.stringify(part), ctx.tenantId, iso(ctx.now));
  }
  return changed.length;
}

/** After a colour mapping changed for a model: the colour of its cars in stock follows the mapping, then its waiting bookings. */
async function recolourModel(ctx: Ctx, model: string): Promise<{ cars: number; bookings: number }> {
  const m = await loadMaster(ctx, true);
  const cars = await all<{ id: string; colour: string; dms_colour: string }>(
    ctx.db,
    `SELECT id, colour, dms_colour FROM vehicles v WHERE tenant_id = ? AND model = ? AND dms_colour IS NOT NULL AND status IN ('IN_TRANSIT','RECEIVED')
       AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.vehicle_id = v.id AND a.status = 'ACTIVE') LIMIT 5000`,
    ctx.tenantId, model,
  );
  const changed = cars.map((v) => ({ id: v.id, colour: canonColour(m, model, v.dms_colour) })).filter((x, i) => x.colour !== cars[i].colour);
  const at = iso(ctx.now);
  for (const part of chunk(changed)) {
    await run(ctx.db, `UPDATE vehicles SET colour = json_extract(j.value,'$.colour'), updated_at = ?3 FROM json_each(?1) AS j WHERE vehicles.id = json_extract(j.value,'$.id') AND vehicles.tenant_id = ?2`, JSON.stringify(part), ctx.tenantId, at);
  }
  // The paint table follows, so bookings that take their colour from a paint alias get the mapped name too.
  const paints = await all<{ oem_colour_code: string; paint_alias: string; colour: string; dms_colour: string }>(ctx.db, `SELECT oem_colour_code, paint_alias, colour, dms_colour FROM vehicle_paints WHERE tenant_id = ? AND model = ?`, ctx.tenantId, model);
  const paintStmts = paints.filter((p) => canonColour(m, model, p.dms_colour) !== p.colour).map((p) => stmt(ctx.db, `UPDATE vehicle_paints SET colour = ?, updated_at = ? WHERE tenant_id = ? AND model = ? AND oem_colour_code = ? AND paint_alias = ?`, canonColour(m, model, p.dms_colour), at, ctx.tenantId, model, p.oem_colour_code, p.paint_alias));
  for (const part of chunk(paintStmts, 40)) await ctx.db.batch(part);
  ctx.cache.delete("master");
  return { cars: changed.length, bookings: await refreshBookingColours(ctx, model) };
}

// ---------------------------------------------------------------- maintaining the master

export interface VariantInput {
  category?: string;
  model?: string;
  trim?: string;
  transmission?: string;
  fuel?: string;
  drive?: string;
  seater?: string;
  variant?: string;
  is_active?: boolean;
}

function tidy(input: VariantInput, opts: { categoryOptional?: boolean } = {}) {
  const v = { category: clean(input.category), model: norm(input.model), trim: clean(input.trim), transmission: clean(input.transmission), fuel: clean(input.fuel), drive: clean(input.drive), seater: clean(input.seater), variant: norm(input.variant) };
  if ((!v.category && !opts.categoryOptional) || !v.model || !v.variant) throw bad("Category, model and variant are required");
  for (const [k, val] of Object.entries(v)) if (val.length > 120) throw bad(`${k} is too long`);
  return { ...v, variant_key: keyOf(v.variant) };
}

export async function addVariant(ctx: Ctx, input: VariantInput): Promise<Variant> {
  const v = tidy(input);
  if (await first(ctx.db, `SELECT id FROM vehicle_variants WHERE tenant_id = ? AND variant_key = ?`, ctx.tenantId, v.variant_key)) throw conflict(`Variant "${v.variant}" is already in the vehicle master`);
  const id = newId("var");
  const at = iso(ctx.now);
  await run(ctx.db, `INSERT INTO vehicle_variants (id, tenant_id, category, model, trim_level, transmission, fuel, drive, seater, variant, variant_key, is_active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?)`, id, ctx.tenantId, v.category, v.model, v.trim, v.transmission, v.fuel, v.drive, v.seater, v.variant, v.variant_key, at, at);
  await audit(ctx, "MASTER_VARIANT_ADDED", "variant", id, v);
  ctx.cache.delete("master");
  return (await first<Variant>(ctx.db, `SELECT ${VARIANT_COLS} FROM vehicle_variants WHERE id = ?`, id))!;
}

/** Edits a master variant. A change of model or variant name is carried through to the stock, bookings and orders that use it. */
export async function updateVariant(ctx: Ctx, id: string, patch: VariantInput): Promise<Variant> {
  const cur = await first<Variant>(ctx.db, `SELECT ${VARIANT_COLS} FROM vehicle_variants WHERE id = ? AND tenant_id = ?`, id, ctx.tenantId);
  if (!cur) throw notFound("Variant");
  // The name of a variant registered from the DMS is its identity in the DMS files (model and OEM model code): it cannot be renamed here.
  if (cur.origin === "DMS" && ((patch.variant !== undefined && norm(patch.variant) !== cur.variant) || (patch.model !== undefined && norm(patch.model) !== cur.model))) throw bad("This variant comes from the DMS files; its model and name follow the DMS. The other attributes can be edited.");
  const v = tidy({ category: patch.category ?? cur.category, model: patch.model ?? cur.model, trim: patch.trim ?? cur.trim, transmission: patch.transmission ?? cur.transmission, fuel: patch.fuel ?? cur.fuel, drive: patch.drive ?? cur.drive, seater: patch.seater ?? cur.seater, variant: patch.variant ?? cur.variant }, { categoryOptional: cur.origin === "DMS" });
  if (v.variant_key !== cur.variant_key && (await first(ctx.db, `SELECT id FROM vehicle_variants WHERE tenant_id = ? AND variant_key = ? AND id <> ?`, ctx.tenantId, v.variant_key, id))) throw conflict(`Variant "${v.variant}" is already in the vehicle master`);
  const active = patch.is_active === undefined ? cur.is_active : patch.is_active ? 1 : 0;
  const at = iso(ctx.now);
  const renamed = v.model !== cur.model || v.variant !== cur.variant;
  await ctx.db.batch([
    stmt(ctx.db, `UPDATE vehicle_variants SET category = ?, model = ?, trim_level = ?, transmission = ?, fuel = ?, drive = ?, seater = ?, variant = ?, variant_key = ?, is_active = ?, fuel_source = CASE WHEN ? THEN 'Entered on the Vehicle master screen' ELSE fuel_source END, updated_at = ? WHERE id = ? AND tenant_id = ?`, v.category, v.model, v.trim, v.transmission, v.fuel, v.drive, v.seater, v.variant, v.variant_key, active, v.fuel !== cur.fuel ? 1 : 0, at, id, ctx.tenantId),
    ...(renamed
      ? [
          stmt(ctx.db, `UPDATE order_requests SET model = ?, variant = ? WHERE tenant_id = ? AND model = ? AND variant = ?`, v.model, v.variant, ctx.tenantId, cur.model, cur.variant),
          stmt(ctx.db, `UPDATE vehicles SET model = ?, variant = ? WHERE tenant_id = ? AND variant_id = ?`, v.model, v.variant, ctx.tenantId, id),
          stmt(ctx.db, `UPDATE bookings SET model = ?, variant = ? WHERE tenant_id = ? AND variant_id = ?`, v.model, v.variant, ctx.tenantId, id),
          ...(v.model !== cur.model ? [stmt(ctx.db, `UPDATE vehicle_colours SET model = ? WHERE tenant_id = ? AND model = ? AND NOT EXISTS (SELECT 1 FROM vehicle_variants x WHERE x.tenant_id = ? AND x.model = ? AND x.id <> ?)`, v.model, ctx.tenantId, cur.model, ctx.tenantId, cur.model, id)] : []),
        ]
      : []),
    stmt(ctx.db, `INSERT INTO audit_log (id, tenant_id, actor, action, entity_type, entity_id, detail_json, at) VALUES (?,?,?,?,?,?,?,?)`, newId("aud"), ctx.tenantId, ctx.actor, "MASTER_VARIANT_CHANGED", "variant", id, JSON.stringify({ before: cur, after: { ...v, is_active: active } }), at),
  ]);
  ctx.cache.delete("master");
  return (await first<Variant>(ctx.db, `SELECT ${VARIANT_COLS} FROM vehicle_variants WHERE id = ?`, id))!;
}

/** Replaces the colour list of one model. An empty list means "any colour name is accepted". */
export async function setColours(ctx: Ctx, modelRaw: string, colours: unknown[]): Promise<string[]> {
  const model = norm(modelRaw);
  if (!model) throw bad("Model is required");
  if (!(await first(ctx.db, `SELECT id FROM vehicle_variants WHERE tenant_id = ? AND model = ?`, ctx.tenantId, model))) throw bad(`Model ${model} is not in the vehicle master`);
  if (!Array.isArray(colours) || colours.length > 60) throw bad("Give the colours as a list of at most 60 names");
  const seen = new Map<string, string>();
  for (const c of colours) {
    const name = norm(c);
    if (!name) continue;
    if (name.length > 60) throw bad("A colour name is too long");
    seen.set(keyOf(name), name);
  }
  const at = iso(ctx.now);
  await ctx.db.batch([
    stmt(ctx.db, `DELETE FROM vehicle_colours WHERE tenant_id = ? AND model = ?`, ctx.tenantId, model),
    ...[...seen].map(([key, name]) => stmt(ctx.db, `INSERT INTO vehicle_colours (id, tenant_id, model, colour, colour_key, created_at) VALUES (?,?,?,?,?,?)`, newId("col"), ctx.tenantId, model, name, key, at)),
    stmt(ctx.db, `INSERT INTO audit_log (id, tenant_id, actor, action, entity_type, entity_id, detail_json, at) VALUES (?,?,?,?,?,?,?,?)`, newId("aud"), ctx.tenantId, ctx.actor, "MASTER_COLOURS_CHANGED", "model", model, JSON.stringify({ colours: [...seen.values()] }), at),
  ]);
  ctx.cache.delete("master");
  return [...seen.values()].sort();
}

/** Points a DMS name at the master variant (or colour) it means. */
export async function mapAlias(ctx: Ctx, input: { id?: string; kind?: "VARIANT" | "COLOUR"; alias?: string; model?: string; variant_id?: string | null; colour?: string | null }) {
  const m = await loadMaster(ctx);
  let row = input.id ? await first<{ id: string; kind: "VARIANT" | "COLOUR"; alias: string; model: string }>(ctx.db, `SELECT id, kind, alias, model FROM vehicle_aliases WHERE id = ? AND tenant_id = ?`, input.id, ctx.tenantId) : null;
  if (input.id && !row) throw notFound("Name");
  const kind = row?.kind ?? input.kind;
  if (kind !== "VARIANT" && kind !== "COLOUR") throw bad("Say whether the name is a variant or a colour");
  const alias = row?.alias ?? clean(input.alias);
  if (!alias) throw bad("The name to map is required");
  const model = kind === "COLOUR" ? row?.model ?? norm(input.model) : "";
  let variantId: string | null = null, colour: string | null = null;
  if (kind === "VARIANT") {
    const v = m.byId.get(String(input.variant_id ?? ""));
    if (!v) throw bad("Choose the master variant this name means");
    if (m.byKey.has(keyOf(alias)) && m.byKey.get(keyOf(alias))!.id !== v.id) throw conflict("This name is itself a variant in the master");
    variantId = v.id;
  } else {
    if (!model || !m.colours.get(model)?.size) throw bad("This model has no colour list to map to");
    colour = m.colours.get(model)!.get(keyOf(input.colour)) ?? null;
    if (!colour) throw bad("Choose a colour from the model's colour list");
    if (keyOf(colour) === keyOf(alias)) throw bad("A colour cannot be mapped to itself");
    // Mappings are one step: the colour chosen must not itself be mapped to another.
    if (m.colourAlias.has(`${model}|${keyOf(colour)}`)) throw bad(`${colour} is itself mapped to ${m.colourAlias.get(`${model}|${keyOf(colour)}`)}; choose that colour instead`);
    for (const [k, target] of m.colourAlias) if (k.startsWith(`${model}|`) && keyOf(target) === keyOf(alias)) throw bad(`Other names are already mapped to ${norm(alias)}; change those first`);
  }
  const at = iso(ctx.now);
  const id = row?.id ?? newId("als");
  await run(
    ctx.db,
    `INSERT INTO vehicle_aliases (id, tenant_id, kind, alias, alias_key, model, variant_id, colour, seen_count, mapped_by, mapped_at, created_at) VALUES (?,?,?,?,?,?,?,?,0,?,?,?)
     ON CONFLICT (tenant_id, kind, model, alias_key) DO UPDATE SET variant_id = excluded.variant_id, colour = excluded.colour, mapped_by = excluded.mapped_by, mapped_at = excluded.mapped_at`,
    id, ctx.tenantId, kind, alias, keyOf(alias), model, variantId, colour, ctx.actor, at, at,
  );
  await audit(ctx, "MASTER_NAME_MAPPED", "alias", id, { kind, alias, model, variant: variantId ? m.byId.get(variantId)!.variant : null, colour });
  ctx.cache.delete("master");
  // Cars and waiting bookings of the model that carry the mapped name now carry the colour it means.
  const recoloured = kind === "COLOUR" ? await recolourModel(ctx, model) : null;
  return { id, kind, alias, model, variant_id: variantId, colour, recoloured };
}

export async function removeAlias(ctx: Ctx, id: string): Promise<void> {
  const row = await first<{ kind: string; model: string; alias: string; colour: string | null }>(ctx.db, `SELECT kind, model, alias, colour FROM vehicle_aliases WHERE id = ? AND tenant_id = ?`, id, ctx.tenantId);
  if (!row) throw notFound("Name");
  await run(ctx.db, `DELETE FROM vehicle_aliases WHERE id = ? AND tenant_id = ?`, id, ctx.tenantId);
  await audit(ctx, "MASTER_NAME_REMOVED", "alias", id, { kind: row.kind, model: row.model, alias: row.alias, colour: row.colour });
  ctx.cache.delete("master");
  if (row.kind === "COLOUR" && row.colour) await recolourModel(ctx, row.model);
}

// ---------------------------------------------------------------- loading the master sheet

const MASTER_ALIASES: Record<string, string> = {
  category: "category", segment: "category", type: "category",
  model: "model", model_name: "model",
  trim: "trim", trim_level: "trim", grade: "trim",
  transmission: "transmission", gearbox: "transmission",
  fuel: "fuel", fuel_type: "fuel",
  drive: "drive", drive_type: "drive", drivetrain: "drive",
  seater: "seater", seats: "seater", seating: "seater", seating_capacity: "seater",
  variant: "variant", variant_name: "variant", variant_description: "variant",
  colours: "colours", colors: "colours", colour: "colours", color: "colours",
  active: "active", status: "active",
};

export const MASTER_CSV_HEADER = ["Category", "Model", "Trim", "Transmission", "Fuel", "Drive", "Seater", "Variant", "OEM Model Code"];

/** The vehicle master as a sheet: download it, fill the blanks from the OEM catalogue, load it back. */
export async function exportMaster(ctx: Ctx): Promise<(string | number)[][]> {
  const m = await loadMaster(ctx, true);
  return [MASTER_CSV_HEADER, ...m.variants.map((v) => [v.category, v.model, v.trim, v.transmission, v.fuel, v.drive, v.seater, v.variant, v.oem_model_code])];
}

export interface MasterUploadResult {
  row_count: number;
  created: number;
  updated: number;
  unchanged: number;
  colours_added: number;
  errors: { row: number; key: string; message: string }[];
}

/**
 * Loads the vehicle master from a sheet with the columns Category, Model, Trim, Transmission, Fuel,
 * Drive, Seater, Variant (other columns are ignored). Rows are matched to existing variants by variant
 * name; nothing is ever deleted. For a variant that exists, a value given in the sheet replaces the
 * master's and a blank cell leaves it as it is: the usual use is to download the master, fill in from
 * the OEM catalogue what the DMS descriptions do not state, and load it back. An optional Colours
 * column (names separated by ; or |) adds to the model's colour list.
 */
export async function importMaster(ctx: Ctx, csvText: string, opts: { filename?: string } = {}): Promise<MasterUploadResult> {
  const rows = parseCsv(csvText);
  if (rows.length < 2) throw bad("The file has no data rows");
  if (rows.length - 1 > 3000) throw bad("The file has more than 3,000 rows");
  const cols = rows[0].map((h) => MASTER_ALIASES[h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")] ?? null);
  for (const need of ["category", "model", "variant"]) if (!cols.includes(need)) throw bad(`Column "${need}" is missing from the file`);
  const m = await loadMaster(ctx, true);
  const result: MasterUploadResult = { row_count: rows.length - 1, created: 0, updated: 0, unchanged: 0, colours_added: 0, errors: [] };
  const at = iso(ctx.now);
  const stmts: D1PreparedStatement[] = [];
  const seen = new Set<string>();
  const colourAdds = new Map<string, Map<string, string>>();
  for (let i = 1; i < rows.length; i++) {
    const rec: Record<string, string> = {};
    rows[i].forEach((cell, idx) => {
      const k = cols[idx];
      if (k) rec[k] = cell.trim();
    });
    const fail = (message: string) => result.errors.push({ row: i + 1, key: rec.variant || "(blank)", message });
    let v;
    try {
      v = tidy(rec, { categoryOptional: m.byKey.has(keyOf(rec.variant)) });
    } catch (e) {
      fail((e as Error).message);
      continue;
    }
    if (seen.has(v.variant_key)) { fail("This variant appears more than once in the file"); continue; }
    seen.add(v.variant_key);
    const active = rec.active === undefined || rec.active === "" ? null : !["N", "NO", "0", "FALSE", "INACTIVE", "DISCONTINUED"].includes(norm(rec.active));
    const cur = m.byKey.get(v.variant_key);
    if (!cur) {
      stmts.push(stmt(ctx.db, `INSERT INTO vehicle_variants (id, tenant_id, category, model, trim_level, transmission, fuel, drive, seater, variant, variant_key, is_active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, newId("var"), ctx.tenantId, v.category, v.model, v.trim, v.transmission, v.fuel, v.drive, v.seater, v.variant, v.variant_key, active === false ? 0 : 1, at, at));
      result.created++;
    } else {
      const nextActive = active === null ? cur.is_active : active ? 1 : 0;
      for (const a of ["category", "trim", "transmission", "fuel", "drive", "seater"] as const) if (!v[a]) v[a] = cur[a]; // a blank cell leaves the master's value
      const same = cur.category === v.category && cur.model === v.model && cur.trim === v.trim && cur.transmission === v.transmission && cur.fuel === v.fuel && cur.drive === v.drive && cur.seater === v.seater && cur.is_active === nextActive;
      if (same) result.unchanged++;
      else if (cur.model !== v.model) { fail(`The master already has this variant under model ${cur.model}; change the model on the Vehicle master screen so stock and bookings follow`); continue; }
      else {
        stmts.push(stmt(ctx.db, `UPDATE vehicle_variants SET category = ?, trim_level = ?, transmission = ?, fuel = ?, drive = ?, seater = ?, is_active = ?, fuel_source = CASE WHEN ? THEN 'Vehicle master sheet' ELSE fuel_source END, updated_at = ? WHERE id = ? AND tenant_id = ?`, v.category, v.trim, v.transmission, v.fuel, v.drive, v.seater, nextActive, v.fuel !== cur.fuel ? 1 : 0, at, cur.id, ctx.tenantId));
        result.updated++;
      }
    }
    for (const c of (rec.colours ?? "").split(/[;|]/)) {
      const name = norm(c);
      if (!name) continue;
      if (m.colours.get(v.model)?.has(keyOf(name))) continue;
      if (!colourAdds.has(v.model)) colourAdds.set(v.model, new Map());
      colourAdds.get(v.model)!.set(keyOf(name), name);
    }
  }
  for (const [model, list] of colourAdds) {
    for (const [key, name] of list) {
      stmts.push(stmt(ctx.db, `INSERT OR IGNORE INTO vehicle_colours (id, tenant_id, model, colour, colour_key, created_at) VALUES (?,?,?,?,?,?)`, newId("col"), ctx.tenantId, model, name, key, at));
      result.colours_added++;
    }
  }
  for (let i = 0; i < stmts.length; i += 40) await ctx.db.batch(stmts.slice(i, i + 40));
  await audit(ctx, "MASTER_LOADED", "tenant", ctx.tenantId, { filename: opts.filename ?? null, created: result.created, updated: result.updated, unchanged: result.unchanged, colours_added: result.colours_added, errors: result.errors.length });
  ctx.cache.delete("master");
  return result;
}

/** What the pickers need: active variants with their attributes, and the colour list of each model. */
export async function catalog(ctx: Ctx) {
  const m = await loadMaster(ctx);
  const colours: Record<string, string[]> = {};
  for (const [model, list] of m.colours) colours[model] = [...list.values()].sort();
  return { master: m.enforced, variants: m.variants.filter((v) => v.is_active), colours };
}
