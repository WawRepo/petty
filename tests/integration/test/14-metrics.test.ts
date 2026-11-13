import { describe, expect, it } from "vitest";
import { compose } from "../lib.js";

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

  it("PETTY-471: each labelled counter has a series for every value, also one that never happened", async () => {
    const text = await (await fetch(METRICS)).text();
    const has = (series: string) => expect(text, series).toMatch(new RegExp(`^${series.replace(/[{}]/g, "\\$&")} \\d+$`, "m"));
    for (const code of ["CustodyProofInvalid", "WrapMismatch", "DeviceKeyInvalid", "ReadTokenCannotSign"]) has(`petty_security_refusals_total{code="${code}"}`);
    for (const result of ["ok", "failed"]) has(`petty_mail_total{result="${result}"}`);
    for (const kind of ["invitation", "transfer"]) has(`petty_mail_limited_total{kind="${kind}"}`);
    for (const result of ["created", "duplicate"]) has(`petty_entries_total{result="${result}"}`);
    // the stack signs in locally, so the local-only events are there too
    for (const event of ["login_fail", "rate_limited", "signup", "device_denied"]) has(`petty_auth_events_total{event="${event}"}`);
  });

  it("PETTY-355: background work has a pool of its own, and housekeeping ran at start", async () => {
    expect(await (await fetch(METRICS)).text()).toMatch(/^petty_pg_pool_clients\{pool="bg",state="total"\} \d+$/m);
    const runs = compose("logs --no-color --no-log-prefix app").split("\n").filter((l) => l.includes('"msg":"maintenance"'));
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0]).toMatch(/"pending":(true|false)/);
  });

  it("PETTY-241: people who used the app in the last 7 days are counted as active", async () => {
    // the earlier files signed people in and made requests; the snapshot is cached for 30 s
    await expect.poll(async () => {
      const m = /^petty_users_active\{window="7d"\} (\d+)$/m.exec(await (await fetch(METRICS)).text());
      return Number(m?.[1] ?? 0);
    }, { timeout: 45_000, interval: 5_000 }).toBeGreaterThan(0);
  }, 60_000);
});
