// Shapes of the JSON the API returns. Kept in step with src/http/routes-*.ts and src/domain/*.ts.

export type Role = "ADMIN" | "DEALER_PRINCIPAL" | "BUSINESS_HEAD" | "VP" | "SALES_MANAGER" | "SALES_EXEC" | "STOCK_INCHARGE" | "ORDERING" | "ACCOUNTS" | "CRM" | "AUDITOR";

export type Permission =
  | "stock.view"
  | "stock.manage"
  | "stock.value"
  | "upload.stock"
  | "upload.bookings"
  | "booking.view"
  | "booking.view_all"
  | "booking.create"
  | "booking.approve"
  | "booking.cancel"
  | "booking.payment_report"
  | "booking.payment"
  | "booking.contact"
  | "booking.deliver"
  | "booking.ready"
  | "owner.view"
  | "owner.review"
  | "wa.resend"
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
  | "master.manage"
  | "admin.users"
  | "admin.settings"
  | "audit.view";

export type OutletScope = "SAME_OUTLET_FIRST" | "SAME_OUTLET_NEARBY" | "SAME_OUTLET_ONLY" | "ANY_OUTLET";
export type QueueCriterion = "BOOKING_DATE" | "DELIVERY_COMMITMENT" | "BOOKING_AMOUNT";
export type CarCriterion = "AT_DEALERSHIP" | "OWN_OUTLET" | "EARLIEST_ARRIVAL" | "OLDEST_INVOICE";
/** Items of the booking submission checklist. Nothing is uploaded; the person submitting confirms each is on file. */
export type ChecklistKey = "DOCKET" | "KYC" | "PAN_AADHAAR" | "PAYMENT_PROOF";

export interface TenantSettings {
  reminder_days: number;
  escalation_days: number;
  reallocate_days: number;
  hold_after_timeout: boolean;
  import_bookings_as_approved: boolean;
  business_hours_from: string;
  business_hours_to: string;
  min_booking_amount: number;
  required_documents: ChecklistKey[];
  outlet_scope: OutletScope;
  nearby_outlets: Record<string, string[]>;
  queue_order: QueueCriterion[];
  car_order: CarCriterion[];
  allocate_in_transit: boolean;
  booking_approver_roles: Role[];
  exception_approver_roles: Role[];
  release_approver_roles: Role[];
  /** The business date from which this system is the authority for allocation; null while it is not. */
  allocation_control_from: string | null;
  day_end_time: string;
  in_transit_eta_text: string;
  approval_sla_hours: number;
  dms_dealer_name: string;
  data_stale_days: number;
  alarm_roles: Role[];
  payment_verify_hours: number;
  funding_rate_pct: number | null;
  transit_days: number | null;
  monthly_retail_target: number | null;
}

export interface Outlet {
  id: string;
  code: string;
  name: string;
  city: string | null;
  /** Where the outlet is, for the customer who has to collect a car from another branch. */
  address: string | null;
  is_active: number;
}
export interface OutletRef {
  id: string;
  code: string;
  name: string;
}

export interface Me {
  user: { id: string; name: string; mobile: string; role: Role; allOutlets: boolean; outletIds: string[]; mustChangePassword: boolean; permissions: Permission[] };
  tenant: { id: string; slug: string; name: string; oem: string; timezone: string };
  settings: TenantSettings;
  outlets: Outlet[];
  all_outlets: OutletRef[];
  role_labels: Record<Role, string>;
  /** True when the user's role is one of the dealership's alarm recipients. */
  receives_alarms: boolean;
  app_name: string;
}

export type AllocationType = "IN_TRANSIT" | "FREE_STOCK" | "REALLOCATED";

export interface AllocationOutcome {
  allocationId: string;
  bookingId: string;
  bookingNo: string;
  vehicleId: string;
  vin: string;
  type: AllocationType;
  needsTransfer: boolean;
}
export interface WithAllocations {
  allocations: AllocationOutcome[];
}

export interface Overview {
  stock: { yard_free: number; yard_allocated: number; transit_free: number; transit_allocated: number; blocked: number; transit_overdue: number };
  bookings: { draft: number; awaiting_approval: number; waiting: number; on_hold: number; allocated: number; invoiced: number; delivery_overdue: number };
  approvals: { exceptions_pending: number };
}

export interface AlertRow {
  id: string;
  /** Set when the alert is addressed to the signed-in user personally rather than to their role. */
  target_user: string | null;
  target_role: string | null;
  outlet_id: string | null;
  kind: string;
  title: string;
  body: string;
  entity_type: string | null;
  entity_id: string | null;
  created_at: string;
  read_at: string | null;
  is_alarm: boolean;
  /** What kind of alarm this is, in words; null for an ordinary alert. */
  kind_label: string | null;
}

/** A car as the lists name it. */
export interface CatalogRow {
  model: string;
  variant: string;
  colour: string;
}

/** The attributes that identify a Mahindra car besides its variant name. Blank when the DMS description does not state it. */
export interface CarAttributes {
  category?: string | null;
  trim?: string | null;
  transmission?: string | null;
  fuel?: string | null;
  drive?: string | null;
  seater?: string | null;
}

export interface MasterVariant {
  id: string;
  category: string;
  model: string;
  trim: string;
  transmission: string;
  fuel: string;
  drive: string;
  seater: string;
  variant: string;
  variant_key: string;
  is_active: number | boolean;
  oem_model_code: string;
  /** "DMS" when the variant was registered from a DMS file; its model and name then follow the DMS. */
  origin: string;
  fuel_source: string | null;
}

