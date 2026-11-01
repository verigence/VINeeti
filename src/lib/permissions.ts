import type { Role, SessionUser } from "../env";
import type { TenantSettings } from "./settings";

export type Permission =
  | "stock.view"
  | "stock.manage" // add, receive, transfer, block, change ETA
  | "upload.stock"
  | "upload.bookings"
  | "booking.view"
  | "booking.view_all" // every booking in the user's outlets, not just their own
  | "booking.create"
  | "booking.approve"
  | "booking.cancel"
  | "booking.payment_report" // sales: report that the customer has paid, for Finance to verify
  | "booking.payment" // Finance: verify a payment as received (or not), record the retail invoice
  | "booking.contact" // correct the customer's mobile number and WhatsApp consent
  | "booking.deliver"
  | "booking.ready" // lift a hold when the customer is ready
  | "stock.value" // dealer price and stock value
  | "owner.view" // the owner's view: fairness, ageing, measures
  | "owner.review" // record the review of an out-of-turn allocation nobody approved beforehand
  | "wa.resend" // send a failed customer message again
  | "exception.request"
  | "exception.decide"
  | "release.decide"
  | "allocation.run"
  | "orders.manage"
  | "dashboards.view"
  | "recon.view"
  | "recon.manage"
  | "wa.view"
  | "wa.manage"
  | "master.manage" // the vehicle master: variants, colours, mapping of DMS names
  | "admin.users"
  | "admin.settings"
  | "audit.view";

/**
 * What each persona can do. Approver roles for bookings and exceptions, and who receives alarms, come
 * from the dealership's settings. A role acts only within the outlets it is given.
 */
const VIEW_ALL: Permission[] = ["stock.view", "booking.view", "booking.view_all", "dashboards.view"];

/** Everything there is. The Dealer Principal has it bar one thing; nobody else comes close. */
const EVERYTHING: Permission[] = [
  ...VIEW_ALL, "stock.manage", "stock.value", "upload.stock", "upload.bookings", "booking.create", "booking.approve", "booking.cancel", "booking.contact",
  "booking.payment_report", "booking.payment", "booking.deliver", "booking.ready", "exception.request", "exception.decide", "release.decide", "allocation.run",
  "orders.manage", "owner.view", "owner.review", "recon.view", "recon.manage", "wa.view", "wa.resend", "wa.manage", "master.manage", "admin.users",
  "admin.settings", "audit.view",
];

/**
 * What the System Admin is meant to settle down to: configure the place and read it, never act on a
 * deal. While the dealership is finding its feet the role keeps everything (below), and switching to
 * this is a one-word change here. It is deliberately not a setting: a setting would let the System
 * Admin give their own privileges back.
 */
export const SYSTEM_ADMIN_SETTLED: Permission[] = [
  ...VIEW_ALL, "stock.value", "recon.view", "wa.view", "wa.manage", "master.manage", "admin.users", "admin.settings", "audit.view",
];

/**
 * What each role can do. Who approves bookings, exceptions and releases comes from the dealership's
 * settings, so those three are added in `permissionsFor`. A role acts only within the outlets, and the
 * vehicle segments, the person is given.
 */
