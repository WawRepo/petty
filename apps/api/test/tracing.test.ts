import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { startTracing, stopTracing } from "../src/lib/tracing.js";

// Tracing must be set up BEFORE Fastify is loaded (it patches node:http), exactly as index.ts does.
const exporter = new InMemorySpanExporter();
startTracing({ exporter, apiPrefix: "" });
const { buildApp } = await import("../src/app.js");

const app = buildApp();
let base = "";
beforeAll(async () => { await app.listen({ port: 0, host: "127.0.0.1" }); base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`; });
afterAll(async () => { await app.close(); await stopTracing(); });

describe("traces (PETTY-34)", () => {
  it("one server span per API request, named after the route template, with a pg child span", async () => {
    exporter.reset();
    const res = await fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "nobody@test.local", password: "wrong-password" }) });
    expect(res.status).toBe(401);
    const spans = exporter.getFinishedSpans();
    const server = spans.find((s) => s.name === "POST /auth/login");
    expect(server, JSON.stringify(spans.map((s) => s.name))).toBeDefined();
    expect(server!.attributes["http.route"]).toBe("/auth/login");
    const pgSpans = spans.filter((s) => s.name.startsWith("pg ") && s.parentSpanContext?.spanId === server!.spanContext().spanId);
    expect(pgSpans.length).toBeGreaterThan(0);
    expect(String(pgSpans[0]!.attributes["db.statement"])).toMatch(/^select/i);
    // Never the values: the email is a bound parameter, not part of any attribute.
    expect(JSON.stringify(spans.map((s) => s.attributes))).not.toContain("nobody@test.local");
  });

  it("a secret in the URL path is reported as the route template", async () => {
    exporter.reset();
    const res = await fetch(`${base}/join-links/not-a-real-token-abc123`);
    expect(res.status).toBeLessThan(500);
    const server = exporter.getFinishedSpans().find((s) => s.name === "GET /join-links/:token");
    expect(server).toBeDefined();
    expect(JSON.stringify(server!.attributes)).not.toContain("not-a-real-token");
    expect(server!.attributes["url.path"]).toBe("/join-links/:token");
  });

  it("health probes are not traced", async () => {
    exporter.reset();
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect(exporter.getFinishedSpans().filter((s) => s.kind === 1 /* SERVER */)).toEqual([]);
  });
});
