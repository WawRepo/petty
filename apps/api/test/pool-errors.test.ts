/**
 * PETTY-530: Postgres ends every connection when it restarts or another server takes over (a CNPG
 * switchover sends FATAL 57P01). Before the fix, an idle pooled connection that got this error was an
 * uncaught "error" event and the API process exited. Here the test ends connections the same way, with
 * pg_terminate_backend (the error code is the same 57P01), and the API must log it and go on.
 * Vitest fails the run on an uncaught error, so a missing listener fails this file.
 */
import pg from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";

const { config } = await import("../src/config.js");
const { apiPool, bgPool, maintPool, logPoolErrors } = await import("../src/db.js");
const { withTx } = await import("../src/lib/tx.js");

const warnings: { fields: unknown; msg: string }[] = [];
logPoolErrors({ warn: ((fields: unknown, msg: string) => { warnings.push({ fields, msg }); }) as never });

// A connection of its own as petty_api: a role may end its own sessions.
const killer = new pg.Client({ connectionString: config.apiDatabaseUrl });
await killer.connect();
afterAll(async () => { await killer.end(); await apiPool.end(); await bgPool.end(); await maintPool.end(); });

const pidOf = async (c: pg.ClientBase): Promise<number> =>
  (await c.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
const terminate = async (pid: number): Promise<boolean> =>
  (await killer.query<{ ok: boolean }>("select pg_terminate_backend($1) as ok", [pid])).rows[0]!.ok;

describe("a database connection that Postgres ends (PETTY-530)", () => {
  it("an idle pooled connection is logged and replaced; the API keeps going", async () => {
    const c = await apiPool.connect();
    const pid = await pidOf(c);
    c.release();
    expect(await terminate(pid)).toBe(true);
    await vi.waitFor(() => expect(warnings).toContainEqual({
      msg: "database connection lost",
      fields: { pool: "api", err: expect.objectContaining({ code: "57P01" }) },
    }));
    const next = (await apiPool.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
    expect(next).not.toBe(pid);
  });

  it("a transaction whose connection ends between two queries fails, and the pool closes that client", async () => {
    const before = warnings.length;
    let pid = 0;
    await expect(withTx(apiPool, async (c) => {
      pid = await pidOf(c);
      expect(await terminate(pid)).toBe(true);
      // Wait until the client got the error while no query runs: the case pg-pool has no listener for.
      await vi.waitFor(() => expect((c as unknown as { _queryable: boolean })._queryable).toBe(false));
      await c.query("select 1");
    })).rejects.toThrow();
    expect(warnings.length).toBe(before); // the transaction's own error, not a pool warning
    const next = (await apiPool.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
    expect(next).not.toBe(pid);
  });
});
