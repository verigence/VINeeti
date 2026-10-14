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
}

export const canApprove = (can: Can) => can("booking.approve") || can("exception.decide");
export const canLoadFiles = (can: Can) => can("upload.stock") || can("upload.bookings");
export const canSeePayments = (can: Can) => can("booking.payment") || can("booking.view_all");

export const DESTINATIONS: Destination[] = [
  { to: "/", label: "Home", icon: "home", allowed: () => true, badge: "alerts" },
  { to: "/stock", label: "Stock", icon: "car", allowed: (can) => can("stock.view") },
  { to: "/bookings", label: "Bookings", icon: "bookings", allowed: (can) => can("booking.view") },
  { to: "/approvals", label: "Approvals", icon: "approvals", allowed: canApprove, badge: "approvals" },
  { to: "/payments", label: "Payments", icon: "payments", allowed: canSeePayments },
  { to: "/owner", label: "Owner's view", icon: "owner", allowed: (can) => can("owner.view") },
  { to: "/dashboards", label: "Day's work", icon: "dashboards", allowed: (can) => can("dashboards.view") },
  { to: "/analytics", label: "Reports", icon: "analytics", allowed: (can) => can("dashboards.view") },
  { to: "/eod", label: "Daily update", icon: "dayend", allowed: (can) => canLoadFiles(can) || can("recon.view") },
  { to: "/recon", label: "Day-end check", icon: "recon", allowed: (can) => can("recon.view") },
  { to: "/master", label: "Models & colours", icon: "master", allowed: (can) => can("master.manage") },
  { to: "/whatsapp", label: "WhatsApp", icon: "whatsapp", allowed: (can) => can("wa.view") },
  { to: "/admin", label: "Settings", icon: "admin", allowed: (can) => can("admin.users") || can("admin.settings") },
  { to: "/audit", label: "History", icon: "audit", allowed: (can) => can("audit.view") },
];

export const destinationsFor = (can: Can) => DESTINATIONS.filter((d) => d.allowed(can));

/**
 * The phone tab bar: Home and the three places this person works in most, judged by what they are
 * allowed to do (never by the name of their role). Everything else sits under "More".
 */
export function tabsFor(can: Can): Destination[] {
  let wanted: string[];
  if (can("admin.users")) wanted = ["/stock", "/bookings", "/eod"]; // sets the system up and does the day's data work
  else if (can("booking.payment")) wanted = ["/payments", "/bookings", "/stock"]; // verifies payments
  else if (can("owner.review")) wanted = ["/owner", "/approvals", "/bookings", "/stock"]; // the owner's view, and decisions
  else if (!can("booking.view_all")) wanted = ["/stock", "/bookings"]; // own bookings only: answers the customer, books
  else if (can("booking.approve")) wanted = ["/bookings", "/approvals", "/stock"]; // leads a sales team
  else if (can("wa.resend")) wanted = ["/bookings", "/eod", "/whatsapp"]; // customer contact, loads the DMS files
  else if (can("stock.manage")) wanted = ["/stock", "/eod", "/bookings"]; // receives cars, loads the DMS files
  else if (can("master.manage")) wanted = ["/dashboards", "/master", "/stock"]; // orders on the manufacturer, vehicle master
  else wanted = ["/owner", "/bookings", "/stock", "/dashboards"];
  const allowed = destinationsFor(can);
  const picked = wanted.map((to) => allowed.find((d) => d.to === to)).filter((d): d is Destination => Boolean(d)).slice(0, 3);
  return [allowed[0], ...picked];
}

export const isActive = (to: string, path: string) => (to === "/" ? path === "/" : path === to || path.startsWith(`${to}/`));
