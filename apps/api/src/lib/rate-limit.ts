import type { FastifyInstance } from "fastify";
import { clientIp } from "./client-ip.js";
import { ApiError } from "./errors.js";
import { checkRate } from "./password.js";
import { isHealthProbe } from "./tracing.js";

/**
 * A general limit on API requests per client address (PETTY-303; CodeQL js/missing-rate-limiting). Sign-in,
 * sign-up, password reset and device codes keep their own, stricter limits; this one is a ceiling for
 * everything else, so one address cannot flood the database through any route. It counts API requests
 * only: the web app's own files and the health probes are free. RATE_LIMIT_PER_MINUTE sets it; 0 = off
 * (the default for the dev server and the tests; the image sets 600).
 */
export function apiRateLimit(app: FastifyInstance, o: { perMinute: number; apiPrefix: string; clientIpHeader: string }): void {
  if (!(o.perMinute > 0)) return;
  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0] ?? "";
    if (o.apiPrefix && path !== o.apiPrefix && !path.startsWith(`${o.apiPrefix}/`)) return;
    if (isHealthProbe(path)) return;
    if (!checkRate(`api:${clientIp(req, o.clientIpHeader)}`, o.perMinute, 60_000)) {
      reply.header("retry-after", "60");
      throw new ApiError(429, "TooManyAttempts", "try again later");
    }
  });
}
