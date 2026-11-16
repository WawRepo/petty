import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { PRIVATE_PROXIES, isPrivateAddress, parseTrustProxy, warnUntrustedProxy } from "../src/lib/trust-proxy.js";

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

  it("knows the private ranges that the three names stand for", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.18.0.1", "169.254.1.1", "::1", "fdaa::3", "fe80::1", "::ffff:10.1.2.3"]) expect(isPrivateAddress(a), a).toBe(true);
    for (const a of ["192.0.2.5", "172.32.0.1", "8.8.8.8", "2001:db8::1", "::ffff:203.0.113.7", "", "not-an-address"]) expect(isPrivateAddress(a), a).toBe(false);
  });
});

// PETTY-419: the image names no proxy. A deployment that forgot TRUST_PROXY behind a proxy gets one warning.
describe("warning when a proxy is not trusted (PETTY-419)", () => {
  async function warnings(o: { trustProxy: boolean | string; clientIpHeader: string }, requests: { remoteAddress: string; xff?: string }[]): Promise<string[]> {
    const lines: string[] = [];
    const app = Fastify({ logger: { level: "warn", stream: { write: (l: string) => void lines.push(l) } }, trustProxy: o.trustProxy });
    warnUntrustedProxy(app, o);
    app.get("/x", async () => ({}));
    for (const r of requests) await app.inject({ method: "GET", url: "/x", remoteAddress: r.remoteAddress, headers: r.xff ? { "x-forwarded-for": r.xff } : {} });
    await app.close();
    return lines.filter((l) => (JSON.parse(l) as { code?: string }).code === "proxy_untrusted");
  }
  const behindProxy = [{ remoteAddress: "172.18.0.1", xff: "203.0.113.7" }, { remoteAddress: "10.0.0.5", xff: "203.0.113.8" }];

  it("logs once, with no address, when X-Forwarded-For comes from a private address and TRUST_PROXY is off", async () => {
    const hits = await warnings({ trustProxy: false, clientIpHeader: "" }, behindProxy);
    expect(hits).toHaveLength(1);
    expect(hits[0]).not.toMatch(/172\.18|203\.0\.113|10\.0\.0/);
  });

  it("stays quiet when TRUST_PROXY or CLIENT_IP_HEADER is set, with no header, or for a public client", async () => {
    expect(await warnings({ trustProxy: PRIVATE_PROXIES, clientIpHeader: "" }, behindProxy)).toEqual([]);
    expect(await warnings({ trustProxy: false, clientIpHeader: "cf-connecting-ip" }, behindProxy)).toEqual([]);
    expect(await warnings({ trustProxy: false, clientIpHeader: "" }, [{ remoteAddress: "172.18.0.1" }])).toEqual([]);
    expect(await warnings({ trustProxy: false, clientIpHeader: "" }, [{ remoteAddress: "192.0.2.5", xff: "198.51.100.1" }])).toEqual([]);
  });
});
