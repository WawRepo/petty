import pg from "pg";
import { config } from "./config.js";
import { checkDbUrl } from "./db-url.js";

checkDbUrl("API_DATABASE_URL", config.apiDatabaseUrl);
checkDbUrl("MAINT_DATABASE_URL", config.maintDatabaseUrl);

/** Pool for ordinary requests. Connects as petty_api. */
export const apiPool = new pg.Pool({ connectionString: config.apiDatabaseUrl, max: 5 });

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
