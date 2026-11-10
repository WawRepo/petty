import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LedgerError, REV_AHEAD_MAX, applyOps, assertDocumentShape, newDocument, nextRev, readDocument, revRolledBack, type DrawerDocument, type Line } from "../src/index.js";

/** PETTY-422: the counter inside a drawer document. */
const line: Line = { id: "a", kind: "money", name: "Cash", currency: "PLN", exponent: 2 };
const ctx = { lineHasEntries: () => false };
const plain = (): DrawerDocument => applyOps(newDocument("Tin"), [{ type: "add_line", line }], ctx);
/** What a ciphertext gives back: the document through JSON. */
const stored = (doc: DrawerDocument): unknown => JSON.parse(JSON.stringify(doc));

describe("the counter of a drawer document", () => {
  it("a document from before the counter is format 1 and opens without one", () => {
    const doc = readDocument(stored(plain()), { schema_version: 1, version: 7 });
    expect(doc).toEqual(plain());
    expect(doc.rev).toBeUndefined();
    expect(revRolledBack(doc, null)).toBe(false);
  });

  it("a counter found in a format 1 document does not count", () => {
    const doc = readDocument({ ...(stored(plain()) as object), rev: 9 }, { schema_version: 1, version: 7 });
    expect("rev" in doc).toBe(false);
    expect(doc).toEqual(plain());
    // its next write starts the counter
    expect(nextRev(doc).rev).toBe(1);
  });

  it("a format 2 document must carry a counter", () => {
    expect(() => readDocument(stored(plain()), { schema_version: 2, version: 7 })).toThrow(/bad_document/);
    expect(readDocument(stored(nextRev(plain())), { schema_version: 2, version: 7 }).rev).toBe(1);
  });

  it("a counter is a whole number from 1", () => {
    for (const rev of [0, -1, 1.5, "3", null, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => assertDocumentShape({ ...(stored(plain()) as object), rev }), String(rev)).toThrow(LedgerError);
      expect(() => readDocument({ ...(stored(plain()) as object), rev }, { schema_version: 2, version: 7 }), String(rev)).toThrow(LedgerError);
    }
    expect(() => assertDocumentShape({ ...(stored(plain()) as object), rev: 1 })).not.toThrow();
  });

  it("a counter further ahead of the drawer's version number than a write in passing explains is refused", () => {
    const at = (rev: number) => ({ ...(stored(plain()) as object), rev });
    expect(readDocument(at(7), { schema_version: 2, version: 7 }).rev).toBe(7);
    expect(readDocument(at(7 + REV_AHEAD_MAX), { schema_version: 2, version: 7 }).rev).toBe(7 + REV_AHEAD_MAX);
    expect(() => readDocument(at(7 + REV_AHEAD_MAX + 1), { schema_version: 2, version: 7 })).toThrow(/bad_document/);
    expect(() => readDocument(at(Number.MAX_SAFE_INTEGER), { schema_version: 2, version: 7 })).toThrow(/bad_document/);
    // so the highest counter anyone can store still leaves room for the next write, which raises the version number too
    const highest = readDocument(at(7 + REV_AHEAD_MAX), { schema_version: 2, version: 7 });
    expect(readDocument(stored(nextRev(highest)), { schema_version: 2, version: 8 }).rev).toBe(8 + REV_AHEAD_MAX);
  });

  it("every write stores the counter it loaded plus one; a change to the content keeps the loaded counter until then", () => {
    const first = nextRev(plain());
    expect(first.rev).toBe(1);
    const edited = applyOps(first, [{ type: "rename_drawer", name: "Kitchen" }, { type: "set_tags", tags: ["shed"] }, { type: "remove_line", line_id: "a" }], ctx);
    expect(edited.rev).toBe(1);
    expect(nextRev(edited).rev).toBe(2);
    expect(first.rev).toBe(1); // the input is not changed
    expect(() => nextRev({ ...plain(), rev: Number.MAX_SAFE_INTEGER })).toThrow(/bad_document/);
  });

  it("two writers that loaded the same document: the one refused loads again and takes the counter from the fresh copy", () => {
    const loaded = { ...plain(), rev: 5 };
    const winner = nextRev(applyOps(loaded, [{ type: "rename_drawer", name: "A" }], ctx));
    expect(winner.rev).toBe(6);
    // the second writer's save was refused (VersionConflict): its change goes on top of what the first one stored
    const second = nextRev(applyOps(readDocument(stored(winner), { schema_version: 2, version: 9 }), [{ type: "set_tags", tags: ["shed"] }], ctx));
    expect(second).toMatchObject({ rev: 7, name: "A", tags: ["shed"] });
  });

  it("the format 2 document of the compatibility corpus reads as a document with its counter", () => {
    const corpus = JSON.parse(readFileSync(fileURLToPath(new URL("../../crypto/corpus/v2/drawer.json", import.meta.url)), "utf8")) as { records: { identity: { schema_version: number }; plaintext: unknown }[] };
    for (const r of corpus.records) {
      const doc = readDocument(r.plaintext, { schema_version: r.identity.schema_version, version: 9 });
      expect(doc).toMatchObject({ rev: 7, name: "Kitchen drawer" });
      expect(doc.lines).toHaveLength(3);
      expect(nextRev(doc).rev).toBe(8);
    }
  });

  it("a reader that remembers a counter refuses a lower one, and a document with none; one that remembers none takes any", () => {
    const at = (rev?: number): DrawerDocument => (rev === undefined ? plain() : { ...plain(), rev });
    expect(revRolledBack(at(4), 5)).toBe(true);
    expect(revRolledBack(at(), 5)).toBe(true);
    expect(revRolledBack(at(), 1)).toBe(true);
    expect(revRolledBack(at(5), 5)).toBe(false); // the same document again, for example after a key rotation
    expect(revRolledBack(at(6), 5)).toBe(false);
    expect(revRolledBack(at(), null)).toBe(false);
    expect(revRolledBack(at(1), null)).toBe(false);
  });
});