/** What the pickers offer: active variants, each model's colours and, with no master, the combinations already seen. */
export interface Catalog {
  master: boolean;
  variants: MasterVariant[];
  colours: Record<string, string[]>;
  legacy: CatalogRow[];
}

export interface StockSummaryRow extends CatalogRow, CarAttributes {
  variant_id: string | null;
  yard_free: number;
  yard_allocated: number;
  transit_free: number;
  transit_allocated: number;
  blocked: number;
  earliest_free_arrival: string | null;
  transit_overdue: number;
}

export type AvailabilityAnswer = "AVAILABLE_NOW" | "IN_TRANSIT" | "INVOICED_NOT_DISPATCHED" | "NEEDS_ORDER";
export interface Availability extends CatalogRow {
  answer: AvailabilityAnswer;
  variant_id: string | null;
  queue_position_for_new_booking: number;
  waiting_bookings: number;
  free_in_yard: number;
  free_in_transit: number;
  committed_in_yard: number;
  committed_in_transit: number;
  on_order: number;
  order_expected_date: string | null;
  car: { vin: string; status: string; outlet: string; same_outlet: boolean | null; expected_arrival_date: string | null; indicative_arrival_date: string | null; oem_invoice_date: string | null; arrival_overdue: boolean } | null;
  free_cars: { vin: string; status: string; outlet: string; expected_arrival_date: string | null; indicative_arrival_date: string | null }[];
  source: { stock_as_on: string | null; bookings_as_on: string | null; stale: boolean };
}

// ---------------------------------------------------------------- where the data comes from
export interface FileStatus {
  upload_id: string;
  report_date: string;
  loaded_at: string;
  loaded_by: string | null;
  filename: string | null;
  age_days: number;
}
export interface DataStatus {
  stock: FileStatus | null;
  bookings: FileStatus | null;
  expected_every_days: number;
  stale: boolean;
  stale_files: ("STOCK" | "BOOKINGS")[];
}

export type VehicleStatus = "IN_TRANSIT" | "RECEIVED" | "INVOICED" | "DELIVERED" | "REMOVED";

export type DmsStockType = "UNALLOTED" | "ALLOTED" | "IBND";

export interface VehicleListRow extends CatalogRow, CarAttributes {
  id: string;
  vin: string;
  variant_id: string | null;
  status: VehicleStatus;
  is_blocked: number;
  block_reason: string | null;
  outlet_id: string;
  outlet: string;
  wholesale_invoice_no: string | null;
  wholesale_invoice_date: string | null;
  dispatch_date: string | null;
  expected_arrival_date: string | null;
  received_at: string | null;
  invoiced_at: string | null;
  updated_at: string;
  allocation_id: string | null;
  allocation_type: AllocationType | null;
  needs_transfer: number | null;
  /** Null when the car is allocated to a booking this user may not see (another outlet, or a sales executive). */
  booking_id: string | null;
  booking_no: string | null;
  customer_name: string | null;
  booking_outlet_id?: string | null;
  description: string | null;
  oem_model_code: string | null;
  oem_colour_code: string | null;
  dms_colour: string | null;
  is_demo: boolean;
  dms_stock_type: DmsStockType | null;
  /** The order the DMS ties the car to. Null when the user may not see that booking. */
  dms_booking_no: string | null;
  report_date: string | null;
  /** Present only for roles that may see stock value. */
  net_dealer_price?: number | null;
  /** Days since the manufacturer's invoice; null when the invoice date is not known. */
  age_days: number | null;
}

export interface Vehicle extends CatalogRow, CarAttributes {
  id: string;
  outlet_id: string;
  outlet?: string;
  vin: string;
  variant_id: string | null;
  description: string | null;
  oem_model_code: string | null;
  oem_colour_code: string | null;
  is_demo: number | boolean;
  dms_stock_type: DmsStockType | null;
  net_dealer_price?: number | null;
  grn_no: string | null;
  engine_no: string | null;
  status: VehicleStatus;
  is_blocked: number;
  block_reason: string | null;
  wholesale_invoice_no: string | null;
  wholesale_invoice_date: string | null;
  dispatch_date: string | null;
  expected_arrival_date: string | null;
  received_at: string | null;
  invoiced_at: string | null;
  delivered_at: string | null;
  dms_booking_no: string | null;
  ever_allocated: number;
  source?: string;
  created_at?: string;
  updated_at?: string;
}
export interface VehicleEvent {
  type: string;
  from_status: string | null;
  to_status: string | null;
  detail: Record<string, unknown>;
  actor: string;
  actor_name: string | null;
  at: string;
}
export interface VehicleAllocation {
  id: string;
  type: AllocationType;
  status: string;
  allocated_at: string;
  allocated_by: string;
  released_at: string | null;
  release_reason: string | null;
  needs_transfer: number;
  /** Null when the user may not see the booking behind the allocation. */
  booking_id: string | null;
  booking_no: string | null;
}
export interface VehicleDetail {
  vehicle: Vehicle;
  events: VehicleEvent[];
  allocations: VehicleAllocation[];
}
export interface VehicleInput {
  vin: string;
  variant_id?: string | null;
  model?: string;
  variant?: string;
  colour: string;
  outlet_id: string;
  status: "IN_TRANSIT" | "RECEIVED";
  engine_no?: string | null;
  wholesale_invoice_no?: string | null;
  wholesale_invoice_date?: string | null;
  dispatch_date?: string | null;
  expected_arrival_date?: string | null;
}
export type VehiclePatch = Partial<Pick<VehicleInput, "engine_no" | "wholesale_invoice_no" | "wholesale_invoice_date" | "dispatch_date" | "expected_arrival_date">>;

