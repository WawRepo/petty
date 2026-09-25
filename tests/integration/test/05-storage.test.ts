import { describe, expect, it } from "vitest";
import { sealPhoto, toB64 } from "@petty/crypto";
import { newDocument } from "@petty/ledger";
import { PHOTO_MAX_BYTES, PHOTO_MAX_CIPHERTEXT } from "@petty/protocol";
import type { Client } from "../../../apps/api/src/devtools/fixtures.js";
import { newUser } from "../lib.js";

/**
 * PETTY-243: the image enforces the photo size limit and a per-user storage quota. compose.test.yml
 * sets STORAGE_QUOTA_MB=1, so a few full-size photos fill an account.
 */
async function photoFor(c: Client, id: string, key: CryptoKey, bytes: Uint8Array) {
  const sealed = await sealPhoto(key, { record_type: "photo", record_id: id, drawer_id: id, line_id: null, author_id: c.id, key_version: 1, schema_version: 1 }, bytes);
  return c.call("PUT", `/drawers/${id}/photo`, { key_version: 1, schema_version: 1, nonce: toB64(sealed.nonce), ciphertext: toB64(sealed.ciphertext) });
}

describe("storage limits", () => {
  it("accepts a full-size photo, refuses a bigger one, and stops at the quota until space is freed", async () => {
    const dee = await newUser("dee");
    const storage = async () => (await dee.call("GET", "/me/storage")).json() as { used_bytes: number; quota_bytes: number | null };
    expect((await storage()).quota_bytes).toBe(1024 * 1024);

    const drawers: { id: string; key: CryptoKey }[] = [];
    for (const n of ["one", "two", "three", "four"]) {
      const d = await dee.createDrawer(n, newDocument(n));
      expect(d.res.statusCode).toBe(201);
      drawers.push({ id: d.id, key: d.key });
    }
    const [a, b, c, d] = drawers as [typeof drawers[0], typeof drawers[0], typeof drawers[0], typeof drawers[0]];

    // over the size limit: refused whatever the quota says (what a script or token could send)
    const big = await dee.call("PUT", `/drawers/${a.id}/photo`, { key_version: 1, schema_version: 1, nonce: toB64(new Uint8Array(12)), ciphertext: toB64(new Uint8Array(PHOTO_MAX_CIPHERTEXT + 1)) });
    expect(big.statusCode).toBe(413);
    expect(big.json().code).toBe("PhotoTooLarge");

    // three photos at the client's maximum fit in 1 MB, the fourth does not
    const full = new Uint8Array(PHOTO_MAX_BYTES);
    for (const x of [a, b, c]) expect((await photoFor(dee, x.id, x.key, full)).statusCode).toBe(204);
    const over = await photoFor(dee, d.id, d.key, full);
    expect(over.statusCode).toBe(413);
    expect(over.json()).toMatchObject({ code: "StorageQuotaExceeded", context: { owner_id: dee.id, quota_bytes: 1024 * 1024 } });
    expect((await storage()).used_bytes).toBeGreaterThan(3 * PHOTO_MAX_BYTES);

    // removing a photo frees the space
    expect((await dee.call("DELETE", `/drawers/${a.id}/photo`)).statusCode).toBe(204);
    expect((await photoFor(dee, d.id, d.key, full)).statusCode).toBe(204);
  }, 60_000);
});
