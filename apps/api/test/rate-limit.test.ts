import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/lib/errors.js";
import { apiRateLimit } from "../src/lib/rate-limit.js";

// PETTY-303 (CodeQL js/missing-rate-limiting): a ceiling on API requests per client address.
async function app(perMinute: number) {
  const a = Fastify();
  a.setErrorHandler((err, _req, reply) => (err instanceof ApiError ? reply.code(err.status).send({ code: err.code }) : reply.code(500).send()));
  apiRateLimit(a, { perMinute, apiPrefix: "/api", clientIpHeader: "x-client" });
  for (const p of ["/api/me", "/api/health/live", "/api/health", "/assets/app.js"]) a.get(p, async () => ({ ok: true }));
  await a.ready();
  return a;
}
const get = (a: Awaited<ReturnType<typeof app>>, url: string, ip: string) =>
  a.inject({ method: "GET", url, headers: { "x-client": ip } });

describe("apiRateLimit", () => {
  it("lets the first N API requests of an address through, then answers 429 with Retry-After", async () => {
    const a = await app(3);
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await get(a, "/api/me", "198.51.100.1")).statusCode);
    expect(codes).toEqual([200, 200, 200, 429]);
    const over = await get(a, "/api/me?x=1", "198.51.100.1");
    expect(over.statusCode).toBe(429);
    expect(over.headers["retry-after"]).toBe("60");
    expect(over.json().code).toBe("TooManyAttempts");
    await a.close();
  });

  it("counts each address on its own", async () => {
    const a = await app(2);
    for (let i = 0; i < 3; i++) await get(a, "/api/me", "198.51.100.2");
    expect((await get(a, "/api/me", "198.51.100.3")).statusCode).toBe(200);
    await a.close();
  });

  it("does not count the health probes or the web app's own files", async () => {
    const a = await app(1);
    expect((await get(a, "/api/me", "198.51.100.4")).statusCode).toBe(200);
    for (let i = 0; i < 5; i++) {
      expect((await get(a, "/api/health/live", "198.51.100.4")).statusCode).toBe(200);
      expect((await get(a, "/api/health", "198.51.100.4")).statusCode).toBe(200);
      expect((await get(a, "/assets/app.js", "198.51.100.4")).statusCode).toBe(200);
    }
    expect((await get(a, "/api/me", "198.51.100.4")).statusCode).toBe(429);
    await a.close();
  });

  it("is off at 0", async () => {
    const a = await app(0);
    for (let i = 0; i < 20; i++) expect((await get(a, "/api/me", "198.51.100.5")).statusCode).toBe(200);
    await a.close();
  });
});
