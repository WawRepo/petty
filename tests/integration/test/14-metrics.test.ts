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
});
