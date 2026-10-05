import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { buildApp } from "../src/app.js";
import { apiPool, maintPool } from "../src/db.js";
import { Client, makeJoinLink, userMaterial } from "../src/devtools/fixtures.js";
import { registry, startMetricsServer } from "../src/lib/metrics.js";

const app = buildApp();
let metrics: Server;
beforeAll(async () => { await app.ready(); metrics = await startMetricsServer(0, "127.0.0.1"); });
afterAll(async () => { await app.close(); metrics.close(); await apiPool.end(); await maintPool.end(); });

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

  it("counts a refusal that normal use never triggers by its code, and an ordinary refusal not at all (PETTY-266)", async () => {
    const run = crypto.randomUUID().slice(0, 8);
    const A = new Client(app, await userMaterial("sec", { email: `sec-${run}@test.local` }));
    const other = await userMaterial("sec2", { email: `sec2-${run}@test.local` });
    expect((await A.signup(await makeJoinLink())).statusCode).toBe(201);
    const { id } = await A.createDrawer("Probe");
    const count = async () => Number(/petty_security_refusals_total\{code="CustodyProofInvalid"\} (\d+)/.exec(await registry.metrics())?.[1] ?? 0);
    const before = await count();
    // a custody proof signed with someone else's key: forged, never a slip of the hand
    expect((await A.call("DELETE", `/drawers/${id}`, { proof: await A.proof(other.keys.ecdsa.privateKey) })).json().code).toBe("CustodyProofInvalid");
    expect(await count()).toBe(before + 1);
    // an ordinary refusal (no proof at all) is not counted as a security refusal
    expect((await A.call("DELETE", `/drawers/${id}`)).statusCode).toBe(400);
    expect(await count()).toBe(before + 1);
    expect(await registry.metrics()).not.toContain(`sec-${run}`); // no email or id in a label
  });

  it("reports the process's resident memory under its own name (PETTY-267)", async () => {
    expect(await registry.metrics()).toMatch(/petty_process_resident_memory_bytes [1-9]\d+/);
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
