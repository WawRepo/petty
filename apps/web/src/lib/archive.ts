/**
 * Export and import (spec "Backup strategy" 2, SPEC-ISSUES B9).
 * Export: every drawer I may export (owner or writer), decrypted in memory, sealed
 * under an export password that is independent of the vault; or plain JSON behind
 * a warning. Import: new drawers with new keys; entries are re-signed by the
 * importer, keep the original author and date as a text label, and are flagged.
 */
import { fromB64, openDocument, openEntryUnverified, openPhoto, sealArchive, openArchive, sealDocument, toB64, createDrawerKey, type ExportArchiveV1, type RecordIdentity } from "@petty/crypto";
import { assertDocumentShape, type DrawerDocument, type Line } from "@petty/ledger";
import { ExportPayload, type DrawerSummary, type ExportDrawer, type ExportPayload as ExportPayloadT } from "@petty/protocol";
import { z } from "zod";
import { api } from "./api.js";
import { appendEntry, getDrawers, loadAll, setPhoto } from "./drawers.js";
import { getAuth } from "./session.js";

function me() { const a = getAuth(); if (a.status !== "unlocked") throw new Error("vault locked"); return a; }

interface ExportRow { document: { author_id: string; key_version: number; schema_version: number; nonce: string; ciphertext: string }; photo: { author_id: string; key_version: number; nonce: string; ciphertext: string } | null; entries: Array<{ id: string; line_id: string; seq: number; received_at: string; author_id: string; key_version: number; schema_version: number; nonce: string; ciphertext: string }>; wraps: unknown[] }

/** Decrypts everything exportable into the archive shape. Returns how many drawers were skipped (read-only role or unreadable). */
export async function buildExport(): Promise<{ payload: ExportPayloadT; skipped: number }> {
  const a = me();
  if (getDrawers().status !== "ready") await loadAll();
  const state = getDrawers();
  const drawers: ExportDrawer[] = [];
  let skipped = 0;
  for (const id of state.order) {
    const view = state.drawers.get(id);
    if (!view?.key || !view.doc || view.summary.role === "read") { skipped += 1; continue; }
    const row = await api<ExportRow>("GET", `/drawers/${id}/export`);
    const keys = new Map<number, CryptoKey>([[view.summary.key_version, view.key]]);
    const keyFor = async (v: number): Promise<CryptoKey> => {
      const k = keys.get(v);
      if (k) return k;
      const { unwrapDrawerKey } = await import("@petty/crypto");
      const { expectedSender } = await import("./drawers.js");
      const wrap = view.wraps.find((w) => w.key_version === v);
      if (!wrap) throw new Error("no key for version");
      const sender = await expectedSender(wrap, view.members);
      if ("error" in sender) throw new Error(sender.error);
      const uk = await unwrapDrawerKey(wrap, a.keys.ecdhPrivate, { drawer_id: id, key_version: v, senderEcdhPublicB64: sender.pub });
      keys.set(v, uk);
      return uk;
    };
    const d = row.document;
    const doc = await openDocument(await keyFor(d.key_version), { record_type: "document", record_id: id, drawer_id: id, line_id: null, author_id: d.author_id, key_version: d.key_version, schema_version: d.schema_version }, { nonce: fromB64(d.nonce), ciphertext: fromB64(d.ciphertext) });
    assertDocumentShape(doc);
    let photo_b64: string | null = null;
    if (row.photo) {
      const p = row.photo;
      photo_b64 = toB64(await openPhoto(await keyFor(p.key_version), { record_type: "photo", record_id: id, drawer_id: id, line_id: null, author_id: p.author_id, key_version: p.key_version, schema_version: 1 }, { nonce: fromB64(p.nonce), ciphertext: fromB64(p.ciphertext) }));
    }
    const entries = [];
    for (const e of row.entries) {
      const identity: RecordIdentity = { record_type: "entry", record_id: e.id, drawer_id: id, line_id: e.line_id, author_id: e.author_id, key_version: e.key_version, schema_version: e.schema_version };
      entries.push({ seq: e.seq, received_at: e.received_at, entry: await openEntryUnverified(await keyFor(e.key_version), identity, { nonce: fromB64(e.nonce), ciphertext: fromB64(e.ciphertext) }) });
    }
    entries.sort((x, y) => x.seq - y.seq);
    drawers.push({ id, document: doc, photo_b64, members: view.members.map((m) => ({ id: m.user_id, display_name: m.display_name, role: m.role })), entries });
  }
  const payload = ExportPayload.parse({ format: "petty-export", v: 1, exported_at: new Date().toISOString(), exported_by: { id: a.me.id, display_name: a.me.display_name }, drawers });
  return { payload, skipped };
}

