import { isIP } from "node:net";
import type { FastifyRequest } from "fastify";
import { config } from "../config.js";

/**
 * The client's address, for the per-address limits and the device-login record (PETTY-301).
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
