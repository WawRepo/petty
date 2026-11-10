import { describe, expect, it } from "vitest";
import { compose } from "../lib.js";

/**
 * PETTY-418: the image starts the API as node itself, with no package manager and no shell in front of
 * it. As the container's first process it must answer a stop on its own: Linux gives that process no
 * default action for a signal, so without a handler a stop waits out the grace period and then kills.
 * Tried on the second instance, which is started again afterwards. The last file, so nothing else is
 * running while an instance is down.
 */
const state = (service: string) => {
  const out = compose(`ps -a --format json ${service}`).trim();
  const rows = (out.startsWith("[") ? JSON.parse(out) : out.split("\n").filter(Boolean).map((l) => JSON.parse(l))) as { State: string; ExitCode: number }[];
  return rows[0]!;
};

describe("the app as the container's first process", () => {
  it("is node running the API", () => {
    for (const service of ["app", "app2"]) {
      expect(compose(`exec -T ${service} sh -c 'tr "\\0" " " < /proc/1/cmdline'`).trim(), service).toBe("node --import tsx src/index.ts");
    }
  });

  it("stops at once when told to, and cleanly", async () => {
    const before = Date.now();
    compose("stop -t 30 app2"); // 30 s of grace: a stop that is ignored would take all of it
    const took = Date.now() - before;
    try {
      expect(took, `the stop took ${took} ms`).toBeLessThan(10_000);
      expect(state("app2")).toMatchObject({ State: "exited", ExitCode: 0 });
      expect(compose("logs --no-color --no-log-prefix --tail 20 app2")).toContain('"signal":"SIGTERM","msg":"stopping"');
    } finally {
      compose("up -d --wait app2");
    }
    expect(state("app2").State).toBe("running");
    expect((await fetch("http://127.0.0.1:3402/api/health/live")).status).toBe(200);
    // the first instance was not touched
    expect((await fetch("http://127.0.0.1:3400/api/health/live")).status).toBe(200);
  });
});