export type BookingStatus = "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED" | "ALLOCATED" | "INVOICED" | "DELIVERED" | "CANCELLED";

export type BookingSource = "DMS" | "DMS_STOCK" | "APP";

export interface BookingListRow extends CatalogRow, CarAttributes {
  id: string;
  variant_id: string | null;
  booking_no: string;
  booking_date: string;
  priority_ts: string;
  customer_name: string;
  customer_mobile: string;
  status: BookingStatus;
  on_hold: number;
  hold_reason: string | null;
  hold_until: string | null;
  booking_amount: number;
  expected_delivery_date: string | null;
  outlet_id: string;
  outlet: string;
  sales_exec_id: string | null;
  sales_exec: string | null;
  /** The sales consultant as the DMS names them, when no user is linked. */
  sc_name: string | null;
  source: BookingSource;
  dms_stage: string | null;
  payment_reported_at: string | null;
  payment_received_at: string | null;
  created_at: string;
  queue_position: number | null;
  vin: string | null;
  vehicle_status: VehicleStatus | null;
  expected_arrival_date: string | null;
  allocation_type: AllocationType | null;
  needs_transfer: number | null;
}

export interface Booking extends CatalogRow, CarAttributes {
  id: string;
  variant_id: string | null;
  outlet_id: string;
  outlet?: string;
  booking_no: string;
  customer_name: string;
  customer_mobile: string;
  wa_opt_in: number;
  booking_date: string;
  priority_ts: string;
  booking_amount: number;
  expected_delivery_date: string | null;
  status: BookingStatus;
  on_hold: number;
  hold_reason: string | null;
  hold_until: string | null;
  payment_reported_at: string | null;
  payment_reported_by: string | null;
  payment_reported_by_name?: string | null;
  payment_amount: number | null;
  payment_ref: string | null;
  payment_note: string | null;
  payment_received_at: string | null;
  payment_verified_by: string | null;
  payment_verified_by_name?: string | null;
  invoiced_at: string | null;
  delivered_at: string | null;
  sales_exec_id: string | null;
  sales_exec?: string | null;
  sc_name?: string | null;
  dms_stage?: string | null;
  submitted_at: string | null;
  approved_by: string | null;
  approved_by_name?: string | null;
  approved_at: string | null;
  decision_remarks: string | null;
  cancelled_at?: string | null;
  cancel_reason?: string | null;
  source: BookingSource;
  created_by: string;
  created_by_name?: string | null;
  created_at: string;
  /** Days between the booking date and the day the booking was entered, when the date was set in the past. */
  backdated_days?: number;
}

export interface BookingInput {
  booking_no?: string;
  outlet_id: string;
  customer_name: string;
  customer_mobile: string;
  wa_opt_in?: boolean;
  variant_id?: string | null;
  model?: string;
  variant?: string;
  colour: string;
  booking_date?: string;
  booking_amount?: number;
  expected_delivery_date?: string | null;
  sales_exec_id?: string | null;
}

export interface ChecklistItem {
  key: ChecklistKey;
  label: string;
  ticked: boolean;
  by: string | null;
  at: string | null;
}

export interface PaymentWindow {
  day: number;
  reminder_on: string;
  escalation_on: string;
  release_on: string;
  stage: "OPEN" | "REMINDED" | "ESCALATED";
  /** A payment has been reported and waits for Finance: the car is not re-allocated meanwhile. */
  held_for_finance?: boolean;
}

export interface BookingAllocation {
  id: string;
  vehicle_id: string;
  type: AllocationType;
  status: string;
  needs_transfer: number;
  allocated_at: string;
  allocated_by: string;
  exception_id: string | null;
  clock_started_at: string | null;
  window_extension_days: number;
  reminder_sent_at: string | null;
  escalated_at: string | null;
  vin: string;
  vehicle_status: VehicleStatus;
  expected_arrival_date: string | null;
  vehicle_outlet_id: string;
  vehicle_outlet: string;
  rule_trace: { rule?: string; queue_position?: number };
  source?: string;
  window: PaymentWindow | null;
}

/** A car standing in a customer's name, as the search for one returns it. */
export interface HeldCar {
  booking_id: string;
  booking_no: string;
  customer_name: string;
  model: string;
  variant: string;
  colour: string;
  vin: string;
  outlet_id: string;
  outlet: string;
  allocated_at: string;
  vehicle_status: string;
  /** Set when a release has already been asked for and not yet decided. */
  pending_request_id: string | null;
}

/**
 * Why a car may be taken back, and what that choice has to bring with it. Served by the API rather
 * than written here, so the form cannot drift from the rule it is collecting for.
 */
export interface ReleaseReason {
  code: string;
  label: string;
  hint: string;
  evidence: "reference" | "booking" | "document" | "none";
  evidenceLabel: string;
  evidenceHint: string;
  holds: boolean;
  reallocates: boolean;
}