const MATRIX: Record<Role, Permission[]> = {
  // Sets the place up. Everything for now, while the dealership settles; SYSTEM_ADMIN_SETTLED above is
  // where it is going, and that is a one-word change.
  ADMIN: EVERYTHING,
  // The owner. Everything except loading the DMS files, which is the EDP Manager's daily job.
  DEALER_PRINCIPAL: EVERYTHING.filter((p) => p !== "upload.stock" && p !== "upload.bookings"),
  // Answerable for execution, so: everything, except acting on money. Payments are read-only here —
  // verifying a receipt and recording a delivery stay with Finance, which is what makes the figures
  // the CEO reads worth reading.
  CEO_VP: EVERYTHING.filter((p) => p !== "booking.payment" && p !== "booking.deliver"),
  // Runs sales for a location, a vehicle segment, or both. Approves what the AGM raises; never raises
  // it, and never changes the rules they work under.
  GM_SALES: [
    ...VIEW_ALL, "stock.value", "booking.create", "booking.approve", "booking.cancel", "booking.ready", "allocation.run", "recon.view",
  ],
  // The segment owner: the one who asks for a car to be allocated or taken back. Cannot approve their
  // own request, and does not see what a car cost.
  AGM_SALES: [...VIEW_ALL, "booking.create", "booking.cancel", "booking.ready", "booking.payment_report", "exception.request", "recon.view"],
  // Leads a team: their outlets' bookings, and approves them.
  SALES_LEAD: [...VIEW_ALL, "booking.create", "booking.cancel", "booking.contact", "booking.ready", "booking.payment_report", "recon.view", "wa.view"],
  // Answers the customer on stock and delivery, books, and follows their own bookings.
  SALES_CONSULTANT: ["stock.view", "booking.view", "booking.create", "booking.payment_report", "dashboards.view"],
  // The systems person: the DMS files, the differences they throw up, the vehicle master, orders, the
  // stock corrections no file can make, and the message log.
  EDP_MANAGER: [
    ...VIEW_ALL, "stock.manage", "upload.stock", "upload.bookings", "booking.contact", "allocation.run", "orders.manage", "recon.view", "recon.manage",
    "wa.view", "wa.resend", "master.manage",
  ],
  // Verifies that a payment has been received, records the invoice and the delivery.
  FINANCE: [...VIEW_ALL, "stock.value", "booking.payment", "booking.deliver", "recon.view"],
  // Reads, and changes nothing at all.
  AUDITOR: [...VIEW_ALL, "stock.value", "recon.view", "wa.view", "audit.view"],
};

export function permissionsFor(role: Role, settings: TenantSettings): Permission[] {
  const set = new Set<Permission>(MATRIX[role] ?? []);
  if (settings.booking_approver_roles.includes(role)) set.add("booking.approve");
  if (settings.exception_approver_roles.includes(role)) set.add("exception.decide");
  // Taking a car back from a customer who holds it is a heavier act than extending a window, and
  // allocation by hand no longer exists, so this is the one door left to a named car. It gets its
  // own, narrower list of approvers.
  if (settings.release_approver_roles.includes(role)) set.add("release.decide");
  return [...set];
}

export function can(user: SessionUser, settings: TenantSettings, p: Permission): boolean {
  return permissionsFor(user.role, settings).includes(p);
}

export function canSeeOutlet(user: SessionUser, outletId: string): boolean {
  return user.allOutlets || user.outletIds.includes(outletId);
}

/** Roles that default to seeing every outlet of the dealership. */
export const TENANT_WIDE_ROLES: Role[] = ["ADMIN", "DEALER_PRINCIPAL", "CEO_VP", "EDP_MANAGER", "FINANCE", "AUDITOR"];

export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: "System Admin",
  DEALER_PRINCIPAL: "Dealer Principal",
  CEO_VP: "CEO / VP",
  GM_SALES: "GM Sales",
  AGM_SALES: "AGM Sales",
  SALES_LEAD: "Sales Lead",
  SALES_CONSULTANT: "Sales Consultant",
  EDP_MANAGER: "EDP Manager",
  FINANCE: "Finance",
  AUDITOR: "Auditor",
};

