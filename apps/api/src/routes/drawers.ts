import type { FastifyInstance } from "fastify";
import { Bootstrap, CreateDrawerBody, DeleteLineBody, DocumentHistory, PutDocumentBody, RestoreDocumentBody, PutDocumentResponse, PutPhotoBody, type DrawerSummary, type Member } from "@petty/protocol";
import { apiPool, maintPool } from "../db.js";
import { fromB64, iso } from "../lib/bytes.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { requireRole, type DrawerRow } from "../lib/perm.js";
import { drawerSummary, entryRow, sealedRow, userKeys } from "../lib/rows.js";
import { requireUser } from "../lib/session.js";
import { withTx, type Queryable } from "../lib/tx.js";
import { loadMe } from "./me.js";

export async function membersOf(db: Queryable, drawerIds: string[]): Promise<Record<string, Member[]>> {
  const { rows } = await db.query(
    `select x.drawer_id, x.user_id, x.role, u.display_name, k.ecdh_pub, k.ecdsa_pub, k.sig_key_id, k.created_at, k.retired_at
       from (select id as drawer_id, owner_id as user_id, 'owner' as role from drawers where id = any($1)
             union all
             select drawer_id, user_id, role from drawer_members where drawer_id = any($1)) x
       join users u on u.id = x.user_id
       left join user_keys k on k.user_id = x.user_id and k.retired_at is null
      order by x.drawer_id, x.role, u.display_name`,
    [drawerIds],
  );
  const out: Record<string, Member[]> = {};
  for (const r of rows) (out[r.drawer_id] ??= []).push({ user_id: r.user_id, display_name: r.display_name, role: r.role, keys: userKeys(r) });
  return out;
}

async function lockDrawer(db: Queryable, drawerId: string): Promise<DrawerRow> {
  const { rows } = await db.query<DrawerRow>("select * from drawers where id = $1 for update", [drawerId]);
  const d = rows[0];
  if (!d) throw notFound("DrawerNotFound", { drawer_id: drawerId });
  return d;
}

/** How long a replaced document stays restorable (PETTY-183, review NR-3). */
const HISTORY_DAYS = 30;

/** Keeps the current sealed document before it is replaced, and drops history older than HISTORY_DAYS. */
async function keepHistory(db: Queryable, drawerId: string, version: number, userId: string, tokenId: string | null) {
  await db.query(
    `insert into drawer_document_history (drawer_id, version, author_id, key_version, schema_version, nonce, ciphertext, written_at, replaced_by, replaced_by_token)
     select drawer_id, $2, author_id, key_version, schema_version, nonce, ciphertext, updated_at, $3, $4 from drawer_documents where drawer_id = $1`,
    [drawerId, version, userId, tokenId],
  );
  await db.query(`delete from drawer_document_history where drawer_id = $1 and replaced_at < now() - make_interval(days => $2)`, [drawerId, HISTORY_DAYS]);
}

/** Version check + sealed write of the document. Used by PUT document and delete-line. */
async function writeDocument(db: Queryable, drawerId: string, userId: string, body: typeof PutDocumentBody._type, tokenId: string | null = null) {
  const d = await lockDrawer(db, drawerId);
  if (d.version !== body.base_version) throw conflict("VersionConflict", "document changed since you loaded it", { drawer_id: drawerId, current_version: d.version });
  if (d.key_version !== body.key_version) throw conflict("KeyVersionMismatch", "drawer key rotated; re-seal with the current key", { drawer_id: drawerId, key_version: d.key_version });
  await keepHistory(db, drawerId, d.version, userId, tokenId);
  await db.query(
    `update drawer_documents set author_id = $2, key_version = $3, schema_version = $4, nonce = $5, ciphertext = $6, updated_at = now() where drawer_id = $1`,
    [drawerId, userId, body.key_version, body.schema_version, fromB64(body.nonce), fromB64(body.ciphertext)],
  );
  const { rows } = await db.query<DrawerRow>(
    `update drawers set version = version + 1, last_write_at = now(), last_verified_at = case when $2 then now() else last_verified_at end where id = $1 returning *`,
    [drawerId, body.verification],
  );
  const nd = rows[0]!;
  return PutDocumentResponse.parse({ version: nd.version, last_write_at: iso(nd.last_write_at), last_verified_at: iso(nd.last_verified_at) });
}