export type ExceptionType = "PRIORITY_CHANGE" | "SKIP_ALLOCATION" | "DEFER_DELIVERY" | "OUTLET_CHANGE" | "MANUAL_ALLOCATION" | "WINDOW_EXTENSION" | "RELEASE_ALLOCATION" | "OTHER";
export type ExceptionStatus = "PENDING" | "APPROVED" | "REJECTED";

export interface ExceptionRow {
  id: string;
  type: ExceptionType;
  booking_id: string;
  vehicle_id: string | null;
  payload: Record<string, unknown>;
  reason: string;
  status: ExceptionStatus;
  requested_by: string;
  requested_by_name: string | null;
  requested_at: string;
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_remarks: string | null;
  /** Names for what the request points at, so no internal id is shown. */
  before_booking_no?: string | null;
  to_outlet?: string | null;
  // Present on the /api/exceptions list only
  booking_no?: string;
  customer_name?: string;
  model?: string;
  variant?: string;
  colour?: string;
  outlet_id?: string;
  vin?: string | null;
}
export interface ExceptionInput {
  type: ExceptionType;
  booking_id: string;
  vehicle_id?: string | null;
  payload?: Record<string, unknown>;
  reason: string;
}

export type WaStatus = "QUEUED" | "SENT" | "DELIVERED" | "READ" | "FAILED" | "SKIPPED";

export interface WaMessage {
  id: string;
  event_key: string;
  audience: string;
  to_mobile: string;
  to_name?: string | null;
  booking_id?: string | null;
  booking_no?: string | null;
  template_name?: string;
  rendered_text: string;
  status: WaStatus;
  provider: string;
  error: string | null;
  attempts?: number;
  created_at: string;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
}

export interface TimelineEntry {
  action: string;
  actor: string | null;
  detail: Record<string, unknown>;
  at: string;
}

export interface BookingDetail {
  booking: Booking;
  /** Empty for a booking that came from the DMS: it was documented there. */
  checklist: ChecklistItem[];
  checklist_missing: ChecklistKey[];
  allocation: BookingAllocation | null;
  allocation_history: { id: string; vin: string; type: AllocationType; status: string; allocated_at: string; released_at: string | null; release_reason: string | null }[];
  exceptions: ExceptionRow[];
  messages: WaMessage[];
  timeline: TimelineEntry[];
  queue: { position: number; waiting: number } | null;
}

export type PaymentState = "TO_VERIFY" | "AWAITING_PAYMENT" | "VERIFIED";
export interface PaymentRow extends CatalogRow {
  booking_id: string;
  booking_no: string;
  customer_name: string;
  outlet_id: string;
  outlet: string;
  sales_exec: string | null;
  payment_reported_at: string | null;
  payment_reported_by_name: string | null;
  payment_amount: number | null;
  payment_ref: string | null;
  payment_note: string | null;
  payment_received_at: string | null;
  payment_verified_by_name: string | null;
  vin: string;
  vehicle_status: VehicleStatus;
  net_dealer_price?: number | null;
  state: PaymentState;
  /** Reported longer ago than the time Finance has to verify. */
  overdue: boolean;
  window: PaymentWindow | null;
}
export interface PaymentInput {
  amount?: number | string | null;
  reference?: string;
  note?: string;
}

export interface DirectoryUser {
  id: string;
  name: string;
  role: Role;
}

export interface UserRow {
  id: string;
  name: string;
  mobile: string;
  email: string | null;
  role: Role;
  all_outlets: number;
  is_active: number;
  must_change_password: number;
  /** The person's ID in the DMS (SC Mile Id). */
  dms_code: string | null;
  created_at: string;
  outlet_ids: string[];
}
export interface UserInput {
  name?: string;
  mobile?: string;
  email?: string;
  role?: Role;
  password?: string;
  all_outlets?: boolean;
  outlet_ids?: string[];
  is_active?: boolean;
  dms_code?: string | null;
}

export interface EmployeeImportResult {
  row_count: number;
  created: { name: string; mobile: string; role: Role; role_label: string; outlets: string; temporary_password: string }[];
  updated: { name: string; mobile: string; role_label: string; changes: string[] }[];
  unchanged: number;
  errors: UploadError[];
  otp_available: boolean;
}

export interface RoleInfo {
  role: Role;
  label: string;
  purpose: string;
  permissions: Permission[];
  tenant_wide: boolean;
  receives_alarms: boolean;
}
export interface RolesResponse {
  roles: RoleInfo[];
  permission_labels: Record<string, string>;
  booking_approver_roles: Role[];
  exception_approver_roles: Role[];
  release_approver_roles: Role[];
  /** The business date from which this system is the authority for allocation; null while it is not. */
  allocation_control_from: string | null;
  alarm_roles: Role[];
}

export interface CriterionInfo {
  label: string;
  help: string;
}
export interface SettingsResponse {
  settings: TenantSettings;
  defaults: TenantSettings;
  queue_criteria: Record<QueueCriterion, CriterionInfo>;
  car_criteria: Record<CarCriterion, CriterionInfo>;
  role_labels: Record<Role, string>;
  role_purpose: Record<Role, string>;
  permissions: Record<Role, Permission[]>;
}

export interface PreviewCar {
  vin: string;
  outlet: string;
  status: string;
}
export interface RulesPreview {
  waiting_bookings: number;
  bookings_affected: number;
  groups: {
    model: string;
    variant: string;
    colour: string;
    waiting: number;
    free_cars: number;
    changed: number;
    rows: { booking_no: string; outlet: string; booking_date: string; expected_delivery_date: string | null; booking_amount: number; position_now: number | null; position_then: number | null; car_now: PreviewCar | null; car_then: PreviewCar | null; changed: boolean }[];
  }[];
}

