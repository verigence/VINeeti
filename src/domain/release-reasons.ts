// Why a car stopped being held for a customer.
//
// Until now this was a bare string: whatever the calling code passed, rendered through two
// separate maps that had drifted apart — one missing two reasons that are written, the other
// carrying four that nothing writes. One catalogue here, and both sides read it.
//
// The column stays free text on purpose. Every release ever recorded has to remain readable,
// including the tokens written before this file existed, so `words()` names what it knows and
// falls back rather than refusing. What is constrained is what may be written *now*, and in
// particular which reasons a person is allowed to ask for.
//
// Two origins:
//
//   SYSTEM    the system worked it out — the payment window ran out, the car left the stock
//             report, the DMS allotted it elsewhere. Nobody asks for these and nobody
//             approves them; they are consequences.
//
//   REQUEST   a person wants the car taken off this booking. These go through an approval,
//             carry evidence, and are the only way a held car changes hands.

/**
 * How far ahead a customer may defer and still keep the car standing in their name.
 *
 * Both directions cost something real. Hold the car for a three-month deferral and it ages in the
 * yard at the dealership's own interest; free it and a customer who asked politely loses their car
 * to someone who did not ask at all. So a short deferral keeps the car and the payment window moves
 * with it, and a long one frees the car while the customer keeps their place in the queue.
 *
 * A constant for now rather than a tenant setting — it wants to become one, with the other window
 * numbers on the rules screen.
 */
export const DEFERRAL_KEEP_DAYS = 14;

export interface Requestable {
  /** Shown in the list a person picks from. */
  label: string;
  /** The one line under it, saying what this choice actually does. */
  hint: string;
  /**
   * What has to come with the request before an approver will see it.
   *
   *   reference   a transaction already recorded elsewhere — typed in, and checked for shape
   *   booking     the booking that is to receive the car
   *   document    a file from the customer, held on the platform's document service
   *   none        the request stands on its written justification alone
   */
  evidence: "reference" | "booking" | "document" | "none";
  evidenceLabel: string;
  evidenceHint: string;
  /**
   * Whether the booking is put on hold rather than returned to the queue. A customer who asked
   * to take delivery later keeps their car; freeing it would punish them for saying so.
   */
  holds: boolean;
  /** Whether the freed car is offered straight back to the queue in the same breath. */
  reallocates: boolean;
}

/**
 * The four a person may ask for.
 *
 * MANAGEMENT_PRIORITY is the one with no external artifact — no cancellation to point at, no
 * customer's email, no named recipient — so it is the one that can quietly move a car past
 * someone who has waited a year. It is kept in the list because the need is real, and it is
 * reported separately, by requester, because it is the one open to abuse.
 */
export const REQUESTABLE: Record<string, Requestable> = {
  BOOKING_CANCELLED: {
    label: "The booking has been cancelled",
    hint: "The car goes back to the queue and the booking is closed.",
    evidence: "reference",
    evidenceLabel: "Cancellation reference",
    evidenceHint: "The cancellation entry already raised in the DMS, so the two records agree.",
    holds: false,
    reallocates: true,
  },
  REALLOCATED_TO_BOOKING: {
    label: "The car is going to another customer",
    hint: "The car moves straight to the booking you name. This customer keeps their place in the queue.",
    evidence: "booking",
    evidenceLabel: "Booking that receives the car",
    evidenceHint: "Search by booking number, customer or model. You will be shown how many earlier bookings this moves the car past.",
    holds: false,
    reallocates: false,
  },
  CUSTOMER_DEFERRED: {
    label: "The customer asked to take delivery later",
    hint: `Up to ${DEFERRAL_KEEP_DAYS} days away the customer keeps the car and the payment window moves with it. Beyond that the car is freed and they wait with their place in the queue.`,
    evidence: "document",
    evidenceLabel: "The customer's own request",
    evidenceHint: "Attach their email or letter. A deferral nobody can produce in writing is a priority change, not a deferral.",
    holds: true,
    // Only reached on the long path, where the car has genuinely been freed and so should go to
    // whoever is next. A short deferral never releases it, so this does not apply.
    reallocates: true,
  },
  MANAGEMENT_PRIORITY: {
    label: "Management is changing the priority",
    hint: "The car is freed and this booking stands down until the date you give, keeping its place in the queue. There is nothing to attach, so the justification is the whole of the case.",
    evidence: "none",
    evidenceLabel: "",
    evidenceHint: "",
    holds: true,
    reallocates: true,
  },
};

/** Everything that can appear in `allocations.release_reason`, and how to say it. */
const WORDS: Record<string, string> = {
  // asked for by a person
  BOOKING_CANCELLED: "Booking cancelled",
  REALLOCATED_TO_BOOKING: "Given to another booking",
  CUSTOMER_DEFERRED: "Customer deferred delivery",
  MANAGEMENT_PRIORITY: "Priority changed by management",

  // worked out by the system
  PAYMENT_TIMEOUT: "Payment window over",
  VEHICLE_BLOCKED: "Car blocked",
  VEHICLE_REMOVED: "Car removed from stock",
  CAR_LEFT_STOCK: "Car no longer in the stock report",
  SKIP_ALLOCATION: "Allocation skipped by request",
  DEFER_DELIVERY: "Delivery deferred by request",
  OUTLET_CHANGE: "Booking moved to another outlet",
  PRIORITY_CHANGE: "Priority changed by request",

  // what the DMS did behind us
  RELEASED_IN_DMS: "Allotment removed in the DMS",
  BILLED_WITH_ANOTHER_CAR: "Customer billed a different car",
  ALLOTTED_IN_DMS_TO_ANOTHER_BOOKING: "DMS allotted the car elsewhere",
  ALLOTTED_ANOTHER_CAR_IN_DMS: "DMS allotted a different car to this booking",

  // retired, and kept only so the rows that carry it still read
  REPLACED_BY_MANUAL_ALLOCATION: "Replaced by an allocation made by hand",
};

const humanish = (code: string) => {
  const s = code.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** What to call this reason. Unknown codes are made readable rather than hidden. */
export function releaseWords(code: string | null | undefined): string {
  if (!code) return "No reason recorded";
  return WORDS[code] ?? humanish(code);
}

/** Whether a person may ask for this one. Anything else is the system's to write, not theirs. */
export const isRequestable = (code: string): boolean => Object.hasOwn(REQUESTABLE, code);

export const requestable = (code: string): Requestable | undefined => REQUESTABLE[code];

/** The order they are offered in: the two with an artifact first, the judgement call last. */
export const REQUESTABLE_ORDER = ["BOOKING_CANCELLED", "REALLOCATED_TO_BOOKING", "CUSTOMER_DEFERRED", "MANAGEMENT_PRIORITY"] as const;

export type RequestableReason = (typeof REQUESTABLE_ORDER)[number];
