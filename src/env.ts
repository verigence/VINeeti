import type { TenantSettings } from "./lib/settings";

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  APP_NAME?: string;
  WA_GRAPH_VERSION?: string;
  /** Set by the deployment (scripts/deploy.mjs): the commit deployed and when. Shown on the platform console's System health page. */
  APP_VERSION?: string;
  APP_DEPLOYED_AT?: string;
  /** Signs login sessions. */
  SESSION_SECRET: string;
  /** Encrypts stored WhatsApp credentials. */
  DATA_KEY: string;
  /** Bearer token for onboarding new dealerships. */
  PLATFORM_ADMIN_TOKEN: string;
  /** Optional: one webhook verify token / app secret shared by all dealers on JBR's own Meta app. */
  WA_VERIFY_TOKEN?: string;
  WA_APP_SECRET?: string;
  /** Optional: SHA-256 fingerprint(s) of the Android app's signing certificate, comma-separated, so the app may open the site full screen. */
  ANDROID_CERT_SHA256?: string;
  /**
   * The mail account the deployment sends from: the dealership group's own, the same one the HR
   * service uses. The app password is a Worker secret. Unset, nothing is emailed and a temporary
   * password is shown on screen instead, as before.
   */
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_USER?: string;
  SMTP_PASSWORD?: string;
  SMTP_FROM?: string;
  /** Where people sign in, for the links in those messages. Written by the deployment. */
  APP_URL?: string;
  /**
   * The Verigence platform. Documents uploaded by a sales consultant are read by Document Intelligence
   * there rather than here: it holds the extraction schemas for a booking form and a payment receipt,
   * and it keeps the files. Left unset, document upload is simply not offered and everything else in
   * VINeeti works as before.
   */
  SECURITY_BASE_URL?: string;
  DI_BASE_URL?: string;
  AUDIT_CORE_BASE_URL?: string;
  /** VINeeti's own machine identity on the platform. The secret is a Worker secret, never in code. */
  VERIGENCE_CLIENT_ID?: string;
  VERIGENCE_CLIENT_SECRET?: string;
}

export type Role =
  | "ADMIN"
  | "DEALER_PRINCIPAL"
  | "CEO_VP"
  | "GM_SALES"
  | "AGM_SALES"
  | "SALES_LEAD"
  | "SALES_CONSULTANT"
  | "EDP_MANAGER"
  | "FINANCE"
  | "AUDITOR";

export interface TenantRow {
  id: string;
  slug: string;
  name: string;
  oem: string;
  timezone: string;
  settings_json: string;
  is_active: number;
}

export interface SessionUser {
  id: string;
  name: string;
  mobile: string;
  role: Role;
  allOutlets: boolean;
  outletIds: string[];
  /** The vehicle segments (master categories) the person works with; empty means every segment. */
  segments: string[];
  mustChangePassword: boolean;
}

/** Everything a piece of business logic needs. Always bound to exactly one tenant. */
export interface Ctx {
  db: D1Database;
  env: Env;
  tenant: TenantRow;
  tenantId: string;
  settings: TenantSettings;
  /** Injected clock so timers and tests are deterministic. */
  now: Date;
  /** User id, 'SYSTEM' or 'UPLOAD:<id>'. */
  actor: string;
  /** Lookups that do not change within one request (outlet names, WhatsApp settings and templates). */
  cache: Map<string, unknown>;
  /** Set when messages were queued, so the caller sends them once after the work is done. */
  flags: { dispatch: boolean };
}
