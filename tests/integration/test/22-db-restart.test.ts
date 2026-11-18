import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { compose, newUser } from "../lib.js";

/**
 * PETTY-530: Postgres ends every open connection when it stops or another server takes over (a CNPG
 * switchover on a cluster, a database image update here). Before the fix, an idle pooled connection that
 * got this error was an uncaught "error" event, and the API exited. The db container stops with a fast
 * shutdown (the postgres image's stop signal is SIGINT), so each session gets FATAL 57P01, as in a
 * switchover. Both instances must log the loss, keep running, and work again once the database is back.
 * After 21-stop, the last file: both instances lose the database for a moment.
 */
const INSTANCES = { app: "http://127.0.0.1:3400", app2: "http://127.0.0.1:3402" } as const;
type Service = keyof typeof INSTANCES;

/** When the container started, and how often Docker restarted it: a crash changes one of them. */
const started = (service: Service): string =>
  execSync(`docker inspect -f '{{.State.StartedAt}} {{.RestartCount}}' ${compose(`ps -q ${service}`).trim()}`, { encoding: "utf8" }).trim();

const health = async (service: Service): Promise<number> => {
  try { return (await fetch(`${INSTANCES[service]}/api/health`)).status; } catch { return 0; }
};

describe("the database restarts under a running API", () => {
  it("both instances log the lost connections, keep running, and work again", async () => {
    const before = { app: started("app"), app2: started("app2") };
    // A request just before the stop leaves a connection idle in each instance's pool (idle ones close after 10 s).
    for (const s of ["app", "app2"] as const) expect(await health(s), s).toBe(200);
    const since = new Date().toISOString();

    compose("restart db");
    compose("up -d --wait db");

    for (const s of ["app", "app2"] as const) {
      await expect.poll(() => health(s), { timeout: 30_000, interval: 500 }).toBe(200);
      expect(started(s), `${s} restarted`).toBe(before[s]);
      const log = compose(`logs --no-color --no-log-prefix --since ${since} ${s}`);
      expect(log, s).toContain('"msg":"database connection lost"');
      expect(log, s).toContain('"code":"57P01"');
    }

    // A write after the restart: a new account (the join link script and the signup both use the database).
    await newUser("afterdbrestart");
  });
});
