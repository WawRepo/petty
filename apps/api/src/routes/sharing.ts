import type { FastifyInstance } from "fastify";
import { InviteBody, TransferBody } from "@petty/protocol";
import { apiPool } from "../db.js";
import { iso } from "../lib/bytes.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { requireRole } from "../lib/perm.js";
import { userKeys } from "../lib/rows.js";
import { requireUser } from "../lib/session.js";
import { withTx } from "../lib/tx.js";
import { membersOf } from "./drawers.js";
import { mails } from "../lib/mail.js";

export async function sharingRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>("/drawers/:id/members", async (req) => {
    const me = requireUser(req);
    await requireRole(apiPool, req.params.id, me.id, "read");
    return { members: (await membersOf(apiPool, [req.params.id]))[req.params.id] ?? [] };
  });

  /** Owner invites an existing user. The drawer key is wrapped at invite time (SPEC-ISSUES B5). */
  app.post<{ Params: { id: string } }>("/drawers/:id/invitations", async (req, reply) => {
    const me = requireUser(req);
    const { drawer } = await requireRole(apiPool, req.params.id, me.id, "owner");
    const body = InviteBody.parse(req.body);
    if (body.invitee_id === me.id) throw badRequest("SelfInvite", "you already own this drawer");
    if (body.wrap.drawer_id !== drawer.id || body.wrap.key_version !== drawer.key_version) throw badRequest("WrapMismatch", "wrap must be for this drawer at the current key version", { key_version: drawer.key_version });
    const invitee = (await apiPool.query("select u.id, u.email, k.id as key_id from users u left join user_keys k on k.user_id = u.id and k.retired_at is null where u.id = $1 and u.deleted_at is null", [body.invitee_id])).rows[0];
    if (!invitee) throw notFound("UserNotFound");
    if (!invitee.key_id) throw badRequest("InviteeHasNoKeys", "invitee has not finished onboarding");
    const member = await apiPool.query("select 1 from drawer_members where drawer_id = $1 and user_id = $2", [drawer.id, body.invitee_id]);
    if (member.rowCount) throw conflict("AlreadyMember", "already a member");
    try {
      const { rows } = await apiPool.query(
        "insert into invitations (drawer_id, inviter_id, invitee_id, role, key_version, wrap) values ($1, $2, $3, $4, $5, $6) returning id, created_at",
        [drawer.id, me.id, body.invitee_id, body.role, drawer.key_version, JSON.stringify({ ...body.wrap, sender_id: me.id })],
      );
      mails.invitation(invitee.email, me.display_name, body.role);
      return reply.code(201).send({ id: rows[0]!.id, created_at: iso(rows[0]!.created_at) });
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw conflict("InvitationPending", "an invitation is already pending");
      throw e;
    }
  });

  app.get("/invitations", async (req) => {
    const me = requireUser(req);
    const { rows } = await apiPool.query(
      `select i.*, u.display_name as inviter_name, k.ecdh_pub, k.ecdsa_pub, k.sig_key_id, k.created_at as k_created_at, k.retired_at
         from invitations i join users u on u.id = i.inviter_id left join user_keys k on k.user_id = i.inviter_id and k.retired_at is null
        where i.invitee_id = $1 and i.state = 'pending' order by i.created_at`,
      [me.id],
    );
    return { invitations: rows.map((r) => ({ id: r.id, drawer_id: r.drawer_id, invitee_id: r.invitee_id, role: r.role, key_version: r.key_version, wrap: r.wrap, state: r.state, created_at: iso(r.created_at), inviter: { id: r.inviter_id, display_name: r.inviter_name, keys: userKeys({ ...r, created_at: r.k_created_at }) } })) };
  });

  /** Invitee accepts: membership + wrap in one transaction, no cryptography needed. */
  app.post<{ Params: { id: string } }>("/invitations/:id/accept", async (req, reply) => {
    const me = requireUser(req);
    await withTx(apiPool, async (db) => {
      const inv = (await db.query("select * from invitations where id = $1 and invitee_id = $2 and state = 'pending' for update", [req.params.id, me.id])).rows[0];
      if (!inv) throw notFound("InvitationNotFound");
      const d = (await db.query<{ key_version: number }>("select key_version from drawers where id = $1", [inv.drawer_id])).rows[0];
      if (!d) throw notFound("DrawerNotFound");
      if (d.key_version !== inv.key_version) {
        await db.query("update invitations set state = 'revoked', resolved_at = now() where id = $1", [inv.id]);
        throw conflict("InvitationStale", "the drawer key rotated since the invitation; ask the owner to invite again");
      }
      await db.query("insert into drawer_members (drawer_id, user_id, role) values ($1, $2, $3)", [inv.drawer_id, me.id, inv.role]);
      await db.query("insert into drawer_keys (drawer_id, user_id, key_version, wrap) values ($1, $2, $3, $4)", [inv.drawer_id, me.id, inv.key_version, JSON.stringify(inv.wrap)]);
      await db.query("update invitations set state = 'accepted', resolved_at = now() where id = $1", [inv.id]);
    });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/invitations/:id/decline", async (req, reply) => {
    const me = requireUser(req);
    const r = await apiPool.query("update invitations set state = 'declined', resolved_at = now() where id = $1 and invitee_id = $2 and state = 'pending'", [req.params.id, me.id]);
    if (!r.rowCount) throw notFound("InvitationNotFound");
    return reply.code(204).send();
  });

  app.delete<{ Params: { id: string } }>("/invitations/:id", async (req, reply) => {
    const me = requireUser(req);
    const r = await apiPool.query("update invitations set state = 'revoked', resolved_at = now() where id = $1 and inviter_id = $2 and state = 'pending'", [req.params.id, me.id]);
    if (!r.rowCount) throw notFound("InvitationNotFound");
    return reply.code(204).send();
  });

  async function removeMember(drawerId: string, userId: string): Promise<void> {
    await withTx(apiPool, async (db) => {
      const r = await db.query("delete from drawer_members where drawer_id = $1 and user_id = $2", [drawerId, userId]);
      if (!r.rowCount) throw notFound("MemberNotFound");
      await db.query("delete from drawer_keys where drawer_id = $1 and user_id = $2", [drawerId, userId]);
      await db.query("delete from ownership_transfers where drawer_id = $1 and to_user_id = $2", [drawerId, userId]);
      // Rotation needs keys the server does not have; a member's client does it next (SPEC-ISSUES A7).
      await db.query("update drawers set rotation_needed = true where id = $1", [drawerId]);
    });
  }

  /** Owner revokes a member. Their wraps go now; the key rotates when a client next opens the drawer. */
  app.delete<{ Params: { id: string; userId: string } }>("/drawers/:id/members/:userId", async (req, reply) => {
    const me = requireUser(req);
    await requireRole(apiPool, req.params.id, me.id, "owner");
    await removeMember(req.params.id, req.params.userId);
    const u = (await apiPool.query<{ email: string }>("select email from users where id = $1", [req.params.userId])).rows[0];
    if (u) mails.revoked(u.email, me.display_name);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/drawers/:id/leave", async (req, reply) => {
    const me = requireUser(req);
    const { role } = await requireRole(apiPool, req.params.id, me.id, "read");
    if (role === "owner") throw forbidden("OwnerCannotLeave", { drawer_id: req.params.id });
    await removeMember(req.params.id, me.id);
    return reply.code(204).send();
  });

  /** Owner offers the drawer to a write member; nothing changes until they accept. */
  app.post<{ Params: { id: string } }>("/drawers/:id/transfer", async (req, reply) => {
    const me = requireUser(req);
    await requireRole(apiPool, req.params.id, me.id, "owner");
    const body = TransferBody.parse(req.body);
    const m = (await apiPool.query<{ role: string }>("select role from drawer_members where drawer_id = $1 and user_id = $2", [req.params.id, body.to_user_id])).rows[0];
    if (!m || m.role !== "write") throw badRequest("TransferTargetNotWriter", "ownership can only go to a write member");
    await apiPool.query(
      "insert into ownership_transfers (drawer_id, from_user_id, to_user_id) values ($1, $2, $3) on conflict (drawer_id) do update set from_user_id = excluded.from_user_id, to_user_id = excluded.to_user_id, created_at = now()",
      [req.params.id, me.id, body.to_user_id],
    );
    const u = (await apiPool.query<{ email: string }>("select email from users where id = $1", [body.to_user_id])).rows[0];
    if (u) mails.transferOffered(u.email, me.display_name);
    return reply.code(201).send({ drawer_id: req.params.id, to_user_id: body.to_user_id });
  });

  app.post<{ Params: { id: string } }>("/drawers/:id/transfer/accept", async (req, reply) => {
    const me = requireUser(req);
    await withTx(apiPool, async (db) => {
      const t = (await db.query("select * from ownership_transfers where drawer_id = $1 and to_user_id = $2 for update", [req.params.id, me.id])).rows[0];
      if (!t) throw notFound("TransferNotFound");
      await db.query("update drawers set owner_id = $2 where id = $1 and owner_id = $3", [req.params.id, me.id, t.from_user_id]);
      await db.query("delete from drawer_members where drawer_id = $1 and user_id = $2", [req.params.id, me.id]);
      await db.query("insert into drawer_members (drawer_id, user_id, role) values ($1, $2, 'write') on conflict do nothing", [req.params.id, t.from_user_id]);
      await db.query("delete from ownership_transfers where drawer_id = $1", [req.params.id]);
      const u = (await db.query<{ email: string }>("select email from users where id = $1", [t.from_user_id])).rows[0];
      if (u) mails.transferDone(u.email, me.display_name);
    });
    return reply.code(204).send();
  });

  app.delete<{ Params: { id: string } }>("/drawers/:id/transfer", async (req, reply) => {
    const me = requireUser(req);
    const r = await apiPool.query("delete from ownership_transfers where drawer_id = $1 and (from_user_id = $2 or to_user_id = $2)", [req.params.id, me.id]);
    if (!r.rowCount) throw notFound("TransferNotFound");
    return reply.code(204).send();
  });
}
