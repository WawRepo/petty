import { createClerkClient, verifyToken } from "@clerk/backend";
import { TokenVerificationErrorReason as Reason } from "@clerk/backend/errors";
import { config } from "../config.js";

/**
 * Clerk (PETTY-88): the API never talks to Clerk on the request path except to verify the
 * session token's signature (offline with CLERK_JWT_KEY, else JWKS fetched once and cached
 * by the SDK). The backend API is used only for provisioning (email, name), account
 * deletion and admin session revocation.
 */
export interface ClerkIdentity { readonly sub: string; readonly sid: string | null }

/** PETTY-189 (NR-9): the origins a session token must have been made for. */
const authorizedParties = (): string[] => (config.clerkAuthorizedParties.length ? config.clerkAuthorizedParties : [new URL(config.appUrl).origin]);

/**
 * Why a session token was refused (PETTY-285), for petty_auth_events_total:
 *  - `expired`: outside its time window (expired, not yet valid, issued "in the future"). Some are normal:
 *    the browser keeps a token about a minute, and a request can leave just before the next one arrives.
 *  - `invalid`: everything else: a bad signature, another Clerk instance's key, the wrong issuer or
 *    authorized party, no subject, not a token at all, and also Petty's own Clerk key being wrong or
 *    Clerk's key list not loading. Normal use sends none of these, so a rise means an attack or a broken key.
 */
export type ClerkRefusal = "expired" | "invalid";
export type ClerkCheck = { readonly identity: ClerkIdentity } | { readonly refused: ClerkRefusal };

const TIME_WINDOW: ReadonlySet<string> = new Set([Reason.TokenExpired, Reason.TokenNotActiveYet, Reason.TokenIatInTheFuture]);
/** The refusal a Clerk verification error stands for (its `reason`); anything without a time-window reason is `invalid`. */
export function refusalOf(err: unknown): ClerkRefusal {
  const reason = (err as { reason?: unknown } | null | undefined)?.reason;
  return typeof reason === "string" && TIME_WINDOW.has(reason) ? "expired" : "invalid";
}

/** Verifies a session token: the identity it carries, or why it was refused. */
export async function checkClerkToken(token: string): Promise<ClerkCheck> {
  try {
    const parties = authorizedParties();
    // Resolves to the payload, or to { errors } (a signature, expiry, format or authorized-party problem); some problems throw.
    const p = (await verifyToken(token, {
      ...(config.clerkJwtKey ? { jwtKey: config.clerkJwtKey } : {}),
      ...(config.clerkSecretKey ? { secretKey: config.clerkSecretKey } : {}),
      authorizedParties: parties,
      clockSkewInMs: 30_000,
    })) as unknown as { sub?: string; sid?: string; azp?: string } | { data?: { sub?: string; sid?: string; azp?: string }; errors?: unknown[] };
    const errors = "errors" in p ? (p as { errors?: unknown[] }).errors : undefined;
    if (errors?.length) return { refused: refusalOf(errors[0]) };
    const payload = "data" in p ? (p as { data?: { sub?: string; sid?: string; azp?: string } }).data : (p as { sub?: string; sid?: string; azp?: string });
    if (!payload?.sub) return { refused: "invalid" };
    // Clerk skips the check when a token has no azp; a browser session token always has one, so require it.
    if (!payload.azp || !parties.includes(payload.azp)) return { refused: "invalid" };
    return { identity: { sub: payload.sub, sid: payload.sid ?? null } };
  } catch (err) {
    return { refused: refusalOf(err) };
  }
}

let client: ReturnType<typeof createClerkClient> | null = null;
function clerk() {
  if (!config.clerkSecretKey) throw new Error("CLERK_SECRET_KEY is not set");
  return (client ??= createClerkClient({ secretKey: config.clerkSecretKey }));
}

/** Email (and whether Clerk verified it), display name of a Clerk user: for provisioning and for relinking (PETTY-104). */
export async function clerkProfile(userId: string): Promise<{ email: string; emailVerified: boolean; name: string }> {
  const u = await clerk().users.getUser(userId);
  const primary = u.emailAddresses.find((e) => e.id === u.primaryEmailAddressId) ?? u.emailAddresses[0];
  if (!primary) throw new Error("clerk user has no email");
  const name = [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.username || primary.emailAddress.split("@")[0]!;
  return { email: primary.emailAddress, emailVerified: primary.verification?.status === "verified", name };
}

/**
 * Does this Clerk user still exist? Only a clear "not found" from Clerk counts as gone; any other
 * error (network, rate limit) answers true, so a relink is refused rather than risked (PETTY-187).
 */
export async function clerkUserExists(userId: string): Promise<boolean> {
  try {
    await clerk().users.getUser(userId);
    return true;
  } catch (e) {
    return (e as { status?: number }).status !== 404;
  }
}

export async function deleteClerkUser(userId: string): Promise<void> {
  await clerk().users.deleteUser(userId);
}

export async function revokeClerkSessions(userId: string): Promise<number> {
  const list = await clerk().sessions.getSessionList({ userId, status: "active" });
  for (const s of list.data) await clerk().sessions.revokeSession(s.id);
  return list.data.length;
}
