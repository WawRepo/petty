import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { clientIp } from "../src/lib/client-ip.js";

// PETTY-301: behind Fly.io, X-Forwarded-For ends in the platform's own addresses, so the limits saw one
// address for every visitor. A platform header (Fly-Client-IP) named in CLIENT_IP_HEADER wins.
async function seen(header: string, headers: Record<string, string>): Promise<string> {
  const app = Fastify({ trustProxy: false });
  app.get("/ip", async (req) => ({ ip: clientIp(req, header) }));
  const r = await app.inject({ method: "GET", url: "/ip", remoteAddress: "172.19.0.2", headers });
  await app.close();
  return r.json().ip as string;
}

describe("clientIp", () => {
  it("takes the platform's header when one is named", async () => {
    expect(await seen("fly-client-ip", { "fly-client-ip": "203.0.113.7" })).toBe("203.0.113.7");
    expect(await seen("fly-client-ip", { "fly-client-ip": "2001:db8::7" })).toBe("2001:db8::7");
    expect(await seen("fly-client-ip", { "fly-client-ip": "203.0.113.7, 10.0.0.1" })).toBe("203.0.113.7");
  });

  it("falls back to the socket or TRUST_PROXY address when the header is missing or holds no address", async () => {
    expect(await seen("fly-client-ip", {})).toBe("172.19.0.2");
    expect(await seen("fly-client-ip", { "fly-client-ip": "not-an-address" })).toBe("172.19.0.2");
  });

  it("ignores the header when none is named: anyone could write it", async () => {
    expect(await seen("", { "fly-client-ip": "203.0.113.7" })).toBe("172.19.0.2");
  });
});
