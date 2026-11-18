import pg from "pg";
import { config } from "../src/config.js";
import { runMaintenance } from "../src/lib/maintenance.js";

/** Any fixed number: the key of the advisory lock below. */
const LOCK = 532;

/**
 * PETTY-532: vitest runs test files at the same time, and several of them run housekeeping on the one test
 * database. Two runs that overlap can trip each other: one skips a row the other has locked and returns
 * before the other commits, so a test sees the row it expects gone still there. Here the runs take turns:
 * each first takes a database-wide advisory lock, and ending its connection gives the lock back.
 * A count a run returns can still be lower than the rows a test made, as another file's run may have taken
 * them first: tests check their own rows, not that count.
 */
export async function runMaintenanceAlone(): ReturnType<typeof runMaintenance> {
  const c = new pg.Client({ connectionString: config.apiDatabaseUrl });
  await c.connect();
  try {
    await c.query("select pg_advisory_lock($1)", [LOCK]);
    return await runMaintenance();
  } finally {
    await c.end();
  }
}
