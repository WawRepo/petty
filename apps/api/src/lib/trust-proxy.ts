/**
 * TRUST_PROXY: which proxies to believe about the client's address (PETTY-290, review S10). The client
 * writes the left end of X-Forwarded-For, and each proxy appends the address it saw. `true` used to
 * trust every hop, so anyone could pick their own address and dodge the per-IP limits. Now the app
 * walks the header from the right and stops at the first address that is not a trusted proxy:
 * - "", "false", "0": no proxy; the socket's address counts.
 * - "true" (the image's default): proxies on private networks — loopback, link-local and unique-local
 *   addresses. A reverse proxy connects from there: Docker's host side, an ingress pod, a platform's
 *   proxy. A public client that connects directly is not believed.
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
