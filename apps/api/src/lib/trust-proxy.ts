import { compile } from "@fastify/proxy-addr";
import type { FastifyInstance } from "fastify";

/**
 * TRUST_PROXY: which proxies to believe about the client's address (PETTY-290, review S10). The client
 * writes the left end of X-Forwarded-For, and each proxy appends the address it saw. `true` used to
 * trust every hop, so anyone could pick their own address and dodge the per-IP limits. Now the app
 * walks the header from the right and stops at the first address that is not a trusted proxy:
 * - "", "false", "0": no proxy; the socket's address counts. This is the default: the image sets no
 *   TRUST_PROXY since PETTY-419, so a deployment names its own proxy (deploy/compose sets one).
 * - "true": proxies on private networks — loopback, link-local and unique-local addresses. A reverse
 *   proxy connects from there: Docker's host side, an ingress pod, a platform's proxy. A public client
 *   that connects directly is not believed, but every machine on those networks is.
 * - anything else: a comma-separated list of addresses, CIDR ranges or those three names.
 * A number of hops is refused: Fastify no longer honours it, because it cannot check who connects.
 */
export const PRIVATE_PROXIES = "loopback,linklocal,uniquelocal";

export function parseTrustProxy(raw: string): boolean | string {
  const v = raw.trim();
  if (v === "" || v === "0" || v.toLowerCase() === "false") return false;
  if (v.toLowerCase() === "true") return PRIVATE_PROXIES;
  if (/^\d+$/.test(v)) throw new Error("TRUST_PROXY takes proxy addresses or ranges (or true, or false), not a number of hops");
  return v;
}

/**
 * True for an address that TRUST_PROXY=true would believe: loopback, link-local or unique-local, also an
 * IPv4 one written as IPv6. The same check Fastify runs (its proxy-addr), so both agree on the ranges.
 */
const privateNetwork = compile(PRIVATE_PROXIES.split(","));
export function isPrivateAddress(address: string): boolean {
  try {
    return privateNetwork(address, 0);
  } catch {
    return false; // not an address
  }
}

/**
 * PETTY-419: a deployment behind a reverse proxy that names no TRUST_PROXY counts every visitor as the
 * proxy's own address, so the per-address limits hit everyone together. The app cannot be sure, but a
 * request with X-Forwarded-For from a private address is a strong sign. It logs one warning per process,
 * with no address in it. Nothing is logged when TRUST_PROXY or CLIENT_IP_HEADER is set.
 */
export function warnUntrustedProxy(app: FastifyInstance, o: { trustProxy: boolean | string; clientIpHeader: string }): void {
  if (o.trustProxy !== false || o.clientIpHeader) return;
  let warned = false;
  app.addHook("onRequest", async (req) => {
    if (warned || req.headers["x-forwarded-for"] === undefined) return;
    if (!isPrivateAddress(req.socket.remoteAddress ?? "")) return;
    warned = true;
    req.log.warn({ code: "proxy_untrusted" }, "X-Forwarded-For from a private address, but TRUST_PROXY is off: every client counts as the proxy's address (docs/deploy.md)");
  });
}
