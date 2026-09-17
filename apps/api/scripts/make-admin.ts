/**
 * Grants (or revokes, with --revoke) the admin flag. Run inside the API container:
 *   kubectl exec deploy/petty -n petty -- pnpm --filter @petty/api make-admin you@example.com
 * Uses the request role; admins can manage accounts but read no drawer content.
 */
import pg from "pg";
import { config } from "../src/config.js";

const email = process.argv[2];
const revoke = process.argv.includes("--revoke");
if (!email) { process.stderr.write("usage: make-admin <email> [--revoke]\n"); process.exit(2); }
const client = new pg.Client({ connectionString: config.apiDatabaseUrl });
await client.connect();
const r = await client.query("update users set is_admin = $2 where lower(email) = lower($1) and deleted_at is null", [email, !revoke]);
await client.end();
if (!r.rowCount) { process.stderr.write("no such user\n"); process.exit(1); }
process.stdout.write(`${email}: admin ${revoke ? "revoked" : "granted"}\n`);
