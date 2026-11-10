import { isIP } from "node:net";
import type { FastifyRequest } from "fastify";
import { config } from "../config.js";

/**
 * The client's whole address: for the device-login record, and what clientNet below reduces for the
 * per-address limits (PETTY-301).
 * A platform proxy that sets a client-address header of its own (Fly.io: Fly-Client-IP; Cloudflare:
 * CF-Connecting-IP) is named in CLIENT_IP_HEADER, and that header wins: on Fly.io the
 * X-Forwarded-For chain ends in the platform's own addresses, so TRUST_PROXY alone saw one address
 * for every visitor (v1.5.7). Set it only when the app is reachable through that proxy alone, since
 * anyone else could write the header. Without it, or when it holds no address, TRUST_PROXY decides.
 */
export function clientIp(req: FastifyRequest, header: string = config.clientIpHeader): string {
  if (header) {
    const raw = req.headers[header];
    const value = (Array.isArray(raw) ? raw[0] : raw)?.split(",")[0]?.trim();
    if (value && isIP(value)) return value;
  }
  return req.ip;
}

/** The eight 16-bit groups of an IPv6 address that node:net accepted (no zone index). */
function groups(address: string): number[] {
  let s = address;
  if (s.includes(".")) {
    // a dotted IPv4 tail (::ffff:203.0.113.7) is the last two groups
    const cut = s.lastIndexOf(":") + 1;
    const [a, b, c, d] = s.slice(cut).split(".").map(Number) as [number, number, number, number];
    s = `${s.slice(0, cut)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = s.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const all = tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  return all.map((g) => parseInt(g, 16));
}

/**
 * What a per-address limit counts under (PETTY-458).
 *  - An IPv4 address: itself, as before.
 *  - An IPv6 address: its /64 network. One home or phone connection holds a whole /64 (often more) and
 *    can send each request from another of its addresses, so a count per address would never fill.
 *  - An IPv4 address written as IPv6 (::ffff:a.b.c.d, as a dual-stack socket reports it): that IPv4
 *    address, in one count with its plain spelling. All of them sit in a single /64, so the rule
 *    above would put every IPv4 client into one count.
 * Anything that is not an address (TRUST_PROXY=true hands on whatever a client wrote) stays as it is.
 */
export function networkOf(address: string): string {
  const zone = address.indexOf("%");
  const bare = zone < 0 ? address : address.slice(0, zone);
  if (isIP(bare) !== 6) return address;
  const g = groups(bare) as [number, number, number, number, number, number, number, number];
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  return `${g.slice(0, 4).map((n) => n.toString(16)).join(":")}::/64`;
}

/** The client as the limits count it: clientIp, reduced by networkOf. Every per-address limit uses this, never clientIp. */
export function clientNet(req: FastifyRequest, header: string = config.clientIpHeader): string {
  return networkOf(clientIp(req, header));
}