export async function drawerRoutes(app: FastifyInstance): Promise<void> {
  /** Everything the home screen needs in one round trip (SPEC-ISSUES A6). */
  app.get("/bootstrap", async (req) => {
    const me = requireUser(req);
    const { rows: ds } = await apiPool.query<DrawerRow & { role: DrawerSummary["role"]; has_photo: boolean }>(
      `select d.*, case when d.owner_id = $1 then 'owner' else m.role end as role, (p.drawer_id is not null) as has_photo
         from drawers d
         left join drawer_members m on m.drawer_id = d.id and m.user_id = $1
         left join drawer_photos p on p.drawer_id = d.id
        where d.owner_id = $1 or m.user_id is not null
        order by d.created_at`,
      [me.id],
    );
    const ids = ds.map((d) => d.id);
    const [docs, wraps, members, entries, invitations, transfers] = await Promise.all([
      apiPool.query("select * from drawer_documents where drawer_id = any($1)", [ids]),
      apiPool.query<{ wrap: unknown }>("select wrap from drawer_keys where user_id = $1 and drawer_id = any($2) order by drawer_id, key_version", [me.id, ids]),
      membersOf(apiPool, ids),
      apiPool.query(
        `select e.* from entries e join line_heads h on h.drawer_id = e.drawer_id and h.line_id = e.line_id
          where e.drawer_id = any($1) and e.seq >= greatest(h.checkpoint_seq, 1)
          order by e.drawer_id, e.line_id, e.seq`,
        [ids],
      ),
      apiPool.query(
        `select i.*, u.display_name as inviter_name, k.ecdh_pub, k.ecdsa_pub, k.sig_key_id, k.created_at as k_created_at, k.retired_at
           from invitations i join users u on u.id = i.inviter_id
           left join user_keys k on k.user_id = i.inviter_id and k.retired_at is null
          where i.invitee_id = $1 and i.state = 'pending' order by i.created_at`,
        [me.id],
      ),
      apiPool.query("select drawer_id, from_user_id, to_user_id from ownership_transfers where to_user_id = $1 or from_user_id = $1", [me.id]),
    ]);
    const documents: Record<string, ReturnType<typeof sealedRow>> = {};
    for (const r of docs.rows) documents[r.drawer_id] = sealedRow(r);
    return Bootstrap.parse({
      me: await loadMe(apiPool, me.id),
      drawers: ds.map((d) => drawerSummary(d, d.role, d.has_photo)),
      documents,
      wraps: wraps.rows.map((r) => r.wrap),
      members,
      entries: entries.rows.map(entryRow),
      invitations: invitations.rows.map((r) => ({
        id: r.id, drawer_id: r.drawer_id, invitee_id: r.invitee_id, role: r.role, key_version: r.key_version, wrap: r.wrap, state: r.state, created_at: iso(r.created_at),
        inviter: { id: r.inviter_id, display_name: r.inviter_name, keys: userKeys({ ...r, created_at: r.k_created_at }) },
      })),
      transfers: transfers.rows,
    });
  });

  app.post("/drawers", async (req, reply) => {
    const me = requireUser(req);
    const body = CreateDrawerBody.parse(req.body);
    if (body.self_wrap.drawer_id !== body.id || body.self_wrap.key_version !== 1 || body.document.key_version !== 1) throw badRequest("WrapMismatch", "self wrap must be for this drawer at key version 1");
    const d = await withTx(apiPool, async (db) => {
      const exists = await db.query("select 1 from drawers where id = $1", [body.id]);
      if (exists.rowCount) throw conflict("DrawerExists", "drawer id already used", { drawer_id: body.id });
      const { rows } = await db.query<DrawerRow>("insert into drawers (id, owner_id) values ($1, $2) returning *", [body.id, me.id]);
      await db.query(
        "insert into drawer_documents (drawer_id, author_id, key_version, schema_version, nonce, ciphertext) values ($1, $2, 1, $3, $4, $5)",
        [body.id, me.id, body.document.schema_version, fromB64(body.document.nonce), fromB64(body.document.ciphertext)],
      );
      await db.query("insert into drawer_keys (drawer_id, user_id, key_version, wrap) values ($1, $2, 1, $3)", [body.id, me.id, JSON.stringify({ ...body.self_wrap, sender_id: me.id })]);
      return rows[0]!;
    });
    return reply.code(201).send(drawerSummary(d, "owner", false));
  });

  app.get<{ Params: { id: string } }>("/drawers/:id", async (req) => {
    const me = requireUser(req);
    const { role, drawer } = await requireRole(apiPool, req.params.id, me.id, "read");
    const doc = (await apiPool.query("select * from drawer_documents where drawer_id = $1", [drawer.id])).rows[0]!;
    const photo = (await apiPool.query("select 1 from drawer_photos where drawer_id = $1", [drawer.id])).rowCount ?? 0;
    return { drawer: drawerSummary(drawer, role, photo > 0), document: sealedRow(doc) };
  });

  app.put<{ Params: { id: string } }>("/drawers/:id/document", async (req) => {
    const me = requireUser(req);
    await requireRole(apiPool, req.params.id, me.id, "write");
    const body = PutDocumentBody.parse(req.body);
    // PETTY-183 (NR-3): only a person who counted may mark the drawer as checked, never a tool
    if (req.token && body.verification) throw forbidden("TokenCannotVerify", { drawer_id: req.params.id });
    return withTx(apiPool, (db) => writeDocument(db, req.params.id, me.id, body, req.token?.id ?? null));
  });

  /** Owner only: the documents replaced in the last 30 days, newest first, still sealed (PETTY-183). */
  app.get<{ Params: { id: string } }>("/drawers/:id/document/history", async (req) => {
    const me = requireUser(req);
    await requireRole(apiPool, req.params.id, me.id, "owner");
    const { rows } = await apiPool.query(
      `select h.* from drawer_document_history h
        where h.drawer_id = $1 and h.replaced_at >= now() - make_interval(days => $2) order by h.replaced_at desc, h.id desc`,
      [req.params.id, HISTORY_DAYS],
    );
    return DocumentHistory.parse({
      history: rows.map((r) => ({
        id: String(r.id),
        version: r.version,
        written_at: iso(r.written_at),
        replaced_at: iso(r.replaced_at),
        replaced_by: r.replaced_by,
        by_token: r.replaced_by_token !== null,
        document: sealedRow({ ...r, updated_at: r.written_at }),
      })),
    });
  });

  /**
   * Owner only: puts an earlier document back, exactly as it was sealed (author and key version
   * included, so it opens under the same AAD). The current document goes into history first.
   */
  app.post<{ Params: { id: string } }>("/drawers/:id/document/restore", async (req) => {
    const me = requireUser(req);
    await requireRole(apiPool, req.params.id, me.id, "owner");
    const body = RestoreDocumentBody.parse(req.body);
    return withTx(apiPool, async (db) => {
      const d = await lockDrawer(db, req.params.id);
      if (d.version !== body.base_version) throw conflict("VersionConflict", "document changed since you loaded it", { drawer_id: d.id, current_version: d.version });
      const h = (await db.query("select * from drawer_document_history where id = $1 and drawer_id = $2", [body.history_id, d.id])).rows[0];
      if (!h) throw notFound("HistoryNotFound", { drawer_id: d.id });
      if (h.key_version !== d.key_version) throw conflict("KeyVersionMismatch", "this document was sealed with an older drawer key", { drawer_id: d.id, key_version: d.key_version });
      await keepHistory(db, d.id, d.version, me.id, null);
      await db.query(
        "update drawer_documents set author_id = $2, key_version = $3, schema_version = $4, nonce = $5, ciphertext = $6, updated_at = now() where drawer_id = $1",
        [d.id, h.author_id, h.key_version, h.schema_version, h.nonce, h.ciphertext],
      );
      const nd = (await db.query<DrawerRow>("update drawers set version = version + 1, last_write_at = now() where id = $1 returning *", [d.id])).rows[0]!;
      return PutDocumentResponse.parse({ version: nd.version, last_write_at: iso(nd.last_write_at), last_verified_at: iso(nd.last_verified_at) });
    });
  });

  app.get<{ Params: { id: string } }>("/drawers/:id/photo", async (req) => {
    const me = requireUser(req);
    await requireRole(apiPool, req.params.id, me.id, "read");
    const r = (await apiPool.query("select * from drawer_photos where drawer_id = $1", [req.params.id])).rows[0];
    if (!r) throw notFound("PhotoNotFound", { drawer_id: req.params.id });
    return sealedRow(r);
  });

  app.put<{ Params: { id: string } }>("/drawers/:id/photo", async (req, reply) => {
    const me = requireUser(req);
    const { drawer } = await requireRole(apiPool, req.params.id, me.id, "write");
    const body = PutPhotoBody.parse(req.body);
    if (body.key_version !== drawer.key_version) throw conflict("KeyVersionMismatch", "re-seal with the current key", { key_version: drawer.key_version });
    await apiPool.query(
      `insert into drawer_photos (drawer_id, author_id, key_version, schema_version, nonce, ciphertext) values ($1, $2, $3, $4, $5, $6)
       on conflict (drawer_id) do update set author_id = excluded.author_id, key_version = excluded.key_version, schema_version = excluded.schema_version, nonce = excluded.nonce, ciphertext = excluded.ciphertext, updated_at = now()`,
      [drawer.id, me.id, body.key_version, body.schema_version, fromB64(body.nonce), fromB64(body.ciphertext)],
    );
    await apiPool.query("update drawers set last_write_at = now() where id = $1", [drawer.id]);
    return reply.code(204).send();
  });

  app.delete<{ Params: { id: string } }>("/drawers/:id/photo", async (req, reply) => {
    const me = requireUser(req);
    await requireRole(apiPool, req.params.id, me.id, "write");
    await apiPool.query("delete from drawer_photos where drawer_id = $1", [req.params.id]);
    await apiPool.query("update drawers set last_write_at = now() where id = $1", [req.params.id]);
    return reply.code(204).send();
  });

  /** Owner only. Permanent (spec "Deletion is permanent"). Runs as petty_maint through delete_drawer(). */
  app.delete<{ Params: { id: string } }>("/drawers/:id", async (req, reply) => {
    const me = requireUser(req);
    await requireRole(apiPool, req.params.id, me.id, "owner");
    await maintPool.query("select delete_drawer($1)", [req.params.id]);
    return reply.code(204).send();
  });

  /**
   * Write role. The new document (without the line) is written under the version
   * check first; then the line's entries are removed as petty_maint. If the second
   * step fails, the entries are orphaned and unreadable, never resurrected.
   */
  app.post<{ Params: { id: string; lineId: string } }>("/drawers/:id/lines/:lineId/delete", async (req) => {
    const me = requireUser(req);
    await requireRole(apiPool, req.params.id, me.id, "write");
    const body = DeleteLineBody.parse(req.body);
    if (req.token && body.document.verification) throw forbidden("TokenCannotVerify", { drawer_id: req.params.id });
    const res = await withTx(apiPool, (db) => writeDocument(db, req.params.id, me.id, body.document, req.token?.id ?? null));
    const { rows } = await maintPool.query<{ n: string }>("select delete_line($1, $2) as n", [req.params.id, req.params.lineId]);
    return { ...res, deleted_entries: Number(rows[0]?.n ?? 0) };
  });
}
