import pg from "pg";
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

export async function dbIsUp(): Promise<boolean> {
  try {
    await apiPool.query("select 1");
    return true;
  } catch {
    return false;
  }
}
