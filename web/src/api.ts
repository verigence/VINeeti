// Typed helpers for the JSON API. The session is an HttpOnly cookie, so every call is same-origin
// with credentials; state-changing calls always carry a JSON or multipart body.

import type * as T from "./types";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | null | undefined>;

let onUnauthorized: (() => void) | null = null;
let onPasswordChangeRequired: (() => void) | null = null;
/**
 * The app registers what to do when any call answers 401 (go back to the sign-in screen) or 403 with
 * the code PASSWORD_CHANGE_REQUIRED (show only the set-a-new-password screen).
 */
export function setSessionHandlers(handlers: { unauthorized: () => void; passwordChangeRequired: () => void } | null) {
  onUnauthorized = handlers?.unauthorized ?? null;
  onPasswordChangeRequired = handlers?.passwordChangeRequired ?? null;
}

export function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `${path}?${s}` : path;
}

async function request<R>(method: string, path: string, opts: { query?: Query; json?: unknown; form?: FormData } = {}): Promise<R> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const init: RequestInit = { method, credentials: "same-origin", headers };
  if (opts.form) init.body = opts.form;
  else if (method !== "GET") {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.json ?? {});
  }
  let res: Response;
  try {
    res = await fetch(withQuery(path, opts.query), init);
  } catch {
    throw offlineError();
  }
  return finish<R>(path, res.status, await res.text());
}

/** The phone has no signal, or the server cannot be reached: one plain message, never a raw fetch error. */
const offlineError = () => new ApiError(0, "NETWORK", "No connection. Try again.");

/** Turns a response into the parsed body, or throws the server's message and runs the session handlers. */
function finish<R>(path: string, status: number, text: string): R {
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (status < 200 || status >= 300) {
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
    if (status === 401 && !path.startsWith("/api/auth/login") && !path.startsWith("/api/auth/otp/")) onUnauthorized?.();
    if (status === 403 && err?.code === "PASSWORD_CHANGE_REQUIRED") onPasswordChangeRequired?.();
    throw new ApiError(status, err?.code ?? "ERROR", err?.message ?? `The request failed (${status}). Please try again.`);
  }
  return data as R;
}

const get = <R>(path: string, query?: Query) => request<R>("GET", path, { query });
const post = <R>(path: string, json?: unknown) => request<R>("POST", path, { json });
const put = <R>(path: string, json?: unknown) => request<R>("PUT", path, { json });
const patch = <R>(path: string, json?: unknown) => request<R>("PATCH", path, { json });
const del = <R>(path: string) => request<R>("DELETE", path, { json: {} });
const upload = <R>(path: string, form: FormData) => request<R>("POST", path, { form });

type Ok = { ok: true };
const enc = encodeURIComponent;

