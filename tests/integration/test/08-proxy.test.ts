import { describe, expect, it } from "vitest";
import { deviceKeyPair, deviceUserCode } from "@petty/crypto";
import { API, ORIGIN } from "../lib.js";

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
        body: JSON.stringify({ cli_pub: key.publicB64, user_code: await deviceUserCode(key.publicB64, ORIGIN), client_name: "petty on it-proxy", role: "read", expires_days: 30 }),
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
        body: JSON.stringify({ cli_pub: key.publicB64, user_code: await deviceUserCode(key.publicB64, ORIGIN), client_name: "petty on it-proxy", role: "read", expires_days: 30 }),
      })).status;
    };
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push(await ask(client, i));
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(201));
    expect(statuses[10]).toBe(429);
    // another client behind the same proxy has a limit of its own
    expect(await ask("2001:db8::1:7", 0)).toBe(201);
  });

  // PETTY-458: one IPv6 connection holds a whole /64 and can send each request from another of its addresses.
  it("count an IPv6 client by its /64 network, and an IPv4 address written as IPv6 as that address", async () => {
    const hex = () => (1 + Math.floor(Math.random() * 0xfffe)).toString(16);
    const ask = async (who: string) => {
      const key = await deviceKeyPair();
      return (await fetch(`${API}/device/code`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-client-ip": who },
        body: JSON.stringify({ cli_pub: key.publicB64, client_name: "petty on it-proxy", role: "read", expires_days: 30 }),
      })).status;
    };
    const net = `2001:db8:${hex()}:${hex()}`;
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push(await ask(`${net}:${hex()}:${hex()}:${hex()}:${hex()}`));
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(201));
    expect(statuses[10]).toBe(429);
    expect(await ask(`2001:db8:${hex()}:${hex()}::1`)).toBe(201); // another /64 is another client
    // IPv4 in both spellings is one client; the next IPv4 address is another
    const v4 = `198.51.100.${10 + Math.floor(Math.random() * 200)}`;
    const mixed: number[] = [];
    for (let i = 0; i < 11; i++) mixed.push(await ask(i % 2 ? v4 : `::ffff:${v4}`));
    expect(mixed.slice(0, 10)).toEqual(Array(10).fill(201));
    expect(mixed[10]).toBe(429);
    expect(await ask(`::ffff:198.51.100.${5 + Math.floor(Math.random() * 4)}`)).toBe(201);
  });
});
