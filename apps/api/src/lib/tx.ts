import type pg from "pg";

/**
 * Runs `fn` inside BEGIN/COMMIT on one client; ROLLBACK on any throw. pg-pool takes its error listener off
 * a client while it is checked out, so a connection that ends between two queries (PETTY-530: a Postgres
 * switchover) would be an uncaught "error" event. The listener here keeps the error; the next query then
 * fails, and the client goes back with it, so the pool closes it instead of keeping it.
 */
export async function withTx<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let lost: Error | undefined;
  const onError = (err: Error): void => { lost = err; };
  client.on("error", onError);
  try {
    await client.query("begin");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (e) {
    try { await client.query("rollback"); } catch { /* connection already broken */ }
    throw e;
  } finally {
    client.removeListener("error", onError);
    client.release(lost);
  }
}

export type Queryable = pg.Pool | pg.PoolClient;
