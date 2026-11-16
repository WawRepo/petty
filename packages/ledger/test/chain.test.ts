import { describe, expect, it } from "vitest";
import { hashEntry } from "@petty/crypto";
import { verifyChain, type LedgerEntry } from "../src/index.js";
import { actor, log } from "./helpers.js";

describe("verifyChain", () => {
  it("a linear chain is ok and yields a head to pin; the pinned head re-verifies", async () => {
    const a = await actor("alice");
    const entries = await log(a, [["add", 100], ["withdraw", -30], ["adjust", 70]]);
    const r = await verifyChain(entries);
    expect(r.status).toBe("ok");
    expect(r.head).toEqual({ line_id: "l1", seq: 3, hash: await hashEntry(entries[2]!.entry), start: await hashEntry(entries[0]!.entry) });
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

  it("a replaced entry at the pinned seq is caught", async () => {
    const a = await actor("alice");
    const entries = await log(a, [["add", 1], ["add", 2]]);
    const pinned = (await verifyChain(entries)).head!;
    const replaced = [entries[0]!, { ...entries[1]!, entry: await a.sign({ ...entries[1]!.entry, amount: 999 }) }];
    const r = await verifyChain(replaced, pinned);
    expect(r.status).toBe("truncated");
    expect(r.problems).toEqual([{ entry_id: entries[1]!.entry.id, code: "pinned_head_changed" }]);
  });

  describe("the pinned head is found by its hash (PETTY-444)", () => {
    const renumber = (list: LedgerEntry[], by: number): LedgerEntry[] => list.map((e) => ({ ...e, seq: e.seq + by }));

    it("a log that lost its newest entries is truncated, whatever numbers the rest carries", async () => {
      const a = await actor("alice");
      const entries = await log(a, [["add", 1], ["add", 2], ["add", 3]]);
      const pinned = (await verifyChain(entries)).head!;
      for (const by of [0, 1, 10]) {
        const r = await verifyChain(renumber(entries.slice(0, 2), by), pinned);
        expect(r.status).toBe("truncated");
        expect(r.searchOlder).toBe(false); // no count started a new window: there is nowhere else to look
      }
      // the same in a window that starts at a count
      const counted = await log(a, [["adjust", 50], ["add", 2], ["add", 3]]);
      const head = (await verifyChain(counted)).head!;
      const cut = await verifyChain(renumber(counted.slice(0, 2), 10), head);
      expect(cut.status).toBe("truncated");
      expect(cut.searchOlder).toBe(false); // the window still starts at the count the head was pinned after
      // a head pinned by an older build does not know its window: the rows before the count are asked for, and do not hold it
      const old = { line_id: head.line_id, seq: head.seq, hash: head.hash };
      const asked = await verifyChain(renumber(counted.slice(0, 2), 10), old);
      expect(asked).toMatchObject({ status: "truncated", searchOlder: true });
      const earlier = await log(a, [["add", 9]]);
      expect((await verifyChain(renumber(counted.slice(0, 2), 10), old, earlier)).status).toBe("truncated");
    });

    it("a complete log under other numbers is reported; the head is not moved", async () => {
      const a = await actor("alice");
      const entries = await log(a, [["add", 1], ["add", 2]]);
      const pinned = (await verifyChain(entries)).head!;
      const r = await verifyChain(renumber(entries, 5), pinned);
      expect(r.status).toBe("broken");
      expect(r.problems).toEqual([{ entry_id: entries[1]!.entry.id, code: "pinned_head_renumbered" }]);
    });

    it("a count made on top of the pinned head starts a new window: ok, and the head moves to it", async () => {
      const a = await actor("alice");
      const entries = await log(a, [["add", 1], ["add", 2], ["adjust", 5], ["add", 1]]);
      const pinned = (await verifyChain(entries.slice(0, 2))).head!;
      const r = await verifyChain(entries.slice(2), pinned);
      expect(r).toMatchObject({ status: "ok", searchOlder: false });
      expect(r.head).toEqual({ line_id: "l1", seq: 4, hash: await hashEntry(entries[3]!.entry), start: await hashEntry(entries[2]!.entry) });
    });

    it("entries, then a count, after the pinned head: the head is looked for in the rows before the new window", async () => {
      const a = await actor("alice");
      const entries = await log(a, [["add", 1], ["add", 2], ["add", 3], ["adjust", 5], ["add", 1]]);
      const pinned = (await verifyChain(entries.slice(0, 2))).head!;
      const window = entries.slice(3);
      const asked = await verifyChain(window, pinned);
      expect(asked).toMatchObject({ status: "truncated", searchOlder: true });
      expect((await verifyChain(window, pinned, entries.slice(2, 3)))).toMatchObject({ status: "truncated", searchOlder: true }); // not on this page: ask for more
      expect((await verifyChain(window, pinned, entries.slice(0, 3)))).toMatchObject({ status: "ok", problems: [], searchOlder: false });
    });

    it("concurrent writers: a pinned head the counting member never saw is still found before the count", async () => {
      const a = await actor("alice");
      const b = await actor("bob");
      const [first] = await log(a, [["add", 100]]);
      const h1 = await hashEntry(first!.entry);
      const fromB = { seq: 2, received_at: "", entry: await b.sign({ ...first!.entry, id: "b2", prev_hash: h1, amount: 30, author_id: b.id, sig_key_id: b.sigKeyId }) };
      const pinned = (await verifyChain([first!, fromB])).head!; // bob's entry is the head here
      const fromA = { seq: 3, received_at: "", entry: await a.sign({ ...first!.entry, id: "a3", prev_hash: h1, amount: 50 }) };
      const count = { seq: 4, received_at: "", entry: await a.sign({ ...first!.entry, id: "a4", op: "adjust" as const, prev_hash: await hashEntry(fromA.entry), amount: 180 }) };
      expect((await verifyChain([count], pinned, [first!, fromB, fromA])).status).toBe("ok");
    });

    it("a head pinned in the window that is still served is looked for nowhere else", async () => {
      const a = await actor("alice");
      const entries = await log(a, [["adjust", 5], ["add", 2], ["add", 3]]);
      const pinned = (await verifyChain(entries)).head!;
      const r = await verifyChain([{ ...entries[0]!, seq: 9 }], pinned, [{ ...entries[1]!, seq: 2 }, { ...entries[2]!, seq: 3 }]);
      expect(r).toMatchObject({ status: "truncated", searchOlder: false });
    });

    it("a head found before the window keeps its number and links to nothing that comes after it", async () => {
      const a = await actor("alice");
      const count = (await log(a, [["adjust", 1]]))[0]!;
      const after = { seq: 2, received_at: "", entry: await a.sign({ ...count.entry, id: "x2", op: "add" as const, amount: 4, prev_hash: await hashEntry(count.entry) }) };
      const head = { line_id: "l1", seq: 2, hash: await hashEntry(after.entry) };
      const back = await verifyChain([{ ...count, seq: 5 }], head, [after]);
      expect(back.problems).toEqual([{ entry_id: "x2", code: "prev_not_older" }]);
      expect(back.status).toBe("broken");

      const earlier = await log(a, [["add", 7], ["add", 8], ["add", 1], ["adjust", 9]]);
      const old = { line_id: "l1", seq: 2, hash: await hashEntry(earlier[1]!.entry) };
      const r = await verifyChain([{ ...earlier[3]!, seq: 30 }], old, renumber(earlier.slice(0, 3), 10));
      expect(r.problems).toEqual([{ entry_id: earlier[1]!.entry.id, code: "pinned_head_renumbered" }]);
      expect(r.status).toBe("broken");
    });
  });

  describe("counts and window starts (PETTY-448)", () => {
    it("a row whose count flag differs from its sealed operation is reported, either way", async () => {
      const a = await actor("alice");
      const entries = await log(a, [["adjust", 100], ["add", 1], ["adjust", 50]]);
      const honest = entries.map((e) => ({ ...e, is_checkpoint: e.entry.op === "adjust" }));
      expect((await verifyChain(honest)).status).toBe("ok");
      const flagged = [honest[0]!, { ...honest[1]!, is_checkpoint: true }, honest[2]!];
      expect(await verifyChain(flagged)).toMatchObject({ status: "broken", problems: [{ entry_id: entries[1]!.entry.id, code: "checkpoint_flag_mismatch" }] });
      const unflagged = [honest[0]!, honest[1]!, { ...honest[2]!, is_checkpoint: false }];
      expect(await verifyChain(unflagged)).toMatchObject({ status: "broken", problems: [{ entry_id: entries[2]!.entry.id, code: "checkpoint_flag_mismatch" }] });
    });

    it("the first entry of a window is a count, or has no prev_hash", async () => {
      const a = await actor("alice");
      const entries = await log(a, [["add", 1], ["add", 2], ["adjust", 5], ["add", 1]]);
      expect((await verifyChain(entries)).status).toBe("ok");       // starts at the line's first entry
      expect((await verifyChain(entries.slice(2))).status).toBe("ok"); // starts at a count
      const r = await verifyChain(entries.slice(1, 2));
      expect(r).toMatchObject({ status: "broken", problems: [{ entry_id: entries[1]!.entry.id, code: "window_start_linked" }] });
      // also when the server says that entry is a count
      const flagged = await verifyChain([{ ...entries[1]!, is_checkpoint: true }]);
      expect(flagged.problems.map((p) => p.code)).toEqual(["window_start_linked", "checkpoint_flag_mismatch"]);
    });

    it("the same entry under two numbers is refused", async () => {
      const a = await actor("alice");
      const [e] = await log(a, [["add", 1]]);
      await expect(verifyChain([e!, { ...e!, seq: 2 }])).rejects.toMatchObject({ code: "duplicate_entry" });
    });
  });

  it("a genesis (null prev) from the same author twice is broken; from two authors it is a fork", async () => {
    const a = await actor("alice");
    const b = await actor("bob");
    const e1 = (await log(a, [["add", 1]]))[0]!;
    const again = await a.sign({ ...e1.entry, id: "x", prev_hash: null });
    expect((await verifyChain([e1, { seq: 2, received_at: "", entry: again }])).problems[0]?.code).toBe("genesis_repeated");
    const other = await b.sign({ ...e1.entry, id: "y", prev_hash: null, author_id: b.id, sig_key_id: b.sigKeyId });
    expect((await verifyChain([e1, { seq: 2, received_at: "", entry: other }])).status).toBe("ok");
    // PETTY-445: an entry a tool signed with its own key may come without a link, as tools before it wrote them
    const tool = { seq: 2, received_at: "", entry: again, by_token: true };
    expect(await verifyChain([e1, tool])).toMatchObject({ status: "ok", problems: [] });
    // …and it is checked like any other entry otherwise: one that links to nothing in the window is reported
    const linked = { seq: 3, received_at: "", entry: await a.sign({ ...e1.entry, id: "z", prev_hash: "0".repeat(64) }), by_token: true };
    expect((await verifyChain([e1, tool, linked])).problems).toEqual([{ entry_id: "z", code: "prev_unresolved" }]);
  });

  it("an empty window with a pinned head is truncated", async () => {
    expect((await verifyChain([], { line_id: "l1", seq: 1, hash: "0".repeat(64) })).status).toBe("truncated");
  });
});
