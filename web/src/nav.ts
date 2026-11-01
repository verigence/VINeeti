// Every destination in the app, in one place. The desktop sidebar, the phone tab bar and the "More"
// sheet are all drawn from this list, so a new screen is added here and in routes.tsx and nowhere else.

import type { IconName } from "./components/icons";
import type { Permission } from "./types";

export type Can = (p: Permission) => boolean;

export interface Destination {
  to: string;
  label: string;
  icon: IconName;
  allowed: (can: Can) => boolean;
  /** A count shown next to the label. */
  badge?: "alerts" | "approvals";
  /**
   * Setting the dealership up, rather than running it today. These sit in their own group at the foot
   * of the sidebar: somebody doing the day's work should not have to read past them, and somebody
   * setting the system up is doing a different job on a different day.
   */
  admin?: true;
}

export const canApprove = (can: Can) => can("booking.approve") || can("exception.decide") || can("release.decide");
export const canLoadFiles = (can: Can) => can("upload.stock") || can("upload.bookings");
export const canSeePayments = (can: Can) => can("booking.payment") || can("booking.view_all");

export const DESTINATIONS: Destination[] = [
  { to: "/", label: "Home", icon: "home", allowed: () => true, badge: "alerts" },
  // The first thing a sales person does all day: a customer asks for a car and they answer. It is its
  // own place in the app, not a panel inside the stock screens or beside their own bookings.
  // One entry, landing on the stock check, because that is the first thing a sales person does all
  // day: a customer asks for a car and they answer. The summary, the browse and the car list are
  // tabs of the same screen and were never worth a second line in the sidebar.
  { to: "/stock/check", label: "Stock", icon: "search", allowed: (can) => can("stock.view") },
  { to: "/bookings", label: "Bookings", icon: "bookings", allowed: (can) => can("booking.view") },
  { to: "/approvals", label: "Approvals", icon: "approvals", allowed: canApprove, badge: "approvals" },
  // Allocation by hand is closed, so this is the one place a held car changes hands. It sits beside
  // Approvals because that is where it ends up.
  { to: "/deallocate", label: "Deallocate / Reallocate", icon: "approvals", allowed: (can) => can("exception.request") },
  { to: "/payments", label: "Payments", icon: "payments", allowed: canSeePayments },
  { to: "/owner", label: "Owner's view", icon: "owner", allowed: (can) => can("owner.view") },
  // The day's work and the reports were two entries that the same people opened one after the other.
  // One screen now: the four things to do about today first, then what the files add up to.
  { to: "/analytics/stock-allocation", label: "Reports", icon: "analytics", allowed: (can) => can("dashboards.view") },
  { to: "/eod", label: "Upload DMS files", icon: "dayend", allowed: (can) => canLoadFiles(can) || can("recon.view") },
  // Not a report: the findings the day-end run turns up, each needing a person to settle it and say
  // so. The old name made it sound like a routine tick, which is how it got overlooked.
  { to: "/recon", label: "Differences to settle", icon: "recon", allowed: (can) => can("recon.view") },
  { admin: true, to: "/master", label: "Models & colours", icon: "master", allowed: (can) => can("master.manage") },
  { admin: true, to: "/whatsapp", label: "WhatsApp", icon: "whatsapp", allowed: (can) => can("wa.view") },
  { admin: true, to: "/admin", label: "Settings", icon: "admin", allowed: (can) => can("admin.users") || can("admin.settings") },
  { admin: true, to: "/audit", label: "History", icon: "audit", allowed: (can) => can("audit.view") },
  // Everybody, with no permission in front of it: somebody who cannot get a screen to work must not
  // have to find a manager before they can say so.
  { admin: true, to: "/support", label: "Support", icon: "info", allowed: () => true },
];

export const destinationsFor = (can: Can) => DESTINATIONS.filter((d) => d.allowed(can));

/** The day's work, and setting the place up: two groups, never mixed in one list. */
export const workDestinations = (can: Can) => destinationsFor(can).filter((d) => !d.admin);
export const adminDestinations = (can: Can) => destinationsFor(can).filter((d) => d.admin);

/**
 * The phone tab bar: Home and the three places this person works in most, judged by what they are
 * allowed to do (never by the name of their role). Everything else sits under "More".
 */
export function tabsFor(can: Can): Destination[] {
  let wanted: string[];
  if (can("admin.users")) wanted = ["/stock", "/bookings", "/eod"]; // sets the system up and does the day's data work
  else if (can("booking.payment")) wanted = ["/payments", "/bookings", "/stock"]; // verifies payments
  else if (can("owner.review")) wanted = ["/owner", "/approvals", "/bookings", "/stock"]; // the owner's view, and decisions
  else if (!can("booking.view_all")) wanted = ["/stock/check", "/stock", "/bookings"]; // own bookings only: answers the customer, books
  else if (can("booking.approve")) wanted = ["/stock/check", "/bookings", "/approvals"]; // leads a sales team
  else if (can("wa.resend")) wanted = ["/bookings", "/eod", "/whatsapp"]; // customer contact, loads the DMS files
  else if (can("stock.manage")) wanted = ["/stock", "/eod", "/bookings"]; // receives cars, loads the DMS files
  else if (can("master.manage")) wanted = ["/analytics/stock-allocation", "/master", "/stock"]; // orders on the manufacturer, vehicle master
  else wanted = ["/owner", "/bookings", "/stock", "/analytics/stock-allocation"];
  const allowed = destinationsFor(can);
  const picked = wanted.map((to) => allowed.find((d) => d.to === to)).filter((d): d is Destination => Boolean(d)).slice(0, 3);
  return [allowed[0], ...picked];
}

const matches = (to: string, path: string) => (to === "/" ? path === "/" : path === to || path.startsWith(`${to}/`));

/**
 * Which destination the current page belongs to. Two destinations can both match a path — /stock/check
 * sits under /stock — and lighting up both tells the person they are in two places at once, so the
 * longest match wins and only one is marked.
 */
export const isActive = (to: string, path: string) => {
  if (!matches(to, path)) return false;
  const better = DESTINATIONS.some((d) => d.to !== to && d.to.length > to.length && matches(d.to, path));
  return !better;
};
