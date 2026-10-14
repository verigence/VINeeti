import type { Role } from "../env";

export type OutletScope = "SAME_OUTLET_FIRST" | "SAME_OUTLET_NEARBY" | "SAME_OUTLET_ONLY" | "ANY_OUTLET";

/** What decides which waiting booking is served first. Applied in the order listed; ties fall to the next one. */
export type QueueCriterion = "BOOKING_DATE" | "DELIVERY_COMMITMENT" | "BOOKING_AMOUNT";
/** What decides which free car a booking is given. Applied in the order listed. */
export type CarCriterion = "AT_DEALERSHIP" | "OWN_OUTLET" | "EARLIEST_ARRIVAL" | "OLDEST_INVOICE";

export const QUEUE_CRITERIA: Record<QueueCriterion, { label: string; help: string }> = {
  BOOKING_DATE: { label: "Booking date and time", help: "Earliest booking first (first booked, first served)." },
  DELIVERY_COMMITMENT: { label: "Delivery commitment", help: "Earliest delivery date committed to the customer first. Bookings with no committed date come after those with one." },
  BOOKING_AMOUNT: { label: "Booking amount", help: "Higher booking amount paid first." },
};
export const CAR_CRITERIA: Record<CarCriterion, { label: string; help: string }> = {
  AT_DEALERSHIP: { label: "Car already at the dealership", help: "A car in the yard is given before one still in transit." },
  OWN_OUTLET: { label: "Car at the customer's outlet", help: "A car at the booking's own outlet is given before one that needs a transfer." },
  EARLIEST_ARRIVAL: { label: "Earliest expected arrival", help: "Among cars in transit, the one expected first." },
  OLDEST_INVOICE: { label: "Oldest wholesale invoice", help: "The car invoiced by the manufacturer longest ago, so stock does not age." },
};
/** Items of the booking submission checklist. The person submitting confirms each is on file; no copy is stored in this system. */
export type DocumentKind = "DOCKET" | "KYC" | "PAN_AADHAAR" | "PAYMENT_PROOF";

/** Per-dealership rules. Everything here can be changed from the Settings screen without a new build. */
export interface TenantSettings {
  /** Days after the car is at the dealership before the customer is reminded. */
  reminder_days: number;
  /** Days before the Business Head is alerted. */
  escalation_days: number;
  /** Day on which the car is released and re-allocated. */
  reallocate_days: number;
  /**
   * After a payment timeout: true = the booking waits on hold until staff mark the customer ready;
   * false = it rejoins the queue at the back.
   */
  hold_after_timeout: boolean;
  /** Bookings in the DMS booking sheet at stage Booked enter the queue directly (they are confirmed in the DMS); otherwise they wait for approval first. */
  import_bookings_as_approved: boolean;
  /** Customer reminders and escalations are only sent between these local times. */
  business_hours_from: string;
  business_hours_to: string;
  min_booking_amount: number;
  required_documents: DocumentKind[];
  /** How far allocation may look for a car. */
  outlet_scope: OutletScope;
  /** For "own outlet, then nearby": outlet id -> the outlets (in order of preference) whose spare cars may serve it. */
  nearby_outlets: Record<string, string[]>;
  /** Which waiting booking is served first: criteria in order. Always ends with booking date, then booking number. */
  queue_order: QueueCriterion[];
  /** Which free car a booking is given: criteria in order. Always ends with chassis number. */
  car_order: CarCriterion[];
  /** Whether a car still in transit is allocated, or only cars that have reached the dealership. */
  allocate_in_transit: boolean;
  booking_approver_roles: Role[];
  exception_approver_roles: Role[];
  /** Local time (HH:MM) at which the day-end reconciliation runs. */
  day_end_time: string;
  /** Text used in the in-transit message when the car has no expected arrival date. */
  in_transit_eta_text: string;
  /** Hours after which a pending approval is reported at day end. */
  approval_sla_hours: number;
  /** The dealership's name as its DMS exports write it. Set by the first file loaded; a file for another dealer is refused. */
  dms_dealer_name: string;
  /** The DMS files are expected at least this often (days). Older than this, screens say so and no car is re-allocated automatically. */
  data_stale_days: number;
  /** Who receives alarms (a bypass, an unapproved out-of-turn allotment, a payment escalation, stale data ...). */
  alarm_roles: Role[];
  /** Hours Finance has to verify a payment that sales reported, before it is raised as an alarm. */
  payment_verify_hours: number;
  /** Annual cost of stock funding, in percent, for the funding-interest measure. Null until the dealership sets it. */
  funding_rate_pct: number | null;
  /** Days a car usually takes from OEM invoice to arrival, for an indicative arrival date. Null: no date is shown for a car in transit unless one was entered. */
  transit_days: number | null;
  /** Retails the dealership is aiming for in a calendar month. Null until it is set: the pace is still shown, without a verdict against it. */
  monthly_retail_target: number | null;
}