export interface AllocationDashRow extends CatalogRow {
  allocation_id: string;
  type: AllocationType;
  allocated_at: string;
  allocated_by: string;
  needs_transfer: number;
  clock_started_at: string | null;
  window_extension_days: number;
  booking_id: string;
  booking_no: string;
  booking_date: string;
  customer_name: string;
  booking_status: BookingStatus;
  expected_delivery_date: string | null;
  payment_received_at: string | null;
  outlet: string;
  vehicle_id: string;
  vin: string;
  vehicle_status: VehicleStatus;
  expected_arrival_date: string | null;
  vehicle_outlet: string;
  window: PaymentWindow | null;
}

export interface OrderQueueRow extends CatalogRow {
  waiting: number;
  on_hold: number;
  earliest_booking: string;
  earliest_commitment: string | null;
  on_order: number;
  to_order: number;
  expected_date: string | null;
  status: "PENDING" | "ORDERED";
}

export type OrderStatus = "PLACED" | "CONFIRMED" | "CLOSED" | "CANCELLED";
export interface OrderRow extends CatalogRow {
  id: string;
  quantity: number;
  status: OrderStatus;
  oem_reference: string | null;
  expected_date: string | null;
  notes: string | null;
  created_by: string;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
}
export interface OrderInput {
  variant_id?: string | null;
  model?: string;
  variant?: string;
  colour?: string;
  quantity?: number;
  status?: OrderStatus;
  oem_reference?: string;
  expected_date?: string | null;
  notes?: string;
}

export interface DelayedRow extends CatalogRow {
  booking_id: string;
  booking_no: string;
  booking_date: string;
  customer_name: string;
  status: BookingStatus;
  on_hold: number;
  hold_reason: string | null;
  expected_delivery_date: string;
  delivered_at: string | null;
  outlet: string;
  vin: string | null;
  vehicle_status: VehicleStatus | null;
  expected_arrival_date: string | null;
  delay_days: number;
  reason: string;
}

export interface UploadError {
  row: number;
  key: string;
  message: string;
}

export interface StockSummary {
  dealer_name: string;
  report_date: string;
  cars: number;
  unallocated: number;
  unallocated_received: number;
  unallocated_in_transit: number;
  allocated: number;
  alloted: number;
  ibnd: number;
  demo: number;
  new_cars: number;
  received: number;
  invoiced: number;
  returned: number;
  left_stock: { delivered: number; removed: number; on_hold: number };
  orders: { total: number; in_booking_data: number; known_only_from_stock: number; recorded: number; confirmed: number; bypassed: number; to_cancelled_booking: number; released_in_dms: number; out_of_turn: number };
  outlets_created: string[];
  variants_added: number;
  not_recognised: number;
  issues: Record<string, number>;
  master_conflicts: string[];
}
export interface BookingSummary {
  dealer_name: string;
  sheet_date: string;
  bookings: number;
  booked: number;
  invoiced: number;
  delivered: number;
  cancelled: number;
  new_bookings: number;
  entered_queue: number;
  cancelled_now: number;
  cars_released: number;
  invoiced_now: number;
  delivered_now: number;
  details_completed: number;
  outlets_created: string[];
  variants_added: number;
  not_recognised: number;
  consultants_not_linked: number;
  master_conflicts: string[];
}
export type UploadKind = "STOCK" | "BOOKINGS";
/** The answer to loading a DMS file. `more` means: send the same file again with `continue` set to upload_id. */
export interface DmsUploadResult {
  upload_id: string;
  kind: UploadKind;
  report_date: string;
  more: boolean;
  row_count: number;
  created: number;
  updated: number;
  unchanged: number;
  errors: UploadError[];
  allocations: number;
  summary: StockSummary | BookingSummary;
}
export interface UploadRow {
  id: string;
  kind: UploadKind | string;
  mode: string;
  report_date: string | null;
  status: "RUNNING" | "DONE" | "EMPTY";
  filename: string | null;
  row_count: number;
  created_count: number;
  updated_count: number;
  unchanged_count: number;
  error_count: number;
  /** A user id, or "EOD" for the end-of-day feed. */
  uploaded_by: string;
  uploaded_by_name: string | null;
  at: string;
  allocations: number;
  summary: Partial<StockSummary & BookingSummary>;
  errors: UploadError[];
}
export interface UploadsResponse {
  issue_labels: Record<string, string>;
  uploads: UploadRow[];
}
export interface MasterUploadResult {
  row_count: number;
  created: number;
  updated: number;
  unchanged: number;
  colours_added: number;
  errors: UploadError[];
}

// ---------------------------------------------------------------- end of day
export interface EodLoad {
  id: string;
  kind: UploadKind;
  filename: string | null;
  report_date: string | null;
  at: string;
  status: "RUNNING" | "DONE" | "EMPTY";
  row_count: number;
  created_count: number;
  updated_count: number;
  error_count: number;
  uploaded_by: string;
  uploaded_by_name: string | null;
}
export interface EodStep {
  key: "BOOKINGS" | "STOCK" | "RECONCILIATION";
  label: string;
  done: boolean;
  load?: EodLoad | null;
  run?: { id: string; business_date: string; started_at: string; by: string; open_items: number; items: ReconItemCounts | null } | null;
}
export interface EodStatus {
  business_date: string;
  day_end_time: string;
  files: DataStatus;
  steps: EodStep[];
  loads_today: EodLoad[];
  feed: { key_set_at: string | null; stock_url: string; bookings_url: string; run_url: string };
}

