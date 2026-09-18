import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  /** Behind Traefik/any reverse proxy: take the client IP from X-Forwarded-For. */
  trustProxy: env("TRUST_PROXY", "false") === "true",
  /** OTLP/HTTP base URL of Tempo (spans go to <endpoint>/v1/traces); empty = tracing off. */
  otlpEndpoint: env("OTEL_EXPORTER_OTLP_ENDPOINT", ""),
  /** Prometheus /metrics on its own port (never behind the ingress); 0 = off. */
  metricsPort: Number(env("METRICS_PORT", "0")),
  /** Secure cookies need HTTPS; off for the local http dev server. */
  secureCookies: env("SECURE_COOKIES", "false") === "true",
  /**
   * Identity (PETTY-88, docs/auth-clerk.md). "local": Petty's own login and cookie sessions.
   * "clerk": Clerk session tokens as bearer; login/signup/reset/join-link routes are off.
   */
  authProvider: env("AUTH_PROVIDER", "local") === "clerk" ? "clerk" as const : "local" as const,
  clerkSecretKey: env("CLERK_SECRET_KEY", ""),
  clerkPublishableKey: env("CLERK_PUBLISHABLE_KEY", ""),
  /** PETTY-160: the operator's address for invite requests; empty hides the "Get an invite" links. */
  contactEmail: env("CONTACT_EMAIL", ""),
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
