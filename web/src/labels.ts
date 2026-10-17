// Plain words for every status, type, role and category the API returns. Nothing on screen shows a raw code.

import { fmtDate, fmtDateTime, fmtMobile, fmtMoney } from "./format";
import type { AllocationOutcome, ChecklistKey, ExceptionRow, ExceptionType } from "./types";

export type Tone = "grey" | "amber" | "blue" | "teal" | "indigo" | "green" | "red" | "purple" | "gold";
export interface Label {
  text: string;
  tone: Tone;
}

/** Last resort for a code we have no wording for: "SOME_CODE" becomes "Some code". */
export function humanize(code: string | null | undefined): string {
  if (!code) return "—";
  const s = String(code).replace(/[_.]+/g, " ").trim().toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const pick = (map: Record<string, Label>, code: string | null | undefined): Label => (code && map[code]) || { text: humanize(code), tone: "grey" };

// ---------------------------------------------------------------- bookings
const BOOKING_STATUS: Record<string, Label> = {
  DRAFT: { text: "Draft", tone: "grey" },
  SUBMITTED: { text: "Waiting for approval", tone: "amber" },
  APPROVED: { text: "Waiting for car", tone: "blue" },
  REJECTED: { text: "Rejected", tone: "red" },
  ALLOCATED: { text: "Allocated", tone: "teal" },
  INVOICED: { text: "Invoiced", tone: "indigo" },
  DELIVERED: { text: "Delivered", tone: "green" },
  CANCELLED: { text: "Cancelled", tone: "red" },
};
export const BOOKING_STATUS_OPTIONS = Object.entries(BOOKING_STATUS).map(([value, l]) => ({ value, label: l.text }));

export function bookingStatus(status: string, onHold?: number | boolean | null): Label {
  if (status === "APPROVED" && onHold) return { text: "On hold", tone: "purple" };
  return pick(BOOKING_STATUS, status);
}

const HOLD_REASON: Record<string, string> = {
  CUSTOMER_DEFERRED: "The customer asked for a later delivery",
  ALLOCATION_SKIPPED: "Allocation was skipped on request",
  PAYMENT_TIMEOUT: "Payment was not received in time",
  CAR_LEFT_STOCK: "Its car left stock; being checked",
  NOT_IN_BOOKING_SHEET: "Known only from the stock report; waiting for a booking sheet",
};
export const holdReason = (code: string | null | undefined) => (code ? HOLD_REASON[code] ?? humanize(code) : "On hold");

const BOOKING_SOURCE: Record<string, Label> = {
  DMS: { text: "From DMS", tone: "grey" },
  DMS_STOCK: { text: "From stock report only", tone: "amber" },
  APP: { text: "Entered here", tone: "blue" },
};
export const bookingSource = (s: string | null | undefined) => pick(BOOKING_SOURCE, s);
export const BOOKING_SOURCE_OPTIONS = Object.entries(BOOKING_SOURCE).map(([value, l]) => ({ value, label: l.text }));
/** Shown in place of the customer's details for a booking the system knows only from the stock report. */
export const NO_CUSTOMER_DETAILS = "Customer details not in any booking sheet loaded";

/** The booking checklist items, for the settings screen. On a booking the labels come from the server. */
export const CHECKLIST_ITEMS: { key: ChecklistKey; label: string }[] = [
  { key: "DOCKET", label: "Signed booking docket" },
  { key: "KYC", label: "KYC documents" },
  { key: "PAN_AADHAAR", label: "PAN card and Aadhaar card" },
  { key: "PAYMENT_PROOF", label: "Proof of minimum booking amount (IMPS screenshot / money receipt)" },
];
export const checklistLabel = (key: string | null | undefined) => CHECKLIST_ITEMS.find((c) => c.key === key)?.label ?? humanize(key);

// ---------------------------------------------------------------- payments
const PAYMENT_STATE: Record<string, Label> = {
  AWAITING_PAYMENT: { text: "Awaiting payment", tone: "grey" },
  TO_VERIFY: { text: "Reported, waiting for Finance", tone: "amber" },
  VERIFIED: { text: "Verified by Finance", tone: "green" },
};
export const paymentState = (s: string) => pick(PAYMENT_STATE, s);
/** The payment state of a booking that holds a car. */
export const paymentStateOf = (b: { payment_reported_at: string | null; payment_received_at: string | null }) => (b.payment_received_at ? "VERIFIED" : b.payment_reported_at ? "TO_VERIFY" : "AWAITING_PAYMENT");
const WINDOW_STAGE: Record<string, Label> = {
  OPEN: { text: "Payment window open", tone: "grey" },
  REMINDED: { text: "Reminder sent", tone: "amber" },
  ESCALATED: { text: "Escalated", tone: "red" },
};
export const windowStage = (s: string) => pick(WINDOW_STAGE, s);

// ---------------------------------------------------------------- stock
const VEHICLE_STATUS: Record<string, Label> = {
  IN_TRANSIT: { text: "In transit", tone: "blue" },
  RECEIVED: { text: "In the yard", tone: "teal" },
  INVOICED: { text: "Invoiced", tone: "indigo" },
  DELIVERED: { text: "Delivered", tone: "green" },
  REMOVED: { text: "Removed from stock", tone: "red" },
};
export const vehicleStatus = (s: string | null | undefined) => pick(VEHICLE_STATUS, s);
export const VEHICLE_STATUS_OPTIONS = Object.entries(VEHICLE_STATUS).map(([value, l]) => ({ value, label: l.text }));

/** The stock type as the DMS stock report has it. */
const DMS_STOCK_TYPE: Record<string, Label> = {
  UNALLOTED: { text: "Unallocated", tone: "grey" },
  ALLOTED: { text: "Allotted in DMS", tone: "teal" },
  IBND: { text: "Invoiced, not delivered", tone: "indigo" },
};
export const dmsStockType = (s: string | null | undefined): Label | null => (s ? pick(DMS_STOCK_TYPE, s) : null);
export const DMS_STOCK_TYPE_OPTIONS = Object.entries(DMS_STOCK_TYPE).map(([value, l]) => ({ value, label: l.text }));

const ALLOCATION_TYPE: Record<string, string> = { IN_TRANSIT: "In-transit stock", FREE_STOCK: "Free stock", REALLOCATED: "Re-allocated stock" };
export const allocationType = (t: string | null | undefined) => (t ? ALLOCATION_TYPE[t] ?? humanize(t) : "—");

const ALLOCATION_STATUS: Record<string, Label> = {
  ACTIVE: { text: "Current", tone: "teal" },
  RELEASED: { text: "Released", tone: "grey" },
  FULFILLED: { text: "Delivered", tone: "green" },
};
export const allocationStatus = (s: string) => pick(ALLOCATION_STATUS, s);

// Kept in step with the catalogue in src/domain/release-reasons.ts. These read mid-sentence
// ("released because ..."), which is why they are fragments rather than the server's labels.
// The four a person can ask for come first.
const RELEASE_REASON: Record<string, string> = {
  REALLOCATED_TO_BOOKING: "the car was given to another booking, with approval",
  CUSTOMER_DEFERRED: "the customer asked to take delivery later",
  MANAGEMENT_PRIORITY: "management changed the priority, with approval",
  VEHICLE_BLOCKED: "the car was blocked",
  VEHICLE_REMOVED: "the car was removed from stock",
  BOOKING_CANCELLED: "the booking was cancelled",
  PAYMENT_TIMEOUT: "payment was not received in time",
  SKIP_ALLOCATION: "allocation was skipped (approved request)",
  DEFER_DELIVERY: "delivery was deferred (approved request)",
  OUTLET_CHANGE: "the booking moved to another outlet",
  REPLACED_BY_MANUAL_ALLOCATION: "another car was allocated manually",
  INVOICED_TO_ANOTHER_BOOKING: "the car was billed to a different booking",
  CUSTOMER_INVOICED_ANOTHER_CAR: "the customer was billed a different car",
  ALLOTTED_ANOTHER_CAR_IN_DMS: "the DMS allotted a different car to this booking",
  ALLOTTED_IN_DMS_TO_ANOTHER_BOOKING: "the DMS allotted the car to a different booking",
  BILLED_WITH_ANOTHER_CAR: "the customer was billed a different car",
  CAR_LEFT_STOCK: "the car is no longer in the stock report",
  NOT_IN_BOOKING_SHEET: "the order is in no booking sheet loaded",
  RELEASED_IN_DMS: "the DMS no longer shows the car allotted to this booking",
  RESERVED_CAR_NOT_USED: "the reserved car was not the one used",
};
export const releaseReason = (r: string | null | undefined) => (r ? RELEASE_REASON[r] ?? humanize(r).toLowerCase() : "no reason recorded");

const ALLOCATION_RULE: Record<string, string> = {
  SAME_OUTLET: "First in the queue at this outlet",
  OTHER_OUTLET: "First in the queue; the car was free at another outlet",
  NEARBY_OUTLET: "First in the queue; the car was free at a nearby outlet",
  OPENING_FROM_DMS: "Allotted in the DMS before the first file was loaded",
  DMS_ALLOTMENT: "Allotted in the DMS",
  DEALERSHIP_QUEUE: "First in the dealership-wide queue",
  MANUAL_APPROVED_EXCEPTION: "Allocated manually through an approved request",
  OPENING_ALLOCATION_FROM_UPLOAD: "Opening allocation taken from the stock file",
};
export const allocationRule = (r: string | null | undefined) => (r ? ALLOCATION_RULE[r] ?? humanize(r) : null);

/** Short result line after a stock or booking action: "Allocated to booking BK-…". */
export function allocationMessage(allocations: AllocationOutcome[] | undefined | null): string {
  if (!allocations?.length) return "";
  if (allocations.length === 1) {
    const a = allocations[0];
    return `Car ${a.vin} allocated to booking ${a.bookingNo}${a.needsTransfer ? " (needs a transfer between outlets)" : ""}.`;
  }
  const list = allocations.slice(0, 4).map((a) => `${a.bookingNo} (${a.vin})`).join(", ");
  return `${allocations.length} cars allocated: ${list}${allocations.length > 4 ? " and more" : ""}.`;
}

// ---------------------------------------------------------------- special requests
const EXCEPTION_TYPE: Record<ExceptionType, string> = {
  PRIORITY_CHANGE: "Change of priority",
  SKIP_ALLOCATION: "Skip allocation",
  DEFER_DELIVERY: "Defer delivery",
  OUTLET_CHANGE: "Change of outlet",
  MANUAL_ALLOCATION: "Manual allocation",
  WINDOW_EXTENSION: "Extend the payment window",
  RELEASE_ALLOCATION: "Take the car back",
  OTHER: "Other request",
};
export const exceptionType = (t: string | null | undefined) => (t ? EXCEPTION_TYPE[t as ExceptionType] ?? humanize(t) : "—");
export const EXCEPTION_HELP: Record<ExceptionType, string> = {
  PRIORITY_CHANGE: "Move this booking ahead in the queue for its car.",
  SKIP_ALLOCATION: "Leave this booking out of allocation for now. Any car it holds goes to the next customer.",
  DEFER_DELIVERY: "The customer wants delivery later. The booking is put on hold until the date given.",
  OUTLET_CHANGE: "Move the booking to another outlet.",
  MANUAL_ALLOCATION: "Give this booking a specific car, outside the queue order.",
  WINDOW_EXTENSION: "Give the customer more days to pay before the car is re-allocated.",
  RELEASE_ALLOCATION: "Take the car this booking is holding away from the customer, and say what happens to it.",
  OTHER: "Anything else that needs an approver's decision. Nothing changes automatically.",
};

const EXCEPTION_STATUS: Record<string, Label> = {
  PENDING: { text: "Awaiting decision", tone: "amber" },
  APPROVED: { text: "Approved", tone: "green" },
  REJECTED: { text: "Rejected", tone: "red" },
};
export const exceptionStatus = (s: string) => pick(EXCEPTION_STATUS, s);

/** What an special request asks for, in a sentence. */
export function exceptionDetail(e: Pick<ExceptionRow, "type" | "payload" | "vin" | "before_booking_no" | "to_outlet">, outletName: (id: string) => string): string {
  const p = e.payload ?? {};
  switch (e.type) {
    case "PRIORITY_CHANGE":
      if (p.before_booking_id) return e.before_booking_no ? `Move ahead of booking ${e.before_booking_no} in the queue for the same car.` : "Move ahead of another booking for the same car.";
      return p.new_priority_ts ? `Set the priority date to ${fmtDateTime(String(p.new_priority_ts))}.` : "Change the place in the queue.";
    case "SKIP_ALLOCATION":
      return p.until ? `Skip allocation until ${fmtDate(String(p.until))}.` : "Skip allocation until the customer is ready.";
    case "DEFER_DELIVERY":
      return p.until ? `Deliver on or after ${fmtDate(String(p.until))}.` : "Deliver later.";
    case "OUTLET_CHANGE":
      return `Move the booking to ${e.to_outlet || outletName(String(p.outlet_id ?? ""))}.`;
    case "MANUAL_ALLOCATION":
      return e.vin ? `Allocate car ${e.vin} to this booking.` : "Allocate a specific car to this booking.";
    case "WINDOW_EXTENSION":
      return `Give ${p.days} more day${Number(p.days) === 1 ? "" : "s"} to pay.`;
    case "RELEASE_ALLOCATION":
      // Each reason does something different with the car, and the approver has to see which — above
      // all whether anyone else is losing their place for it.
      switch (String(p.release_reason ?? "")) {
        case "BOOKING_CANCELLED":
          return `Cancel the booking and free ${e.vin ?? "the car"}. DMS cancellation ${p.cancellation_ref ?? "not given"}.`;
        case "REALLOCATED_TO_BOOKING": {
          const jumped = Number(p.jumped ?? 0);
          const over = jumped ? ` This steps over ${jumped} earlier booking${jumped === 1 ? "" : "s"}: ${(p.jumped_booking_nos as string[] | undefined)?.join(", ") ?? ""}.` : "";
          return `Give ${e.vin ?? "the car"} to booking ${p.to_booking_no ?? "—"}${p.to_customer_name ? ` (${p.to_customer_name})` : ""}.${over}`;
        }
        case "CUSTOMER_DEFERRED":
          return p.keep_days !== undefined
            ? `Customer asked to take delivery from ${fmtDate(String(p.until))}. They keep ${e.vin ?? "the car"} and the payment window moves out ${p.keep_days} days.`
            : `Customer asked to take delivery from ${fmtDate(String(p.until))}, ${p.days_away} days away, so ${e.vin ?? "the car"} is freed and they keep their place in the queue.`;
        case "MANAGEMENT_PRIORITY":
          return `Free ${e.vin ?? "the car"} for someone else. This booking stands down until ${fmtDate(String(p.until))}, keeping its place.`;
        default:
          return `Take ${e.vin ?? "the car"} back from this booking.`;
      }
    default:
      return "";
  }
}

// ---------------------------------------------------------------- WhatsApp
const WA_STATUS: Record<string, Label> = {
  QUEUED: { text: "Queued", tone: "grey" },
  SENT: { text: "Sent", tone: "blue" },
  DELIVERED: { text: "Delivered", tone: "teal" },
  READ: { text: "Read", tone: "green" },
  FAILED: { text: "Failed", tone: "red" },
  SKIPPED: { text: "Not sent", tone: "amber" },
};
export const waStatus = (s: string) => pick(WA_STATUS, s);
export const WA_STATUS_OPTIONS = Object.entries(WA_STATUS).map(([value, l]) => ({ value, label: l.text }));

export const WA_EVENTS: Record<string, string> = {
  ALLOC_IN_TRANSIT: "Allocated on in-transit stock",
  ALLOC_FREE_STOCK: "Allocated on free stock",
  ALLOC_REALLOCATED: "Re-allocated stock",
  STOCK_RECEIVED: "Stock received at dealership",
  PAYMENT_REMINDER: "Payment reminder",
  PAYMENT_ESCALATION: "Escalation to Business Head",
  MANAGEMENT_ALARM: "Alarm to Business Head / CEO and Dealer Principal",
  PASSWORD_OTP: "One-time code to set a password",
};
export const waEvent = (k: string | null | undefined) => (k ? WA_EVENTS[k] ?? humanize(k) : "—");
export const waAudience = (a: string) => (a === "CUSTOMER" ? "Customer" : a === "STAFF" ? "Staff" : humanize(a));
export const waProvider = (p: string) => (p === "TEST" ? "Test mode (not sent)" : p === "META" ? "WhatsApp Cloud API" : humanize(p));

const META_STATUS: Record<string, Label> = {
  PENDING: { text: "Waiting for Meta's approval", tone: "amber" },
  IN_REVIEW: { text: "Waiting for Meta's approval", tone: "amber" },
  APPROVED: { text: "Approved by Meta", tone: "green" },
  REJECTED: { text: "Rejected by Meta", tone: "red" },
  PAUSED: { text: "Paused by Meta", tone: "amber" },
  DISABLED: { text: "Disabled by Meta", tone: "red" },
  NOT_FOUND: { text: "Not found in WhatsApp Manager", tone: "red" },
};
export const metaStatus = (s: string | null | undefined): Label => (s ? pick(META_STATUS, s) : { text: "Not sent for approval", tone: "grey" });

// ---------------------------------------------------------------- orders, reconciliation, uploads
const ORDER_STATUS: Record<string, Label> = {
  PLACED: { text: "Order placed", tone: "amber" },
  CONFIRMED: { text: "Confirmed by manufacturer", tone: "blue" },
  CLOSED: { text: "Closed", tone: "green" },
  CANCELLED: { text: "Cancelled", tone: "red" },
};
export const orderStatus = (s: string) => pick(ORDER_STATUS, s);
export const ORDER_STATUS_OPTIONS = [
  { value: "PLACED", label: "Order placed" },
  { value: "CONFIRMED", label: "Confirmed by manufacturer" },
  { value: "CLOSED", label: "Closed (cars have arrived)" },
  { value: "CANCELLED", label: "Cancelled" },
];
export const orderQueueStatus = (s: string): Label => (s === "ORDERED" ? { text: "Order placed", tone: "green" } : { text: "To be ordered", tone: "amber" });

const SEVERITY: Record<string, Label> = {
  HIGH: { text: "High", tone: "red" },
  MEDIUM: { text: "Medium", tone: "amber" },
  LOW: { text: "Low", tone: "grey" },
};
export const severity = (s: string) => pick(SEVERITY, s);
export const SEVERITY_TITLES: Record<string, string> = { HIGH: "Act today", MEDIUM: "Follow up", LOW: "For information" };
export const reconItemStatus = (s: string): Label => (s === "RESOLVED" ? { text: "Closed", tone: "green" } : { text: "Open", tone: "amber" });

export const uploadKind = (k: string) => (k === "STOCK" ? "Stock report" : k === "BOOKINGS" ? "Booking sheet" : k === "MASTER" ? "Vehicle master sheet" : humanize(k));
/** Who loaded a file: a person, or the dealership's scheduled end-of-day job. */
export const uploadedBy = (u: { uploaded_by: string; uploaded_by_name: string | null }) => (u.uploaded_by === "EOD" ? "End-of-day feed" : u.uploaded_by_name ?? "A former user");

/**
 * Some messages written by the server name a status code inside a sentence ("is IN_TRANSIT in the system").
 * This swaps those codes for the words used everywhere else on screen.
 */
const CODE_WORDS: [RegExp, string][] = [
  [/\bALLOC_IN_TRANSIT\b/g, "allocated on in-transit stock"],
  [/\bALLOC_FREE_STOCK\b/g, "allocated on free stock"],
  [/\bALLOC_REALLOCATED\b/g, "re-allocated stock"],
  [/\bSTOCK_RECEIVED\b/g, "stock received"],
  [/\bPAYMENT_REMINDER\b/g, "payment reminder"],
  [/\bPAYMENT_ESCALATION\b/g, "escalation"],
  [/\bIN_TRANSIT\b/g, "in transit"],
  [/\b(is|status|to|from) RECEIVED\b/g, "$1 in the yard"],
  [/\b(is|status|to|from) INVOICED\b/g, "$1 invoiced"],
  [/\b(is|status|to|from) DELIVERED\b/g, "$1 delivered"],
  [/\b(is|status|to|from) REMOVED\b/g, "$1 removed from stock"],
  [/\b(is|status|to|from) APPROVED\b/g, "$1 waiting for a car"],
  [/\b(is|status|to|from) ALLOCATED\b/g, "$1 allocated"],
  [/\b(is|status|to|from) SUBMITTED\b/g, "$1 waiting for approval"],
  [/\b(is|status|to|from) DRAFT\b/g, "$1 a draft"],
  [/\b(is|status|to|from) REJECTED\b/g, "$1 rejected"],
  [/\b(is|status|to|from) CANCELLED\b/g, "$1 cancelled"],
];
/**
 * The signed-in person's own name, for greeting them and for the top bar. The DMS holds staff names in
 * capitals, and "Good morning, RAJESH" reads like a shout, so a name that is entirely in capitals is
 * written the ordinary way. A name with any lower-case letter in it is left exactly as it was entered,
 * and a customer's name is never passed through here: that is a record, shown as the DMS has it.
 */
export function personName(name: string | null | undefined): string {
  const s = String(name ?? "").trim();
  if (!s || s !== s.toUpperCase() || !/[A-Z]/.test(s)) return s;
  return s.toLowerCase().replace(/(^|[\s.'\-/])([a-z])/g, (_m, before: string, letter: string) => before + letter.toUpperCase());
}

export function plainText(message: string | null | undefined): string {
  let s = String(message ?? "");
  for (const [re, to] of CODE_WORDS) s = s.replace(re, to);
  // Dates the server writes as 2026-10-05 are shown the way every other date is.
  return s.replace(/\b\d{4}-\d{2}-\d{2}\b(?!T)/g, (d) => fmtDate(d));
}

// ---------------------------------------------------------------- stock movement history
export function vehicleEventText(e: { type: string; detail: Record<string, unknown>; from_status: string | null; to_status: string | null }, outletName: (id: string) => string): string {
  const d = e.detail ?? {};
  switch (e.type) {
    case "CREATED":
      return `Added to stock as ${vehicleStatus(e.to_status).text.toLowerCase()}${typeof d.source === "string" && /DMS|UPLOAD/.test(d.source) ? " (from the DMS stock report)" : ""}.`;
    case "RECEIVED":
      return "Received at the dealership.";
    case "INVOICED":
      return d.source === "DMS" ? `Invoiced in the DMS${d.dms_booking_no ? ` to booking ${d.dms_booking_no}` : ""}.` : "Invoiced to the customer.";
    case "DELIVERED":
      return d.reason ? `Delivered to the customer (${String(d.reason).toLowerCase()}).` : "Delivered to the customer.";
    case "TRANSFERRED":
      return `Moved from ${outletName(String(d.from_outlet_id ?? ""))} to ${outletName(String(d.to_outlet_id ?? ""))}.`;
    case "BLOCKED":
      return `Blocked${d.reason ? `: ${d.reason}` : "."}`;
    case "UNBLOCKED":
      return "Block removed.";
    case "REMOVED":
      return `Removed from stock${d.reason ? `: ${d.reason}` : "."}`;
    case "ETA_CHANGED": {
      const c = d.expected_arrival_date;
      if (Array.isArray(c)) return `Expected arrival changed from ${c[0] ? fmtDate(String(c[0])) : "not set"} to ${c[1] ? fmtDate(String(c[1])) : "not set"}.`;
      return typeof c === "string" ? `Expected arrival changed to ${fmtDate(c)}.` : "Expected arrival changed.";
    }
    case "UPDATED":
      return "Details updated.";
    default:
      return `${humanize(e.type)}.`;
  }
}

// ---------------------------------------------------------------- audit trail
export const AUDIT_ACTIONS: Record<string, string> = {
  BOOKING_CREATED: "Booking created",
  BOOKING_EDITED: "Booking edited",
  BOOKING_SUBMITTED: "Booking submitted for approval",
  BOOKING_APPROVED: "Booking approved",
  BOOKING_REJECTED: "Booking rejected",
  BOOKING_CANCELLED: "Booking cancelled",
  BOOKING_IMPORTED: "Booking loaded from a file",
  BOOKING_UPDATED_FROM_UPLOAD: "Booking updated from a file",
  PAYMENT_RECEIVED: "Payment received",
  INVOICED: "Invoiced",
  DELIVERED: "Delivered",
  HOLD_LIFTED: "Hold lifted",
  ALLOCATED: "Car allocated",
  ALLOCATION_RELEASED: "Car released",
  STOCK_RECEIVED: "Reserved car arrived",
  PAYMENT_REMINDER_SENT: "Payment reminder sent",
  PAYMENT_ESCALATED: "Payment escalated",
  EXCEPTION_REQUESTED: "Request raised",
  EXCEPTION_APPROVED: "Request approved",
  EXCEPTION_REJECTED: "Request rejected",
  BOOKING_CHECKLIST: "Booking checklist changed",
  PAYMENT_REPORTED: "Payment reported",
  PAYMENT_VERIFIED: "Payment verified by Finance",
  PAYMENT_NOT_RECEIVED: "Payment not received",
  CUSTOMER_CONTACT_CHANGED: "Customer contact changed",
  OUT_OF_TURN_REVIEWED: "Out-of-turn allocation reviewed",
  RESERVED_CAR_NOT_USED: "Reserved car not used",
  ALLOCATION_RULES_CHANGED: "Allocation rules changed",
  DMS_DEALER_SET: "DMS dealer name set",
  EOD_KEY_CREATED: "End-of-day key created",
  EOD_KEY_REMOVED: "End-of-day key removed",
  MASTER_LOADED: "Vehicle master sheet loaded",
  MASTER_NAME_MAPPED: "Same-colour mapping added",
  MASTER_NAME_REMOVED: "Same-colour mapping removed",
  MASTER_VARIANT_ADDED: "Variant added to the vehicle master",
  MASTER_VARIANT_CHANGED: "Variant changed in the vehicle master",
  MASTER_COLOURS_CHANGED: "Colour list changed",
  PASSWORD_RESET_BY_ADMIN: "Password reset by an administrator",
  PASSWORD_CODE_REQUESTED: "Password code requested",
  PASSWORD_SET_WITH_CODE: "Password set with a WhatsApp code",
  BYPASS_DETECTED: "Car billed to a different booking",
  INVOICED_OUTSIDE_ALLOCATION: "Car billed without an allocation",
  ORDER_PLACED: "Manufacturer order recorded",
  ORDER_UPDATED: "Manufacturer order updated",
  RECON_ITEM_RESOLVED: "Day-end check finding closed",
  USER_CREATED: "User added",
  USER_UPDATED: "User changed",
  PASSWORD_CHANGED: "Password changed",
  OUTLET_CREATED: "Outlet added",
  OUTLET_UPDATED: "Outlet changed",
  SETTINGS_CHANGED: "Rules changed",
  WA_CONFIG_CHANGED: "WhatsApp connection changed",
  WA_TEMPLATE_CHANGED: "WhatsApp message changed",
  WA_TEMPLATE_SUBMITTED: "WhatsApp message sent for approval",
  WA_TEST_SENT: "WhatsApp test sent",
};

export const AUDIT_ENTITIES: Record<string, string> = {
  booking: "Booking",
  vehicle: "Car",
  order: "Manufacturer order",
  recon_item: "Day-end check finding",
  user: "User",
  outlet: "Outlet",
  tenant: "Dealership settings",
  wa_template: "WhatsApp message",
  variant: "Vehicle master variant",
  alias: "Same-colour mapping",
  model: "Model",
};
export const auditEntity = (t: string) => AUDIT_ENTITIES[t] ?? humanize(t);

export function actorName(actor: string | null | undefined, name?: string | null): string {
  if (name) return name;
  if (!actor) return "System";
  if (actor === "SYSTEM" || actor === "System") return "System";
  if (actor.startsWith("UPLOAD:") || actor === "Data upload") return "DMS file";
  if (actor === "EOD") return "End-of-day feed";
  if (actor === "DMS") return "DMS";
  if (/^usr_[0-9a-f]+$/.test(actor)) return "A former user";
  return actor;
}

/** One readable sentence for an audit entry. */
export function auditSentence(action: string, d: Record<string, unknown>, outletName: (id: string) => string, roleLabel: (r: string) => string): string {
  const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));
  const tail = (v: unknown, prefix = ": ") => (s(v) ? `${prefix}${s(v)}` : "");
  switch (action) {
    case "BOOKING_CREATED":
      return `Booking ${s(d.booking_no)} created for ${s(d.model)} ${s(d.variant)}, ${s(d.colour)}.`.replace(/\s+/g, " ");
    case "BOOKING_EDITED":
      return "Booking details edited.";
    case "BOOKING_SUBMITTED":
      return "Submitted for approval.";
    case "BOOKING_APPROVED":
      return `Booking approved${tail(d.remarks, ". Remarks: ")}.`;
    case "BOOKING_REJECTED":
      return `Booking rejected${tail(d.remarks)}.`;
    case "BOOKING_CANCELLED":
      return `Booking cancelled${tail(d.reason)}.`;
    case "BOOKING_IMPORTED":
      return `Booking loaded from the DMS booking sheet${d.status === "APPROVED" ? " and placed in the queue" : ""}.`;
    case "BOOKING_UPDATED_FROM_UPLOAD":
      return "Booking details updated from the DMS booking sheet.";
    case "PAYMENT_RECEIVED":
      return "Payment received from the customer.";
    case "INVOICED":
      return `Invoiced${tail(d.vin, " on car ")}${d.source === "DMS" ? " (as per DMS data)" : ""}.`;
    case "DELIVERED":
      return `Car delivered to the customer${d.source === "DMS" ? " (as per DMS data)" : ""}.`;
    case "HOLD_LIFTED":
      return d.automatic ? "Hold date reached; the booking is back in the queue." : "Customer is ready; the booking is back in the queue.";
    case "ALLOCATED":
      if (d.source === "DMS") return `Car ${s(d.vin)} allotted in the DMS.`;
      return `Car ${s(d.vin)} allocated${d.type ? ` (${allocationType(s(d.type)).toLowerCase()})` : ""}${d.needs_transfer ? "; it needs a transfer between outlets" : ""}${d.exception_id ? ", through an approved request" : ""}.`;
    case "ALLOCATION_RELEASED": {
      const hold = d.hold as { until?: string | null } | null | undefined;
      return `Car released because ${releaseReason(s(d.reason))}.${hold ? ` Booking put on hold${hold.until ? ` until ${fmtDate(hold.until)}` : ""}.` : ""}`;
    }
    case "STOCK_RECEIVED":
      return `The reserved car ${s(d.vin)} reached the dealership. The payment window has started.`;
    case "PAYMENT_REMINDER_SENT":
      return `Payment reminder sent to the customer (day ${s(d.day)}).`;
    case "PAYMENT_ESCALATED":
      return `Escalated (day ${s(d.day)}). The car will be re-allocated on ${fmtDate(s(d.release_on))}.`;
    case "EXCEPTION_REQUESTED":
      return `Request raised: ${exceptionType(s(d.type)).toLowerCase()}${tail(d.reason, ". Reason: ")}.`;
    case "EXCEPTION_APPROVED":
      return `Request approved: ${exceptionType(s(d.type)).toLowerCase()}${tail(d.remarks, ". Remarks: ")}.`;
    case "EXCEPTION_REJECTED":
      return `Request rejected: ${exceptionType(s(d.type)).toLowerCase()}${tail(d.remarks, ". Reason: ")}.`;
    case "BOOKING_CHECKLIST": {
      const on = Object.entries(d).filter(([, v]) => v === true).map(([k]) => checklistLabel(k));
      const off = Object.entries(d).filter(([, v]) => v === false).map(([k]) => checklistLabel(k));
      return [on.length ? `Confirmed on file: ${on.join("; ")}.` : "", off.length ? `No longer confirmed: ${off.join("; ")}.` : ""].filter(Boolean).join(" ") || "Checklist changed.";
    }
    case "PAYMENT_REPORTED":
      return `Payment reported${d.amount ? ` of ${fmtMoney(Number(d.amount))}` : ""}${tail(d.reference, ", reference ")}${tail(d.note, ". Note: ")}. Waiting for Finance to verify.`;
    case "PAYMENT_VERIFIED":
      return `Finance verified the payment${d.amount ? ` of ${fmtMoney(Number(d.amount))}` : ""}${tail(d.reference, ", reference ")}.`;
    case "PAYMENT_NOT_RECEIVED":
      return `Finance could not find the reported payment${tail(d.reference, " (reference ")}${d.reference ? ")" : ""}${tail(d.note)}. The payment window continues.`;
    case "CUSTOMER_CONTACT_CHANGED":
      return `Customer contact changed${d.mobile_changed ? " (mobile number)" : ""}. WhatsApp messages: ${d.wa_opt_in ? "agreed" : "not agreed"}.`;
    case "OUT_OF_TURN_REVIEWED":
      return `Out-of-turn allocation reviewed${tail(d.note)}.`;
    case "BYPASS_DETECTED":
      return `Car ${s(d.vin)} was allocated to booking ${s(d.allocated_booking_no)} but billed to ${s(d.invoiced_booking_no) || "another booking"}.`;
    case "INVOICED_OUTSIDE_ALLOCATION":
      return `Billed in the DMS on car ${s(d.vin)}, which the system had not allocated to this booking.`;
    case "ORDER_PLACED":
      return `Order recorded with the manufacturer: ${s(d.quantity)} × ${s(d.model)} ${s(d.variant)}, ${s(d.colour)}.`;
    case "ORDER_UPDATED":
      return "Manufacturer order updated.";
    case "RECON_ITEM_RESOLVED":
      return `Day-end check finding closed${tail(d.note)}.`;
    case "USER_CREATED":
      return `User added: ${s(d.name)} (${roleLabel(s(d.role))}).`;
    case "USER_UPDATED":
      if (Array.isArray(d.changes)) return `User changed from the employee sheet: ${d.changes.join(", ")}.`;
      if (d.is_active === false) return "User deactivated.";
      if (d.is_active === true) return "User reactivated.";
      if (d.password) return "User's password was reset.";
      return "User details changed.";
    case "PASSWORD_CHANGED":
      return "Changed their own password.";
    case "OUTLET_CREATED":
      return `Outlet added: ${s(d.name)} (${s(d.code)}).`;
    case "OUTLET_UPDATED":
      if (d.is_active === false) return "Outlet deactivated.";
      if (d.is_active === true) return "Outlet reactivated.";
      return "Outlet details changed.";
    case "SETTINGS_CHANGED":
      return "Dealership settings changed.";
    case "ALLOCATION_RULES_CHANGED":
      return `Allocation rules changed${Array.isArray(d.changed) ? `: ${d.changed.join(", ")}` : ""}.`;
    case "PASSWORD_RESET_BY_ADMIN":
      return "Given a new temporary password by an administrator.";
    case "PASSWORD_SET_WITH_CODE":
      return "Set their own password with a WhatsApp code.";
    case "PASSWORD_CODE_REQUESTED":
      return "Asked for a WhatsApp code to set a password.";
    case "EOD_KEY_CREATED":
      return "End-of-day key created.";
    case "EOD_KEY_REMOVED":
      return "End-of-day key removed.";
    case "MASTER_LOADED":
      return `Vehicle master sheet loaded: ${s(d.created)} added, ${s(d.updated)} updated.`;
    case "MASTER_NAME_MAPPED":
      return d.colour ? `${s(d.model)}: "${s(d.alias)}" is treated as the colour ${s(d.colour)}.` : `"${s(d.alias)}" mapped to ${s(d.variant)}.`;
    case "MASTER_NAME_REMOVED":
      return `Mapping removed: ${s(d.model)} "${s(d.alias)}".`;
    case "WA_CONFIG_CHANGED":
      return "WhatsApp connection settings changed.";
    case "WA_TEMPLATE_CHANGED":
      return `WhatsApp message changed${d.wording_changed ? " (wording)" : ""}.`;
    case "WA_TEMPLATE_SUBMITTED":
      return "WhatsApp message sent to Meta for approval.";
    case "WA_TEST_SENT":
      return `WhatsApp test message sent to ${fmtMobile(s(d.to))}.`;
    default:
      void outletName;
      return `${AUDIT_ACTIONS[action] ?? humanize(action)}.`;
  }
}

// ---------------------------------------------------------------- settings
export const OUTLET_SCOPE_OPTIONS = [
  { value: "SAME_OUTLET_FIRST", label: "Own outlet first, then other outlets", help: "A car serves bookings at its own outlet first. If nobody there is waiting for it, it can go to a booking at another outlet and is flagged for transfer." },
  { value: "SAME_OUTLET_NEARBY", label: "Own outlet, then nearby outlets", help: "A car serves bookings at its own outlet first, then bookings at the outlets listed as nearby, in the order given. It does not go further." },
  { value: "SAME_OUTLET_ONLY", label: "Own outlet only", help: "A car only ever serves bookings at the outlet where it is. Each outlet has its own queue." },
  { value: "ANY_OUTLET", label: "One queue for the whole dealership", help: "The earliest booking anywhere gets the next car, wherever the car is. Cars are transferred as needed." },
] as const;

/** Words for a code found inside an audit entry's detail, chosen by the field it sits in. */
export function codeLabel(key: string, code: string): string {
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  if (key === "type") return ALLOCATION_TYPE[code] ?? EXCEPTION_TYPE[code as ExceptionType] ?? humanize(code);
  if (key === "rule") return ALLOCATION_RULE[code] ?? humanize(code);
  if (key === "outlet_scope") return OUTLET_SCOPE_OPTIONS.find((o) => o.value === code)?.label ?? humanize(code);
  if (key === "vehicle_status") return vehicleStatus(code).text;
  if (key === "status") return BOOKING_STATUS[code]?.text ?? EXCEPTION_STATUS[code]?.text ?? ORDER_STATUS[code]?.text ?? META_STATUS[code]?.text ?? humanize(code);
  if (/documents$/.test(key)) return checklistLabel(code);
  if (key === "reason" || key === "previous_reason") return RELEASE_REASON[code] ? cap(RELEASE_REASON[code]) : HOLD_REASON[code] ?? humanize(code);
  if (key === "provider") return waProvider(code);
  if (key === "event_key") return waEvent(code);
  return humanize(code);
}

/** Readable name for a field inside an audit entry's detail. */
export function fieldLabel(key: string): string {
  const known: Record<string, string> = {
    booking_no: "Booking number",
    vin: "Chassis number",
    outlet_id: "Outlet",
    from_outlet_id: "From outlet",
    to_outlet_id: "To outlet",
    wa_opt_in: "WhatsApp consent",
    needs_transfer: "Needs transfer",
    priority_ts: "Priority date",
    release_on: "Re-allocation date",
    is_active: "Active",
    all_outlets: "All outlets",
    outlet_ids: "Outlets",
    type: "Type",
    rule: "Why this car",
    outlet_scope: "Allocation across outlets",
    vehicle_status: "Where the car was",
    queue_position: "Place in the queue",
    event_key: "Message",
    wa_opt_in_changed: "WhatsApp consent changed",
    oem_reference: "Manufacturer reference",
    previous_reason: "Reason it was on hold",
    hold_after_timeout: "On hold after a payment timeout",
    import_bookings_as_approved: "Loaded bookings enter the queue directly",
    min_booking_amount: "Minimum booking amount",
    in_transit_eta_text: "Arrival wording without a date",
    approval_sla_hours: "Approval time limit (hours)",
    booking_approver_roles: "Who approves bookings",
    exception_approver_roles: "Who approves special requests",
    required_documents: "Booking checklist",
    alarm_roles: "Alarm recipients",
    data_stale_days: "DMS files expected every (days)",
    payment_verify_hours: "Time for Finance to verify (hours)",
    funding_rate_pct: "Annual funding rate (%)",
    transit_days: "Usual transit days",
    queue_order: "Queue order",
    car_order: "Car order",
    nearby_outlets: "Nearby outlets",
    allocate_in_transit: "Allocate cars in transit",
    dms_dealer_name: "DMS dealer name",
    reference: "Payment reference",
    reminder_days: "Reminder day",
    escalation_days: "Escalation day",
    reallocate_days: "Re-allocation day",
    day_end_time: "Day-end time",
    business_hours_from: "Business hours start",
    business_hours_to: "Business hours end",
    before: "Before",
    after: "After",
    backdated_days: "Days the booking date is before entry",
  };
  return known[key] ?? humanize(key);
}
