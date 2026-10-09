import { describe, expect, it } from "vitest";

/**
 * PETTY-266/267: the image reports what two alerts read. A refusal that normal use never triggers is
 * counted by its code (the counting itself is tested in apps/api/test/metrics.test.ts), and the API's
 * resident memory has a name of its own, so an instance that only pushes OTLP has a memory figure too.
 */
const METRICS = process.env["PETTY_IT_METRICS"] ?? "http://127.0.0.1:3401/metrics";

describe("the scrape port", () => {
  it("lists the security refusal counter and the resident memory gauge", async () => {
    const r = await fetch(METRICS);
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toContain("# TYPE petty_security_refusals_total counter");
    expect(text).toMatch(/^petty_process_resident_memory_bytes [1-9]\d+$/m);
  });

  it("PETTY-241: people who used the app in the last 7 days are counted as active", async () => {
    // the earlier files signed people in and made requests; the snapshot is cached for 30 s
    await expect.poll(async () => {
      const m = /^petty_users_active\{window="7d"\} (\d+)$/m.exec(await (await fetch(METRICS)).text());
      return Number(m?.[1] ?? 0);
    }, { timeout: 45_000, interval: 5_000 }).toBeGreaterThan(0);
  }, 60_000);
});
