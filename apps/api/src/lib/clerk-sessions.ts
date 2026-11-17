import { apiPool } from "../db.js";
import { sha256 } from "./bytes.js";
import { authEvents } from "./metrics.js";

const TOUCH_MS = 24 * 60 * 60_000;

/**
 * PETTY-285: under Clerk, Clerk signs people in and Petty never saw a sign-in. It counts one
 * (petty_auth_events_total{event="clerk_signin"}) the first time a request carries a Clerk session it has
 * not seen: the token's `sid`. Table clerk_sessions_seen remembers the sessions seen, by a hash of the id
 * and with no link to an account, so a restart or a second instance does not count one session twice; the
 * insert that adds the row is the one that counts. A process remembers the sessions it wrote for a day, so a
 * session costs one query per process per day; that write moves the row's `seen_at` on, and maintenance
 * deletes a row not seen for CLERK_SESSION_DAYS (30). A session unused that long and then used again counts again.
 */
const written = new Map<string, number>();

export async function noteClerkSession(sid: string): Promise<void> {
  const now = Date.now();
  if (now - (written.get(sid) ?? 0) < TOUCH_MS) return;
  if (written.size >= 10_000) written.clear();
  written.set(sid, now);
  const hash = sha256(sid);
  try {
    const added = await apiPool.query("insert into clerk_sessions_seen (sid_hash) values ($1) on conflict (sid_hash) do nothing", [hash]);
    if (added.rowCount === 1) authEvents.inc({ event: "clerk_signin" });
    else await apiPool.query("update clerk_sessions_seen set seen_at = now() where sid_hash = $1", [hash]);
  } catch {
    written.delete(sid); // try again on the next request
  }
}

/** Test hook: forget what this process wrote, as a restart does. */
export const forgetClerkSessions = (): void => written.clear();
