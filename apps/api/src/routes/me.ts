import type { FastifyInstance, FastifyRequest } from "fastify";
import { AddPasskeyBody, CustodyChallenge, DeleteAccountBody, DeletePreview, Me, PasskeyEntry, PasskeyVault, PatchMeBody, PutRecoveryVaultBody, PutUserDocBody, PutVaultBody, RemovePasskeyBody, StorageUsage, UserDocRow, UserLookup, VaultBlob, type Me as MeT } from "@petty/protocol";
import { config } from "../config.js";
import { storageUsed } from "../lib/quota.js";
import { consumeCustodyProof, issueChallenge } from "../lib/custody.js";
import { z } from "zod";
import { deleteClerkUser } from "../lib/clerk.js";
import { apiPool } from "../db.js";
import { badRequest, conflict, notFound, unauthorized, ApiError } from "../lib/errors.js";
import { verifyPassword } from "../lib/password.js";
import { maintPool } from "../db.js";
import { mails } from "../lib/mail.js";
import { destroySession, hasLoginPassword } from "../lib/session.js";
import { fromB64, iso, toB64 } from "../lib/bytes.js";
import { withTx } from "../lib/tx.js";
import { endAllTokens } from "../lib/tokens.js";
import { userKeys } from "../lib/rows.js";
import { requireUser } from "../lib/session.js";
import type { Queryable } from "../lib/tx.js";

interface PasskeyRow { id: string; credential_id: string; prf_salt: string; vault: unknown; label: string; transports: string[]; created_at: Date }
const passkeyEntry = (r: PasskeyRow): MeT["passkeys"][number] => PasskeyEntry.parse({ id: r.id, credential_id: r.credential_id, prf_salt: r.prf_salt, vault: r.vault, label: r.label, transports: r.transports, created_at: iso(r.created_at) });

export async function loadMe(db: Queryable, userId: string): Promise<MeT> {
  const { rows } = await db.query(
    `select u.id, u.email, u.display_name, u.locale, u.vault, u.is_admin, k.ecdh_pub, k.ecdsa_pub, k.sig_key_id, k.created_at, k.retired_at
       from users u join user_keys k on k.user_id = u.id and k.retired_at is null
      where u.id = $1`,
    [userId],
  );
  const r = rows[0];
  if (!r) throw notFound("UserNotFound");
  const pk = await db.query<PasskeyRow>("select id, credential_id, prf_salt, vault, label, transports, created_at from passkey_vaults where user_id = $1 order by created_at", [userId]);
  return { id: r.id, email: r.email, display_name: r.display_name, locale: r.locale, keys: userKeys(r)!, pub: { ecdh: r.ecdh_pub, ecdsa: r.ecdsa_pub }, vault: r.vault ?? null, passkeys: pk.rows.map(passkeyEntry), is_admin: r.is_admin };
}

