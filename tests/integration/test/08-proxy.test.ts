import { describe, expect, it } from "vitest";
import { deviceKeyPair } from "@petty/crypto";
import { API } from "../lib.js";

/**
 * PETTY-290 (review S10): the image believes only proxies on private networks. The test reaches the app
 * through Docker's port mapping, so it connects from a private address, as a reverse proxy would. A
 * client can write anything at the left of X-Forwarded-For, but its proxy appends the address it saw,
 * and only that one counts. The test plays both: a forged left part that changes on every request, and
 * a fixed public right part. The limit: 10 device codes per address per hour (routes/device.ts).
 */
describe("per-IP limits behind a proxy", () => {
  it("count the address the proxy added, not the one the client wrote", async () => {
    const proxySaw = `203.0.113.${10 + Math.floor(Math.random() * 200)}`;
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const key = await deviceKeyPair();
      const r = await fetch(`${API}/device/code`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${i + 1}, ${proxySaw}` },
        body: JSON.stringify({ cli_pub: key.publicB64, client_name: "petty on it-proxy", role: "read", expires_days: 30 }),
      });
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(201));
    expect(statuses[10]).toBe(429);
  });

  // PETTY-301: behind Fly.io the X-Forwarded-For chain ends in the platform's own addresses; the platform's
  // own header (here x-test-client-ip, CLIENT_IP_HEADER in compose.test.yml) names the client instead.
  it("count the address in the platform's header when one is named, each client on its own", async () => {
    const client = `203.0.113.${10 + Math.floor(Math.random() * 200)}`;
    const ask = async (who: string, i: number) => {
      const key = await deviceKeyPair();
      return (await fetch(`${API}/device/code`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-client-ip": who, "x-forwarded-for": `198.51.100.${i + 1}` },
        body: JSON.stringify({ cli_pub: key.publicB64, client_name: "petty on it-proxy", role: "read", expires_days: 30 }),
      })).status;
    };
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push(await ask(client, i));
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(201));
    expect(statuses[10]).toBe(429);
    // another client behind the same proxy has a limit of its own
    expect(await ask("2001:db8::1:7", 0)).toBe(201);
  });
});
