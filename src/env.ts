import type { TenantSettings } from "./lib/settings";

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  APP_NAME?: string;
  WA_GRAPH_VERSION?: string;
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
}

export type Role =
  | "ADMIN"
  | "DEALER_PRINCIPAL"
  | "BUSINESS_HEAD"
  | "SALES_MANAGER"
  | "SALES_EXEC"
  | "STOCK_INCHARGE"
  | "ORDERING"
  | "ACCOUNTS"
  | "CRM"
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
