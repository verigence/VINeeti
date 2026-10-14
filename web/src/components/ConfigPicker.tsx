// Model, variant and colour pickers. The lists come from /api/catalog: the dealership's vehicle master
// (variants registered from the DMS files, and each model's colours). A dealership with no master yet
// picks from the combinations already in its stock and bookings.

import { useMemo } from "react";
import { api } from "../api";
import { useLoad, type Loaded } from "../hooks";
import type { Catalog } from "../types";
import { Field } from "./ui";

export interface CarConfig {
  /** The master variant chosen, when the dealership has a master. */
  variant_id: string;
  model: string;
  variant: string;
  colour: string;
}
export const EMPTY_CONFIG: CarConfig = { variant_id: "", model: "", variant: "", colour: "" };
export const configReady = (c: CarConfig) => Boolean(c.model && c.variant && c.colour.trim());
/** How a chosen car is sent to the API: by master variant when there is one, otherwise by its names. */
export const configInput = (c: CarConfig) => (c.variant_id ? { variant_id: c.variant_id, colour: c.colour.trim() } : { model: c.model, variant: c.variant, colour: c.colour.trim() });

export const useCatalog = (): Loaded<Catalog> => useLoad(() => api.catalog(), "catalog");

const uniq = (list: string[]) => [...new Set(list.filter(Boolean))].sort((a, b) => a.localeCompare(b));

/** Cascading pickers: choosing a model narrows the variants, and the model decides the colours. */
export function ConfigSelects({ catalog, value, onChange, disabled }: { catalog: Catalog; value: CarConfig; onChange: (v: CarConfig) => void; disabled?: boolean }) {
  const models = useMemo(() => uniq(catalog.master ? catalog.variants.map((v) => v.model) : catalog.legacy.map((c) => c.model)), [catalog]);
  const variants = useMemo(() => {
    if (!catalog.master) return uniq(catalog.legacy.filter((c) => c.model === value.model).map((c) => c.variant)).map((name) => ({ id: "", name }));
    return catalog.variants.filter((v) => v.model === value.model).map((v) => ({ id: v.id, name: v.variant })).sort((a, b) => a.name.localeCompare(b.name));
  }, [catalog, value.model]);
  const colours = useMemo(() => {
    if (!catalog.master) return uniq(catalog.legacy.filter((c) => c.model === value.model && c.variant === value.variant).map((c) => c.colour));
    return catalog.colours[value.model] ?? [];
  }, [catalog, value.model, value.variant]);
  // A car already on a record may name a variant or colour that is no longer offered; it stays selectable.
  const modelOptions = value.model && !models.includes(value.model) ? [value.model, ...models] : models;
  const variantOptions = value.variant && !variants.some((v) => v.name === value.variant) ? [{ id: value.variant_id, name: value.variant }, ...variants] : variants;
  const colourOptions = value.colour && colours.length && !colours.includes(value.colour) ? [value.colour, ...colours] : colours;

  return (
    <>
      <Field label="Model">
        <select value={value.model} onChange={(e) => onChange({ variant_id: "", model: e.target.value, variant: "", colour: "" })} disabled={disabled}>
          <option value="">Choose a model</option>
          {modelOptions.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
      </Field>
      <Field label="Variant">
        <select
          value={value.variant}
          onChange={(e) => {
            const v = variantOptions.find((x) => x.name === e.target.value);
            onChange({ ...value, variant_id: v?.id ?? "", variant: e.target.value, colour: catalog.master ? value.colour : "" });
          }}
          disabled={disabled || !value.model}
        >
          <option value="">{value.model ? "Choose a variant" : "Choose a model first"}</option>
          {variantOptions.map((v) => (
            <option key={v.name}>{v.name}</option>
          ))}
        </select>
      </Field>
      {value.model && catalog.master && colours.length === 0 ? (
        <Field label="Colour" hint="This model has no colour list yet. Type the colour as the DMS names it.">
          <input value={value.colour} onChange={(e) => onChange({ ...value, colour: e.target.value.toUpperCase() })} autoComplete="off" maxLength={60} disabled={disabled} />
        </Field>
      ) : (
        <Field label="Colour">
          <select value={value.colour} onChange={(e) => onChange({ ...value, colour: e.target.value })} disabled={disabled || !value.model || (!catalog.master && !value.variant)}>
            <option value="">{value.model ? "Choose a colour" : "Choose a model first"}</option>
            {colourOptions.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </Field>
      )}
    </>
  );
}

/** Whether the pickers have anything to offer yet. */
export const catalogEmpty = (c: Catalog) => (c.master ? c.variants.length === 0 : c.legacy.length === 0);
