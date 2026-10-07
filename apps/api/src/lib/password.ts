import { argon2Verify, argon2id } from "hash-wasm";
import { createHash, randomBytes } from "node:crypto";
import { apiPool } from "../db.js";

/** Login password only. The vault passphrase never reaches the server. */
export async function hashPassword(password: string): Promise<string> {
  return argon2id({ password, salt: randomBytes(16), parallelism: 1, iterations: 2, memorySize: 19 * 1024, hashLength: 32, outputType: "encoded" });
}
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  try { return await argon2Verify({ password, hash: encoded }); } catch { return false; }
}
/**
 * Verified against when the email is unknown, so a login attempt costs the same
 * Argon2id time whether or not the address exists (security review SR-7).
 */
export const DUMMY_HASH: string = await hashPassword(randomBytes(24).toString("hex"));

/**
 * The limiter (security review SR-7). Two shapes:
 *  - checkRate: counts every call (per-IP login, forgot, invite minting, the general API limit).
 *  - failuresExceeded / recordFailure: per-email login lockout counts only WRONG
 *    passwords, so a household member cannot be locked out by ten quick sign-ins.
 * Counts live in the database since PETTY-334, so every instance of the API shares them (no sticky
 * sessions needed); keys are hashed, since they hold addresses and attacker-chosen emails. A row lasts
 * one window; runMaintenance deletes the expired ones.
 */
export const LOGIN_LIMIT_PER_EMAIL = Number(process.env["LOGIN_LIMIT_PER_EMAIL"] ?? 10);
export const LOGIN_LIMIT_PER_IP = Number(process.env["LOGIN_LIMIT_PER_IP"] ?? 100);
export const DEFAULT_WINDOW_MS = 15 * 60_000;

const keyHash = (key: string) => createHash("sha256").update(key).digest();
/** One more in the key's window (a new window when the last one ended); the count so far. */
async function bump(key: string, windowMs: number): Promise<number> {
  const r = await apiPool.query<{ n: number }>(
    `insert into rate_counters (key_hash, n, reset_at) values ($1, 1, now() + make_interval(secs => $2::float8 / 1000))
     on conflict (key_hash) do update set
       n        = case when rate_counters.reset_at < now() then 1 else rate_counters.n + 1 end,
       reset_at = case when rate_counters.reset_at < now() then excluded.reset_at else rate_counters.reset_at end
     returning n`,
    [keyHash(key), windowMs],
  );
  return r.rows[0]!.n;
}
export async function checkRate(key: string, max: number, windowMs = DEFAULT_WINDOW_MS): Promise<boolean> {
  return (await bump(key, windowMs)) <= max;
}
export async function failuresExceeded(key: string, max: number): Promise<boolean> {
  const r = await apiPool.query<{ n: number }>("select n from rate_counters where key_hash = $1 and reset_at >= now()", [keyHash(key)]);
  return (r.rows[0]?.n ?? 0) >= max;
}
export async function recordFailure(key: string, windowMs = DEFAULT_WINDOW_MS): Promise<void> {
  await bump(key, windowMs);
}
