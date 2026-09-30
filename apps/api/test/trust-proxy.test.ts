import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { PRIVATE_PROXIES, parseTrustProxy } from "../src/lib/trust-proxy.js";

async function ipSeen(trustProxy: string, remoteAddress: string, xff?: string): Promise<string> {
  const app = Fastify({ trustProxy: parseTrustProxy(trustProxy) });
  app.get("/ip", async (req) => ({ ip: req.ip }));
  const r = await app.inject({ method: "GET", url: "/ip", remoteAddress, headers: xff ? { "x-forwarded-for": xff } : {} });
  await app.close();
  return r.json().ip as string;
}

describe("TRUST_PROXY (PETTY-290, review S10)", () => {
  it("reads no proxy, true, and a list; refuses a hop count", () => {
    expect(parseTrustProxy("")).toBe(false);
    expect(parseTrustProxy("false")).toBe(false);
    expect(parseTrustProxy("0")).toBe(false);
    expect(parseTrustProxy("true")).toBe(PRIVATE_PROXIES);
    expect(parseTrustProxy("TRUE")).toBe(PRIVATE_PROXIES);
    expect(parseTrustProxy(" loopback,203.0.113.0/24 ")).toBe("loopback,203.0.113.0/24");
    expect(() => parseTrustProxy("2")).toThrow(/not a number of hops/);
  });

  it("behind a reverse proxy on a private network, the address the proxy added counts, not what the client wrote", async () => {
    expect(await ipSeen("true", "172.18.0.1", "198.51.100.1, 203.0.113.7")).toBe("203.0.113.7");
    expect(await ipSeen("true", "172.18.0.1", "198.51.100.99, 203.0.113.7")).toBe("203.0.113.7");
    expect(await ipSeen("true", "10.1.2.3", "10.9.9.9, 203.0.113.7")).toBe("203.0.113.7");
    expect(await ipSeen("true", "fdaa::3", "203.0.113.8")).toBe("203.0.113.8");
  });

  it("a public client that connects directly is not believed", async () => {
    expect(await ipSeen("true", "192.0.2.5", "198.51.100.1")).toBe("192.0.2.5");
  });

  it("with no proxy, the header is ignored", async () => {
    expect(await ipSeen("false", "172.18.0.1", "198.51.100.1")).toBe("172.18.0.1");
  });

  it("a CDN on a public range can be added to the list", async () => {
    expect(await ipSeen(`${PRIVATE_PROXIES},198.51.100.0/24`, "172.18.0.1", "203.0.113.9, 198.51.100.20")).toBe("203.0.113.9");
  });
});