export interface ReconItemCounts {
  total: number;
  high: number;
  medium: number;
  low: number;
  by_category: Record<string, number>;
}
export interface ReconSummary {
  business_date: string;
  stock: { outlet_id: string; outlet: string; in_transit: number; in_yard_free: number; in_yard_allocated: number; blocked: number; opening: number; added: number; left: number; closing: number; expected_closing: number }[];
  bookings: { waiting: number; on_hold: number; allocated: number; awaiting_approval: number; invoiced_today: number; delivered_today: number; cancelled_today: number };
  day: { allocations: number; releases: number; received: number; reminders: number; escalations: number; exceptions_decided: number; messages_sent: number; messages_failed: number; uploads: number };
  items: ReconItemCounts;
}
export interface ReconRunRow {
  id: string;
  business_date: string;
  trigger: "SCHEDULED" | "MANUAL";
  run_by: string | null;
  started_at: string;
  open_items: number;
  items: ReconItemCounts | null;
}
export interface ReconItem {
  id: string;
  category: string;
  severity: "HIGH" | "MEDIUM" | "LOW";
  outlet_id: string | null;
  outlet: string | null;
  entity_type: string | null;
  entity_id: string | null;
  message: string;
  status: "OPEN" | "RESOLVED";
  resolved_by_name: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
}
export interface ReconRunDetail {
  id: string;
  business_date: string;
  trigger: "SCHEDULED" | "MANUAL";
  run_by?: string | null;
  started_at: string;
  summary: Partial<ReconSummary>;
  categories: Record<string, string>;
  items: ReconItem[];
}

export interface WaConfig {
  provider: "TEST" | "META";
  enabled: boolean;
  display_number: string | null;
  phone_number_id: string | null;
  waba_id: string | null;
  graph_version: string | null;
  default_graph_version: string;
  verify_token: string | null;
  has_access_token: boolean;
  has_app_secret: boolean;
  webhook_url: string;
  connected: boolean;
  updated_at: string | null;
}
export interface WaConfigInput {
  provider?: "TEST" | "META";
  enabled?: boolean;
  display_number?: string;
  phone_number_id?: string;
  waba_id?: string;
  graph_version?: string;
  verify_token?: string;
  access_token?: string;
  app_secret?: string;
}
export interface WaTemplate {
  event_key: string;
  title: string;
  when: string;
  audience: "CUSTOMER" | "STAFF";
  category: string;
  /** WhatsApp fixes the wording (one-time code): only the template name and language can change, and it cannot be test-sent. */
  fixed_wording: boolean;
  template_name: string;
  language: string;
  body: string;
  default_body: string;
  enabled: boolean;
  meta_status: string | null;
  params: string[];
  available_params: string[];
  examples: Record<string, string>;
}
export interface WaTestResult {
  id: string;
  status: WaStatus;
  error: string | null;
  provider: string;
  provider_message_id: string | null;
  rendered_text: string;
  to_mobile: string;
}
export interface WaInbound {
  id: string;
  from_mobile: string;
  from_name: string | null;
  message_type: string;
  text: string | null;
  received_at: string;
}

export interface AuditRow {
  id: string;
  actor: string;
  actor_name: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  detail: Record<string, unknown>;
  at: string;
}

/** One place in the queue for a model, variant and colour. No customer details. */
export interface QueueRow {
  id: string;
  booking_no: string;
  booking_date: string;
  priority_ts: string;
  expected_delivery_date: string | null;
  outlet: string;
  position: number;
  is_this_booking: boolean;
}

// ---------------------------------------------------------------- the owner's view
export interface AgeBucket {
  label: string;
  cars: number;
  in_yard: number;
  in_transit: number;
  /** Present only for roles that may see stock value. */
  value?: number;
}
export interface AtRiskRow extends CatalogRow {
  booking_id: string;
  booking_no: string;
  customer_name: string;
  status: BookingStatus;
  on_hold: number;
  expected_delivery_date: string;
  outlet: string;
  vin: string | null;
  vehicle_status: VehicleStatus | null;
  expected_arrival_date: string | null;
  overdue: boolean;
  why: string;
}
export type OutOfTurnState = "APPROVED" | "REVIEWED" | "UNDER_REVIEW";
export interface OutOfTurnRow extends CatalogRow {
  allocation_id: string;
  allocated_at: string;
  source: string;
  allocation_status: string;
  bypassed_count: number;
  reviewed_at: string | null;
  review_note: string | null;
  reviewed_by_name: string | null;
  booking_id: string;
  given_to: string;
  customer_name: string;
  booking_date: string;
  outlet: string;
  vin: string;
  bypassed_booking_id: string | null;
  bypassed: string | null;
  bypassed_booking_date: string | null;
  bypassed_status: string | null;
  exception_id: string | null;
  exception_type: string | null;
  exception_reason: string | null;
  decision_remarks: string | null;
  decided_at: string | null;
  approved_by_name: string | null;
  approved_by_role: string | null;
  state: OutOfTurnState;
  how: string;
}
export interface OwnerView {
  source: DataStatus;
  customers_waiting: number;
  customers_on_hold: number;
  cars_not_matched: number;
  cars_reserved: number;
  invoiced_not_delivered: number;
  delivery_dates_at_risk: { count: number; overdue: number; rows: AtRiskRow[]; basis: string };
  out_of_turn: { this_month: number; under_review: number; rows: OutOfTurnRow[] };
  unsold_by_age: { buckets: AgeBucket[]; total: number; demo_excluded: number; basis: string };
  bookings_with_no_car_coming: { bookings: number; configurations: number };
  payments: { awaiting_payment: number; to_verify: number; verified_not_invoiced: number };
  outlets: { outlet_id: string; code: string; name: string; waiting: number; holding_a_car: number; cars: number; cars_free: number }[];
}
export interface Measure {
  key: string;
  group: string;
  label: string;
  should: "rise" | "fall";
  /** Null when the system has nothing to measure it from; `note` says why. */
  value: number | null;
  unit: "%" | "days" | "cars" | "bookings" | "INR" | "count";
  previous: number | null;
  basis: string;
  note?: string;
}
export interface MeasuresResponse {
  period: { from: string; to: string };
  previous: { from: string; to: string };
  measures: Measure[];
}

