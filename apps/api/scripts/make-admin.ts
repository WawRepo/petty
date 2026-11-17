/**
 * Grants (or revokes, with --revoke) the admin flag. Run inside the API container:
 *   <exec into the API container> pnpm --filter @petty/api make-admin you@example.com
 * Uses the request role; admins can manage accounts but read no drawer content.
 */
import pg from "pg";
import { config } from "../src/config.js";
import { emailMatchParams, emailMatchSql } from "../src/lib/email-seal.js";

const email = process.argv[2];
const revoke = process.argv.includes("--revoke");
if (!email) { process.stderr.write("usage: make-admin <email> [--revoke]\n"); process.exit(2); }
const client = new pg.Client({ connectionString: config.apiDatabaseUrl });
await client.connect();
// PETTY-359: the address is found plain or sealed, with this container's EMAIL_KEY
const r = await client.query(`update users u set is_admin = $1 where ${emailMatchSql("u", 2)} and u.deleted_at is null`, [!revoke, ...(await emailMatchParams(email))]);
await client.end();
if (!r.rowCount) { process.stderr.write("no such user\n"); process.exit(1); }
process.stdout.write(`${email}: admin ${revoke ? "revoked" : "granted"}\n`);
