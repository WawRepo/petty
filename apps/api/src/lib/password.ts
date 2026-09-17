import { argon2Verify, argon2id } from "hash-wasm";
import { randomBytes } from "node:crypto";

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
 * Small in-memory limiter. Two shapes (security review SR-7):
 *  - checkRate: counts every call (per-IP login, forgot, invite minting).
 *  - failuresExceeded / recordFailure: per-email login lockout counts only WRONG
 *    passwords, so a household member cannot be locked out by ten quick sign-ins.
 * Expired keys are pruned once a minute; keys are attacker-chosen emails, so the
 * map must not grow for the life of the process.
 */
const attempts = new Map<string, { n: number; resetAt: number }>();
let lastPrune = 0;
function prune(now: number): void {
  if (now - lastPrune < 60_000) return;
  lastPrune = now;
  for (const [k, a] of attempts) if (a.resetAt < now) attempts.delete(k);
}
export const LOGIN_LIMIT_PER_EMAIL = Number(process.env["LOGIN_LIMIT_PER_EMAIL"] ?? 10);
export const LOGIN_LIMIT_PER_IP = Number(process.env["LOGIN_LIMIT_PER_IP"] ?? 100);
export const DEFAULT_WINDOW_MS = 15 * 60_000;

export function checkRate(key: string, max: number, windowMs = DEFAULT_WINDOW_MS): boolean {
  const now = Date.now();
  prune(now);
  const a = attempts.get(key);
  if (!a || a.resetAt < now) { attempts.set(key, { n: 1, resetAt: now + windowMs }); return true; }
  a.n += 1;
  return a.n <= max;
}
export function failuresExceeded(key: string, max: number): boolean {
  const now = Date.now();
  prune(now);
  const a = attempts.get(key);
  return !!a && a.resetAt >= now && a.n >= max;
}
export function recordFailure(key: string, windowMs = DEFAULT_WINDOW_MS): void {
  const now = Date.now();
  const a = attempts.get(key);
  if (!a || a.resetAt < now) attempts.set(key, { n: 1, resetAt: now + windowMs });
  else a.n += 1;
}
/** Test hook: how many keys the limiter holds. */
export function limiterSize(): number { prune(Date.now()); return attempts.size; }