/** A waiting customer who could be offered the same model and variant in another colour that is free. */
export interface MatchRow extends CatalogRow {
  booking_id: string;
  booking_no: string;
  customer_name: string;
  booking_date: string;
  outlet: string;
  sales_exec: string | null;
  options: { colour: string; in_yard: number; in_transit: number; at_own_outlet: number; oldest_invoice: string | null }[];
}

// ---------------------------------------------------------------- vehicle master
export interface MasterVariantRow extends MasterVariant {
  is_active: boolean;
  cars_in_stock: number;
  open_bookings: number;
}
export interface MasterName {
  id: string;
  kind: "VARIANT" | "COLOUR";
  alias: string;
  model: string;
  variant_id: string | null;
  variant: string | null;
  colour: string | null;
  seen_count: number;
  last_seen_at: string | null;
  mapped_at: string | null;
  mapped_by_name: string | null;
  pending: boolean;
}
export interface ColourReviewRow {
  model: string;
  booking_says: string;
  stock_says: string;
  cars: number;
  mapped: boolean;
}
export interface MasterResponse {
  colour_review: ColourReviewRow[];
  enforced: boolean;
  variants: MasterVariantRow[];
  colours: Record<string, string[]>;
  names: MasterName[];
  pending_names: number;
  not_tied_to_master: { cars: number; bookings: number };
}
export interface VariantPatch {
  category?: string;
  model?: string;
  trim?: string;
  transmission?: string;
  fuel?: string;
  drive?: string;
  seater?: string;
  variant?: string;
  is_active?: boolean;
}

// ---- analytics
export interface AgeingRow { model: string; cars: number; in_yard: number; in_transit: number; buckets: number[]; unknown: number; oldest_days: number | null; average_days: number | null; value?: number; cars_detail: { vin: string; variant: string; colour: string; outlet: string; status: string; oem_invoice_date: string | null; age_days: number | null; value?: number }[] }
export interface AgeingResponse { as_of: string; source: DataStatus; buckets: string[]; totals: { cars: number; over_30_days: number; over_60_days: number; value?: number }; rows: AgeingRow[]; basis: string }
export interface NotPickedUpRow { booking_id: string; booking_no: string; customer_name: string; customer_mobile: string; sales_exec: string | null; outlet: string; model: string; variant: string; colour: string; vin: string; stage: "WAITING_FOR_PAYMENT" | "INVOICED_NOT_TAKEN"; since: string; days: number; payment_reported_at: string | null; payment_received_at: string | null; invoiced_on: string | null }
export interface NotPickedUpResponse { as_of: string; days: number; source: DataStatus; counts: { total: number; waiting_for_payment: number; invoiced_not_taken: number }; rows: NotPickedUpRow[]; basis: string }
export interface SalesRow { key: string; model: string; variant?: string; colour?: string; sold: number; delivered: number; unsold_in_stock: number; waiting_bookings: number; share_pct?: number | null }
export interface SalesResponse { period: { from: string; to: string }; source: DataStatus; total_sold: number; most_selling_model: SalesRow | null; least_selling_model: SalesRow | null; most_selling_car: SalesRow | null; models: SalesRow[]; cars: SalesRow[]; basis: string }
export interface AllocationDayRow { at: string; kind: "ALLOCATED" | "RELEASED"; outlet: string; outlet_id: string; booking_id: string; booking_no: string; customer_name: string; model: string; variant: string; colour: string; vin: string; how: string; by: string }
export interface AllocationsByDayResponse { period: { from: string; to: string }; source: DataStatus; totals: { allocated: number; released: number }; days: { date: string; allocated: number; released: number; outlets: { outlet: string; allocated: number; released: number }[]; reasons: Record<string, number> }[]; rows: AllocationDayRow[]; basis: string }
export interface StockDayRow { date: string; outlet_id?: string; outlet?: string; in_transit_free: number; in_transit_reserved: number; in_yard_free: number; in_yard_reserved: number; invoiced_in_stock: number; blocked: number; total: number; value_unsold?: number | null; source?: string }
export interface StockByDayResponse { period: { from: string; to: string }; source: DataStatus; days: { date: string; outlets: StockDayRow[]; total: StockDayRow }[]; basis: string }

