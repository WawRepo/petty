import { createClerkClient, verifyToken } from "@clerk/backend";
import { config } from "../config.js";

/**
 * Clerk (PETTY-88): the API never talks to Clerk on the request path except to verify the
 * session token's signature (offline with CLERK_JWT_KEY, else JWKS fetched once and cached
 * by the SDK). The backend API is used only for provisioning (email, name), account
 * deletion and admin session revocation.
 */
export interface ClerkIdentity { readonly sub: string; readonly sid: string | null }

export async function verifyClerkToken(token: string): Promise<ClerkIdentity | null> {
  try {
    // Resolves to the payload; any signature, expiry or format problem throws.
    const p = (await verifyToken(token, {
      ...(config.clerkJwtKey ? { jwtKey: config.clerkJwtKey } : {}),
      ...(config.clerkSecretKey ? { secretKey: config.clerkSecretKey } : {}),
      clockSkewInMs: 30_000,
    })) as unknown as { sub?: string; sid?: string } | { data?: { sub?: string; sid?: string }; errors?: unknown[] };
    const payload = "errors" in p || "data" in p ? ((p as { errors?: unknown[] }).errors ? undefined : (p as { data?: { sub?: string; sid?: string } }).data) : (p as { sub?: string; sid?: string });
    if (!payload?.sub) return null;
    return { sub: payload.sub, sid: payload.sid ?? null };
  } catch {
    return null;
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
