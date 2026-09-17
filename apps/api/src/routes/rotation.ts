import type { FastifyInstance } from "fastify";
import { ExportResponse, RotationBatchBody, RotationStatus, StartRotationBody } from "@petty/protocol";
import { apiPool, maintPool } from "../db.js";
import { fromB64 } from "../lib/bytes.js";
import { badRequest, conflict } from "../lib/errors.js";
import { rotationsStarted } from "../lib/metrics.js";
import { requireRole } from "../lib/perm.js";
import { drawerSummary, entryRow, sealedRow } from "../lib/rows.js";
import { requireUser } from "../lib/session.js";
import { withTx, type Queryable } from "../lib/tx.js";

async function status(db: Queryable, drawerId: string) {
  const d = (await db.query<{ key_version: number }>("select key_version from drawers where id = $1", [drawerId])).rows[0]!;
  const pending = (await db.query<{ n: string }>("select count(*)::text as n from entries where drawer_id = $1 and key_version < $2", [drawerId, d.key_version])).rows[0]!;
  const doc = (await db.query<{ key_version: number }>("select key_version from drawer_documents where drawer_id = $1", [drawerId])).rows[0];
  const photo = (await db.query<{ key_version: number }>("select key_version from drawer_photos where drawer_id = $1", [drawerId])).rows[0];
  const document_pending = !!doc && doc.key_version < d.key_version;
  const photo_pending = !!photo && photo.key_version < d.key_version;
  const completed = Number(pending.n) === 0 && !document_pending && !photo_pending;
  return RotationStatus.parse({ drawer_id: drawerId, key_version: d.key_version, pending_entries: Number(pending.n), document_pending, photo_pending, completed });
}

export async function rotationRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Step 1 of SPEC-ISSUES A7: publish the new key generation with a wrap for every
   * remaining member. From this moment every new write must use it. Old rows are
   * re-sealed by batches (step 3), resumable at any time.
   */
  app.post<{ Params: { id: string } }>("/drawers/:id/rotation", async (req, reply) => {
    const me = requireUser(req);
    await requireRole(apiPool, req.params.id, me.id, "write");
    const body = StartRotationBody.parse(req.body);
    const out = await withTx(apiPool, async (db) => {
      const d = (await db.query<{ key_version: number; owner_id: string }>("select key_version, owner_id from drawers where id = $1 for update", [req.params.id])).rows[0]!;
      if (body.to_version !== d.key_version + 1) throw conflict("RotationVersion", "to_version must be the next key version", { key_version: d.key_version });
      const members = new Set([d.owner_id, ...(await db.query<{ user_id: string }>("select user_id from drawer_members where drawer_id = $1", [req.params.id])).rows.map((r) => r.user_id)]);
      const given = new Set(body.wraps.map((w) => w.user_id));
      if (members.size !== given.size || [...members].some((m) => !given.has(m))) throw badRequest("WrapsIncomplete", "a wrap is required for every current member and nobody else");
      for (const w of body.wraps) {
        if (w.wrap.drawer_id !== req.params.id || w.wrap.key_version !== body.to_version) throw badRequest("WrapMismatch", "wrap drawer/version mismatch", { user_id: w.user_id });
        await db.query("insert into drawer_keys (drawer_id, user_id, key_version, wrap) values ($1, $2, $3, $4)", [req.params.id, w.user_id, body.to_version, JSON.stringify({ ...w.wrap, sender_id: me.id })]);
      }
      await db.query("update drawers set key_version = $2, rotation_needed = false where id = $1", [req.params.id, body.to_version]);
      await db.query("insert into rotations (drawer_id, to_version, started_by) values ($1, $2, $3)", [req.params.id, body.to_version, me.id]);
      return status(db, req.params.id);
    });
    rotationsStarted.inc();
    return reply.code(201).send(out);
  });

  /** Step 3: re-sealed rows. Runs as petty_maint; the trigger allows only ciphertext, nonce and a higher key_version to change. */
  app.put<{ Params: { id: string } }>("/drawers/:id/rotation/batch", async (req) => {
    const me = requireUser(req);
    const { drawer } = await requireRole(apiPool, req.params.id, me.id, "write");
    const body = RotationBatchBody.parse(req.body);
    if (body.to_version !== drawer.key_version) throw conflict("RotationVersion", "batch is not for the current key version", { key_version: drawer.key_version });
    return withTx(maintPool, async (db) => {
      for (const e of body.entries) {
        await db.query("update entries set nonce = $3, ciphertext = $4, key_version = $5 where id = $1 and drawer_id = $2 and key_version < $5", [e.id, req.params.id, fromB64(e.nonce), fromB64(e.ciphertext), body.to_version]);
      }
      if (body.document) {
        await db.query("update drawer_documents set nonce = $2, ciphertext = $3, key_version = $4, schema_version = $5 where drawer_id = $1 and key_version < $4", [req.params.id, fromB64(body.document.nonce), fromB64(body.document.ciphertext), body.to_version, body.document.schema_version]);
      }
      if (body.photo) {
        await db.query("update drawer_photos set nonce = $2, ciphertext = $3, key_version = $4, schema_version = $5 where drawer_id = $1 and key_version < $4", [req.params.id, fromB64(body.photo.nonce), fromB64(body.photo.ciphertext), body.to_version, body.photo.schema_version]);
      }
      const s = await status(db, req.params.id);
      if (s.completed) await db.query("update rotations set completed_at = now() where drawer_id = $1 and to_version = $2 and completed_at is null", [req.params.id, body.to_version]);
      return s;
    });
  });

  app.get<{ Params: { id: string } }>("/drawers/:id/rotation", async (req) => {
    const me = requireUser(req);
    await requireRole(apiPool, req.params.id, me.id, "read");
    return status(apiPool, req.params.id);
  });

  /** Export is a deliberate bulk copy: owner and write members only (spec "What read access includes"). */
  app.get<{ Params: { id: string } }>("/drawers/:id/export", async (req) => {
    const me = requireUser(req);
    const { role, drawer } = await requireRole(apiPool, req.params.id, me.id, "write");
    const doc = (await apiPool.query("select * from drawer_documents where drawer_id = $1", [drawer.id])).rows[0]!;
    const photo = (await apiPool.query("select * from drawer_photos where drawer_id = $1", [drawer.id])).rows[0];
    const entries = await apiPool.query("select * from entries where drawer_id = $1 order by line_id, seq", [drawer.id]);
    const wraps = await apiPool.query<{ wrap: unknown }>("select wrap from drawer_keys where drawer_id = $1 and user_id = $2 order by key_version", [drawer.id, me.id]);
    return ExportResponse.parse({ drawer: drawerSummary(drawer, role, !!photo), document: sealedRow(doc), photo: photo ? sealedRow(photo) : null, entries: entries.rows.map(entryRow), wraps: wraps.rows.map((r) => r.wrap) });
  });
}
