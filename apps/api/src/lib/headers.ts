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
 * pinned version (PETTY-185), so script-src adds no Clerk origin; Clerk's components inject styles
 * (style-src 'unsafe-inline'), the frontend API is the only extra connect target, avatars come from
 * img.clerk.com, clerk-js may spawn its session poller as a blob: worker (worker-src), and Trusted
 * Types enforcement is off because Clerk's code injects script elements.
 *
 * PETTY-404 (review finding #6): the bot check, Cloudflare Turnstile, is a third-party script (script
 * + frame). Clerk runs it only while someone signs up (or signs in with "sign up if missing"), so only
 * the sign-in and sign-up pages allow it. The web app leaves those pages with a full page load
 * (ClerkShell), never a router step, so vault setup and unlock always run in a page whose policy names
 * no third party, and a script loaded on the sign-up page is gone with that page.
 */
const clerk = config.authProvider === "clerk";
const fapi = clerk && config.clerkFrontendApi ? ` ${config.clerkFrontendApi}` : "";
const TURNSTILE = "https://challenges.cloudflare.com";
/** The sign-in and sign-up pages and Clerk's steps under them (/login/factor-one, /join/verify-email-address…). */
export const AUTH_PAGE = /^\/(?:login|join)(?:\/|$)/;

function policy(turnstile: boolean): string {
  const t = clerk && turnstile;
  return [
    "default-src 'self'",
    t ? `script-src 'self' 'wasm-unsafe-eval' ${TURNSTILE}` : "script-src 'self' 'wasm-unsafe-eval'",
    clerk ? "style-src 'self' 'unsafe-inline'" : "style-src 'self'",
    clerk ? "img-src 'self' blob: data: https://img.clerk.com" : "img-src 'self' blob: data:",
    "font-src 'self'",
    `connect-src 'self'${fapi}`,
    clerk ? "worker-src 'self' blob:" : "worker-src 'self'", // clerk-js runs its session poller in a blob: worker
    "manifest-src 'self'",
    t ? `frame-src ${TURNSTILE}` : "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
    ...(clerk ? [] : ["require-trusted-types-for 'script'"]),
  ].join("; ");
}
/** Every page and API answer. */
export const CSP = policy(false);
/** The sign-in and sign-up pages in clerk mode; the same as CSP in local mode. */
export const AUTH_CSP = policy(true);
/** The policy for a request, by its path (the query string never counts). */
export const cspFor = (url: string): string => (AUTH_PAGE.test(url.split(/[?#]/, 1)[0] ?? "") ? AUTH_CSP : CSP);

export function securityHeaders(app: FastifyInstance, opts: { hsts: boolean }): void {
  app.addHook("onSend", async (req, reply) => {
    reply.header("Content-Security-Policy", cspFor(req.url));
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Cross-Origin-Opener-Policy", "same-origin");
    reply.header("Cross-Origin-Resource-Policy", "same-origin");
    reply.header("Permissions-Policy", "camera=(self), geolocation=(), microphone=(), payment=(), usb=()");
    if (opts.hsts) reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  });
}
