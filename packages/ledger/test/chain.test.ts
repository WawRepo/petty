import { describe, expect, it } from "vitest";
import { hashEntry } from "@petty/crypto";
import { verifyChain } from "../src/index.js";
import { actor, log } from "./helpers.js";

describe("verifyChain", () => {
  it("a linear chain is ok and yields a head to pin; the pinned head re-verifies", async () => {
    const a = await actor("alice");
    const entries = await log(a, [["add", 100], ["withdraw", -30], ["adjust", 70]]);
    const r = await verifyChain(entries);
    expect(r.status).toBe("ok");
    expect(r.head).toEqual({ line_id: "l1", seq: 3, hash: await hashEntry(entries[2]!.entry) });
    expect((await verifyChain(entries, r.head)).status).toBe("ok");
  });

  it("a concurrent fork (two entries sharing a prev) is ok", async () => {
    const a = await actor("alice");
    const b = await actor("bob");
    const [first] = await log(a, [["add", 100]]);
    const h = await hashEntry(first!.entry);
    const fromA = await a.sign({ ...first!.entry, id: "a2", prev_hash: h, amount: 50 });
    const fromB = await b.sign({ ...first!.entry, id: "b2", prev_hash: h, amount: 30, author_id: b.id, sig_key_id: b.sigKeyId });
    const entries = [first!, { seq: 2, received_at: "", entry: fromA }, { seq: 3, received_at: "", entry: fromB }];
    expect((await verifyChain(entries)).status).toBe("ok");
  });

  it("deleting a middle entry breaks the chain; deleting the newest is caught by the pinned head", async () => {
    const a = await actor("alice");
    const entries = await log(a, [["add", 1], ["add", 2], ["add", 3]]);
    const pinned = (await verifyChain(entries)).head;
    const middleGone = [entries[0]!, entries[2]!];
    const r1 = await verifyChain(middleGone);
    expect(r1.status).toBe("broken");
    expect(r1.problems).toEqual([{ entry_id: entries[2]!.entry.id, code: "prev_unresolved" }]);
    const tailGone = entries.slice(0, 2);
    const r2 = await verifyChain(tailGone, pinned);
    expect(r2.status).toBe("truncated");
    expect(r2.problems[0]?.code).toBe("pinned_head_missing");
    expect((await verifyChain(tailGone)).status).toBe("ok"); // without a pin, a chain cannot see it
  });

  it("a replaced entry at the pinned seq is caught; a window that starts after the pin is fine", async () => {
    const a = await actor("alice");
    const entries = await log(a, [["add", 1], ["add", 2]]);
    const pinned = (await verifyChain(entries)).head!;
    const replaced = [entries[0]!, { ...entries[1]!, entry: await a.sign({ ...entries[1]!.entry, amount: 999 }) }];
    expect((await verifyChain(replaced, pinned)).status).toBe("truncated");
    const later = await log(a, [["adjust", 5]]);
    const window = [{ ...later[0]!, seq: 3 }];
    expect((await verifyChain(window, pinned)).status).toBe("ok"); // pin (seq 2) is before the fetched window
  });

  it("a genesis (null prev) from the same author twice is broken; from two authors it is a fork", async () => {
    const a = await actor("alice");
    const b = await actor("bob");
    const e1 = (await log(a, [["add", 1]]))[0]!;
    const again = await a.sign({ ...e1.entry, id: "x", prev_hash: null });
    expect((await verifyChain([e1, { seq: 2, received_at: "", entry: again }])).problems[0]?.code).toBe("genesis_repeated");
    const other = await b.sign({ ...e1.entry, id: "y", prev_hash: null, author_id: b.id, sig_key_id: b.sigKeyId });
    expect((await verifyChain([e1, { seq: 2, received_at: "", entry: other }])).status).toBe("ok");
  });

  it("an empty window with a pinned head is truncated", async () => {
    expect((await verifyChain([], { line_id: "l1", seq: 1, hash: "0".repeat(64) })).status).toBe("truncated");
  });
});
