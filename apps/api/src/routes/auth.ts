import type { FastifyInstance } from "fastify";
import { ForgotBody, JoinLinkBody, JoinLinkInfo, JoinLinkResponse, LoginBody, Me, ProvisionBody, ResetBody, SignupBody, type PasskeyVault, type VaultBlob } from "@petty/protocol";
import { config } from "../config.js";
import { clerkProfile } from "../lib/clerk.js";
import { apiPool } from "../db.js";
import { iso, randomToken, sha256 } from "../lib/bytes.js";
import { ApiError, badRequest, conflict, unauthorized } from "../lib/errors.js";
import { DUMMY_HASH, LOGIN_LIMIT_PER_EMAIL, LOGIN_LIMIT_PER_IP, checkRate, failuresExceeded, hashPassword, recordFailure, verifyPassword } from "../lib/password.js";
import { createSession, destroySession, requireUser } from "../lib/session.js";
import { withTx, type Queryable } from "../lib/tx.js";
import { endAllTokens } from "../lib/tokens.js";
import { mails } from "../lib/mail.js";
import { authEvents } from "../lib/metrics.js";
import { loadMe } from "./me.js";

const JOIN_LINK_DAYS = 7;

interface VaultMaterial { keys: { ecdh_pub: string; ecdsa_pub: string }; vault?: VaultBlob | undefined; passkey?: PasskeyVault | undefined; recovery_vault: VaultBlob }
/** Every copy of the keys must be of its own kind and carry the published public keys; at least one everyday door (passphrase or passkey) must exist (PETTY-102). */
function checkVaultMaterial(body: VaultMaterial): void {
  const same = (v: VaultBlob) => v.pub.ecdh === body.keys.ecdh_pub && v.pub.ecdsa === body.keys.ecdsa_pub;
  if (!body.vault && !body.passkey) throw badRequest("VaultKind", "a passphrase vault or a passkey is required");
  if ((body.vault && body.vault.kind !== "passphrase") || (body.passkey && body.passkey.vault.kind !== "passkey") || body.recovery_vault.kind !== "recovery") throw badRequest("VaultKind", "vault kinds are wrong");
  if ((body.vault && !same(body.vault)) || (body.passkey && !same(body.passkey.vault)) || !same(body.recovery_vault)) throw badRequest("KeysMismatch", "vault public keys do not match published keys");
}
async function insertPasskey(db: Queryable, userId: string, pk: PasskeyVault | undefined): Promise<void> {
  if (!pk) return;
  await db.query("insert into passkey_vaults (user_id, credential_id, prf_salt, vault, label, transports) values ($1, $2, $3, $4, $5, $6)", [userId, pk.credential_id, pk.prf_salt, JSON.stringify(pk.vault), pk.label, pk.transports]);
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  if (config.authProvider === "clerk") {
    // Clerk mode (PETTY-88, docs/auth-clerk.md): identity is Clerk's. The only auth route is provisioning the vault.
    app.post("/auth/provision", async (req, reply) => {
      const id = req.clerk;
      if (!id) throw unauthorized();
      if (req.user) throw conflict("AlreadyProvisioned", "this account already has a vault");
      const body = ProvisionBody.parse(req.body);
      checkVaultMaterial(body);
      const profile = await clerkProfile(id.sub);
      const me = await withTx(apiPool, async (db) => {
        const exists = await db.query("select 1 from users where clerk_user_id = $1 or (lower(email) = lower($2) and deleted_at is null)", [id.sub, profile.email]);
        if (exists.rowCount) throw conflict("EmailTaken", "email already registered");
        const user = (await db.query<{ id: string }>(
          "insert into users (email, display_name, password_hash, locale, vault, recovery_vault, clerk_user_id) values ($1, $2, null, $3, $4, $5, $6) returning id",
          [profile.email, body.display_name ?? profile.name, body.locale, body.vault ? JSON.stringify(body.vault) : null, JSON.stringify(body.recovery_vault), id.sub],
        )).rows[0]!;
        await db.query("insert into user_keys (user_id, ecdh_pub, ecdsa_pub, sig_key_id) values ($1, $2, $3, $4)", [user.id, body.keys.ecdh_pub, body.keys.ecdsa_pub, body.keys.sig_key_id]);
        await insertPasskey(db, user.id, body.passkey);
        return loadMe(db, user.id);
      });
      authEvents.inc({ event: "signup" });
      return reply.code(201).send(Me.parse(me));
    });
    for (const path of ["/auth/signup", "/auth/login", "/auth/forgot", "/auth/reset", "/auth/logout", "/join-links"]) {
      app.post(path, async () => { throw new ApiError(404, "NotAvailable", "identity is managed by Clerk"); });
    }
    app.get("/join-links/:token", async () => { throw new ApiError(404, "NotAvailable", "identity is managed by Clerk"); });
    return;
  }

  /** Invite-only signup. The client generated the keys and both vault blobs; the server stores what it cannot open. */
  app.post("/auth/signup", async (req, reply) => {
    const body = SignupBody.parse(req.body);
    const me = await withTx(apiPool, async (db) => {
      const link = (await db.query<{ id: string; email: string | null }>(
        "select id, email from join_links where token_hash = $1 and used_at is null and expires_at > now() for update",
        [sha256(body.join_token)],
      )).rows[0];
      if (!link) throw badRequest("JoinLinkInvalid", "join link is invalid or used");
      if (link.email && link.email.toLowerCase() !== body.email.toLowerCase()) throw badRequest("JoinLinkEmailMismatch", "join link is for another address");
      checkVaultMaterial(body);
      const exists = await db.query("select 1 from users where lower(email) = lower($1)", [body.email]);
      if (exists.rowCount) throw conflict("EmailTaken", "email already registered");
      const user = (await db.query<{ id: string }>(
        "insert into users (email, display_name, password_hash, locale, vault, recovery_vault) values ($1, $2, $3, $4, $5, $6) returning id",
        [body.email, body.display_name, await hashPassword(body.password), body.locale, body.vault ? JSON.stringify(body.vault) : null, JSON.stringify(body.recovery_vault)],
      )).rows[0]!;
      await db.query("insert into user_keys (user_id, ecdh_pub, ecdsa_pub, sig_key_id) values ($1, $2, $3, $4)", [user.id, body.keys.ecdh_pub, body.keys.ecdsa_pub, body.keys.sig_key_id]);
      await insertPasskey(db, user.id, body.passkey);
      await db.query("update join_links set used_by = $1, used_at = now() where id = $2", [user.id, link.id]);
      return loadMe(db, user.id);
    });
    await createSession(reply, me.id);
    authEvents.inc({ event: "signup" });
    return reply.code(201).send(Me.parse(me));
  });

  app.post("/auth/login", async (req, reply) => {
    const body = LoginBody.parse(req.body);
    const emailKey = `login:${body.email.toLowerCase()}`;
    if (!checkRate(`login:${req.ip}`, LOGIN_LIMIT_PER_IP) || failuresExceeded(emailKey, LOGIN_LIMIT_PER_EMAIL)) {
      authEvents.inc({ event: "rate_limited" });
      throw new ApiError(429, "TooManyAttempts", "try again later");
    }
    const { rows } = await apiPool.query<{ id: string; password_hash: string; blocked_at: Date | null }>("select id, password_hash, blocked_at from users where lower(email) = lower($1) and deleted_at is null", [body.email]);
    const u = rows[0];
    // Unknown email, wrong password and blocked account all cost one Argon2id verify and answer alike: nothing to enumerate, by content or by timing.
    const ok = await verifyPassword(body.password, u?.password_hash ?? DUMMY_HASH);
    if (!u || !ok || u.blocked_at) {
      recordFailure(emailKey);
      authEvents.inc({ event: "login_fail" });
      throw unauthorized();
    }
    await createSession(reply, u.id);
    authEvents.inc({ event: "login_ok" });
    return Me.parse(await loadMe(apiPool, u.id));
  });

  /**
   * Login-password reset (Phase 15a). Always 204: the response never says whether the
   * address exists. The mail carries a one-hour, single-use link. The vault is untouched —
   * a new login password opens the account, not the data.
   */
  app.post("/auth/forgot", async (req, reply) => {
    const body = ForgotBody.parse(req.body);
    if (!checkRate(`forgot:${req.ip}`, LOGIN_LIMIT_PER_IP)) {
      authEvents.inc({ event: "rate_limited" });
      throw new ApiError(429, "TooManyAttempts", "try again later");
    }
    authEvents.inc({ event: "forgot" });
    if (checkRate(`forgot:${body.email.toLowerCase()}`, 5, 60 * 60_000)) {
      const u = (await apiPool.query<{ id: string; locale: string }>("select id, locale from users where lower(email) = lower($1) and deleted_at is null and blocked_at is null", [body.email])).rows[0];
      if (u) {
        const token = randomToken(32);
        await apiPool.query("insert into password_resets (user_id, token_hash, expires_at) values ($1, $2, now() + interval '1 hour')", [u.id, sha256(token)]);
        mails.passwordReset(body.email, token, u.locale);
      }
    }
    return reply.code(204).send();
  });

  app.post("/auth/reset", async (req, reply) => {
    const body = ResetBody.parse(req.body);
    const who = await withTx(apiPool, async (db) => {
      const r = (await db.query<{ id: string; user_id: string; email: string; locale: string }>("select r.id, r.user_id, u.email, u.locale from password_resets r join users u on u.id = r.user_id where r.token_hash = $1 and r.used_at is null and r.expires_at > now() for update of r", [sha256(body.token)])).rows[0];
      if (!r) throw badRequest("ResetInvalid", "reset link is invalid, used or expired");
      await db.query("update users set password_hash = $2 where id = $1", [r.user_id, await hashPassword(body.password)]);
      await db.query("update password_resets set used_at = now() where id = $1", [r.id]);
      await db.query("delete from sessions where user_id = $1", [r.user_id]);
      await endAllTokens(db, r.user_id, { erase: false });
      return r;
    });
    // The owner hears about it (SR-2): a reset they did not ask for is the first sign of a stolen mailbox.
    mails.passwordChanged(who.email, who.locale);
    authEvents.inc({ event: "reset" });
    return reply.code(204).send();
  });

  app.post("/auth/logout", async (req, reply) => {
    await destroySession(reply, req.sessionId);
    authEvents.inc({ event: "logout" });
    return reply.code(204).send();
  });

  app.post("/join-links", async (req, reply) => {
    const me = requireUser(req);
    // Five invites an hour per member: enough for a household, useless as a mail relay (SR-9).
    if (!checkRate(`joinlinks:${me.id}`, 5, 60 * 60_000)) throw new ApiError(429, "TooManyAttempts", "try again later");
    const body = JoinLinkBody.parse(req.body ?? {});
    const token = randomToken(24);
    const expires = new Date(Date.now() + JOIN_LINK_DAYS * 86_400_000);
    await apiPool.query("insert into join_links (token_hash, created_by, email, expires_at) values ($1, $2, $3, $4)", [sha256(token), me.id, body.email ?? null, expires]);
    if (body.email) mails.joinLink(body.email, me.display_name, token);
    return reply.code(201).send(JoinLinkResponse.parse({ token, expires_at: iso(expires) }));
  });

  app.get<{ Params: { token: string } }>("/join-links/:token", async (req) => {
    const { rows } = await apiPool.query<{ email: string | null; inviter: string | null }>(
      `select l.email, u.display_name as inviter from join_links l left join users u on u.id = l.created_by
        where l.token_hash = $1 and l.used_at is null and l.expires_at > now()`,
      [sha256(req.params.token)],
    );
    const r = rows[0];
    return JoinLinkInfo.parse({ valid: !!r, inviter_name: r?.inviter ?? null, email: r?.email ?? null });
  });
}
