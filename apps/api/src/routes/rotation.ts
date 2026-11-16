import type { FastifyInstance } from "fastify";
import { ENTRY_MAX_CIPHERTEXT, ExportResponse, PHOTO_MAX_CIPHERTEXT, RotationBatchBody, RotationStatus, StartRotationBody } from "@petty/protocol";
import { apiPool, maintPool } from "../db.js";
import { fromB64 } from "../lib/bytes.js";
import { consumeCustodyProof, requireProofField } from "../lib/custody.js";
import { badRequest, conflict, tooLarge } from "../lib/errors.js";
import { rotationsStarted } from "../lib/metrics.js";
import { requireRole, type DrawerRow } from "../lib/perm.js";
import { assertQuota } from "../lib/quota.js";
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

interface Resealed { nonce: Buffer; ciphertext: Buffer; schema_version?: number }

/**
 * PETTY-442: a re-sealed row is as long as the row it replaces. So an entry or a photo may not pass its
 * size limit unless the stored row already does, and what the batch adds must fit the owner's quota.
 * Only rows still under an older key are written, so only those are measured.
 */
async function assertBatchFits(drawer: DrawerRow, toVersion: number, entries: Map<string, Resealed>, document: Resealed | null, photo: Resealed | null): Promise<void> {
  const size = async (sql: string) => (await apiPool.query<{ n: number }>(sql, [drawer.id, toVersion])).rows[0]?.n;
  const old = (await apiPool.query<{ id: string; n: number }>(
    "select id, octet_length(ciphertext) as n from entries where drawer_id = $1 and key_version < $2 and id = any($3::uuid[])", [drawer.id, toVersion, [...entries.keys()]],
  )).rows;
  let added = 0;
  for (const o of old) {
    const n = entries.get(o.id)!.ciphertext.length;
    if (n > Math.max(ENTRY_MAX_CIPHERTEXT, o.n)) throw tooLarge("EntryTooLarge", "entry over the size limit", { drawer_id: drawer.id, entry_id: o.id, max_bytes: ENTRY_MAX_CIPHERTEXT });
    added += n - o.n;
  }
  if (document) {
    const n = await size("select octet_length(ciphertext) as n from drawer_documents where drawer_id = $1 and key_version < $2");
    if (n !== undefined) added += document.ciphertext.length - n;
  }
  if (photo) {
    const n = await size("select octet_length(ciphertext) as n from drawer_photos where drawer_id = $1 and key_version < $2");
    if (n !== undefined && photo.ciphertext.length > Math.max(PHOTO_MAX_CIPHERTEXT, n)) throw tooLarge("PhotoTooLarge", "photo over the size limit", { drawer_id: drawer.id, max_bytes: PHOTO_MAX_CIPHERTEXT });
    if (n !== undefined) added += photo.ciphertext.length - n;
  }
  await assertQuota(apiPool, drawer.owner_id, added);
}

export async function rotationRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Step 1 of SPEC-ISSUES A7: publish the new key generation with a wrap for every
   * remaining member. From this moment every new write must use it. Old rows are
   * re-sealed by batches (step 3), resumable at any time.
   * PETTY-440: like the other calls that can destroy data (SR-2), it needs a custody proof. The server
   * cannot check a wrap, and a published key opens every row of the drawer to re-sealing.
   */
  app.post<{ Params: { id: string } }>("/drawers/:id/rotation", async (req, reply) => {
    const me = requireUser(req);
    await requireRole(apiPool, req.params.id, me.id, "write");
    requireProofField(req.body);
    const body = StartRotationBody.parse(req.body);
    await consumeCustodyProof(req, me.id, body.proof);
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

  /**
   * Step 3: re-sealed rows. Runs as petty_maint; the trigger allows only ciphertext, nonce and a higher key_version to change.
   * PETTY-440: every batch needs its own custody proof, from whichever write member's app sends it (a
   * rotation that one member began may be finished by another), because a batch overwrites rows in place.
   * PETTY-442: the batch keeps the size limits and the quota (assertBatchFits).
   */
  app.put<{ Params: { id: string } }>("/drawers/:id/rotation/batch", async (req) => {
    const me = requireUser(req);
    const { drawer } = await requireRole(apiPool, req.params.id, me.id, "write");
    requireProofField(req.body);
    const body = RotationBatchBody.parse(req.body);
    await consumeCustodyProof(req, me.id, body.proof);
    if (body.to_version !== drawer.key_version) throw conflict("RotationVersion", "batch is not for the current key version", { key_version: drawer.key_version });
    // Only rows still under an older key are written, and each id once: the first one given.
    const entries = new Map<string, Resealed>();
    for (const e of body.entries) if (!entries.has(e.id)) entries.set(e.id, { nonce: fromB64(e.nonce), ciphertext: fromB64(e.ciphertext) });
    const document = body.document ? { nonce: fromB64(body.document.nonce), ciphertext: fromB64(body.document.ciphertext), schema_version: body.document.schema_version } : null;
    const photo = body.photo ? { nonce: fromB64(body.photo.nonce), ciphertext: fromB64(body.photo.ciphertext), schema_version: body.photo.schema_version } : null;
    await assertBatchFits(drawer, body.to_version, entries, document, photo);
    return withTx(maintPool, async (db) => {
      for (const [id, e] of entries) {
        await db.query("update entries set nonce = $3, ciphertext = $4, key_version = $5 where id = $1 and drawer_id = $2 and key_version < $5", [id, req.params.id, e.nonce, e.ciphertext, body.to_version]);
      }
      if (document) {
        await db.query("update drawer_documents set nonce = $2, ciphertext = $3, key_version = $4, schema_version = $5 where drawer_id = $1 and key_version < $4", [req.params.id, document.nonce, document.ciphertext, body.to_version, document.schema_version]);
      }
      if (photo) {
        await db.query("update drawer_photos set nonce = $2, ciphertext = $3, key_version = $4, schema_version = $5 where drawer_id = $1 and key_version < $4", [req.params.id, photo.nonce, photo.ciphertext, body.to_version, photo.schema_version]);
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
