import { Hono } from "hono";
import type { Env } from "./env";
import { HttpError } from "./lib/util";
import { clock, type Vars } from "./http/app";
import { authRoutes } from "./http/routes-auth";
import { bookingRoutes } from "./http/routes-bookings";
import { eodFeedRoutes, eodRoutes } from "./http/routes-eod";
import { masterRoutes } from "./http/routes-master";
import { opsRoutes } from "./http/routes-ops";
import { stockRoutes } from "./http/routes-stock";
import { runScheduled } from "./scheduled";

export function createApp() {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
    console.error(err);
    return c.json({ error: { code: "INTERNAL", message: "Something went wrong. Please try again." } }, 500);
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

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(env, clock.now()));
  },
} satisfies ExportedHandler<Env>;
