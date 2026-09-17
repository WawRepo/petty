import { defineConfig } from "vitest/config";

// The client is tested against the real API in memory, so these are not unit tests in a vacuum.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], testTimeout: 30_000, hookTimeout: 120_000 } });
