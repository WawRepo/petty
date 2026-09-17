/**
 * Mints a join link without an existing user — for the very first account of an
 * installation (signup is invite-only). Run inside the API container:
 *   kubectl exec deploy/petty -n petty -- pnpm --filter @petty/api join-link [email]
 * Uses the request role (petty_api), which may insert join links.
 */
import pg from "pg";
import { config } from "../src/config.js";
import { randomToken, sha256 } from "../src/lib/bytes.js";

const email = process.argv[2] ?? null;
const client = new pg.Client({ connectionString: config.apiDatabaseUrl });
await client.connect();
const token = randomToken(24);
await client.query("insert into join_links (token_hash, email, expires_at) values ($1, $2, now() + interval '7 days')", [sha256(token), email]);
await client.end();
process.stdout.write(`${config.appUrl}/join/${token}\n`);
