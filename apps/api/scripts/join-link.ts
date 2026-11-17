/**
 * Mints a join link without an existing user — for the very first account of an
 * installation (signup is invite-only). Run inside the API container:
 *   <exec into the API container> pnpm --filter @petty/api join-link [email]
 * Uses the request role (petty_api), which may insert join links.
 */
import pg from "pg";
import { config } from "../src/config.js";
import { randomToken, sha256 } from "../src/lib/bytes.js";
import { linkEmailColumns } from "../src/lib/email-seal.js";

const email = process.argv[2] ?? null;
const client = new pg.Client({ connectionString: config.apiDatabaseUrl });
await client.connect();
const token = randomToken(24);
const id = crypto.randomUUID();
const e = await linkEmailColumns(id, email); // PETTY-359: sealed with this container's EMAIL_KEY, if it has one
await client.query(
  "insert into join_links (id, token_hash, email, email_sealed, email_key_id, expires_at) values ($1, $2, $3, $4, $5, now() + interval '7 days')",
  [id, sha256(token), e.email, e.email_sealed, e.email_key_id],
);
await client.end();
// The token goes after "#", the part of an address a browser never sends to a server, as in the emailed links.
process.stdout.write(`${config.appUrl}/join#${token}\n`);
