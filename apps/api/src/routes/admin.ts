import type { FastifyInstance } from "fastify";
import { withTx } from "../lib/tx.js";
import { AdminUsers, SetAdminBody } from "@petty/protocol";
import { revokeClerkSessions } from "../lib/clerk.js";
import { apiPool } from "../db.js";
import { iso } from "../lib/bytes.js";
import { badRequest, notFound } from "../lib/errors.js";
import { requireAdmin } from "../lib/session.js";

/**
 * Account administration (Phase 15a): list, block, sign out everywhere, grant admin.
 * Metadata only. There is no endpoint that returns a vault blob, a wrap or a
 * ciphertext to an admin, and no way to add one that would help — the server
 * holds no keys.
 */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.get("/admin/users", async (req) => {
    requireAdmin(req);
    const { rows } = await apiPool.query(
      `select u.id, u.email, u.display_name, u.locale, u.created_at, u.is_admin, u.blocked_at, u.deleted_at,
              (select count(*)::int from drawers d where d.owner_id = u.id) as owned,
              (select max(s.last_seen_at) from sessions s where s.user_id = u.id) as last_seen_at,
              exists(select 1 from passkey_vaults p where p.user_id = u.id) as has_passkey
         from users u order by u.created_at`,
    );
    return AdminUsers.parse({ users: rows.map((r) => ({
      id: r.id, email: r.email, display_name: r.display_name, locale: r.locale, created_at: iso(r.created_at), is_admin: r.is_admin,
      blocked_at: r.blocked_at ? iso(r.blocked_at) : null, deleted: !!r.deleted_at, owned: r.owned, last_seen_at: r.last_seen_at ? iso(r.last_seen_at) : null, has_passkey: r.has_passkey,
    })) });
  });

  async function target(req: { params: { id: string } }, meId: string): Promise<string> {
    const id = req.params.id;
    if (id === meId) throw badRequest("NotOnSelf", "use another admin account for this");
    const r = (await apiPool.query("select 1 from users where id = $1 and deleted_at is null", [id])).rows[0];
    if (!r) throw notFound("UserNotFound");
    return id;
  }

  /** Block: no login, and every existing session dies now. Data stays; unblock restores everything. */
  app.post<{ Params: { id: string } }>("/admin/users/:id/block", async (req, reply) => {
    const me = requireAdmin(req);
    const id = await target(req, me.id);
    await apiPool.query("update users set blocked_at = coalesce(blocked_at, now()) where id = $1", [id]);
    await apiPool.query("delete from sessions where user_id = $1", [id]);
    const cu = (await apiPool.query<{ clerk_user_id: string | null }>("select clerk_user_id from users where id = $1", [id])).rows[0];
    if (cu?.clerk_user_id) await revokeClerkSessions(cu.clerk_user_id);
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string } }>("/admin/users/:id/unblock", async (req, reply) => {
    const me = requireAdmin(req);
    const id = await target(req, me.id);
    await apiPool.query("update users set blocked_at = null where id = $1", [id]);
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string } }>("/admin/users/:id/revoke-sessions", async (req, reply) => {
    const me = requireAdmin(req);
    const id = await target(req, me.id);
    await apiPool.query("delete from sessions where user_id = $1", [id]);
    return reply.code(204).send();
  });
  /**
   * Put back the vault blobs as they were before the last replacement (SR-2). The
   * current blobs go to history in turn, so a wrong restore can itself be undone.
   */
  app.post<{ Params: { id: string } }>("/admin/users/:id/restore-vault", async (req, reply) => {
    requireAdmin(req);
    await withTx(apiPool, async (db) => {
      const h = (await db.query<{ id: string; vault: unknown; recovery_vault: unknown }>("select id, vault, recovery_vault from vault_history where user_id = $1 order by replaced_at desc limit 1 for update", [req.params.id])).rows[0];
      if (!h) throw notFound("VaultHistoryEmpty");
      const cur = (await db.query<{ vault: unknown; recovery_vault: unknown }>("select vault, recovery_vault from users where id = $1 and deleted_at is null for update", [req.params.id])).rows[0];
      if (!cur) throw notFound("UserNotFound");
      await db.query("delete from vault_history where id = $1", [h.id]);
      await db.query("insert into vault_history (user_id, vault, recovery_vault) values ($1, $2, $3)", [req.params.id, JSON.stringify(cur.vault), cur.recovery_vault ? JSON.stringify(cur.recovery_vault) : null]);
      await db.query("update users set vault = $2, recovery_vault = coalesce($3, recovery_vault) where id = $1", [req.params.id, JSON.stringify(h.vault), h.recovery_vault ? JSON.stringify(h.recovery_vault) : null]);
      await db.query("delete from sessions where user_id = $1", [req.params.id]);
    });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/admin/users/:id/admin", async (req, reply) => {
    const me = requireAdmin(req);
    const id = await target(req, me.id);
    const body = SetAdminBody.parse(req.body);
    await apiPool.query("update users set is_admin = $2 where id = $1", [id, body.is_admin]);
    return reply.code(204).send();
  });
}