export const ROLE_PURPOSE: Record<Role, string> = {
  ADMIN: "Sets the system up: users, outlets, settings, WhatsApp. Holds every right while the dealership settles.",
  DEALER_PRINCIPAL: "The owner: every screen and every outlet. Does not load the DMS files.",
  CEO_VP: "Answerable for execution: every screen, approves what is raised. Payments are read-only.",
  GM_SALES: "Runs sales for a location, a vehicle segment or both. Approves allocation and deallocation requests.",
  AGM_SALES: "The segment owner: raises allocation and deallocation requests, and approves nothing.",
  SALES_LEAD: "Leads a team: the team's bookings at their outlets, and approves them.",
  SALES_CONSULTANT: "Answers the customer on stock and delivery, books, and follows their own bookings.",
  EDP_MANAGER: "Loads the DMS files and settles the differences; keeps the vehicle master, orders and stock corrections.",
  FINANCE: "Verifies that payments have been received; records invoicing and delivery.",
  AUDITOR: "Reads everything, changes nothing.",
};

/**
 * The same thing as ROLE_PURPOSE, said to the person whose role it is. The matrix above is written for
 * an administrator comparing roles, where "approves nothing" and "changes nothing" are the useful facts;
 * addressed to somebody on their first day it reads like a demotion, so the introduction email uses this.
 */
export const ROLE_TO_YOU: Record<Role, string> = {
  ADMIN: "You administer VINeeti for the dealership: users, outlets and system settings.",
  DEALER_PRINCIPAL: "You have access to all screens and all outlets, including the owner's dashboards.",
  CEO_VP: "You have access to all screens and approve the requests raised to you. Payment records are read-only.",
  GM_SALES: "You approve allocation and deallocation requests raised at your billing centre.",
  AGM_SALES: "You raise allocation and deallocation requests for your segment. A GM or the CEO approves them.",
  SALES_LEAD: "You manage your team's bookings at your outlets and approve them.",
  SALES_CONSULTANT: "You check stock and delivery for customers, create bookings and track your own bookings.",
  EDP_MANAGER: "You upload the daily DMS files and resolve the differences, and you maintain the vehicle master and orders.",
  FINANCE: "You verify that payments have been received, and record invoicing and delivery.",
  AUDITOR: "You have read-only access to all records.",
};

export const PERMISSION_LABELS: Record<Permission, string> = {
  "stock.view": "See stock and availability",
  "stock.manage": "Receive, transfer, block cars",
  "stock.value": "See dealer price and stock value",
  "upload.stock": "Load the DMS stock report",
  "upload.bookings": "Load the DMS booking sheet",
  "booking.view": "See own bookings",
  "booking.view_all": "See all bookings of their outlets",
  "booking.create": "Create a booking",
  "booking.approve": "Approve bookings",
  "booking.cancel": "Cancel a booking",
  "booking.payment_report": "Report a payment for Finance to verify",
  "booking.payment": "Verify payments; record invoicing",
  "booking.contact": "Correct customer contact details",
  "booking.deliver": "Mark delivered",
  "booking.ready": "Release a booking from hold",
  "exception.request": "Raise an allocation or deallocation request",
  "exception.decide": "Approve or reject those requests",
  "release.decide": "Approve taking a car back from a customer",
  "allocation.run": "Run allocation now",
  "orders.manage": "Manage orders on the manufacturer",
  "dashboards.view": "See dashboards",
  "owner.view": "See the owner's view and measures",
  "owner.review": "Review out-of-turn allocations",
  "recon.view": "See the day-end reconciliation",
  "recon.manage": "Resolve reconciliation items",
  "wa.view": "See WhatsApp messages",
  "wa.resend": "Send a failed message again",
  "wa.manage": "Set up WhatsApp",
  "master.manage": "Maintain the vehicle master",
  "admin.users": "Manage users and outlets",
  "admin.settings": "Change settings and allocation rules",
  "audit.view": "See the audit trail",
};

export function roleMatrix(settings: TenantSettings) {
  return (Object.keys(MATRIX) as Role[]).map((role) => ({ role, label: ROLE_LABELS[role], purpose: ROLE_PURPOSE[role], permissions: permissionsFor(role, settings), tenant_wide: TENANT_WIDE_ROLES.includes(role), receives_alarms: settings.alarm_roles.includes(role) }));
}
