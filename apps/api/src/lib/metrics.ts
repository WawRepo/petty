import http from "node:http";
import type { FastifyInstance, FastifyRequest } from "fastify";
import client from "prom-client";
import { apiPool, maintPool } from "../db.js";
import { safeUrl } from "./tracing.js";

/**
 * Prometheus metrics (Phase 15b). Served on a SEPARATE port, never through the
 * app's ingress: the deployment annotates the pod and Alloy scrapes it inside
 * the cluster. Labels are bounded by construction — route templates, not URLs;
 * event names, not ids — because nothing downstream can drop a label once pushed.
 * No label ever carries content, an email, or a user id (CLAUDE.md rule 2).
 */
export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const httpDuration = new client.Histogram({
  name: "petty_http_request_duration_seconds",
  help: "API request latency by route template and status code",
  labelNames: ["method", "route", "status"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const authEvents = new client.Counter({
  name: "petty_auth_events_total",
  help: "Sign-in flow events: login_ok, login_fail, rate_limited, signup, forgot, reset, logout",
  labelNames: ["event"] as const,
  registers: [registry],
});

export const entriesAppended = new client.Counter({
  name: "petty_entries_total",
  help: "Entry appends by result: created (new row) or duplicate (idempotent replay)",
  labelNames: ["result"] as const,
  registers: [registry],
});

export const rotationsStarted = new client.Counter({
  name: "petty_rotations_started_total",
  help: "Drawer key rotations started",
  registers: [registry],
});

export const mailsSent = new client.Counter({
  name: "petty_mail_total",
  help: "Notification emails handed to SMTP, by result",
  labelNames: ["result"] as const,
  registers: [registry],
});

new client.Gauge({
  name: "petty_pg_pool_clients",
  help: "pg pool clients by pool (api, maint) and state (total, idle, waiting)",
  labelNames: ["pool", "state"] as const,
  registers: [registry],
  collect() {
    for (const [name, pool] of [["api", apiPool], ["maint", maintPool]] as const) {
      this.set({ pool: name, state: "total" }, pool.totalCount);
      this.set({ pool: name, state: "idle" }, pool.idleCount);
      this.set({ pool: name, state: "waiting" }, pool.waitingCount);
    }
  },
});

/**
 * Usage, for the story of who uses Petty (PETTY-35): aggregate counts from the
 * database, refreshed at most every 30 s, on scrape. Never a per-user series.
 * "Active" = a session that made a request in the window (sessions.last_seen_at
 * is touched at most every 5 minutes, so "15m" really means 15-20 minutes).
 */
interface Usage { users_total: number; active_15m: number; active_24h: number; active_7d: number; sessions_open: number; drawers_total: number; drawers_shared: number; entries_stored: number }
let usageCache: { at: number; value: Promise<Usage | null> } | null = null;
export function usageSnapshot(): Promise<Usage | null> {
  const now = Date.now();
  if (usageCache && now - usageCache.at < 30_000) return usageCache.value;
  const value = apiPool.query<Record<keyof Usage, string>>(`
    select (select count(*) from users where deleted_at is null)                                                                  as users_total,
           (select count(distinct user_id) from sessions where expires_at > now() and last_seen_at > now() - interval '15 minutes') as active_15m,
           (select count(distinct user_id) from sessions where expires_at > now() and last_seen_at > now() - interval '24 hours')   as active_24h,
           (select count(distinct user_id) from sessions where expires_at > now() and last_seen_at > now() - interval '7 days')     as active_7d,
           (select count(*) from sessions where expires_at > now())                                                                as sessions_open,
           (select count(*) from drawers)                                                                                          as drawers_total,
           (select count(distinct drawer_id) from drawer_members)                                                                  as drawers_shared,
           (select count(*) from entries)                                                                                          as entries_stored`)
    .then((r) => { const row = r.rows[0]!; const out = {} as Usage; for (const k of Object.keys(row) as (keyof Usage)[]) out[k] = Number(row[k]); return out; })
    .catch(() => null);
  usageCache = { at: now, value };
  return value;
}

// prom-client collects every metric IN PARALLEL on a scrape (Promise.all over
// get()), so a single collector on one gauge leaves the others a scrape behind.
// Each usage gauge therefore awaits the same cached snapshot (one query per 30 s).
function usageGauge(name: string, help: string, pick: (u: Usage) => number): void {
  const g = new client.Gauge({ name, help, registers: [registry], async collect() { const u = await usageSnapshot(); if (u) g.set(pick(u)); } });
}
usageGauge("petty_users_total", "Accounts that exist (not deleted)", (u) => u.users_total);
usageGauge("petty_sessions_open", "Unexpired sessions (signed-in devices)", (u) => u.sessions_open);
usageGauge("petty_drawers_total", "Drawers that exist", (u) => u.drawers_total);
usageGauge("petty_drawers_shared", "Drawers with at least one member besides the owner", (u) => u.drawers_shared);
usageGauge("petty_entries_stored", "Entry rows in the ledger (all drawers, all time)", (u) => u.entries_stored);
const usersActive = new client.Gauge({
  name: "petty_users_active", help: "Distinct users with a request in the window (15m, 24h, 7d)", labelNames: ["window"] as const, registers: [registry],
  async collect() {
    const u = await usageSnapshot();
    if (!u) return;
    usersActive.set({ window: "15m" }, u.active_15m);
    usersActive.set({ window: "24h" }, u.active_24h);
    usersActive.set({ window: "7d" }, u.active_7d);
  },
});

/** Route label: the matched template under the API prefix; everything else is one bucket. */
export function routeLabel(req: FastifyRequest, apiPrefix: string): string {
  const tpl = req.routeOptions.url;
  if (!tpl) return req.url.startsWith(`${apiPrefix || "/api"}/`) ? "unmatched" : "spa";
  if (!apiPrefix || tpl.startsWith(`${apiPrefix}/`)) return tpl;
  return "static";
}

const HEALTH = /\/health$/;

/**
 * One metrics observation and ONE log line per request, on completion.
 * Replaces Fastify's two-line default. Health probes are measured but not logged:
 * three probes every few seconds would be most of the log volume and say nothing.
 */
export function requestMetrics(app: FastifyInstance, apiPrefix: string): void {
  app.addHook("onResponse", async (req, reply) => {
    const route = routeLabel(req, apiPrefix);
    const ms = reply.elapsedTime;
    httpDuration.observe({ method: req.method, route, status: String(reply.statusCode) }, ms / 1000);
    if (HEALTH.test(req.url) && reply.statusCode < 500) return;
    req.log.info({ method: req.method, route, url: safeUrl(req), status: reply.statusCode, ms: Math.round(ms * 10) / 10, user: req.user?.id ?? null }, "request");
  });
}

/** Plain http server for /metrics. Port 0 picks a free port (tests). */
export function startMetricsServer(port: number, host: string): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    if (req.method !== "GET" || req.url !== "/metrics") { res.writeHead(404).end(); return; }
    try {
      const body = await registry.metrics();
      res.writeHead(200, { "content-type": registry.contentType }).end(body);
    } catch {
      res.writeHead(500).end();
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}
