import http from "node:http";
import type { FastifyInstance, FastifyRequest } from "fastify";
import client from "prom-client";
import { metrics as otelApi } from "@opentelemetry/api";
import { apiPool, maintPool } from "../db.js";
import { isHealthProbe, safeUrl } from "./tracing.js";

/**
 * Metrics (Phase 15b, PETTY-92). Two paths from one definition:
 *  - a Prometheus registry served on a SEPARATE port (pull), for a scraper on the same network —
 *    unchanged, so an existing scrape stays byte-for-byte the same during the OTLP migration;
 *  - an OpenTelemetry mirror pushed over OTLP when `otlpPush` is on (lib/otel-push.ts), so an instance
 *    that nothing can scrape from outside (a platform-hosted one) still reports.
 * `dualCounter`/`dualHistogram` write both from one call, so the call sites never change. When OTLP is
 * off there is no MeterProvider, the OTel side is a no-op, and only the Prometheus path runs.
 *
 * Labels are bounded by construction — route templates, not URLs; event names, not ids — because nothing
 * downstream can drop a label once pushed. No label ever carries content, an email, or a user id (rule 2).
 */
export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

const meter = otelApi.getMeter("petty");
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

function dualCounter(name: string, help: string, labelNames: string[] = []) {
  const prom = new client.Counter({ name, help, labelNames, registers: [registry] });
  const otel = meter.createCounter(name, { description: help });
  // prom-client pre-initialises a label-free counter to 0, so the scrape shows a 0 series from the start.
  // The OTel SDK emits only on first record, so the same counter is No-data on the OTLP path until it
  // first fires — a panel or alert that reads the 0 then breaks after the scrape is retired. Emit 0 once
  // to match. Labeled counters create a series per label value on both paths, so only these need it.
  if (labelNames.length === 0) otel.add(0);
  return {
    inc(labels?: Record<string, string>): void {
      if (labels) { prom.inc(labels); otel.add(1, labels); } else { prom.inc(); otel.add(1); }
    },
  };
}

function dualHistogram(name: string, help: string, labelNames: string[], buckets: number[]) {
  const prom = new client.Histogram({ name, help, labelNames, buckets, registers: [registry] });
  const otel = meter.createHistogram(name, { description: help, unit: "s", advice: { explicitBucketBoundaries: buckets } });
  return {
    observe(labels: Record<string, string>, value: number): void { prom.observe(labels, value); otel.record(value, labels); },
  };
}

export const httpDuration = dualHistogram(
  "petty_http_request_duration_seconds",
  "API request latency by route template and status code",
  ["method", "route", "status"], BUCKETS,
);

export const authEvents = dualCounter(
  "petty_auth_events_total",
  "Sign-in flow events: login_ok, login_fail, rate_limited, signup, forgot, reset, logout, device_code, device_approved, device_denied", ["event"],
);

export const entriesAppended = dualCounter(
  "petty_entries_total",
  "Entry appends by result: created (new row) or duplicate (idempotent replay)", ["result"],
);

export const rotationsStarted = dualCounter("petty_rotations_started_total", "Drawer key rotations started");

export const mailsSent = dualCounter("petty_mail_total", "Notification emails handed to SMTP, by result", ["result"]);

export const securityRefusals = dualCounter(
  "petty_security_refusals_total",
  "Refusals that normal use never triggers (errors.ts SECURITY_REFUSALS), by error code", ["code"],
);

// pg pool occupancy: prom collects on scrape; OTel observes on its export interval. Same numbers, two readers.
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
// PETTY-267: resident memory on both paths. The scrape also has prom-client's process_resident_memory_bytes,
// but the OTLP push (an instance nothing can scrape) had no memory figure at all, so a memory alert was blind.
new client.Gauge({
  name: "petty_process_resident_memory_bytes",
  help: "Resident set size of the API process, in bytes",
  registers: [registry],
  collect() { this.set(process.memoryUsage.rss()); },
});
meter.createObservableGauge("petty_process_resident_memory_bytes", { description: "Resident set size of the API process, in bytes" })
  .addCallback((obs) => obs.observe(process.memoryUsage.rss()));

meter.createObservableGauge("petty_pg_pool_clients", { description: "pg pool clients by pool and state" }).addCallback((obs) => {
  for (const [name, pool] of [["api", apiPool], ["maint", maintPool]] as const) {
    obs.observe(pool.totalCount, { pool: name, state: "total" });
    obs.observe(pool.idleCount, { pool: name, state: "idle" });
    obs.observe(pool.waitingCount, { pool: name, state: "waiting" });
  }
});

/**
 * Usage, for the story of who uses Petty (PETTY-35): aggregate counts from the
 * database, refreshed at most every 30 s, on scrape. Never a per-user series.
 * "Active" = a user who made a request in the window (users.last_seen_at, PETTY-241: touched at most every
 * 5 minutes per user in both sign-in modes, so "15m" really means 15-20 minutes). "Sessions open" counts
 * Petty's own sign-in sessions, which exist in local mode only; under Clerk it stays 0.
 */
interface Usage { users_total: number; active_15m: number; active_24h: number; active_7d: number; sessions_open: number; drawers_total: number; drawers_shared: number; entries_stored: number }
let usageCache: { at: number; value: Promise<Usage | null> } | null = null;
export function usageSnapshot(): Promise<Usage | null> {
  const now = Date.now();
  if (usageCache && now - usageCache.at < 30_000) return usageCache.value;
  const value = apiPool.query<Record<keyof Usage, string>>(`
    select (select count(*) from users where deleted_at is null)                                                                  as users_total,
           (select count(*) from users where deleted_at is null and last_seen_at > now() - interval '15 minutes')                    as active_15m,
           (select count(*) from users where deleted_at is null and last_seen_at > now() - interval '24 hours')                      as active_24h,
           (select count(*) from users where deleted_at is null and last_seen_at > now() - interval '7 days')                        as active_7d,
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
// The OTel observable gauge shares that same cache, so adding it costs no extra query.
function usageGauge(name: string, help: string, pick: (u: Usage) => number): void {
  const g = new client.Gauge({ name, help, registers: [registry], async collect() { const u = await usageSnapshot(); if (u) g.set(pick(u)); } });
  meter.createObservableGauge(name, { description: help }).addCallback(async (obs) => { const u = await usageSnapshot(); if (u) obs.observe(pick(u)); });
}
usageGauge("petty_users_total", "Accounts that exist (not deleted)", (u) => u.users_total);
usageGauge("petty_sessions_open", "Unexpired local sign-in sessions (signed-in devices; local mode only, 0 under Clerk)", (u) => u.sessions_open);
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
meter.createObservableGauge("petty_users_active", { description: "Distinct users with a request in the window (15m, 24h, 7d)" }).addCallback(async (obs) => {
  const u = await usageSnapshot();
  if (!u) return;
  obs.observe(u.active_15m, { window: "15m" });
  obs.observe(u.active_24h, { window: "24h" });
  obs.observe(u.active_7d, { window: "7d" });
});

/** Route label: the matched template under the API prefix; everything else is one bucket. */
export function routeLabel(req: FastifyRequest, apiPrefix: string): string {
  const tpl = req.routeOptions.url;
  if (!tpl) return req.url.startsWith(`${apiPrefix || "/api"}/`) ? "unmatched" : "spa";
  if (!apiPrefix || tpl.startsWith(`${apiPrefix}/`)) return tpl;
  return "static";
}

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
    if (isHealthProbe(req.url) && reply.statusCode < 500) return;
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
