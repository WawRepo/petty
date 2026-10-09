import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { apiPool } from "../db.js";
import { config } from "../config.js";
import { randomToken, sha256 } from "./bytes.js";
import { forbidden, unauthorized } from "./errors.js";

import { clerkProfile, clerkUserExists, verifyClerkToken, type ClerkIdentity } from "./clerk.js";
import { mails } from "./mail.js";
import { assertTokenMay, authenticateToken, PAT_PREFIX } from "./tokens.js";

export interface SessionUser { id: string; email: string; display_name: string; locale: string; is_admin: boolean }
declare module "fastify" {
  /** `clerk`: the verified Clerk identity of this request (clerk mode), whether or not a users row exists yet. */
  interface FastifyRequest { user: SessionUser | null; sessionId: string | null; clerk: ClerkIdentity | null }
}

// __Host- binds the cookie to this host, the root path and HTTPS (SR-13). Browsers refuse the
// prefix over plain http, so the dev server keeps the plain name.
export const COOKIE = config.secureCookies ? "__Host-petty_session" : "petty_session";
const SESSION_DAYS = 30;

export async function createSession(reply: FastifyReply, userId: string): Promise<void> {
  if (config.authProvider === "clerk") return; // the session is Clerk's
  const token = randomToken(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await apiPool.query("insert into sessions (user_id, token_hash, expires_at) values ($1, $2, $3)", [userId, sha256(token), expires]);
  reply.setCookie(COOKIE, token, { httpOnly: true, sameSite: "lax", secure: config.secureCookies, path: "/", expires });
}

export async function destroySession(reply: FastifyReply, sessionId: string | null): Promise<void> {
  if (sessionId) await apiPool.query("delete from sessions where id = $1", [sessionId]);
  if (config.authProvider !== "clerk") reply.clearCookie(COOKIE, { path: "/" });
}

/** In clerk mode the login password is gone: only routes that still have one check it. */
export const hasLoginPassword = (): boolean => config.authProvider === "local";

export function requireUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw unauthorized();
  return req.user;
}
/** Admin = a user with `is_admin`. Admins manage accounts (block, sign out, invite); they can read no drawer content — nobody can. */
export function requireAdmin(req: FastifyRequest): SessionUser {
  const u = requireUser(req);
  if (!u.is_admin) throw forbidden("AdminOnly");
  return u;
}

/**
 * PETTY-104: no row for this Clerk identity, but one may exist for its VERIFIED email — an
 * earlier Clerk account (email/password) replaced by a social sign-up, or a local-mode account
 * from before the switch to Clerk. Clerk keeps emails unique per instance, so the previous
 * identity is necessarily gone: the row is relinked to this identity and the user meets their
 * own vault (unlock), not the setup screen. Only on the miss path, so one Clerk API call per
 * new identity, not per request; a Clerk outage here means "no vault yet" for that request.
 *
 * PETTY-187 (review NR-7): a row still linked to a Clerk user that EXISTS is never taken over, even
 * with a verified email (an address can change hands, or a row's email can lag behind Clerk). Only
 * a row with no Clerk link, or whose linked Clerk user is gone, is relinked, and the stored address
 * is told when that happens.
 */
async function relinkByVerifiedEmail(sub: string): Promise<SessionUser | null> {
  let email: string;
  try {
    const p = await clerkProfile(sub);
    if (!p.emailVerified) return null;
    email = p.email;
  } catch { return null; }
  const found = (await apiPool.query<{ id: string; clerk_user_id: string | null }>(
    "select id, clerk_user_id from users where lower(email) = lower($1) and deleted_at is null and blocked_at is null and clerk_user_id is distinct from $2",
    [email, sub],
  )).rows[0];
  if (!found) return null;
  if (found.clerk_user_id && (await clerkUserExists(found.clerk_user_id))) return null;
  // The old link must still be the one we checked, so two racing sign-ins cannot both win.
  const { rows } = await apiPool.query<SessionUser>(
    `update users set clerk_user_id = $2 where id = $1 and clerk_user_id is not distinct from $3
     returning id, email, display_name, locale, is_admin`,
    [found.id, sub, found.clerk_user_id],
  );
  const u = rows[0] ?? null;
  if (u) mails.relinked(u.email, u.locale);
  return u;
}