export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get("/me", async (req) => {
    if (!req.user && req.clerk) throw new ApiError(404, "NoVault", "signed in with Clerk, no vault yet");
    return meGet(req);
  });
  const meGet = async (req: FastifyRequest) => Me.parse(await loadMe(apiPool, requireUser(req).id));

  app.patch("/me", async (req) => {
    const me = requireUser(req);
    const body = PatchMeBody.parse(req.body);
    await apiPool.query("update users set locale = coalesce($2, locale), display_name = coalesce($3, display_name) where id = $1", [me.id, body.locale ?? null, body.display_name ?? null]);
    return Me.parse(await loadMe(apiPool, me.id));
  });

  /** Exact-email lookup for inviting. Returns the active public keys so the inviter can pin and show the safety number. */
  app.get("/users/lookup", async (req) => {
    requireUser(req);
    const q = z.object({ email: z.string().email() }).parse(req.query);
    const { rows } = await apiPool.query(
      `select u.id, u.display_name, k.ecdh_pub, k.ecdsa_pub, k.sig_key_id, k.created_at, k.retired_at
         from users u left join user_keys k on k.user_id = u.id and k.retired_at is null
        where lower(u.email) = lower($1) and u.deleted_at is null`,
      [q.email],
    );
    const r = rows[0];
    if (!r) throw notFound("UserNotFound");
    return UserLookup.parse({ id: r.id, display_name: r.display_name, keys: userKeys(r) });
  });

  /** Every key a user ever published, so old entries can be verified against retired keys. */
  app.get<{ Params: { id: string } }>("/users/:id/keys", async (req) => {
    requireUser(req);
    const { rows } = await apiPool.query("select * from user_keys where user_id = $1 order by created_at", [req.params.id]);
    if (!rows.length) throw notFound("UserNotFound");
    const u = (await apiPool.query<{ display_name: string; deleted_at: Date | null }>("select display_name, deleted_at from users where id = $1", [req.params.id])).rows[0];
    return { display_name: u?.display_name ?? "?", deleted: !!u?.deleted_at, keys: rows.map((r) => userKeys(r)) };
  });

  /** The recovery-code copy of the vault, for "I forgot my passphrase". Ciphertext; only the recovery code opens it. */
  app.get("/me/recovery-vault", async (req) => {
    const me = requireUser(req);
    const r = (await apiPool.query<{ recovery_vault: unknown }>("select recovery_vault from users where id = $1", [me.id])).rows[0];
    if (!r?.recovery_vault) throw notFound("RecoveryVaultNotFound");
    return { recovery_vault: VaultBlob.parse(r.recovery_vault) };
  });

  /** A challenge for the destructive custody calls below (security review SR-2). Five minutes, single use. */
  app.post("/me/custody-challenge", async (req) => CustodyChallenge.parse(issueChallenge(requireUser(req).id)));

  /**
   * Passphrase change or recovery: replace the vault blob(s) for the SAME keypairs.
   * Login password re-entered, public keys must match the published ones, and the
   * caller proves it holds the signing key (SR-2): a reset login password alone
   * cannot overwrite someone's keys. The previous blobs go to vault_history (30 days).
   */
  app.put("/me/vault", async (req, reply) => {
    const me = requireUser(req);
    const body = PutVaultBody.parse(req.body);
    const u = (await apiPool.query<{ password_hash: string; ecdh_pub: string; ecdsa_pub: string; vault: unknown; recovery_vault: unknown; email: string; locale: string }>("select u.password_hash, u.vault, u.recovery_vault, u.email, u.locale, k.ecdh_pub, k.ecdsa_pub from users u join user_keys k on k.user_id = u.id and k.retired_at is null where u.id = $1", [me.id])).rows[0];
    if (!u || (hasLoginPassword() && !(await verifyPassword(body.password ?? "", u.password_hash ?? "")))) throw unauthorized();
    await consumeCustodyProof(req, me.id, body.proof);
    const same = (v: { pub: { ecdh: string; ecdsa: string } }) => v.pub.ecdh === u.ecdh_pub && v.pub.ecdsa === u.ecdsa_pub;
    if (body.vault.kind !== "passphrase" || !same(body.vault) || (body.recovery_vault && (body.recovery_vault.kind !== "recovery" || !same(body.recovery_vault)))) throw badRequest("KeysMismatch", "vault public keys do not match the published keys");
    await withTx(apiPool, async (db) => {
      // A passkey-only account (PETTY-102) has no passphrase copy yet: setting one is not a replacement, nothing to keep.
      if (u.vault) await db.query("insert into vault_history (user_id, vault, recovery_vault) values ($1, $2, $3)", [me.id, JSON.stringify(u.vault), u.recovery_vault ? JSON.stringify(u.recovery_vault) : null]);
      await db.query("update users set vault = $2, recovery_vault = coalesce($3, recovery_vault) where id = $1", [me.id, JSON.stringify(body.vault), body.recovery_vault ? JSON.stringify(body.recovery_vault) : null]);
    });
    mails.vaultReplaced(u.email, u.locale);
    return reply.code(204).send();
  });

  /**
   * A new recovery code (PETTY-200): replace only the recovery-code copy of the SAME keys. Same
   * checks as PUT /me/vault: login password where one exists, custody proof, published keys. The
   * old copy goes to vault_history when there is a passphrase copy to keep with it.
   */
  app.put("/me/recovery-vault", async (req, reply) => {
    const me = requireUser(req);
    const body = PutRecoveryVaultBody.parse(req.body);
    const u = (await apiPool.query<{ password_hash: string; ecdh_pub: string; ecdsa_pub: string; vault: unknown; recovery_vault: unknown; email: string; locale: string }>("select u.password_hash, u.vault, u.recovery_vault, u.email, u.locale, k.ecdh_pub, k.ecdsa_pub from users u join user_keys k on k.user_id = u.id and k.retired_at is null where u.id = $1", [me.id])).rows[0];
    if (!u || (hasLoginPassword() && !(await verifyPassword(body.password ?? "", u.password_hash ?? "")))) throw unauthorized();
    await consumeCustodyProof(req, me.id, body.proof);
    const v = body.recovery_vault;
    if (v.kind !== "recovery" || v.pub.ecdh !== u.ecdh_pub || v.pub.ecdsa !== u.ecdsa_pub) throw badRequest("KeysMismatch", "vault public keys do not match the published keys");
    await withTx(apiPool, async (db) => {
      if (u.vault) await db.query("insert into vault_history (user_id, vault, recovery_vault) values ($1, $2, $3)", [me.id, JSON.stringify(u.vault), u.recovery_vault ? JSON.stringify(u.recovery_vault) : null]);
      await db.query("update users set recovery_vault = $2 where id = $1", [me.id, JSON.stringify(v)]);
    });
    mails.vaultReplaced(u.email, u.locale);
    return reply.code(204).send();
  });

  /**
   * Passkeys (Phase 14; several per account since PETTY-102). The server stores the credential
   * id, the PRF salt, a label and the PRF-wrapped copy of the keys; it never sees the PRF output
   * and does not verify WebAuthn assertions — a passkey is a key holder, not a login factor.
   * Adding or removing one takes the custody proof (the vault is open) and, in local mode, the
   * login password, like a vault replace.
   */
  app.post("/me/passkeys", async (req, reply) => {
    const me = requireUser(req);
    const body = AddPasskeyBody.parse(req.body);
    const u = (await apiPool.query<{ password_hash: string; ecdh_pub: string; ecdsa_pub: string }>("select u.password_hash, k.ecdh_pub, k.ecdsa_pub from users u join user_keys k on k.user_id = u.id and k.retired_at is null where u.id = $1", [me.id])).rows[0];
    if (!u || (hasLoginPassword() && !(await verifyPassword(body.password ?? "", u.password_hash ?? "")))) throw unauthorized();
    await consumeCustodyProof(req, me.id, body.proof);
    const v = body.passkey.vault;
    if (v.kind !== "passkey" || v.pub.ecdh !== u.ecdh_pub || v.pub.ecdsa !== u.ecdsa_pub) throw badRequest("KeysMismatch", "vault public keys do not match the published keys");
    const pk = PasskeyVault.parse(body.passkey);
    const row = (await apiPool.query<PasskeyRow>(
      `insert into passkey_vaults (user_id, credential_id, prf_salt, vault, label, transports) values ($1, $2, $3, $4, $5, $6)
       on conflict (user_id, credential_id) do update set prf_salt = excluded.prf_salt, vault = excluded.vault, label = excluded.label, transports = excluded.transports, created_at = now()
       returning id, credential_id, prf_salt, vault, label, transports, created_at`,
      [me.id, pk.credential_id, pk.prf_salt, JSON.stringify(pk.vault), pk.label, pk.transports],
    )).rows[0]!;
    return reply.code(201).send(passkeyEntry(row));
  });
  app.delete<{ Params: { id: string } }>("/me/passkeys/:id", async (req, reply) => {
    const me = requireUser(req);
    const body = RemovePasskeyBody.parse(req.body ?? {});
    const u = (await apiPool.query<{ password_hash: string; vault: unknown }>("select password_hash, vault from users where id = $1", [me.id])).rows[0];
    if (!u || (hasLoginPassword() && !(await verifyPassword(body.password ?? "", u.password_hash ?? "")))) throw unauthorized();
    await consumeCustodyProof(req, me.id, body.proof);
    await withTx(apiPool, async (db) => {
      const mine = await db.query<{ id: string }>("select id from passkey_vaults where user_id = $1 for update", [me.id]);
      if (!mine.rows.some((r) => r.id === req.params.id)) throw notFound("PasskeyNotFound");
      // Without a passphrase copy the last passkey is the last everyday door; the recovery code alone is not a way to live.
      if (!u.vault && mine.rows.length === 1) throw conflict("LastDoor", "set a passphrase before removing the last passkey");
      await db.query("delete from passkey_vaults where id = $1 and user_id = $2", [req.params.id, me.id]);
    });
    return reply.code(204).send();
  });

  /** The user's own encrypted document (key pins). Version-checked like a drawer document. */
  app.get("/me/doc", async (req, reply) => {
    const me = requireUser(req);
    const r = (await apiPool.query("select * from user_docs where user_id = $1", [me.id])).rows[0];
    if (!r) return reply.code(204).send(); // no document yet is the normal first state, not an error (PETTY-133)
    return UserDocRow.parse({ version: r.version, schema_version: r.schema_version, nonce: toB64(r.nonce), ciphertext: toB64(r.ciphertext), updated_at: iso(r.updated_at) });
  });
  app.put("/me/doc", async (req) => {
    const me = requireUser(req);
    const body = PutUserDocBody.parse(req.body);
    return withTx(apiPool, async (db) => {
      const cur = (await db.query<{ version: number }>("select version from user_docs where user_id = $1 for update", [me.id])).rows[0];
      const current = cur?.version ?? 0;
      if (current !== body.base_version) throw conflict("VersionConflict", "user document changed", { current_version: current });
      const r = await db.query(
        `insert into user_docs (user_id, version, schema_version, nonce, ciphertext) values ($1, 1, $2, $3, $4)
         on conflict (user_id) do update set version = user_docs.version + 1, schema_version = excluded.schema_version, nonce = excluded.nonce, ciphertext = excluded.ciphertext, updated_at = now()
         returning version, updated_at`,
        [me.id, body.schema_version, fromB64(body.nonce), fromB64(body.ciphertext)],
      );
      return { version: r.rows[0]!.version, updated_at: iso(r.rows[0]!.updated_at) };
    });
  });

  /** PETTY-243: bytes stored in the drawers you own, against the instance's limit (null = none). */
  app.get("/me/storage", async (req) => {
    const me = requireUser(req);
    return StorageUsage.parse({ used_bytes: await storageUsed(apiPool, me.id), quota_bytes: config.storageQuotaBytes });
  });

  async function preview(userId: string) {
    const owned = (await apiPool.query<{ id: string }>("select id from drawers where owner_id = $1 order by created_at", [userId])).rows.map((r) => r.id);
    const shared = [];
    const sole: string[] = [];
    for (const id of owned) {
      const members = (await apiPool.query("select m.user_id, m.role, u.display_name from drawer_members m join users u on u.id = m.user_id where m.drawer_id = $1 and u.deleted_at is null order by u.display_name", [id])).rows;
      if (members.length) shared.push({ drawer_id: id, members }); else sole.push(id);
    }
    const memberships = (await apiPool.query<{ drawer_id: string }>("select drawer_id from drawer_members where user_id = $1", [userId])).rows.map((r) => r.drawer_id);
    return DeletePreview.parse({ shared, sole, memberships });
  }

  /** What deleting the account would touch, and which drawers need a decision first. */
  app.get("/me/delete", async (req) => preview(requireUser(req).id));

  /**
   * Delete the account (spec "Account deletion", SPEC-ISSUES A8). Blocks until every
   * owned drawer that has members has a decision: hand it to a member (no acceptance
   * needed — the giver is leaving for good) or delete it for everyone. Sole-owner
   * drawers are deleted. Memberships end and those drawers are flagged for key
   * rotation. What is erased: private keys (vault blobs), sessions, the user's own
   * document, email and display name. What stays: public keys (old entries must
   * still verify) and the user's entries inside drawers other members keep.
   */
  app.post("/me/delete", async (req, reply) => {
    const me = requireUser(req);
    const body = DeleteAccountBody.parse(req.body);
    const u = (await apiPool.query<{ password_hash: string | null; clerk_user_id: string | null }>("select password_hash, clerk_user_id from users where id = $1", [me.id])).rows[0];
    if (!u || (hasLoginPassword() && !(await verifyPassword(body.password ?? "", u.password_hash ?? "")))) throw unauthorized();
    await consumeCustodyProof(req, me.id, body.proof);
    const p = await preview(me.id);
    const decisions = new Map(body.decisions.map((d) => [d.drawer_id, d]));
    const missing = p.shared.filter((s) => !decisions.has(s.drawer_id)).map((s) => s.drawer_id);
    if (missing.length) throw conflict("DecisionsRequired", "decide what happens to each shared drawer you own", { count: missing.length });
    for (const s of p.shared) {
      const d = decisions.get(s.drawer_id)!;
      if (d.action === "transfer" && !s.members.some((m) => m.user_id === d.to_user_id)) throw badRequest("TransferTargetNotMember", "the recipient must be a member of that drawer", { drawer_id: s.drawer_id });
    }
    const toDelete = [...p.sole, ...p.shared.filter((s) => decisions.get(s.drawer_id)!.action === "delete").map((s) => s.drawer_id)];
    const toTransfer = p.shared.filter((s) => decisions.get(s.drawer_id)!.action === "transfer").map((s) => ({ drawer_id: s.drawer_id, to: decisions.get(s.drawer_id)!.to_user_id! }));

    // 1. Permanent deletions as petty_maint (these were chosen for deletion; if a later step fails the user can retry).
    for (const id of toDelete) await maintPool.query("select delete_drawer($1)", [id]);
    // 2. Everything else in one transaction as petty_api.
    await withTx(apiPool, async (db) => {
      for (const t of toTransfer) {
        await db.query("update drawers set owner_id = $2, rotation_needed = true where id = $1 and owner_id = $3", [t.drawer_id, t.to, me.id]);
        await db.query("delete from drawer_members where drawer_id = $1 and user_id = $2", [t.drawer_id, t.to]);
        await db.query("delete from drawer_keys where drawer_id = $1 and user_id = $2", [t.drawer_id, me.id]);
        await db.query("delete from ownership_transfers where drawer_id = $1", [t.drawer_id]);
      }
      for (const id of p.memberships) {
        await db.query("delete from drawer_members where drawer_id = $1 and user_id = $2", [id, me.id]);
        await db.query("delete from drawer_keys where drawer_id = $1 and user_id = $2", [id, me.id]);
        await db.query("update drawers set rotation_needed = true where id = $1", [id]);
      }
      await db.query("update invitations set state = 'revoked', resolved_at = now() where state = 'pending' and (inviter_id = $1 or invitee_id = $1)", [me.id]);
      await db.query("delete from ownership_transfers where from_user_id = $1 or to_user_id = $1", [me.id]);
      await db.query("delete from sessions where user_id = $1", [me.id]);
      await endAllTokens(db, me.id, { erase: true });
      await db.query("delete from user_docs where user_id = $1", [me.id]);
      await db.query("delete from passkey_vaults where user_id = $1", [me.id]);
      await db.query("delete from vault_history where user_id = $1", [me.id]);
      await db.query("update user_keys set retired_at = now() where user_id = $1 and retired_at is null", [me.id]);
      await db.query(
        `update users set email = 'deleted-' || id || '@deleted.invalid', display_name = 'Deleted user', password_hash = 'deleted',
                          vault = null, recovery_vault = null, clerk_user_id = null, deleted_at = now() where id = $1`,
        [me.id],
      );
    });
    for (const t of toTransfer) {
      const r = (await apiPool.query<{ email: string; locale: string }>("select email, locale from users where id = $1", [t.to])).rows[0];
      if (r) mails.handedOver(r.email, me.display_name, r.locale);
    }
    await destroySession(reply, null);
    // Clerk mode (PETTY-88): the identity goes too; a failure here leaves a Clerk user with no vault, which the next sign-in reports as NoVault.
    if (u.clerk_user_id) await deleteClerkUser(u.clerk_user_id).catch((e: unknown) => req.log.warn({ err: e instanceof Error ? e.name : "Error" }, "clerk user deletion failed"));
    return reply.code(204).send();
  });
}
