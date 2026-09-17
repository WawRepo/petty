import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { buildApp } from "../src/app.js";
import { registry, startMetricsServer } from "../src/lib/metrics.js";

const app = buildApp();
let metrics: Server;
beforeAll(async () => { await app.ready(); metrics = await startMetricsServer(0, "127.0.0.1"); });
afterAll(async () => { await app.close(); metrics.close(); });

describe("metrics (Phase 15b)", () => {
  it("records every request under its route template, never its URL", async () => {
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/drawers/not-a-real-id" })).statusCode).toBe(401);
    const text = await registry.metrics();
    // The FIRST scrape already carries every usage gauge: each one awaits the shared snapshot.
    expect(text).toMatch(/petty_users_total \d+/);
    expect(text).toMatch(/petty_users_active\{window="7d"\} \d+/);
    expect(text).toMatch(/petty_entries_stored \d+/);
    expect(text).toMatch(/petty_http_request_duration_seconds_count\{method="GET",route="\/health",status="200"\} \d+/);
    expect(text).toMatch(/petty_http_request_duration_seconds_count\{method="GET",route="\/drawers\/:id",status="401"\} \d+/);
    expect(text).not.toContain("not-a-real-id");
  });

  it("serves /metrics on its own port and nothing else", async () => {
    const port = (metrics.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("process_cpu_seconds_total");
    expect(body).toContain('petty_pg_pool_clients{pool="api",state="total"}');

    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(404);
  });
});

describe("what may appear in a log line (SR-1)", () => {
  it("reports SPA paths by their first segment only, and API token routes by their template", async () => {
    const { safeUrl } = await import("../src/lib/tracing.js");
    const fake = (url: string, tpl?: string) => ({ url, routeOptions: { url: tpl } }) as unknown as import("fastify").FastifyRequest;
    expect(safeUrl(fake("/join/SECRET-JOIN-TOKEN-123"))).toBe("/join/…");
    expect(safeUrl(fake("/reset/SECRET-RESET-TOKEN?x=1"))).toBe("/reset/…");
    expect(safeUrl(fake("/"))).toBe("/");
    expect(safeUrl(fake("/drawers/abc"))).toBe("/drawers/…");
    expect(safeUrl(fake("/join-links/SECRET", "/join-links/:token"))).toBe("/join-links/:token");
    expect(safeUrl(fake("/drawers/0d1/entries", "/drawers/:id/entries"))).toBe("/drawers/0d1/entries");
  });
});