export interface MonthPace {
  month: { from: string; to: string; days_elapsed: number; days_total: number; days_left: number };
  retails: { this_month: number; previous_month_to_date: number; target: number | null; per_day: number; projected: number };
  months: { month: string; retails: number }[];
  outlets: { outlet_id: string; code: string; name: string; retails: number }[];
  stock: { on_hand: number; value: number | null; days_of_stock: number | null };
  basis: string;
}

export type StockFacet = "model" | "trim_level" | "transmission" | "fuel" | "seater" | "drive" | "variant" | "colour" | "outlet";
export interface BrowseGroup {
  model: string; variant: string; colour: string;
  trim_level: string; transmission: string; fuel: string; seater: string;
  in_yard: number; in_transit: number;
  outlets: Record<string, number>;
  soonest: string | null; soonest_indicative: boolean;
}
export interface BrowseResponse {
  show: "FREE" | "ALL";
  chosen: Partial<Record<StockFacet, string>>;
  total: number;
  in_yard: number;
  in_transit: number;
  facets: Record<StockFacet, { value: string; cars: number }[]>;
  groups: BrowseGroup[];
  as_on: string;
  source: { stock_as_on: string | null; bookings_as_on: string | null; stale: boolean };
  basis: string;
}

export interface Alternative {
  model: string; variant: string; colour: string;
  trim_level: string; transmission: string; fuel: string; seater: string;
  spare_in_yard: number; spare_in_transit: number; waiting: number;
  outlets: { outlet: string; cars: number; same_outlet: boolean }[];
  soonest_arrival: string | null; soonest_indicative: boolean;
  differs: string[];
  headline: string;
  price_gap: number | null;
  closeness: number;
}
export interface AlternativesResponse {
  asked: { model: string; variant: string; colour: string };
  can_give_now: Alternative[];
  on_the_way: Alternative[];
  alternatives: Alternative[];
  considered: number;
  source: { stock_as_on: string | null; stale: boolean };
  basis: string;
}

export interface ModelRow {
  model: string;
  yard_free: number; transit_free: number; yard_held: number; transit_held: number; blocked: number;
  old_free: number; oldest_days: number | null;
  value: number | null; old_value: number | null;
  sold_30: number; sold_90: number; months_of_cover: number | null;
  waiting: number; on_order: number;
}
export interface ModelPicture {
  as_of: string;
  rows: ModelRow[];
  totals: { models: number; free: number; held: number; value: number | null; old_value: number | null };
  source: DataStatus;
  basis: string;
}
export interface HoldingRow {
  booking_id: string; booking_no: string; customer_name: string;
  model: string; variant: string; colour: string; vin: string; outlet: string; sales_exec: string | null;
  held_days: number; window_days: number | null; at_dealership: boolean;
  payment: "NONE" | "REPORTED" | "RECEIVED";
  invoiced: boolean; invoiced_days: number | null;
}
export interface HoldingResponse { as_of: string; rows: HoldingRow[]; source: DataStatus; basis: string }
export interface WaitingRow {
  booking_id: string; booking_no: string; customer_name: string;
  model: string; variant: string; colour: string; outlet: string; sales_exec: string | null;
  booked_on: string; waiting_days: number; on_hold: boolean; free_now: number; on_order: number;
}
/** A booking that has not paid the dealership's minimum, so it takes no place in the queue. */
export interface BelowMinimumRow {
  booking_id: string; booking_no: string; customer_name: string;
  model: string; variant: string; colour: string; outlet: string; sales_exec: string | null;
  booked_on: string; waiting_days: number;
  booking_amount: number;
  /** How much more the customer has to pay before they take a place in the queue. */
  short_by: number;
}
export interface WaitingResponse {
  as_of: string; rows: WaitingRow[];
  below_minimum: { minimum: number; bookings: BelowMinimumRow[] };
  buckets: { label: string; bookings: number }[];
  source: DataStatus; basis: string;
}
export interface DayRow { date: string; allocated: number; released: number; invoiced: number; delivered: number }
export interface DailyResponse { period: { from: string; to: string }; days: DayRow[]; totals: DayRow; source: DataStatus; basis: string }
export interface MyWork { as_of: string; counts: { waiting: number; allocated: number; invoiced: number; delivered_30: number; no_car_coming: number }; basis: string }

export interface DemandRow {
  model: string; variant: string; colour: string;
  queue: number; on_hold: number; longest_wait_days: number;
  free_now: number; on_order: number; short_by: number;
}
export interface DemandResponse { as_of: string; rows: DemandRow[]; totals: { waiting: number; configurations: number; short: number }; source: DataStatus; basis: string }
export interface DueRow {
  booking_id: string; booking_no: string; customer_name: string;
  model: string; variant: string; colour: string; vin: string; outlet: string; sales_exec: string | null;
  window_days: number; days_left: number; state: "AWAITING" | "REPORTED";
  booking_amount: number; reported_amount: number | null; reported_on: string | null;
}
export interface PaymentsDueResponse {
  as_of: string; rows: DueRow[]; buckets: { label: string; bookings: number }[];
  totals: { awaiting: number; reported: number; past_window: number; booking_amount: number };
  window_days: number; source: DataStatus; basis: string;
}
export interface MoneyFlow {
  period: { from: string; to: string };
  blocked: { label: string; cars: number; value: number }[];
  blocked_total: { cars: number; value: number; unpriced: number };
  churned: { cars: number; value: number; unpriced: number };
  source: DataStatus; basis: string;
}
