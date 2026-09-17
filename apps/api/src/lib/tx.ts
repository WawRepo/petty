import type pg from "pg";

/** Runs `fn` inside BEGIN/COMMIT on one client; ROLLBACK on any throw. */
export async function withTx<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (e) {
    try { await client.query("rollback"); } catch { /* connection already broken */ }
    throw e;
  } finally {
    client.release();
  }
}

export type Queryable = pg.Pool | pg.PoolClient;
