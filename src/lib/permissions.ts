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
const MATRIX: Record<Role, Permission[]> = {
  // Sets the system up: users, outlets, settings, WhatsApp. Can also do the day's data work.
  ADMIN: [
    ...VIEW_ALL, "stock.manage", "stock.value", "upload.stock", "upload.bookings", "booking.create", "booking.cancel", "booking.contact", "booking.payment_report", "booking.payment",
    "booking.deliver", "booking.ready", "exception.request", "allocation.run", "orders.manage", "owner.view", "recon.view", "recon.manage", "wa.view", "wa.manage",
    "admin.users", "admin.settings", "audit.view", "master.manage",
  ],
  // The owner: fairness, ageing and results across every outlet; reviews what was done out of turn.
  DEALER_PRINCIPAL: [...VIEW_ALL, "stock.value", "owner.view", "owner.review", "booking.cancel", "exception.request", "recon.view", "wa.view", "admin.settings", "audit.view"],
  // Runs the business day to day: receives the alarms, decides exceptions, owns the allocation rules.
  BUSINESS_HEAD: [
    ...VIEW_ALL, "stock.value", "owner.view", "owner.review", "booking.cancel", "booking.ready", "exception.request", "allocation.run", "orders.manage", "recon.view", "recon.manage", "wa.view",
    "admin.settings", "audit.view",
  ],
  // Vice President: oversight above the day's running. Sees everything, changes almost nothing, and
  // is the one who decides whether a car may be taken back from the customer holding it — the single
  // way a named car reaches a named booking now that allocation by hand is closed.
  VP: [...VIEW_ALL, "stock.value", "owner.view", "owner.review", "exception.request", "recon.view", "audit.view"],
  // Sales Lead: the team's bookings at their outlets.
  SALES_MANAGER: [...VIEW_ALL, "booking.create", "booking.cancel", "booking.ready", "booking.payment_report", "exception.request", "allocation.run", "recon.view", "wa.view"],
  // Sales Executive: stock and delivery answers, and their own bookings.
  SALES_EXEC: ["stock.view", "booking.view", "booking.create", "booking.payment_report", "exception.request", "dashboards.view"],
  // Finance: verifies that payments have been received, records invoicing and delivery, sees stock value.
  ACCOUNTS: [...VIEW_ALL, "stock.value", "booking.payment", "booking.deliver", "owner.view", "exception.request", "recon.view", "recon.manage"],
  // CRM: the customer's side: messages and replies, contact details, holds, delayed deliveries; loads the DMS files.
  CRM: [...VIEW_ALL, "upload.stock", "upload.bookings", "booking.contact", "booking.ready", "exception.request", "recon.view", "wa.view", "wa.resend"],
  // Stock in-charge: receives cars and loads the DMS files.
  STOCK_INCHARGE: [...VIEW_ALL, "stock.manage", "upload.stock", "upload.bookings", "booking.deliver", "exception.request", "allocation.run", "recon.view", "recon.manage"],
  // Ordering desk: what to order from the manufacturer, and the vehicle master.
  ORDERING: [...VIEW_ALL, "orders.manage", "master.manage"],
  // Auditor: reads everything, changes nothing.
  AUDITOR: [...VIEW_ALL, "stock.value", "owner.view", "recon.view", "wa.view", "audit.view"],
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
export const TENANT_WIDE_ROLES: Role[] = ["ADMIN", "DEALER_PRINCIPAL", "BUSINESS_HEAD", "VP", "ORDERING", "AUDITOR"];

export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: "System Admin",
  DEALER_PRINCIPAL: "Dealer Principal",
  BUSINESS_HEAD: "Business Head / CEO",
  VP: "Vice President",
  SALES_MANAGER: "Sales Lead",
  SALES_EXEC: "Sales Executive",
  ACCOUNTS: "Finance",
  CRM: "CRM",
  STOCK_INCHARGE: "Stock In-charge",
  ORDERING: "Ordering Desk",
  AUDITOR: "Auditor",
};

/** One line on what each persona is for, shown where roles are chosen. */
export const ROLE_PURPOSE: Record<Role, string> = {
  ADMIN: "Sets up users, outlets, settings and WhatsApp.",
  DEALER_PRINCIPAL: "Owner's view across all outlets: fairness, out-of-turn allocations, ageing and results. Decides exceptions.",
  BUSINESS_HEAD: "Runs the business day to day: receives the alarms, decides exceptions, sets the allocation rules.",
  VP: "Oversight above the day's running: sees every outlet, reviews what was done out of turn, and decides whether a car may be taken back from the customer holding it.",
  SALES_MANAGER: "Leads a sales team: sees the team's bookings at their outlets and approves them.",
  SALES_EXEC: "Answers the customer on stock and delivery, books, and follows their own bookings.",
  ACCOUNTS: "Verifies that payments have been received; records invoicing and delivery; sees stock value.",
  CRM: "Customer contact: messages and replies, delayed deliveries, holds. Loads the DMS files.",
  STOCK_INCHARGE: "Receives cars, moves them between outlets, loads the DMS files.",
  ORDERING: "Places orders on the manufacturer from the order queue; maintains the vehicle master.",
  AUDITOR: "Reads everything, changes nothing.",
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
  "exception.request": "Raise an exception request",
  "exception.decide": "Approve or reject exceptions",
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

/** The permissions of every role under the dealership's current settings: the "roles and controls" table. */
export function roleMatrix(settings: TenantSettings) {
  return (Object.keys(MATRIX) as Role[]).map((role) => ({ role, label: ROLE_LABELS[role], purpose: ROLE_PURPOSE[role], permissions: permissionsFor(role, settings), tenant_wide: TENANT_WIDE_ROLES.includes(role), receives_alarms: settings.alarm_roles.includes(role) }));
}
