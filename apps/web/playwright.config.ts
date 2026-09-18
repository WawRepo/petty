import { defineConfig, devices } from "@playwright/test";

/**
 * Projects:
 *  - `dev`  the suite against the Vite dev server (:5173) + API (:3000)
 *  - `prod` e2e/prod.spec.ts against the production shape: the API serving the
 *           built web app under strict security headers (:3100, /api prefix),
 *           service worker active. Fails on any CSP violation.
 * Both need `make db`.
 */
// WEB_PORT moves the dev server when :5173 is busy on this machine (another project's Vite), e.g. WEB_PORT=5174.
const WEB_PORT = process.env.WEB_PORT ?? "5173";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  // The self-hosted runner is a 4-core Pi: one retry there, and twice the per-test budget (export/import runs Argon2id twice and re-encodes a photo).
  retries: process.env["CI"] ? 1 : 0,
  reporter: [["list"]],
  timeout: process.env["CI"] ? 120_000 : 60_000,
  use: { trace: "retain-on-failure", locale: "en-GB" },
  projects: [
    { name: "dev", use: { ...devices["Desktop Chrome"], baseURL: `http://localhost:${WEB_PORT}` }, testIgnore: /prod\.spec\.ts/ },
    { name: "prod", use: { ...devices["Desktop Chrome"], baseURL: "http://localhost:3100" }, testMatch: /prod\.spec\.ts/ },
    // PETTY-185: the Clerk flow against the built app under the production CSP (CLERK_E2E=1, root .env in clerk mode).
    { name: "clerk-prod", use: { ...devices["Desktop Chrome"], baseURL: "http://localhost:3100" }, testMatch: /clerk\.spec\.ts/ },
  ],
  webServer: [
    // Test-only: the login limiter is per process; a day of e2e runs against one dev API would trip it.
    // The suite runs the API in local mode whatever the root .env says; CLERK_E2E=1 runs it in clerk mode (needs the Clerk keys in .env).
    { command: `AUTH_PROVIDER=${process.env["CLERK_E2E"] ? "clerk" : "local"} CLERK_AUTHORIZED_PARTIES=http://localhost:${WEB_PORT} LOGIN_LIMIT_PER_IP=1000000 CONTACT_EMAIL=invites@example.com pnpm --filter @petty/api dev`, url: "http://127.0.0.1:3000/health", reuseExistingServer: true, timeout: 60_000, cwd: "../.." },
    { command: `pnpm --filter @petty/web dev --port ${WEB_PORT}`, url: `http://localhost:${WEB_PORT}`, reuseExistingServer: true, timeout: 60_000, cwd: "../.." },
    { command: "pnpm --filter @petty/web build && CLERK_AUTHORIZED_PARTIES=http://localhost:3100 LOGIN_LIMIT_PER_IP=1000000 CONTACT_EMAIL=invites@example.com pnpm --filter @petty/web preview:prod", url: "http://localhost:3100/api/health", reuseExistingServer: true, timeout: 180_000, cwd: "../.." },
  ],
});
