import { Hono } from "hono";
import type { Env } from "./env";
import { HttpError } from "./lib/util";
import { clock, type Vars } from "./http/app";
import { authRoutes } from "./http/routes-auth";
import { bookingRoutes } from "./http/routes-bookings";
import { eodFeedRoutes, eodRoutes } from "./http/routes-eod";
import { masterRoutes } from "./http/routes-master";
import { opsRoutes } from "./http/routes-ops";
import { platformRoutes } from "./http/routes-platform";
import { stockRoutes } from "./http/routes-stock";
import { runScheduled } from "./scheduled";
import { flush, flushDue, instrumentEnv, pruneStmts, recordCron, recordError, recordRequest, routePattern, withTally } from "./lib/health";
import { iso, newId } from "./lib/util";

export function createApp() {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      if (err.status >= 500) recordError({ now: clock.now(), source: "HTTP", route: routePattern(c.req.method, new URL(c.req.url).pathname), status: err.status, code: err.code, message: err.message });
      return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
    }
    console.error(err);
    recordError({ now: clock.now(), source: "HTTP", route: routePattern(c.req.method, new URL(c.req.url).pathname), status: 500, code: "INTERNAL", message: (err as Error)?.message ?? String(err) });
    return c.json({ error: { code: "INTERNAL", message: "Something went wrong. Please try again." } }, 500);
  });

  // Counts every request for the System health page: how it ended, how long it took, and what it cost
  // the database. Nothing is written here; the totals go out in one batch a minute, after the response.
  app.use("*", async (c, next) => {
    instrumentEnv(c.env);
    const started = Date.now();
    const now = clock.now();
    let failed: unknown = null;
    const { db } = await withTally(async () => {
      try {
        await next();
      } catch (e) {
        failed = e;
      }
    });
    const status = failed ? (failed instanceof HttpError ? failed.status : 500) : c.res.status;
    recordRequest({ now, path: new URL(c.req.url).pathname, status, ms: Date.now() - started, db, colo: ((c.req.raw as { cf?: { colo?: string } }).cf?.colo as string | undefined) ?? null });
    if (flushDue(now)) {
      try {
        c.executionCtx.waitUntil(flush(c.env, now));
      } catch {
        // No execution context (a test harness without one): the next request or the scheduled job writes it.
      }
    }
    if (failed) throw failed;
  });

  // Browsers only send the session cookie on same-site requests (SameSite=Lax); requiring JSON or a form
  // upload on every state-changing call closes the remaining cross-site form-post route.
  app.use("/api/*", async (c, next) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method)) {
      const type = c.req.header("Content-Type") ?? "";
      const path = new URL(c.req.url).pathname;
      const hasBody = Number(c.req.header("Content-Length") ?? "0") > 0 || type !== "";
      // A DMS export may be sent as the request body itself. A cross-site form cannot produce these content types.
      const feed = /^\/api\/eod\/[^/]+\/(stock|bookings|run)$/.test(path);
      const fileBody = (path.startsWith("/api/uploads/") || path === "/api/users/import" || feed) && /^(application\/octet-stream|application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet)/.test(type);
      if (hasBody && !fileBody && !path.startsWith("/api/wa/webhook") && !/^(application\/json|multipart\/form-data|text\/csv|text\/plain)/.test(type)) {
        throw new HttpError(415, "Unsupported content type", "UNSUPPORTED_MEDIA_TYPE");
      }
      const origin = c.req.header("Origin");
      if (origin && new URL(origin).host !== new URL(c.req.url).host && !path.startsWith("/api/wa/webhook") && !path.startsWith("/api/platform/") && !feed) {
        throw new HttpError(403, "Cross-site request refused", "FORBIDDEN");
      }
    }
    await next();
  });

  // Digital Asset Links: lets the Android app (a Trusted Web Activity) open this site without the browser's bar.
  app.get("/.well-known/assetlinks.json", (c) => {
    const prints = (c.env.ANDROID_CERT_SHA256 ?? "").split(",").map((x) => x.trim().toUpperCase()).filter(Boolean);
    if (!prints.length) return c.json([], 404);
    return c.json([{ relation: ["delegate_permission/common.handle_all_urls"], target: { namespace: "android_app", package_name: "com.jbrconsulting.vineeti", sha256_cert_fingerprints: prints } }]);
  });

  platformRoutes(app); // the platform console: its own sign-in, no dealership data
  eodFeedRoutes(app); // the end-of-day feed proves itself with the dealership's key, not a sign-in
  authRoutes(app); // registers the authentication guard for everything after it
  eodRoutes(app);
  opsRoutes(app);
  masterRoutes(app);
  stockRoutes(app);
  bookingRoutes(app);

  app.all("/api/*", (c) => c.json({ error: { code: "NOT_FOUND", message: "Not found" } }, 404));
  // Anything else is the web app (served from static assets in production).
  app.all("*", (c) => (c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.text("Web app not built", 404)));
  return app;
}

/**
 * The scheduled job, with its firing recorded for the System health page: when, how long, what each
 * dealership reported, and whether anything failed. Once a day it also removes health rows past their keep.
 */
export async function runScheduledWithHealth(env: Env, now: Date) {
  instrumentEnv(env);
  const started = Date.now();
  let reports: Awaited<ReturnType<typeof runScheduled>> = [];
  let failure: string | null = null;
  const { db } = await withTally(async () => {
    try {
      reports = await runScheduled(env, now);
    } catch (e) {
      failure = (e as Error)?.message ?? String(e);
      console.error("scheduled job failed:", e);
    }
  });
  const ms = Date.now() - started;
  const errors = reports.filter((r) => r.error).length + (failure ? 1 : 0);
  recordCron(now, ms, errors === 0, db);
  if (failure) recordError({ now, source: "CRON", route: "scheduled", message: failure });
  for (const r of reports) if (r.error) recordError({ now, source: "CRON", route: `scheduled ${r.tenant}`, message: r.error });
  const stmts = [
    env.DB.prepare(`INSERT INTO health_cron_runs (id, started_at, finished_at, duration_ms, ok, tenants, errors, report_json) VALUES (?,?,?,?,?,?,?,?)`).bind(
      newId("run"), iso(now), iso(new Date(now.getTime() + ms)), ms, errors === 0 ? 1 : 0, reports.length, errors, JSON.stringify(failure ? [{ tenant: "*", error: failure }, ...reports] : reports),
    ),
    // Once a day, in the quiet hours (around 01:30 IST): rows past their keep go.
    ...(now.getUTCHours() === 20 && now.getUTCMinutes() < 15 ? pruneStmts(env, now) : []),
  ];
  try {
    await env.DB.batch(stmts);
    await flush(env, now, true);
  } catch (e) {
    console.error("health record failed:", e);
  }
  if (failure) throw new Error(failure);
  return reports;
}

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduledWithHealth(env, clock.now()));
  },
} satisfies ExportedHandler<Env>;
