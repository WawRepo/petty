// Runs before the migrations (`pnpm migrate`): a clear message instead of the driver's "Invalid URL".
import { config } from "./config.js";
import { checkDbUrl } from "./db-url.js";

try {
  checkDbUrl("DATABASE_URL", config.ownerDatabaseUrl);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