export const api = {
  // ---- session
  login: (dealer: string, mobile: string, password: string) => post<Ok>("/api/auth/login", { dealer: dealer || undefined, mobile, password }),
  logout: () => post<Ok>("/api/auth/logout"),
  me: () => get<T.Me>("/api/auth/me"),
  changePassword: (current: string, next: string) => post<Ok>("/api/auth/change-password", { current, next }),
  authOptions: (dealer: string, mobile: string) => get<{ otp: boolean }>("/api/auth/options", { dealer, mobile }),
  requestOtp: (dealer: string, mobile: string) => post<{ ok: true; message: string }>("/api/auth/otp/request", { dealer: dealer || undefined, mobile }),
  resetWithOtp: (dealer: string, mobile: string, code: string, password: string) => post<Ok>("/api/auth/otp/reset", { dealer: dealer || undefined, mobile, code, password }),

  // ---- home
  overview: () => get<T.Overview>("/api/dashboards/overview"),
  alerts: () => get<T.AlertRow[]>("/api/alerts"),
  alarms: () => get<T.AlertRow[]>("/api/alerts", { alarms: 1 }),
  markAlertRead: (id: string) => post<Ok>(`/api/alerts/${enc(id)}/read`),
  dataStatus: () => get<T.DataStatus>("/api/data-status"),

  // ---- stock
  catalog: () => get<T.Catalog>("/api/catalog"),
  stockSummary: (q: Query) => get<T.StockSummaryRow[]>("/api/stock/summary", q),
  availability: (q: { variant_id?: string; model?: string; variant?: string; colour: string; outlet_id?: string }) => get<T.Availability>("/api/stock/availability", q),
  browse: (q: Query) => get<T.BrowseResponse>("/api/stock/browse", q),
  alternatives: (q: { model: string; variant: string; colour: string; outlet_id?: string }) => get<T.AlternativesResponse>("/api/stock/alternatives", q),
  vehicles: (q: Query) => get<T.VehicleListRow[]>("/api/vehicles", q),
  vehicle: (id: string) => get<T.VehicleDetail>(`/api/vehicles/${enc(id)}`),
  addVehicle: (v: T.VehicleInput) => post<{ id: string } & T.WithAllocations>("/api/vehicles", v),
  updateVehicle: (id: string, p: T.VehiclePatch) => patch<{ changed: boolean }>(`/api/vehicles/${enc(id)}`, p),
  receiveVehicle: (id: string) => post<T.WithAllocations>(`/api/vehicles/${enc(id)}/receive`),
  receiveBulk: (vins: string[]) => post<{ received: string[]; errors: { vin: string; message: string }[] }>("/api/vehicles/receive-bulk", { vins }),
  transferVehicle: (id: string, outletId: string) => post<T.WithAllocations>(`/api/vehicles/${enc(id)}/transfer`, { outlet_id: outletId }),
  blockVehicle: (id: string, reason: string) => post<T.WithAllocations>(`/api/vehicles/${enc(id)}/block`, { reason }),
  unblockVehicle: (id: string) => post<T.WithAllocations>(`/api/vehicles/${enc(id)}/unblock`),
  removeVehicle: (id: string, reason: string) => post<T.WithAllocations>(`/api/vehicles/${enc(id)}/remove`, { reason }),
  runAllocation: () => post<{ allocated: number } & T.WithAllocations>("/api/allocations/run"),

  // ---- bookings
  bookings: (q: Query) => get<T.BookingListRow[]>("/api/bookings", q),
  booking: (id: string) => get<T.BookingDetail>(`/api/bookings/${enc(id)}`),
  bookingQueue: (id: string) => get<T.QueueRow[]>(`/api/bookings/${enc(id)}/queue`),
  createBooking: (b: T.BookingInput) => post<T.Booking>("/api/bookings", b),
  updateBooking: (id: string, b: Partial<T.BookingInput>) => patch<T.Booking>(`/api/bookings/${enc(id)}`, b),
  submitBooking: (id: string) => post<T.Booking>(`/api/bookings/${enc(id)}/submit`),
  approveBooking: (id: string, remarks?: string) => post<{ booking: T.Booking } & T.WithAllocations>(`/api/bookings/${enc(id)}/approve`, { remarks: remarks || undefined }),
  rejectBooking: (id: string, remarks: string) => post<T.Booking>(`/api/bookings/${enc(id)}/reject`, { remarks }),
  cancelBooking: (id: string, reason: string) => post<T.WithAllocations>(`/api/bookings/${enc(id)}/cancel`, { reason }),
  setChecklist: (id: string, ticks: Partial<Record<T.ChecklistKey, boolean>>) => put<{ checklist_missing: T.ChecklistKey[] }>(`/api/bookings/${enc(id)}/checklist`, ticks),
  setContact: (id: string, c: { customer_mobile?: string; wa_opt_in?: boolean }) => post<{ changed: boolean }>(`/api/bookings/${enc(id)}/contact`, c),
  invoiceBooking: (id: string) => post<T.Booking>(`/api/bookings/${enc(id)}/invoice`),
  deliverBooking: (id: string) => post<T.Booking>(`/api/bookings/${enc(id)}/deliver`),
  markReady: (id: string) => post<T.WithAllocations>(`/api/bookings/${enc(id)}/ready`),

  // ---- payments: sales reports, Finance verifies
  payments: () => get<T.PaymentRow[]>("/api/payments"),
  reportPayment: (id: string, p: T.PaymentInput) => post<T.Booking>(`/api/bookings/${enc(id)}/payment-reported`, p),
  verifyPayment: (id: string, p: T.PaymentInput) => post<T.Booking>(`/api/bookings/${enc(id)}/payment-received`, p),
  paymentNotReceived: (id: string, note: string) => post<T.Booking>(`/api/bookings/${enc(id)}/payment-not-received`, { note }),

  // ---- special requests
  exceptions: (status?: string) => get<T.ExceptionRow[]>("/api/exceptions", { status }),
  requestException: (input: T.ExceptionInput) => post<T.ExceptionRow>("/api/exceptions", input),
  decideException: (id: string, decision: "approve" | "reject", remarks?: string) => post<T.ExceptionRow>(`/api/exceptions/${enc(id)}/${decision}`, { remarks: remarks || undefined }),

  // ---- dashboards and manufacturer orders
  allocationDashboard: () => get<T.AllocationDashRow[]>("/api/dashboards/allocation"),
  orderQueue: () => get<T.OrderQueueRow[]>("/api/dashboards/order-queue"),
  delayed: () => get<T.DelayedRow[]>("/api/dashboards/delayed"),
  matches: () => get<T.MatchRow[]>("/api/dashboards/matches"),
  orders: () => get<T.OrderRow[]>("/api/orders"),
  createOrder: (o: T.OrderInput) => post<{ id: string }>("/api/orders", o),
  updateOrder: (id: string, o: T.OrderInput) => patch<Ok>(`/api/orders/${enc(id)}`, o),

  // ---- the owner's view
  ownerView: () => get<T.OwnerView>("/api/dashboards/owner"),
  outOfTurn: () => get<T.OutOfTurnRow[]>("/api/dashboards/out-of-turn"),
  reviewOutOfTurn: (allocationId: string, note: string) => post<Ok>(`/api/out-of-turn/${enc(allocationId)}/review`, { note }),
  measures: (from?: string, to?: string) => get<T.MeasuresResponse>("/api/dashboards/measures", { from, to }),
  monthPace: () => get<T.MonthPace>("/api/dashboards/month"),

  // ---- analytics
  ageing: () => get<T.AgeingResponse>("/api/analytics/ageing"),
  notPickedUp: (days: number) => get<T.NotPickedUpResponse>("/api/analytics/not-picked-up", { days: String(days) }),
  sales: (from?: string, to?: string) => get<T.SalesResponse>("/api/analytics/sales", { from, to }),
  allocationsByDay: (from?: string, to?: string) => get<T.AllocationsByDayResponse>("/api/analytics/allocations", { from, to }),
  stockByDay: (from?: string, to?: string) => get<T.StockByDayResponse>("/api/analytics/stock-days", { from, to }),

  // ---- the two DMS files and the end of day
  /** One step of loading a DMS file. The caller repeats it with `continue` while the answer says `more`. */
  uploadDms: (kind: "stock" | "bookings", file: File, opts: { report_date?: string; mode?: "COMPLETE" | "PARTIAL"; confirm_missing?: boolean; continue?: string }) => {
    const form = new FormData();
    form.set("file", file, file.name);
    if (opts.report_date) form.set("report_date", opts.report_date);
    if (opts.mode) form.set("mode", opts.mode);
    if (opts.confirm_missing) form.set("confirm_missing", "1");
    if (opts.continue) form.set("continue", opts.continue);
    return upload<T.DmsUploadResult>(`/api/uploads/${kind}`, form);
  },
  uploads: () => get<T.UploadsResponse>("/api/uploads"),
  eodStatus: () => get<T.EodStatus>("/api/eod/status"),
  createEodKey: () => post<{ key: string; set_at: string }>("/api/eod/key"),
  removeEodKey: () => del<Ok>("/api/eod/key"),

  // ---- day-end reconciliation
  reconRuns: () => get<T.ReconRunRow[]>("/api/recon/runs"),
  reconRun: (id: string) => get<T.ReconRunDetail>(`/api/recon/runs/${enc(id)}`),
  reconCsvUrl: (id: string) => `/api/recon/runs/${enc(id)}?format=csv`,
  runRecon: () => post<{ run_id: string; summary: T.ReconSummary }>("/api/recon/run"),
  resolveReconItem: (id: string, note: string) => post<Ok>(`/api/recon/items/${enc(id)}/resolve`, { note }),

  // ---- vehicle master
  master: () => get<T.MasterResponse>("/api/master"),
  updateVariant: (id: string, p: T.VariantPatch) => patch<T.MasterVariant>(`/api/master/variants/${enc(id)}`, p),
  masterExportUrl: "/api/master/export",
  uploadMaster: (file: File) => {
    const form = new FormData();
    form.set("file", file, file.name);
    return upload<T.MasterUploadResult>("/api/uploads/master", form);
  },
  mapColour: (model: string, alias: string, colour: string) => post<{ id: string; recoloured: { cars: number; bookings: number } | null }>("/api/master/names", { kind: "COLOUR", model, alias, colour }),
  removeName: (id: string) => del<Ok>(`/api/master/names/${enc(id)}`),

  // ---- WhatsApp
  waConfig: () => get<T.WaConfig>("/api/wa/config"),
  saveWaConfig: (c: T.WaConfigInput) => put<T.WaConfig>("/api/wa/config", c),
  waTemplates: () => get<T.WaTemplate[]>("/api/wa/templates"),
  saveWaTemplate: (key: string, t: { body?: string; template_name?: string; language?: string; enabled?: boolean }) => put<Ok>(`/api/wa/templates/${enc(key)}`, t),
  submitWaTemplate: (key: string) => post<{ status: string }>(`/api/wa/templates/${enc(key)}/submit`),
  refreshWaTemplates: () => post<Record<string, string>>("/api/wa/templates/refresh"),
  waTest: (to: string, eventKey: string) => post<T.WaTestResult>("/api/wa/test", { to, event_key: eventKey }),
  waMessages: (q: Query) => get<{ messages: T.WaMessage[]; counts: { status: T.WaStatus; n: number }[] }>("/api/wa/messages", q),
  retryWaMessage: (id: string) => post<{ id: string; status: T.WaStatus; error: string | null }>(`/api/wa/messages/${enc(id)}/retry`),
  waInbound: () => get<T.WaInbound[]>("/api/wa/inbound"),

  // ---- administration
  outlets: () => get<T.Outlet[]>("/api/outlets"),
  createOutlet: (o: { code: string; name: string; city?: string; address?: string }) => post<{ id: string }>("/api/outlets", o),
  updateOutlet: (id: string, o: { name?: string; city?: string; address?: string; is_active?: boolean }) => patch<Ok>(`/api/outlets/${enc(id)}`, o),
  users: () => get<T.UserRow[]>("/api/users"),
  directory: () => get<T.DirectoryUser[]>("/api/users/directory"),
  createUser: (u: T.UserInput) => post<{ id: string }>("/api/users", u),
  updateUser: (id: string, u: T.UserInput) => patch<Ok>(`/api/users/${enc(id)}`, u),
  resetUserPassword: (id: string) => post<{ temporary_password: string }>(`/api/users/${enc(id)}/reset-password`),
  employeeTemplateUrl: "/api/users/template",
  importEmployees: (file: File) => {
    const form = new FormData();
    form.set("file", file, file.name);
    return upload<T.EmployeeImportResult>("/api/users/import", form);
  },
  roles: () => get<T.RolesResponse>("/api/roles"),
  settings: () => get<T.SettingsResponse>("/api/settings"),
  saveSettings: (s: Partial<T.TenantSettings>) => put<{ settings: T.TenantSettings; rules_changed: string[] }>("/api/settings", s),
  previewSettings: (s: Partial<T.TenantSettings>) => post<T.RulesPreview>("/api/settings/preview", s),

  // ---- audit trail
  audit: (q: Query) => get<T.AuditRow[]>("/api/audit", q),
};

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error && e.message) return e.message;
  return "Something went wrong. Please try again.";
}
