import { describe, expect, it } from "vitest";
import { confirmedFor, leftDrawerAt, membersNoted, pinConfirmed, pinnedSigningKeys, rotationOwed } from "./pins.js";

type Doc = Parameters<typeof membersNoted>[0];
const keys = (n: string) => ({ ecdh_pub: `ecdh-${n}`, ecdsa_pub: `ecdsa-${n}`, sig_key_id: `id-${n}` });
const firstSight = (n: string) => ({ ecdh: `ecdh-${n}`, ecdsa: `ecdsa-${n}`, sig_key_id: `id-${n}`, pinned_at: "2026-01-01T00:00:00.000Z", confirmed_at: null });
const empty: Doc = { v: 1, pins: {} };
const D = "drawer-1";
const drawer = (members: string[], key_version = 1, wraps: Array<{ key_version: number; sender_id?: string }> = []) => ({ id: D, key_version, members, wraps });

// PETTY-413: which signing keys count for a contact
describe("pinConfirmed", () => {
  it("pins the keys as confirmed and keeps no earlier key the first time", () => {
    const doc = pinConfirmed(empty, "bob", keys("b1"), "2026-02-02T00:00:00.000Z");
    expect(doc.pins["bob"]).toEqual({ ecdh: "ecdh-b1", ecdsa: "ecdsa-b1", sig_key_id: "id-b1", pinned_at: "2026-02-02T00:00:00.000Z", confirmed_at: "2026-02-02T00:00:00.000Z" });
    expect(pinnedSigningKeys("bob", doc)).toEqual(["ecdsa-b1"]);
    expect(pinnedSigningKeys("carol", doc)).toBeNull();
  });
  it("confirming the same keys again changes nothing but the date", () => {
    const once = pinConfirmed(empty, "bob", keys("b1"), "2026-02-02T00:00:00.000Z");
    const twice = pinConfirmed(once, "bob", keys("b1"), "2026-03-03T00:00:00.000Z");
    expect(twice.pins["bob"]).toEqual({ ...once.pins["bob"], confirmed_at: "2026-03-03T00:00:00.000Z" });
  });
  it("keeps a signing key that was confirmed before when a new one is confirmed", () => {
    const b1 = pinConfirmed(empty, "bob", keys("b1"), "2026-02-02T00:00:00.000Z");
    const b2 = pinConfirmed(b1, "bob", keys("b2"), "2026-03-03T00:00:00.000Z");
    expect(b2.pins["bob"]?.ecdsa).toBe("ecdsa-b2");
    expect(pinnedSigningKeys("bob", b2)).toEqual(["ecdsa-b2", "ecdsa-b1"]);
    const b3 = pinConfirmed(b2, "bob", keys("b3"), "2026-04-04T00:00:00.000Z");
    expect(pinnedSigningKeys("bob", b3)).toEqual(["ecdsa-b3", "ecdsa-b1", "ecdsa-b2"]);
  });
  it("does not keep a key that was pinned on first sight and never confirmed", () => {
    const seen: Doc = { v: 1, pins: { bob: firstSight("b1") } };
    expect(pinnedSigningKeys("bob", seen)).toEqual(["ecdsa-b1"]);
    const doc = pinConfirmed(seen, "bob", keys("b2"), "2026-03-03T00:00:00.000Z");
    expect(pinnedSigningKeys("bob", doc)).toEqual(["ecdsa-b2"]);
    expect(doc.pins["bob"]?.pinned_at).toBe("2026-01-01T00:00:00.000Z");
  });
  it("lists a key once when it comes back as the current one", () => {
    const b1 = pinConfirmed(empty, "bob", keys("b1"), "2026-02-02T00:00:00.000Z");
    const b2 = pinConfirmed(b1, "bob", keys("b2"), "2026-03-03T00:00:00.000Z");
    const back = pinConfirmed(b2, "bob", keys("b1"), "2026-04-04T00:00:00.000Z");
    expect(pinnedSigningKeys("bob", back)).toEqual(["ecdsa-b1", "ecdsa-b2"]);
  });
});