export const DEFAULT_SETTINGS: TenantSettings = {
  reminder_days: 3,
  escalation_days: 5,
  reallocate_days: 6,
  hold_after_timeout: true,
  import_bookings_as_approved: true,
  business_hours_from: "09:00",
  business_hours_to: "20:00",
  min_booking_amount: 0,
  required_documents: ["DOCKET", "KYC", "PAN_AADHAAR", "PAYMENT_PROOF"],
  outlet_scope: "SAME_OUTLET_FIRST",
  nearby_outlets: {},
  queue_order: ["BOOKING_DATE"],
  car_order: ["AT_DEALERSHIP", "OWN_OUTLET", "EARLIEST_ARRIVAL", "OLDEST_INVOICE"],
  allocate_in_transit: true,
  booking_approver_roles: ["SALES_MANAGER", "BUSINESS_HEAD"],
  exception_approver_roles: ["BUSINESS_HEAD", "DEALER_PRINCIPAL"],
  day_end_time: "21:00",
  in_transit_eta_text: "10-15 days",
  approval_sla_hours: 24,
  dms_dealer_name: "",
  data_stale_days: 3,
  alarm_roles: ["BUSINESS_HEAD", "DEALER_PRINCIPAL"],
  payment_verify_hours: 24,
  funding_rate_pct: null,
  transit_days: null,
  monthly_retail_target: null,
};

const ROLES: Role[] = ["ADMIN", "DEALER_PRINCIPAL", "CRM", "BUSINESS_HEAD", "SALES_MANAGER", "SALES_EXEC", "STOCK_INCHARGE", "ORDERING", "ACCOUNTS", "AUDITOR"];
const DOC_KINDS: DocumentKind[] = ["DOCKET", "KYC", "PAN_AADHAAR", "PAYMENT_PROOF"];
const SCOPES: OutletScope[] = ["SAME_OUTLET_FIRST", "SAME_OUTLET_NEARBY", "SAME_OUTLET_ONLY", "ANY_OUTLET"];

/** The settings that decide who gets which car. A change to any of them is announced to the Business Head. */
export const ALLOCATION_RULE_KEYS: (keyof TenantSettings)[] = ["queue_order", "car_order", "outlet_scope", "nearby_outlets", "allocate_in_transit", "hold_after_timeout", "reminder_days", "escalation_days", "reallocate_days", "import_bookings_as_approved"];