/**
 * PETTY-241: "last seen" per user, in both modes (Clerk keeps no sessions rows here). At most one write per
 * user per 5 minutes: a per-process memory of the last touch skips the query, and the WHERE skips the write
 * when another instance touched the row meanwhile. The memory is only an optimisation (several instances
 * may each write once per window).
 */
const touched = new Map<string, number>();
function touchUser(userId: string): void {
  const now = Date.now();
  if (now - (touched.get(userId) ?? 0) < 5 * 60_000) return;
  touched.set(userId, now);
  if (touched.size > 10_000) touched.clear();
  apiPool.query("update users set last_seen_at = now() where id = $1 and (last_seen_at is null or last_seen_at < now() - interval '5 minutes')", [userId]).catch(() => undefined);
}

export const sessionPlugin = fp(async (app: FastifyInstance) => {
  app.decorateRequest("user", null);
  app.decorateRequest("sessionId", null);
  app.decorateRequest("clerk", null);
  app.decorateRequest("token", null);
  app.addHook("onRequest", async (req) => {
    // Access tokens (PETTY-164) work in both modes and are checked first: they carry their own prefix.
    const auth = req.headers.authorization ?? "";
    if (auth.startsWith(`Bearer ${PAT_PREFIX}`)) {
      const found = await authenticateToken(auth.slice(7).trim());
      if (!found) return;
      req.user = found.user;
      req.token = found.token;
      touchUser(found.user.id);
      return;
    }
    if (config.authProvider === "clerk") {
      // Clerk mode (PETTY-88): the session is Clerk's; the API verifies the bearer token and maps it to a users row.
      const h = req.headers.authorization ?? "";
      if (!h.startsWith("Bearer ")) return;
      const id = await verifyClerkToken(h.slice(7).trim());
      if (!id) return;
      req.clerk = id;
      const { rows } = await apiPool.query<SessionUser>(
        "select id, email, display_name, locale, is_admin from users where clerk_user_id = $1 and deleted_at is null and blocked_at is null",
        [id.sub],
      );
      req.user = rows[0] ?? (await relinkByVerifiedEmail(id.sub));
      if (req.user) touchUser(req.user.id);
      return;
    }
    const token = req.cookies[COOKIE];
    if (!token) return;
    const { rows } = await apiPool.query<{ sid: string; id: string; email: string; display_name: string; locale: string; is_admin: boolean; stale: boolean }>(
      `select s.id as sid, u.id, u.email, u.display_name, u.locale, u.is_admin, s.last_seen_at < now() - interval '5 minutes' as stale
         from sessions s join users u on u.id = s.user_id
        where s.token_hash = $1 and s.expires_at > now() and u.deleted_at is null and u.blocked_at is null`,
      [sha256(token)],
    );
    const r = rows[0];
    if (!r) return;
    req.user = { id: r.id, email: r.email, display_name: r.display_name, locale: r.locale, is_admin: r.is_admin };
    req.sessionId = r.sid;
    // At most one write per session per 5 minutes: last_seen_at is what "users active in the last 15m" counts.
    if (r.stale) apiPool.query("update sessions set last_seen_at = now() where id = $1", [r.sid]).catch(() => undefined);
    touchUser(r.id);
  });
  // Cross-site request forgery guard: mutations must be JSON, which browsers cannot send cross-origin without CORS.
  // A token may only do what tokens.ts allows, and only inside its scope.
  app.addHook("preHandler", async (req) => {
    if (req.token) assertTokenMay(req, req.token);
  });
  app.addHook("preHandler", async (req) => {
    if (req.method !== "GET" && req.method !== "HEAD" && req.user) {
      const ct = req.headers["content-type"] ?? "";
      if (req.body !== undefined && !ct.startsWith("application/json")) throw unauthorized();
    }
  });
});