export async function exportEncrypted(password: string): Promise<{ name: string; text: string }> {
  const { payload } = await buildExport();
  const archive = await sealArchive(password, payload);
  return { name: `petty-export-${payload.exported_at.slice(0, 10)}.petty.json`, text: JSON.stringify(archive) };
}
export async function exportPlain(): Promise<{ name: string; text: string }> {
  const { payload } = await buildExport();
  return { name: `petty-export-${payload.exported_at.slice(0, 10)}.PLAINTEXT.json`, text: JSON.stringify(payload, null, 2) };
}

/** Hands the file to the browser's download. The bytes exist on disk only because the user asked for exactly that. */
export function downloadText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.rel = "noopener";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const Archive = z.object({ v: z.literal(1), kdf: z.object({ name: z.literal("argon2id"), m: z.number(), t: z.number(), p: z.number(), salt: z.string() }), nonce: z.string(), ciphertext: z.string() });
export type ParsedImport = { kind: "encrypted"; archive: ExportArchiveV1 } | { kind: "plain"; payload: ExportPayloadT };

export function parseImportFile(text: string): ParsedImport {
  const json = JSON.parse(text) as unknown;
  const enc = Archive.safeParse(json);
  if (enc.success) return { kind: "encrypted", archive: enc.data };
  return { kind: "plain", payload: ExportPayload.parse(json) };
}
export async function openImport(parsed: ParsedImport, password: string): Promise<ExportPayloadT> {
  if (parsed.kind === "plain") return parsed.payload;
  return ExportPayload.parse(await openArchive(password, parsed.archive));
}

export type ImportProgress = { drawer: string; done: number; total: number };

/**
 * Creates a NEW drawer per archived drawer (new id, new key, me as owner), then
 * replays the entries in seq order per line as my own entries: the original
 * author and time become a label in the comment, and "[imported]" marks them.
 * Line ids are kept so verifications keep pointing at the right lines.
 */
export async function importPayload(payload: ExportPayloadT, onProgress: (p: ImportProgress) => void): Promise<string[]> {
  const a = me();
  const created: string[] = [];
  const total = payload.drawers.reduce((n, d) => n + d.entries.length, 0);
  let done = 0;
  for (const ad of payload.drawers) {
    const doc = ad.document as DrawerDocument;
    assertDocumentShape(doc);
    const id = crypto.randomUUID();
    const { key, selfWrap } = await createDrawerKey({ ecdhPrivate: a.keys.ecdhPrivate, ecdhPublicB64: a.me.pub.ecdh }, id, 1);
    const importedDoc: DrawerDocument = { ...doc, has_photo: false, verifications: doc.verifications.map((v) => ({ ...v, author_id: a.me.id, comment: `${v.comment ? v.comment + " · " : ""}[imported: ${ad.members.find((m) => m.id === v.author_id)?.display_name ?? "?"}]` })) };
    const sealed = await sealDocument(key, { record_type: "document", record_id: id, drawer_id: id, line_id: null, author_id: a.me.id, key_version: 1, schema_version: 1 }, importedDoc);
    await api<DrawerSummary>("POST", "/drawers", { id, document: { key_version: 1, schema_version: 1, nonce: toB64(sealed.nonce), ciphertext: toB64(sealed.ciphertext) }, self_wrap: selfWrap });
    await loadAll();
    const byLine = new Map<string, typeof ad.entries>();
    for (const e of ad.entries) { const l = byLine.get(e.entry.line_id) ?? []; l.push(e); byLine.set(e.entry.line_id, l); }
    const idMap = new Map<string, string>();
    for (const [lineId, list] of byLine) {
      const line = importedDoc.lines.find((l) => l.id === lineId) as Line | undefined;
      if (!line || line.kind === "single") { done += list.length; continue; }
      for (const e of list.sort((x, y) => x.seq - y.seq)) {
        const p = e.entry;
        const author = ad.members.find((m) => m.id === p.author_id)?.display_name ?? "?";
        const label = `[imported: ${author}, ${p.logged_at.slice(0, 10)}]`;
        const comment = p.comment ? `${p.comment} · ${label}` : label;
        const reverses = p.reverses ? (idMap.get(p.reverses) ?? null) : null;
        if (p.op === "reverse" && !reverses) { done += 1; continue; } // target not imported: skip rather than invent
        try {
          const le = await appendEntry(id, line, p.op, p.amount, { comment, reverses, delta_hint: p.delta_hint });
          idMap.set(p.id, le.entry.id);
        } catch { /* refused by the rules (e.g. reverse after a count): the archive stays the record; keep going */ }
        done += 1;
        onProgress({ drawer: doc.name, done, total });
      }
    }
    if (ad.photo_b64) await setPhoto(id, fromB64(ad.photo_b64));
    created.push(id);
  }
  await loadAll();
  return created;
}
