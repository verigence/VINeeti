// The product's own name. The dealership's name and OEM remain the identity shown in the header.

export const PRODUCT = "Verigence VINeeti";
export const PRODUCT_SHORT = "VINeeti";
/** The byline: shown small on the sign-in screen and at the foot of the menu, not on every screen. */
export const PRODUCT_BYLINE = "by JBR Consulting";

/** The name the API reports is preferred; the product's earlier names are replaced by the current one. */
const EARLIER_NAMES = ["Vehicle Allocation", "Verigence Allot"];
export function productName(fromApi?: string | null): string {
  const name = fromApi?.trim();
  return !name || EARLIER_NAMES.includes(name) ? PRODUCT : name;
}
