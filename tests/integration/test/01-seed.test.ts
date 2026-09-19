import { describe, expect, it } from "vitest";
import { toB64 } from "@petty/crypto";
import { applyOp, newDocument } from "@petty/ledger";
import { newUser, readState, writeState } from "../lib.js";

/**
 * Writes a small household that later files (and, with PETTY_BASE_IMAGE, the NEXT image) must still
 * read: one account, one drawer, two entries. Runs once per stack; a second run leaves it alone.
 */
describe("seed", () => {
  it.skipIf(readState() !== null)("an account with a drawer and two entries", async () => {
    const owner = await newUser("seed");
    const lineId = crypto.randomUUID();
    const doc = applyOp(newDocument("Seed tin"), { type: "add_line", line: { id: lineId, kind: "money", name: "Cash", currency: "PLN", exponent: 2 } }, { lineHasEntries: () => false });
    const d = await owner.createDrawer("Seed tin", doc);
    expect(d.res.statusCode).toBe(201);
    expect((await owner.postEntry(d.id, d.key, lineId, "add", 1000)).res.statusCode).toBe(201);
    expect((await owner.postEntry(d.id, d.key, lineId, "withdraw", -250)).res.statusCode).toBe(201);
    const wrap = (await owner.call("GET", "/bootstrap")).json().wraps.find((w: { drawer_id: string }) => w.drawer_id === d.id);
    const raw = await owner.unwrap(wrap, owner.user.pub.ecdh, true);
    writeState({
      email: owner.user.email, password: owner.user.password, drawerId: d.id, drawerName: "Seed tin", lineId,
      drawerKey: toB64(new Uint8Array(await crypto.subtle.exportKey("raw", raw))), balance: 750, entries: 2,
    });
  });
});
