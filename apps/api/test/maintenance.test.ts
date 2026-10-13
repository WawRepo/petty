import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { apiPool, bgPool, lastRequestUse, maintPool } from "../src/db.js";
import { maintenanceDue, runMaintenance } from "../src/lib/maintenance.js";
import { usageSnapshot } from "../src/lib/metrics.js";

const app = buildApp();
beforeAll(async () => { await app.ready(); });
afterAll(async () => { vi.useRealTimers(); await app.close(); await apiPool.end(); await maintPool.end(); await bgPool.end(); });

const H = 60 * 60_000;

/** PETTY-355: a database that scales to zero sleeps only if nothing queries it; the API must not poll it awake. */
describe("the API lets an idle database sleep", () => {
  it("housekeeping is due hourly while requests use the database or short-lived rows wait, else once a day", () => {
    const now = 10 * 24 * H;
    expect(maintenanceDue(now, 0, false, 0)).toBe(true); // not run since start
    expect(maintenanceDue(now, now - 0.5 * H, true, now)).toBe(false); // never twice within the hour
    expect(maintenanceDue(now, now - 1.1 * H, true, 0)).toBe(true); // rows still wait for their end
    expect(maintenanceDue(now, now - 1.1 * H, false, now - 0.5 * H)).toBe(true); // a request since the last run
    expect(maintenanceDue(now, now - 1.1 * H, false, now - 2 * H)).toBe(false); // idle: wait for the day
    expect(maintenanceDue(now, now - 23 * H, false, 0)).toBe(false);
    expect(maintenanceDue(now, now - 24 * H, false, 0)).toBe(true);
  });

  it("background work does not count as a request using the database; a request does", async () => {
    const before = lastRequestUse();
    await runMaintenance();
    await bgPool.query("select 1");
    expect(lastRequestUse()).toBe(before);
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect(lastRequestUse()).toBeGreaterThan(before);
  });

  it("housekeeping says when short-lived rows still wait for their end", async () => {
    await apiPool.query("insert into rate_counters (key_hash, n, reset_at) values ($1, 1, now() + interval '10 minutes')", [randomBytes(32)]);
    expect((await runMaintenance()).pending).toBe(true);
  });

  it("the usage gauges never query a sleeping database: they repeat the last values until a request wakes it", async () => {
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    const awake = await usageSnapshot();
    expect(awake).not.toBeNull();
    const query = vi.spyOn(bgPool, "query");
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 5 * 60_000 }); // five minutes without a request
    expect(await usageSnapshot()).toEqual(awake);
    expect(query).not.toHaveBeenCalled();
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    await usageSnapshot();
    expect(query).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    query.mockRestore();
  });
});
