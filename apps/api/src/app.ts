import { AuthConfig } from "@petty/protocol";
import path from "node:path";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { config } from "./config.js";
import type { HealthResponse } from "@petty/protocol";
import { ZodError } from "zod";
import { dbIsUp } from "./db.js";
import { ApiError, notFound } from "./lib/errors.js";
import { sessionPlugin } from "./lib/session.js";
import { securityHeaders } from "./lib/headers.js";
import { requestMetrics } from "./lib/metrics.js";
import { safeUrl, tracingHooks } from "./lib/tracing.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { drawerRoutes } from "./routes/drawers.js";
import { entryRoutes } from "./routes/entries.js";
import { meRoutes } from "./routes/me.js";
import { tokenRoutes } from "./routes/tokens.js";
import { rotationRoutes } from "./routes/rotation.js";
import { sharingRoutes } from "./routes/sharing.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ENTRY = /(?:^|\/)(index\.html|sw\.js|registerSW\.js|manifest\.webmanifest)$/;
/** Cache-Control for a file under the web dist, by its on-disk path (a .br/.gz twin counts as the original). */
export function staticCacheControl(filePath: string): string {
  const plain = filePath.replace(/\.(br|gz)$/, "");
  if (ENTRY.test(plain)) return "no-cache";
  if (plain.includes(`${path.sep}assets${path.sep}`)) return "public, max-age=31536000, immutable";
  // PETTY-144: the landing captures keep their names across deploys; the browser must ask (etag) every time.
  if (plain.includes(`${path.sep}landing${path.sep}`)) return "no-cache";
  return "public, max-age=3600";
}

export function buildApp() {
  const app = Fastify({
    // Error class + ids only, never bodies (CLAUDE.md rule 2). Phase 13 tightens further.
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      redact: ["req.headers.cookie", "req.headers.authorization"],
      // "level":"error" instead of 50, so Loki's level detection and `| json | level="error"` work.
      formatters: { level: (label) => ({ level: label }) },
    },
    // One "request" line per request from lib/metrics.ts instead of Fastify's incoming/completed pair.
    disableRequestLogging: true,
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: config.trustProxy,
  });

  app.register(cookie);
  tracingHooks(app);
  app.register(sessionPlugin);
  requestMetrics(app, config.apiPrefix);
  securityHeaders(app, { hsts: config.secureCookies });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.status).send({ code: err.code, message: err.message, context: err.context });
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({ code: "ValidationError", message: "request body is not valid", context: { path: err.issues[0]?.path.join(".") ?? null } });
    }
    const e = err as { statusCode?: number; code?: string };
    if (e.statusCode && e.statusCode < 500) {
      return reply.code(e.statusCode).send({ code: e.code ?? "BadRequest", message: "request rejected" });
    }
    req.log.error({ err: { name: (err as Error).name, code: e.code ?? null }, url: safeUrl(req) }, "unhandled");
    return reply.code(500).send({ code: "Internal", message: "internal error" });
  });

  const api = async (a: FastifyInstance) => {
    // API answers are per-session and must never sit in a shared or disk cache (SR-13).
    a.addHook("onSend", async (_req, reply) => { reply.header("Cache-Control", "no-store"); });
    // PETTY-193 (review NR-13): every :id, :lineId and :userId is a UUID. Anything else is a plain
    // 404 here, before a handler hands it to Postgres (which answered 500 for a malformed uuid).
    a.addHook("preValidation", async (req) => {
      if (!req.user) return; // not signed in: the handler answers 401 first
      const params = req.params as Record<string, string> | undefined;
      for (const k of ["id", "lineId", "userId"]) {
        const v = params?.[k];
        if (v !== undefined && !UUID.test(v)) throw notFound();
      }
    });
    // Readiness: 503 while the database is unreachable, so the ingress does not route to a pod that
    // cannot serve (some orchestrators admit a new pod to the network only seconds after it starts). Liveness
    // uses /health/live, which only says the process is up; a database outage must not restart the API.
    a.get("/health", async (_req, reply): Promise<HealthResponse> => {
      const up = await dbIsUp();
      if (!up) reply.code(503);
      return { ok: up, db: up ? "up" : "down" };
    });
    a.get("/health/live", async () => ({ ok: true }));
    // Public (PETTY-88): which identity provider the web app must use; one image serves both modes.
    a.get("/config", async () => AuthConfig.parse({ auth: config.authProvider, clerk_publishable_key: config.clerkPublishableKey || null, contact_email: config.contactEmail || null, open_signup: config.openSignup, version: config.version }));
    await a.register(authRoutes);
    await a.register(meRoutes);
    await a.register(tokenRoutes);
    await a.register(drawerRoutes);
    await a.register(entryRoutes);
    await a.register(sharingRoutes);
    await a.register(rotationRoutes);
    await a.register(adminRoutes);
  };
  app.register(api, { prefix: config.apiPrefix });

  // Production image: the same process serves the static web app, so the app and the API share one origin.
  if (config.webDist) {
    // Caching (PETTY-57): the shell, the service worker and the manifest must be re-validated on every
    // load so a deploy shows up at once; the hashed files under /assets/ never change and may live for a year.
    // With preCompressed the path handed to setHeaders is the file actually sent — index.html.br for a
    // browser that accepts brotli — so the suffix is stripped before the name is matched.
    app.register(fastifyStatic, {
      root: path.resolve(config.webDist), wildcard: false, preCompressed: true, cacheControl: false,
      setHeaders: (res, filePath) => { res.header("Cache-Control", staticCacheControl(filePath)); },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith(`${config.apiPrefix || "/api"}/`)) return reply.sendFile("index.html");
      return reply.code(404).send({ code: "NotFound", message: "not found" });
    });
  }
  return app;
}
