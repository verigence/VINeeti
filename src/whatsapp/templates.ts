// The messages in the booking-to-delivery process. Each dealership gets these as defaults and can edit
// the wording, the template name and the language. The wording stored here must match the template
// approved in WhatsApp Manager, because Meta sends the approved text, not ours.

export type EventKey =
  | "ALLOC_IN_TRANSIT"
  | "ALLOC_FREE_STOCK"
  | "ALLOC_REALLOCATED"
  | "STOCK_RECEIVED"
  | "PAYMENT_REMINDER"
  | "PAYMENT_ESCALATION"
  | "MANAGEMENT_ALARM"
  | "SALES_EXEC_UPDATE"
  | "PASSWORD_OTP";

export interface TemplateDef {
  event_key: EventKey;
  audience: "CUSTOMER" | "STAFF";
  template_name: string;
  language: string;
  title: string;
  when: string;
  body: string;
  /** Example values, sent to Meta when the template is submitted for approval. */
  examples: Record<string, string>;
  /** AUTHENTICATION for the one-time code: Meta fixes its wording, so only the template name and language can be changed. */
  category?: "UTILITY" | "AUTHENTICATION";
}

export const DEFAULT_TEMPLATES: TemplateDef[] = [
  {
    event_key: "ALLOC_IN_TRANSIT",
    audience: "CUSTOMER",
    template_name: "allocation_in_transit",
    language: "en",
    title: "Allocated on in-transit stock",
    when: "A car that is in transit from the plant is allocated to the booking",
    body:
      "Dear {{customer_name}}, your {{vehicle}} has been allocated against booking {{booking_no}}. The car has been built and is in transit from the plant. It is expected {{eta}} at {{dealership}}. Kindly arrange your finances. Thank you.",
    examples: { customer_name: "Rahul Sharma", vehicle: "XUV 3XO AX5 PM MT (M1024) EVEREST WHITE", booking_no: "OTF27A000123", dealership: "Sample Motors, Cuttack", eta: "in 10-15 days" },
  },
  {
    event_key: "ALLOC_FREE_STOCK",
    audience: "CUSTOMER",
    template_name: "allocation_free_stock",
    language: "en",
    title: "Allocated on free stock",
    when: "A car already at the stockyard or dealership is allocated to the booking",
    body:
      "Dear {{customer_name}}, your {{vehicle}} has been allocated against booking {{booking_no}}. The car is available at {{dealership}}. Kindly arrange your funds for the next process. Thank you.",
    examples: { customer_name: "Rahul Sharma", vehicle: "XUV 3XO AX5 PM MT (M1024) EVEREST WHITE", booking_no: "OTF27A000123", dealership: "Sample Motors, Cuttack" },
  },
  {
    event_key: "ALLOC_REALLOCATED",
    audience: "CUSTOMER",
    template_name: "allocation_reallocated",
    language: "en",
    title: "Re-allocated stock",
    when: "A car released from another customer is allocated to the booking",
    body:
      "Dear {{customer_name}}, your {{vehicle}} has been allocated against booking {{booking_no}}. This vehicle was earlier allocated to another customer and is now allocated to you. Kindly arrange your funds for the next process. Thank you.",
    examples: { customer_name: "Rahul Sharma", vehicle: "XUV 3XO AX5 PM MT (M1024) EVEREST WHITE", booking_no: "OTF27A000123" },
  },
  {
    event_key: "STOCK_RECEIVED",
    audience: "CUSTOMER",
    template_name: "stock_received",
    language: "en",
    title: "Stock received at dealership",
    when: "An allocated in-transit car reaches the dealership",
    body:
      "Dear {{customer_name}}, your allocated {{vehicle}} has now reached {{dealership}}. Kindly arrange your finances for invoicing. Please complete the payment and invoicing within {{days}} days. Thank you.",
    examples: { customer_name: "Rahul Sharma", vehicle: "XUV 3XO AX5 PM MT (M1024) EVEREST WHITE", dealership: "Sample Motors, Cuttack", days: "3" },
  },
  {
    event_key: "PAYMENT_REMINDER",
    audience: "CUSTOMER",
    template_name: "payment_reminder",
    language: "en",
    title: "Payment reminder",
    when: "Invoicing or payment is still pending on the reminder day",
    body:
      "Dear {{customer_name}}, it has been {{days}} days since your allocated {{vehicle}} reached {{dealership}}. The billing is still pending. Kindly arrange your payment at the earliest to proceed with the invoicing. Thank you.",
    examples: { customer_name: "Rahul Sharma", days: "3", vehicle: "XUV 3XO AX5 PM MT (M1024) EVEREST WHITE", dealership: "Sample Motors, Cuttack" },
  },
  {
    event_key: "PAYMENT_ESCALATION",
    audience: "STAFF",
    template_name: "payment_escalation",
    language: "en",
    title: "Escalation to Business Head",
    when: "Invoicing or payment is still pending on the escalation day",
    body:
      "Payment alert: {{vehicle}} has been allocated to {{customer_name}} against booking {{booking_no}} for {{days}} days, but no payment has been received. The vehicle will be re-allocated to a new customer on {{release_date}} as per policy.",
    examples: { vehicle: "XUV 3XO AX5 PM MT (M1024) EVEREST WHITE (chassis MA1XXXXXXXX123456)", customer_name: "Rahul Sharma", booking_no: "OTF27A000123", days: "5", release_date: "20 Oct 2026" },
  },
  {
    event_key: "MANAGEMENT_ALARM",
    audience: "STAFF",
    template_name: "management_alarm",
    language: "en",
    title: "Alarm to Business Head / CEO and Dealer Principal",
    when: "Something needs management attention: a bypass, an unapproved out-of-turn allotment, a reserved car that left stock, a payment not verified in time, DMS files not updated",
    body: "Alarm for {{dealership}}: {{title}}. {{detail}} Open Verigence VINeeti for the details.",
    examples: { dealership: "Sample Motors", title: "Car given to a different booking in the DMS", detail: "THAR ROXX AX7L D AT 4WD (M0705) STEALTH BLACK was reserved for booking OTF27A000123, but the DMS shows it invoiced to OTF27A000456." },
  },
  {
    event_key: "SALES_EXEC_UPDATE",
    audience: "STAFF",
    template_name: "sales_executive_update",
    language: "en",
    title: "Update to the sales executive",
    when: "The sales executive's booking gets a car, the car arrives, Finance verifies the payment, payment is pending, or the car is released",
    body: "Update for {{name}} on booking {{booking_no}} ({{customer_name}}): {{title}}. {{detail}} Open Verigence VINeeti for the details.",
    examples: { name: "Ravi Sahoo", booking_no: "OTF27A000123", customer_name: "Rahul Sharma", title: "Car allocated to your booking", detail: "XUV 3XO AX5 PM MT (M1024) EVEREST WHITE (MA1XXXXXXXX123456) is allocated. The car is at the dealership; the payment window has started." },
  },
  {
    event_key: "PASSWORD_OTP",
    audience: "STAFF",
    category: "AUTHENTICATION",
    template_name: "password_code",
    language: "en",
    title: "One-time code to set a password",
    when: "A user asks to set or reset their password from the sign-in page",
    body: "{{code}} is your verification code. For your security, do not share this code.",
    examples: { code: "123456" },
  },
];

export const EVENT_KEYS = DEFAULT_TEMPLATES.map((t) => t.event_key);

export function paramNames(body: string): string[] {
  const names: string[] = [];
  for (const m of body.matchAll(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g)) if (!names.includes(m[1])) names.push(m[1]);
  return names;
}

export function render(body: string, params: Record<string, string>): string {
  return body.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g, (_, k: string) => params[k] ?? "");
}

/** Rules Meta applies to template bodies; checking here saves a rejected submission. */
export function validateTemplateBody(body: string): string | null {
  const text = body.trim();
  if (!text) return "Message text is required";
  if (text.length > 1024) return "Message text must be 1,024 characters or fewer";
  if (/\{\{[^}]*\}\}/.test(text.replace(/\{\{\s*[a-z][a-z0-9_]*\s*\}\}/g, ""))) return "Parameters must be lowercase names such as {{customer_name}}";
  if (/^\{\{/.test(text) || /\}\}$/.test(text)) return "The message cannot start or end with a parameter";
  if (/\}\}\s*\{\{/.test(text)) return "Two parameters cannot sit next to each other";
  return null;
}
