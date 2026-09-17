import type { FastifyInstance } from "fastify";
import { EntriesPage, PostEntryBody, PostEntryResponse } from "@petty/protocol";
import { z } from "zod";
import { apiPool } from "../db.js";
import { fromB64 } from "../lib/bytes.js";
import { badRequest, conflict } from "../lib/errors.js";
import { entriesAppended } from "../lib/metrics.js";
import { requireRole } from "../lib/perm.js";
import { entryRow } from "../lib/rows.js";
import { requireUser } from "../lib/session.js";
import { withTx } from "../lib/tx.js";

const PAGE = 50;

export async function entryRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Append one entry. Idempotent on the client-assigned id. The per-line row lock in
   * line_heads serialises concurrent appends; an Adjust (is_checkpoint) is a
   * conditional insert on expected_head_seq (SPEC-ISSUES B2): first write wins.
   */
  app.post<{ Params: { id: string } }>("/drawers/:id/entries", async (req, reply) => {
    const me = requireUser(req);
    const drawerId = req.params.id;
    const { drawer } = await requireRole(apiPool, drawerId, me.id, "write");
    const body = PostEntryBody.parse(req.body);
    if (body.key_version !== drawer.key_version) throw conflict("KeyVersionMismatch", "drawer key rotated; re-seal with the current key", { drawer_id: drawerId, key_version: drawer.key_version });
    if (body.is_checkpoint && body.expected_head_seq === undefined) throw badRequest("ExpectedHeadRequired", "an Adjust must state the head seq it was counted against");
    if (body.is_checkpoint && body.reverses_entry_id) throw badRequest("CheckpointReverse", "an Adjust cannot reverse");

    const replay = (existing: Record<string, unknown>) => {
      if (existing["drawer_id"] !== drawerId || existing["line_id"] !== body.line_id || existing["author_id"] !== me.id) throw conflict("EntryIdReused", "entry id belongs to another row", { entry_id: body.id });
      entriesAppended.inc({ result: "duplicate" });
      return PostEntryResponse.parse({ entry: entryRow(existing), created: false });
    };
    const existing = (await apiPool.query("select * from entries where id = $1", [body.id])).rows[0];
    if (existing) return replay(existing);

    const row = await withTx(apiPool, async (db) => {
      const head = (await db.query<{ head_seq: string; checkpoint_seq: string }>(
        `insert into line_heads (drawer_id, line_id, head_seq) values ($1, $2, 1)
         on conflict (drawer_id, line_id) do update set head_seq = line_heads.head_seq + 1
         returning head_seq, checkpoint_seq`,
        [drawerId, body.line_id],
      )).rows[0]!;
      const seq = Number(head.head_seq);
      const prev = seq - 1;
      const checkpointSeq = Number(head.checkpoint_seq);
      if (body.is_checkpoint && body.expected_head_seq !== prev) {
        throw conflict("RecountRequired", "the line changed since you counted it", { drawer_id: drawerId, line_id: body.line_id, head_seq: prev });
      }
      if (body.reverses_entry_id) {
        const t = (await db.query("select drawer_id, line_id, seq, is_checkpoint from entries where id = $1", [body.reverses_entry_id])).rows[0];
        if (!t || t.drawer_id !== drawerId || t.line_id !== body.line_id) throw badRequest("ReverseTargetUnknown", "reverse target is not on this line", { entry_id: body.reverses_entry_id });
        if (t.is_checkpoint) throw conflict("ReverseRefused", "an Adjust cannot be reversed", { entry_id: body.reverses_entry_id, reason: "adjust_not_reversible" });
        if (Number(t.seq) <= checkpointSeq) throw conflict("ReverseRefused", "already reconciled by a later count", { entry_id: body.reverses_entry_id, reason: "before_checkpoint" });
        const dup = await db.query("select 1 from entries where reverses_entry_id = $1", [body.reverses_entry_id]);
        if (dup.rowCount) throw conflict("ReverseRefused", "entry already reversed", { entry_id: body.reverses_entry_id, reason: "already_reversed" });
      }
      const inserted = (await db.query(
        `insert into entries (id, drawer_id, line_id, seq, author_id, is_checkpoint, reverses_entry_id, key_version, schema_version, nonce, ciphertext)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning *`,
        [body.id, drawerId, body.line_id, seq, me.id, body.is_checkpoint, body.reverses_entry_id, body.key_version, body.schema_version, fromB64(body.nonce), fromB64(body.ciphertext)],
      )).rows[0]!;
      if (body.is_checkpoint) await db.query("update line_heads set checkpoint_seq = $3 where drawer_id = $1 and line_id = $2", [drawerId, body.line_id, seq]);
      return inserted;
    // Two replays of the same id at the same instant (SR-14): the loser hits the primary key and is answered like any other replay.
    }).catch(async (e: unknown) => {
      if ((e as { code?: string }).code !== "23505") throw e;
      const again = (await apiPool.query("select * from entries where id = $1", [body.id])).rows[0];
      if (!again) throw e;
      return { replayed: replay(again) };
    });
    if ("replayed" in row) return row.replayed;
    entriesAppended.inc({ result: "created" });
    return reply.code(201).send(PostEntryResponse.parse({ entry: entryRow(row), created: true }));
  });

  /** Older history pages. `before` is a seq; the bootstrap already delivered everything since the last Adjust. */
  app.get<{ Params: { id: string; lineId: string } }>("/drawers/:id/lines/:lineId/entries", async (req) => {
    const me = requireUser(req);
    await requireRole(apiPool, req.params.id, me.id, "read");
    const q = z.object({ before: z.coerce.number().int().min(1).optional(), limit: z.coerce.number().int().min(1).max(200).default(PAGE) }).parse(req.query);
    const { rows } = await apiPool.query(
      `select * from entries where drawer_id = $1 and line_id = $2 and ($3::bigint is null or seq < $3) order by seq desc limit $4`,
      [req.params.id, req.params.lineId, q.before ?? null, q.limit + 1],
    );
    const has_more = rows.length > q.limit;
    return EntriesPage.parse({ entries: rows.slice(0, q.limit).map(entryRow), has_more });
  });
}
