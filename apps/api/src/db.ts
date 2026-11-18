import pg from "pg";
import type { FastifyBaseLogger } from "fastify";
import { config } from "./config.js";
import { checkDbUrl } from "./db-url.js";

checkDbUrl("API_DATABASE_URL", config.apiDatabaseUrl);
checkDbUrl("MAINT_DATABASE_URL", config.maintDatabaseUrl);

/** Pool for ordinary requests. Connects as petty_api. */
export const apiPool = new pg.Pool({ connectionString: config.apiDatabaseUrl, max: 5 });

/**
 * Pool for the API's own background work (housekeeping, usage gauges), as petty_api (PETTY-355). Kept apart
 * so that an apiPool checkout means "a request used the database": a hosted database that scales to zero
 * (suspended after a few idle minutes, billed while awake) must not be kept awake by the API polling itself.
 */
export const bgPool = new pg.Pool({ connectionString: config.apiDatabaseUrl, max: 1 });

let requestUse = 0;
apiPool.on("acquire", () => { requestUse = Date.now(); });
/** When a request last took a database connection (ms since the epoch; 0 = not since start). */
export const lastRequestUse = (): number => requestUse;

/** Pool for rotation and deletion. Connects as petty_maint. Open a client only inside those transactions. */
export const maintPool = new pg.Pool({ connectionString: config.maintDatabaseUrl, max: 2 });

type Warn = (fields: object, msg: string) => void;
let warn: Warn = (fields, msg) => console.warn(msg, fields);
/** Pool errors go to this logger (buildApp sets it). */
export function logPoolErrors(log: Pick<FastifyBaseLogger, "warn">): void {
  warn = (fields, msg) => log.warn(fields, msg);
}

/** The Postgres error code (57P01 = an administrator ended the connection), or the Node one, never the text. */
export const pgErrorFields = (err: Error): { name: string; code: string | null } =>
  ({ name: err.name, code: (err as { code?: unknown }).code?.toString() ?? null });

/**
 * PETTY-530: Postgres ends every connection when it restarts or another server takes over (a CNPG
 * switchover sends 57P01). pg-pool then drops the idle client and emits "error" on the pool; without a
 * listener Node treats that as an uncaught error and the API exits. Log it and go on: the next query
 * opens a new connection.
 */
for (const [pool, name] of [[apiPool, "api"], [bgPool, "background"], [maintPool, "maint"]] as const) {
  pool.on("error", (err) => warn({ pool: name, err: pgErrorFields(err) }, "database connection lost"));
}

export async function dbIsUp(): Promise<boolean> {
  try {
    await apiPool.query("select 1");
    return true;
  } catch {
    return false;
  }
}