function orderedList<T extends string>(value: unknown, allowed: Record<T, unknown>, label: string): T[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} needs at least one rule`);
  const out: T[] = [];
  for (const v of value) {
    if (typeof v !== "string" || !(v in allowed)) throw new Error(`${label} has an unknown rule`);
    if (out.includes(v as T)) throw new Error(`${label} lists a rule twice`);
    out.push(v as T);
  }
  return out;
}

export function parseSettings(json: string | null | undefined): TenantSettings {
  let raw: Partial<TenantSettings> = {};
  try {
    raw = json ? JSON.parse(json) : {};
  } catch {
    raw = {};
  }
  return { ...DEFAULT_SETTINGS, ...raw };
}

const LABELS: Record<string, string> = {
  reminder_days: "Reminder day", escalation_days: "Escalation day", reallocate_days: "Re-allocation day", approval_sla_hours: "Approval time limit (hours)",
  min_booking_amount: "Minimum booking amount", business_hours_from: "Business hours start", business_hours_to: "Business hours end",
  required_documents: "Booking checklist", data_stale_days: "DMS files expected every (days)", payment_verify_hours: "Time for Finance to verify a payment (hours)", alarm_roles: "Alarm recipients", outlet_scope: "Outlet reach", queue_order: "Queue order", car_order: "Car order", booking_approver_roles: "Booking approvers",
  exception_approver_roles: "Exception approvers", day_end_time: "Day-end time",
};

/** Validates a settings patch. `outletIds`, when given, are the dealership's outlets, used to check the nearby-outlet lists. */
export function mergeSettings(current: TenantSettings, patch: Record<string, unknown>, outletIds?: string[]): TenantSettings {
  const next: TenantSettings = { ...current };
  const int = (k: keyof TenantSettings, min: number, max: number) => {
    if (patch[k] === undefined) return;
    const v = Number(patch[k]);
    if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${LABELS[k]} must be a whole number between ${min} and ${max}`);
    (next as any)[k] = v;
  };
  int("reminder_days", 1, 60);
  int("escalation_days", 1, 60);
  int("reallocate_days", 1, 90);
  int("approval_sla_hours", 1, 720);
  int("data_stale_days", 1, 30);
  int("payment_verify_hours", 1, 240);
  for (const k of ["funding_rate_pct", "transit_days", "monthly_retail_target"] as const) {
    if (patch[k] === undefined) continue;
    if (patch[k] === null || patch[k] === "") { next[k] = null; continue; }
    const v = Number(patch[k]);
    const bad =
      k === "funding_rate_pct" ? !(v > 0 && v <= 40)
      : k === "transit_days" ? !(Number.isInteger(v) && v >= 1 && v <= 90)
      : !(Number.isInteger(v) && v >= 1 && v <= 100_000);
    if (bad) {
      throw new Error(
        k === "funding_rate_pct" ? "Funding rate must be a percentage between 0 and 40"
        : k === "transit_days" ? "Transit days must be a whole number between 1 and 90"
        : "The monthly target must be a whole number of cars",
      );
    }
    next[k] = v;
  }
  if (patch.dms_dealer_name !== undefined) next.dms_dealer_name = String(patch.dms_dealer_name ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (next.reminder_days >= next.escalation_days || next.escalation_days >= next.reallocate_days) {
    throw new Error("Days must increase: reminder, then escalation, then re-allocation");
  }
  if (patch.min_booking_amount !== undefined) {
    const v = Number(patch.min_booking_amount);
    if (!Number.isFinite(v) || v < 0) throw new Error("Minimum booking amount must be zero or more");
    next.min_booking_amount = v;
  }
  if (patch.hold_after_timeout !== undefined) next.hold_after_timeout = Boolean(patch.hold_after_timeout);
  if (patch.import_bookings_as_approved !== undefined) next.import_bookings_as_approved = Boolean(patch.import_bookings_as_approved);
  for (const k of ["business_hours_from", "business_hours_to"] as const) {
    if (patch[k] === undefined) continue;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(patch[k]))) throw new Error(`${LABELS[k]} must be a time such as 09:00`);
    next[k] = String(patch[k]);
  }
  if (next.business_hours_from >= next.business_hours_to) throw new Error("Business hours must start before they end");
  if (patch.required_documents !== undefined) {
    const v = patch.required_documents as unknown[];
    if (!Array.isArray(v) || v.some((k) => !DOC_KINDS.includes(k as DocumentKind))) throw new Error("The booking checklist has an unknown item");
    next.required_documents = v as DocumentKind[];
  }
  if (patch.outlet_scope !== undefined) {
    if (!SCOPES.includes(patch.outlet_scope as OutletScope)) throw new Error("Outlet reach is not valid");
    next.outlet_scope = patch.outlet_scope as OutletScope;
  }
  if (patch.queue_order !== undefined) next.queue_order = orderedList<QueueCriterion>(patch.queue_order, QUEUE_CRITERIA, "Queue order");
  if (patch.car_order !== undefined) next.car_order = orderedList<CarCriterion>(patch.car_order, CAR_CRITERIA, "Car order");
  if (patch.allocate_in_transit !== undefined) next.allocate_in_transit = Boolean(patch.allocate_in_transit);
  if (patch.nearby_outlets !== undefined) {
    const raw = patch.nearby_outlets as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Nearby outlets are not valid");
    const out: Record<string, string[]> = {};
    for (const [outlet, list] of Object.entries(raw)) {
      if (!Array.isArray(list)) throw new Error("Nearby outlets are not valid");
      const ids = [...new Set(list.map(String))].filter((id) => id !== outlet);
      if (outletIds && (!outletIds.includes(outlet) || ids.some((id) => !outletIds.includes(id)))) throw new Error("Nearby outlets name an outlet that does not exist");
      if (ids.length) out[outlet] = ids;
    }
    next.nearby_outlets = out;
  }
  for (const k of ["booking_approver_roles", "exception_approver_roles", "alarm_roles"] as const) {
    if (patch[k] === undefined) continue;
    const v = patch[k] as unknown[];
    if (!Array.isArray(v) || v.length === 0 || v.some((r) => !ROLES.includes(r as Role))) throw new Error(`${LABELS[k]} must name at least one role`);
    next[k] = v as Role[];
  }
  if (patch.day_end_time !== undefined) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(patch.day_end_time))) throw new Error("Day-end time must be a time such as 21:00");
    next.day_end_time = String(patch.day_end_time);
  }
  if (patch.in_transit_eta_text !== undefined) next.in_transit_eta_text = String(patch.in_transit_eta_text).slice(0, 60);
  return next;
}
