import { describe, expect, it } from "vitest";
import { API } from "../lib.js";

/**
 * PETTY-303: the image limits API requests per client address (RATE_LIMIT_PER_MINUTE=600). The test plays
 * one client through the platform header that compose.test.yml names (x-test-client-ip), so the rest of
 * the suite, which comes from the host's own address, is not affected. The rest of the suite passing
 * under the default is the other half of the check: normal use stays under the limit.
 */
describe("the general API limit", () => {
  it("answers 429 after 600 requests a minute from one address, and only to that address", async () => {
    // PETTY-377: a range of its own. 08-proxy draws its clients from 203.0.113.0/24 a few seconds before,
    // and an address both drew added 08's 11 requests to this count.
    const client = `192.0.2.${10 + Math.floor(Math.random() * 200)}`;
    const get =(who: string) => fetch(`${API}/config`, { headers: { "x-test-client-ip": who } });
    const statuses = await Promise.all(Array.from({ length: 600 }, () => get(client).then((r) => r.status)));
    expect(statuses.filter((s) => s !== 200)).toEqual([]);
    const over = await get(client);
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBe("60");
    expect((await get("2001:db8::603")).status).toBe(200);
    expect((await fetch(`${API}/health/live`, { headers: { "x-test-client-ip": client } })).status).toBe(200);
  });
});
