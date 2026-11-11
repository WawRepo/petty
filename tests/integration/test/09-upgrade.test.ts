import { describe, expect, it } from "vitest";
import { fromB64, openDocument, openEntryUnverified } from "@petty/crypto";
import { fold, nextRev, readDocument, type LedgerEntry } from "@petty/ledger";
import { Client, sealedBody, userMaterial } from "../../../apps/api/src/devtools/fixtures.js";
import { API, compose, http, readState } from "../lib.js";

/**
 * What was written before is still there and still opens: after an app restart, and (with
 * PETTY_BASE_IMAGE) after an upgrade from the older image. Data written by the old version, read
 * by the new one: the check that a change did not break what people already have.
 */
describe("existing data", () => {
  it("survives a restart (and the upgrade), still logs in, still decrypts to the same balance", async () => {
    const s = readState();
    expect(s, "01-seed did not run").not.toBeNull();
    compose("restart app");
    await expect.poll(async () => (await fetch(`${API}/health`).catch(() => null))?.status, { timeout: 60_000, interval: 1000 }).toBe(200);

    const c = new Client(http, { ...(await userMaterial("upgrade")), email: s!.email, password: s!.password });
    expect((await c.login()).statusCode).toBe(200);
    const key = await crypto.subtle.importKey("raw", new Uint8Array(fromB64(s!.drawerKey)), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);

    const got = (await c.call("GET", `/drawers/${s!.drawerId}`)).json();
    const d = got.document;
    const doc = await openDocument(key, { record_type: "document", record_id: s!.drawerId, drawer_id: s!.drawerId, line_id: null, author_id: d.author_id, key_version: d.key_version, schema_version: d.schema_version }, { nonce: fromB64(d.nonce), ciphertext: fromB64(d.ciphertext) });
    expect((doc as { name: string }).name).toBe(s!.drawerName);

    const rows = (await c.call("GET", "/bootstrap")).json().entries.filter((e: { drawer_id: string }) => e.drawer_id === s!.drawerId);
    const list: LedgerEntry[] = [];
    for (const r of rows) {
      const entry = await openEntryUnverified(key, { record_type: "entry", record_id: r.id, drawer_id: s!.drawerId, line_id: r.line_id, author_id: r.author_id, key_version: r.key_version, schema_version: r.schema_version }, { nonce: fromB64(r.nonce), ciphertext: fromB64(r.ciphertext) });
      list.push({ seq: r.seq, received_at: r.received_at, entry });
    }
    expect(list).toHaveLength(s!.entries);
    expect(fold(list).balance).toBe(s!.balance);
  });

  /**
   * PETTY-422: the seeded document is from before the counter (format 1; with PETTY_BASE_IMAGE the older image
   * stored it). It opens under the rules for a document without a counter, and the first save by a client that
   * knows the counter stores format 2 with the counter at 1, the content unchanged. After that a client from
   * before the counter cannot save over it. A second run of this file finds the document already in format 2.
   */
  it("a drawer document from before the counter still opens, and takes its first counter at the next save", async () => {
    const s = readState();
    expect(s, "01-seed did not run").not.toBeNull();
    const c = new Client(http, { ...(await userMaterial("upgrade")), email: s!.email, password: s!.password });
    expect((await c.login()).statusCode).toBe(200);
    const key = await crypto.subtle.importKey("raw", new Uint8Array(fromB64(s!.drawerKey)), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    const read = async () => {
      const got = (await c.call("GET", `/drawers/${s!.drawerId}`)).json();
      const d = got.document;
      const opened = await openDocument(key, { record_type: "document", record_id: s!.drawerId, drawer_id: s!.drawerId, line_id: null, author_id: d.author_id, key_version: d.key_version, schema_version: d.schema_version }, { nonce: fromB64(d.nonce), ciphertext: fromB64(d.ciphertext) });
      return { version: got.drawer.version as number, schema: d.schema_version as number, doc: readDocument(opened, { schema_version: d.schema_version, version: got.drawer.version }) };
    };
    const before = await read();
    expect(before.doc.name).toBe(s!.drawerName);
    expect(before.doc.lines.map((l) => l.id)).toEqual([s!.lineId]);
    if (before.schema === 1) {
      expect(before.doc.rev).toBeUndefined();
      const put = await c.call("PUT", `/drawers/${s!.drawerId}/document`, { ...sealedBody(await c.sealDoc(s!.drawerId, key, nextRev(before.doc), 1, 2), 1, 2), base_version: before.version, verification: false });
      expect(put.statusCode).toBe(200);
    }
    const after = await read();
    expect(after.schema).toBe(2);
    expect(after.doc).toEqual({ ...before.doc, rev: before.schema === 1 ? 1 : before.doc.rev });
    // a client from before the counter: its document without one is refused, and nothing changes
    const { rev: _rev, ...plain } = after.doc;
    void _rev;
    const older = await c.call("PUT", `/drawers/${s!.drawerId}/document`, { ...sealedBody(await c.sealDoc(s!.drawerId, key, plain, 1, 1), 1, 1), base_version: after.version, verification: false });
    expect(older.statusCode).toBe(409);
    expect(older.json().code).toBe("DocumentFormatOlder");
    expect(await read()).toEqual(after);
  });
});
