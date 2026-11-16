import { afterAll, describe, expect, it, vi } from "vitest";

// PETTY-378: Fastify 5.12 deprecates the top-level disableRequestLogging (FSTDEP023) and Fastify 6
// removes it. The app sets it through logController, so the server starts without the warning and
// still writes no incoming/completed pair of its own (lib/metrics.ts writes one "request" line).

// Fastify warns while buildApp() runs, before any test, so catch it with a plain wrapper: a vi.spyOn
// made here would be reset before the first test.
const warnings: string[] = [];
const emitWarning = process.emitWarning;
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  warnings.push([String(warning), ...rest.map(String)].join(" "));
}) as typeof process.emitWarning;
const { buildApp } = await import("../src/app.js");
const app = buildApp();
process.emitWarning = emitWarning;
afterAll(async () => { await app.close(); });

/** pino's one stream, which every logger of the app writes into. */
const pinoStream = (logger: object): { write(line: string): boolean } => {
  for (let o: object | null = logger; o; o = Object.getPrototypeOf(o)) {
    const sym = Object.getOwnPropertySymbols(o).find((s) => s.description === "pino.stream");
    if (sym) return (o as Record<symbol, { write(line: string): boolean }>)[sym]!;
  }
  throw new Error("no pino stream on the app's logger");
};

describe("request logging", () => {
  it("starts without Fastify's FSTDEP023 warning", () => {
    expect(warnings.filter((w) => w.includes("FSTDEP023") || w.includes("disableRequestLogging"))).toEqual([]);
  });

  it("writes one 'request' line and no 'incoming request' or 'request completed' line", async () => {
    const lines: string[] = [];
    const write = vi.spyOn(pinoStream(app.log), "write").mockImplementation((line: string) => {
      lines.push(line);
      return true;
    });
    try {
      await app.inject({ method: "GET", url: "/config" }); // health probes write no line at all
    } finally {
      write.mockRestore();
    }
    const all = lines.join("");
    expect(all).toContain('"msg":"request"');
    expect(all).not.toContain("incoming request");
    expect(all).not.toContain("request completed");
  });
});
