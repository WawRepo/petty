import { describe, expect, it } from "vitest";
import { fromB64, openDocument, openEntryUnverified } from "@petty/crypto";
import { fold, type LedgerEntry } from "@petty/ledger";
import { Client, userMaterial } from "../../../apps/api/src/devtools/fixtures.js";
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
});
