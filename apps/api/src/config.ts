import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTrustProxy } from "./lib/trust-proxy.js";

/**
 * One .env for the whole repo, at its root (gitignored; see .env.example). Loaded here so the dev
 * server, the tests and Playwright's API all read it; variables already in the environment win,
 * and the production image carries no file at all.
 */
{
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const file = resolve(root, ".env");
  if (existsSync(file)) { try { process.loadEnvFile(file); } catch { /* unreadable: fall back to the environment */ } }
}

const env = (name: string, fallback: string): string => process.env[name] ?? fallback;

export const config = {
  port: Number(env("API_PORT", "3000")),
  host: env("API_HOST", "127.0.0.1"),
  /** Request role: SELECT/INSERT on entries only. */
  apiDatabaseUrl: env("API_DATABASE_URL", "postgres://petty_api:petty_api@localhost:5432/petty"),
  /** Maintenance role: used only inside rotation and line/drawer deletion. */
  maintDatabaseUrl: env("MAINT_DATABASE_URL", "postgres://petty_maint:petty_maint@localhost:5432/petty"),
  /** Owner role: migrations and seed only. Never opened by the running API. */
  ownerDatabaseUrl: env("DATABASE_URL", "postgres://petty:petty@localhost:5432/petty"),
  /** Where the web app lives; used in emails. */
  appUrl: env("APP_URL", "http://localhost:5173"),
  smtpHost: env("SMTP_HOST", "localhost"),
  smtpPort: Number(env("SMTP_PORT", "1025")),
  smtpUser: env("SMTP_USER", ""),
  smtpPass: env("SMTP_PASS", ""),
  mailFrom: env("MAIL_FROM", "Petty <petty@petty.local>"),
  /** Route prefix. "" in dev (Vite proxies /api and strips it); "/api" in the production image. */
  apiPrefix: env("API_PREFIX", ""),
  /** When set, the API also serves the built web app from this directory (SPA fallback). */
  webDist: env("WEB_DIST", ""),
  /** Behind a reverse proxy: which X-Forwarded-For hops to believe (lib/trust-proxy.ts). */
  trustProxy: parseTrustProxy(env("TRUST_PROXY", "false")),
  /** A platform proxy's own client-address header, e.g. Fly-Client-IP (lib/client-ip.ts); empty = none. */
  clientIpHeader: env("CLIENT_IP_HEADER", "").trim().toLowerCase(),
  /** API requests per client address per minute (lib/rate-limit.ts); 0 = off. The image sets 600. */
  apiRateLimitPerMinute: Math.max(0, Number(env("RATE_LIMIT_PER_MINUTE", "0")) || 0),
  /** OTLP/HTTP base URL of Tempo (spans go to <endpoint>/v1/traces); empty = tracing off. */
  otlpEndpoint: env("OTEL_EXPORTER_OTLP_ENDPOINT", ""),
  /** Prometheus /metrics on its own port (never behind the ingress); 0 = off. */
  metricsPort: Number(env("METRICS_PORT", "0")),
  /**
   * PETTY-92: also push metrics and logs to <OTEL_EXPORTER_OTLP_ENDPOINT> over OTLP (traces always do).
   * Default off so the endpoint can point at a traces-only receiver (Tempo) without 404s; the operator
   * flips this on in the same window the endpoint moves to a full OTLP collector (Alloy) or Grafana Cloud.
   */
  otlpPush: env("OTEL_PUSH", "") === "true",
  /**
   * PETTY-92: distinguishes this instance's telemetry from other instances that share service.name=petty
   * (home vs the public cloud). Becomes the `deployment.environment` resource attribute; empty = unset.
   */
  deploymentEnv: env("DEPLOYMENT_ENV", ""),
  /** PETTY-218: the release version, baked into the image at build (Dockerfile ARG PETTY_VERSION). "dev" locally. */
  version: env("PETTY_VERSION", "dev"),
  /** Secure cookies need HTTPS; off for the local http dev server. */
  secureCookies: env("SECURE_COOKIES", "false") === "true",
  /**
   * Identity (PETTY-88, docs/auth-clerk.md). "local": Petty's own login and cookie sessions.
   * "clerk": Clerk session tokens as bearer; login/signup/reset/join-link routes are off.
   */
  authProvider: env("AUTH_PROVIDER", "local") === "clerk" ? "clerk" as const : "local" as const,
  clerkSecretKey: env("CLERK_SECRET_KEY", ""),
  clerkPublishableKey: env("CLERK_PUBLISHABLE_KEY", ""),
  /**
   * PETTY-342: a directory with the operator's privacy notice and terms (privacy.<lang>.md, terms.<lang>.md).
   * Empty = none: the privacy page shows only what Petty itself explains, and no terms are linked.
   */
  legalDir: env("LEGAL_DIR", ""),
  /** PETTY-160: the operator's address for invite requests; empty hides the "Get an invite" links. */
  contactEmail: env("CONTACT_EMAIL", ""),
  /** PETTY-215: local mode only — allow signup without a join link (a public self-hosted instance). */
  openSignup: env("OPEN_SIGNUP", "") === "true",
  /**
   * PETTY-243: per-user storage limit in MB — ciphertext in the drawers a person owns (photos,
   * documents and their 30-day history, entries). 0 or unset = no limit (a household instance).
   */
  storageQuotaBytes: Number(env("STORAGE_QUOTA_MB", "0")) > 0 ? Math.round(Number(env("STORAGE_QUOTA_MB", "0")) * 1024 * 1024) : null,
  /** PEM public key for networkless token verification (tests, air-gapped); empty = fetch JWKS with the secret key. */
  clerkJwtKey: env("CLERK_JWT_KEY", ""),
  /** Clerk frontend API origin (https://….clerk.accounts.dev or https://clerk.<domain>): CSP connect-src in clerk mode. */
  clerkFrontendApi: env("CLERK_FRONTEND_API", ""),
  /**
   * PETTY-189 (review NR-9): origins whose Clerk session tokens we accept (the token's `azp`).
   * Comma separated; defaults to the origin of APP_URL.
   */
  clerkAuthorizedParties: env("CLERK_AUTHORIZED_PARTIES", "").split(",").map((s) => s.trim()).filter(Boolean),
} as const;
