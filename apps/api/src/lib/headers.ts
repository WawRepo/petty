import type { FastifyInstance } from "fastify";
import { config } from "../config.js";

/**
 * Browser security headers (spec "What Petty explicitly does NOT defend against":
 * a malicious build / XSS is the residual risk; these narrow it).
 *  - script-src 'self' 'wasm-unsafe-eval': our own bundles plus Argon2id's WebAssembly; no inline scripts, no third parties.
 *  - style-src 'self': no inline styles (the app uses classes only).
 *  - img-src adds blob: for decrypted photos held in memory.
 *  - connect-src 'self': the API only; no analytics, no telemetry.
 *  - require-trusted-types-for 'script': DOM XSS sinks need a policy; React never uses them.
 */
/**
 * Clerk mode (PETTY-88, docs/auth-clerk.md) relaxes exactly this much: clerk-js is bundled at a
 * pinned version (PETTY-185), so script-src adds only Turnstile; Clerk's components inject styles
 * (style-src 'unsafe-inline'), the bot check is Cloudflare Turnstile (script + frame), the frontend
 * API is the only extra connect target, avatars come from img.clerk.com, clerk-js may spawn its
 * session poller as a blob: worker (worker-src), and Trusted Types enforcement is off because
 * those scripts are injected as elements.
 */
const clerk = config.authProvider === "clerk";
const fapi = clerk && config.clerkFrontendApi ? ` ${config.clerkFrontendApi}` : "";
export const CSP = [
  "default-src 'self'",
  clerk ? "script-src 'self' 'wasm-unsafe-eval' https://challenges.cloudflare.com" : "script-src 'self' 'wasm-unsafe-eval'",
  clerk ? "style-src 'self' 'unsafe-inline'" : "style-src 'self'",
  clerk ? "img-src 'self' blob: data: https://img.clerk.com" : "img-src 'self' blob: data:",
  "font-src 'self'",
  `connect-src 'self'${fapi}`,
  clerk ? "worker-src 'self' blob:" : "worker-src 'self'", // clerk-js runs its session poller in a blob: worker
  "manifest-src 'self'",
  clerk ? "frame-src https://challenges.cloudflare.com" : "frame-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
  ...(clerk ? [] : ["require-trusted-types-for 'script'"]),
].join("; ");

export function securityHeaders(app: FastifyInstance, opts: { hsts: boolean }): void {
  app.addHook("onSend", async (_req, reply) => {
    reply.header("Content-Security-Policy", CSP);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Cross-Origin-Opener-Policy", "same-origin");
    reply.header("Cross-Origin-Resource-Policy", "same-origin");
    reply.header("Permissions-Policy", "camera=(self), geolocation=(), microphone=(), payment=(), usb=()");
    if (opts.hsts) reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  });
}
