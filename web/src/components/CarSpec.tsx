// How a car is named on screen. A Mahindra car is identified by Category, Model, Trim, Transmission,
// Fuel, Drive, Seater and Variant (plus colour). What the DMS description does not state is shown as
// a dash; nothing is guessed.

import type { ReactNode } from "react";
import { orDash } from "../format";
import type { CarAttributes, CatalogRow } from "../types";

const ATTRIBUTES: [keyof CarAttributes, string][] = [
  ["category", "Category"],
  ["trim", "Trim"],
  ["transmission", "Transmission"],
  ["fuel", "Fuel"],
  ["drive", "Drive"],
  ["seater", "Seater"],
];

/** The six attributes in one compact, labelled line, for lists. */
export function SpecLine({ car }: { car: CarAttributes }) {
  return (
    <span className="spec">
      {ATTRIBUTES.map(([key, label]) => (
        <span key={key} className="spec-item">
          <span className="spec-label">{label}</span> {orDash(car[key])}
        </span>
      ))}
    </span>
  );
}

/** Model and variant, with the colour underneath. */
export function CarName({ car }: { car: CatalogRow }) {
  return (
    <>
      <span className="strong">
        {car.model} {car.variant}
      </span>
      <span className="sub">{orDash(car.colour)}</span>
    </>
  );
}

/** The full identity of a car as label and value pairs, for a detail screen. */
export function carItems(car: CatalogRow & CarAttributes): [string, ReactNode][] {
  return [
    ["Category", orDash(car.category)],
    ["Model", orDash(car.model)],
    ["Trim", orDash(car.trim)],
    ["Transmission", orDash(car.transmission)],
    ["Fuel", orDash(car.fuel)],
    ["Drive", orDash(car.drive)],
    ["Seater", orDash(car.seater)],
    ["Variant", orDash(car.variant)],
    ["Colour", orDash(car.colour)],
  ];
}