// PETTY-449: who left a drawer, and what that means for its key
describe("membersNoted", () => {
  it("remembers the other members of a shared drawer, and nothing for a drawer nobody else is in", () => {
    expect(membersNoted(empty, "me", [drawer(["me"])])).toBe(empty);
    const doc = membersNoted(empty, "me", [drawer(["me", "carol", "bob"])]);
    expect(doc.drawer_members).toEqual({ [D]: ["bob", "carol"] });
    expect(doc.drawer_left).toBeUndefined();
    expect(membersNoted(doc, "me", [drawer(["bob", "me", "carol"])])).toBe(doc);
  });
  it("someone no longer listed left with the key this person had accepted: that key is owed a replacement", () => {
    const before: Doc = { ...empty, drawer_members: { [D]: ["bob", "carol"] }, drawer_keys: { [D]: 1 } };
    const doc = membersNoted(before, "me", [drawer(["me", "carol"], 1, [{ key_version: 1, sender_id: "carol" }])]);
    expect(doc.drawer_members).toEqual({ [D]: ["carol"] });
    expect(leftDrawerAt(D, "bob", doc)).toBe(1);
    expect(leftDrawerAt(D, "carol", doc)).toBeNull();
    expect(rotationOwed(D, 1, doc)).toBe(true);
    expect(rotationOwed(D, 2, doc)).toBe(false);
    expect(rotationOwed("drawer-2", 1, doc)).toBe(false);
  });
  it("a newer key that another member made is not counted as one the leaver holds", () => {
    const before: Doc = { ...empty, drawer_members: { [D]: ["bob", "carol"] }, drawer_keys: { [D]: 1 } };
    const doc = membersNoted(before, "me", [drawer(["me", "carol"], 2, [{ key_version: 1, sender_id: "carol" }, { key_version: 2, sender_id: "carol" }])]);
    expect(leftDrawerAt(D, "bob", doc)).toBe(1);
    expect(rotationOwed(D, 2, doc)).toBe(false);
  });
  it("a newer key that the leaver wrapped is one they hold", () => {
    const before: Doc = { ...empty, drawer_members: { [D]: ["bob"] }, drawer_keys: { [D]: 1 } };
    const doc = membersNoted(before, "me", [drawer(["me"], 2, [{ key_version: 1, sender_id: "me" }, { key_version: 2, sender_id: "bob" }])]);
    expect(leftDrawerAt(D, "bob", doc)).toBe(2);
    expect(rotationOwed(D, 2, doc)).toBe(true);
    expect(doc.drawer_members).toBeUndefined();
  });
  it("a wrap numbered above the drawer's key version says nothing about what the leaver holds", () => {
    const before: Doc = { ...empty, drawer_members: { [D]: ["bob"] }, drawer_keys: { [D]: 2 } };
    const doc = membersNoted(before, "me", [drawer(["me"], 2, [{ key_version: 900, sender_id: "bob" }])]);
    expect(leftDrawerAt(D, "bob", doc)).toBe(2);
    expect(rotationOwed(D, 3, doc)).toBe(false);
  });
  it("never lowers what is already remembered about a leaver", () => {
    const before: Doc = { ...empty, drawer_members: { [D]: ["bob"] }, drawer_keys: { [D]: 1 }, drawer_left: { [D]: { bob: 3 } } };
    expect(leftDrawerAt(D, "bob", membersNoted(before, "me", [drawer(["me"], 3)]))).toBe(3);
  });
  it("with no key version remembered, the leaver is taken to hold the current key", () => {
    const before: Doc = { ...empty, drawer_members: { [D]: ["bob"] } };
    expect(leftDrawerAt(D, "bob", membersNoted(before, "me", [drawer(["me"], 4)]))).toBe(4);
  });
});

describe("confirmedFor", () => {
  const confirmed = pinConfirmed({ v: 1, pins: { carol: firstSight("c1") } }, "bob", keys("b1"), "2026-02-02T00:00:00.000Z");
  it("takes a drawer key only from someone whose safety number was confirmed", () => {
    expect(confirmedFor(D, "bob", 1, confirmed)).toBe(true);
    expect(confirmedFor(D, "carol", 1, confirmed)).toBe(false);
    expect(confirmedFor(D, "dave", 1, confirmed)).toBe(false);
  });
  it("from someone who left the drawer, only up to the key version they held; in other drawers as before", () => {
    const left: Doc = { ...confirmed, drawer_left: { [D]: { bob: 2 } } };
    expect(confirmedFor(D, "bob", 1, left)).toBe(true);
    expect(confirmedFor(D, "bob", 2, left)).toBe(true);
    expect(confirmedFor(D, "bob", 3, left)).toBe(false);
    expect(confirmedFor("drawer-2", "bob", 3, left)).toBe(true);
  });
  it("someone listed again stays as they were until they are confirmed again for that drawer", () => {
    const left: Doc = { ...confirmed, drawer_members: { [D]: ["carol"] }, drawer_left: { [D]: { bob: 2 }, "drawer-2": { bob: 1 } } };
    const listedAgain = membersNoted(left, "me", [drawer(["me", "bob", "carol"], 3)]);
    expect(confirmedFor(D, "bob", 3, listedAgain)).toBe(false);
    const again = pinConfirmed(listedAgain, "bob", keys("b1"), "2026-05-05T00:00:00.000Z", D);
    expect(confirmedFor(D, "bob", 3, again)).toBe(true);
    expect(again.drawer_left).toEqual({ "drawer-2": { bob: 1 } });
    // confirming without naming the drawer (an invitation to another drawer, say) leaves the drawer's memory alone
    expect(leftDrawerAt(D, "bob", pinConfirmed(listedAgain, "bob", keys("b1"), "2026-05-05T00:00:00.000Z"))).toBe(2);
  });
});
