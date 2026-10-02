/**
 * OTLP push (PETTY-92): metrics and logs leave the process over OTLP/HTTP when enabled, and stay off
 * otherwise. Proves the pipeline against a mock collector — the same wire an OpenTelemetry collector
 * (Grafana Alloy, Grafana Cloud) receives. Runs in its own file so the global OTel providers it sets do not leak into other tests.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { metrics } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { otelResource } from "../src/lib/otel-resource.js";
import { startOtlpMetrics, startOtlpLogs, flushOtlpPush, stopOtlpPush } from "../src/lib/otel-push.js";

const hits = new Map<string, number>();
let server: http.Server;
let endpoint = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.set(req.url ?? "?", (hits.get(req.url ?? "?") ?? 0) + 1);
    req.on("data", () => {});
    req.on("end", () => res.writeHead(200).end());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => { await stopOtlpPush(); server.close(); });

describe("otlp push", () => {
  it("is off without an endpoint", () => {
    const resource = otelResource("test", "public");
    expect(startOtlpMetrics({ endpoint: "", resource })).toBe(false);
    expect(startOtlpLogs({ endpoint: "", resource })).toBe(false);
  });

  it("pushes metrics and logs over OTLP when enabled", async () => {
    const resource = otelResource("test", "public");
    expect(startOtlpMetrics({ endpoint, resource, intervalMs: 200 })).toBe(true);
    expect(startOtlpLogs({ endpoint, resource })).toBe(true);

    metrics.getMeter("petty").createCounter("petty_auth_events_total").add(1, { event: "login_ok" });
    logs.getLogger("petty").emit({ body: "request", attributes: { traceId: "abc123" } });

    await new Promise((r) => setTimeout(r, 400));
    await flushOtlpPush();
    await new Promise((r) => setTimeout(r, 200));
    expect(hits.get("/v1/metrics") ?? 0).toBeGreaterThan(0);
    expect(hits.get("/v1/logs") ?? 0).toBeGreaterThan(0);
  });
});
