import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, exportPublicKeys, fromB64, fromUtf8, generateUserKeys, hkdfAesKey, open, seal, toB64, utf8, type RecordIdentity } from "@petty/crypto";

/**
 * PETTY-439: the counter inside the user document. The module under test runs as in the browser; the server,
 * IndexedDB and the unlocked vault are played here. The "server" keeps one sealed row and a version number,
 * and the tests move both the way a server that kept older copies could.
 */
const mem = vi.hoisted(() => ({ idb: new Map<string, unknown>(), auth: { status: "locked" } as unknown }));
vi.mock("./idb.js", () => ({
  idb: {
    get: async (k: string) => mem.idb.get(k),
    set: async (k: string, v: unknown) => { mem.idb.set(k, JSON.parse(JSON.stringify(v))); },
    del: async (k: string) => { mem.idb.delete(k); },
    clear: async () => { mem.idb.clear(); },
    keys: async () => [...mem.idb.keys()],
  },
}));
vi.mock("./session.js", () => ({ getAuth: () => mem.auth }));
// the store's hook, outside a component: it hands back the state as it is now
vi.mock("react", () => ({ useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot() }));

// `usePins` under a plain name: outside React it is only a read of the store
import { acceptedDocRev, acknowledgeRollback, confirmPin, forgetSelfKey, leftDrawerAt, loadPins, noteMembers, parseUserDoc, pinnedSigningKeys, placesShown, recordDrawerVersions, recordLeft, rotationOwed, setPlacesShown, setTotalsShown, startUserDoc, usePins as pinsNow, userDocRolledBack } from "./pins.js";

const USER = "5b0c6a0e-6f0e-4d7e-9a57-0d6c1f6a2a11";
const DRAWER = "d1000000-0000-4000-8000-000000000001";
const identity: RecordIdentity = { record_type: "document", record_id: USER, drawer_id: USER, line_id: null, author_id: USER, key_version: 1, schema_version: 1 };
let key: CryptoKey;

interface Row { version: number; schema_version: number; nonce: string; ciphertext: string }
const server = { row: null as Row | null, puts: 0, down: false, refusePut: false };
/** The sealed row as the user's own key makes it. */
async function sealedRow(doc: unknown, version: number): Promise<Row> {
  const s = await seal(key, identity, utf8(canonicalJson(doc)));
  return { version, schema_version: 1, nonce: toB64(s.nonce), ciphertext: toB64(s.ciphertext) };
}
async function onServer(): Promise<{ version: number; doc: Record<string, unknown> } | null> {
  if (!server.row) return null;
  return { version: server.row.version, doc: JSON.parse(fromUtf8(await open(key, identity, { nonce: fromB64(server.row.nonce), ciphertext: fromB64(server.row.ciphertext) }))) as Record<string, unknown> };
}
const seen = () => mem.idb.get(`userdoc.${USER}`);
/** The page is loaded again in the same browser: memory is gone, IndexedDB stays. */
const reload = () => forgetSelfKey();
/** Another browser, or this one with its site data cleared. */
const newBrowser = () => { forgetSelfKey(); mem.idb.clear(); };
/** The module's own state, read the way the screens read it. */
function status(): { status: string; rev: number | undefined; olderInside: boolean } {
  const st = pinsNow();
  return { status: st.status, rev: st.doc.rev, olderInside: st.olderInside === true };
}

beforeAll(async () => {
  const keys = await generateUserKeys();
  const pub = await exportPublicKeys(keys);
  mem.auth = { status: "unlocked", me: { id: USER }, keys: { pub, ecdhPrivate: keys.ecdh.privateKey } };
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: keys.ecdh.publicKey }, keys.ecdh.privateKey, 256));
  key = await hkdfAesKey(shared, utf8("petty/self-doc/v1"), utf8(USER), "AES-GCM", ["encrypt", "decrypt"]);
});
beforeEach(() => {
  server.row = null; server.puts = 0; server.down = false; server.refusePut = false;
  newBrowser();
  vi.stubGlobal("fetch", async (url: string, init?: { method?: string; body?: string }) => {
    if (server.down) throw new TypeError("fetch failed");
    if (url !== "/api/me/doc") throw new Error(`unexpected request: ${url}`);
    if ((init?.method ?? "GET") === "GET") return server.row ? new Response(JSON.stringify({ ...server.row, updated_at: "2026-11-10T10:00:00.000Z" }), { status: 200 }) : new Response(null, { status: 204 });
    server.puts += 1;
    if (server.refusePut) return new Response(JSON.stringify({ code: "Internal", message: "internal error" }), { status: 500 });
    const body = JSON.parse(init!.body!) as { base_version: number; schema_version: number; nonce: string; ciphertext: string };
    if (body.base_version !== (server.row?.version ?? 0)) return new Response(JSON.stringify({ code: "VersionConflict", message: "user document changed" }), { status: 409 });
    server.row = { version: body.base_version + 1, schema_version: body.schema_version, nonce: body.nonce, ciphertext: body.ciphertext };
    return new Response(JSON.stringify({ version: server.row.version, updated_at: "2026-11-10T10:00:00.000Z" }), { status: 200 });
  });
});
afterEach(() => vi.unstubAllGlobals());

const PIN = { ecdh: "AAAA", ecdsa: "BBBB", sig_key_id: "k1", pinned_at: "2026-10-01T00:00:00.000Z", confirmed_at: "2026-10-01T00:00:00.000Z" };
/** A document as Petty wrote it before the counter. */
const before = { v: 1, pins: { someone: PIN }, hide_totals: true, drawer_docs: { [DRAWER]: 4 } };

describe("the rules", () => {
  it("a v 2 document must carry its counter; a counter found in a v 1 document does not count", () => {
    expect(parseUserDoc({ v: 2, rev: 3, pins: {} })).toMatchObject({ v: 2, rev: 3 });
    expect(() => parseUserDoc({ v: 2, pins: {} })).toThrow();
    expect("rev" in parseUserDoc({ v: 1, rev: 9, pins: {} })).toBe(false);
    for (const rev of [0, -1, 1.5, "3"]) expect(() => parseUserDoc({ v: 2, rev, pins: {} }), String(rev)).toThrow();
    expect(() => parseUserDoc({ v: 3, rev: 1, pins: {} })).toThrow(); // a later format: this build does not open it
  });

  it("older than what this browser saw: a lower version number, a lower counter, or no counter after one was seen", () => {
    expect(userDocRolledBack({ version: 7 }, 7, {})).toBe(false);
    expect(userDocRolledBack({ version: 7 }, 9, {})).toBe(false); // no counter seen yet: the version number is all there is
    expect(userDocRolledBack({ version: 7 }, 6, { rev: 99 })).toBe(true);
    expect(userDocRolledBack({ version: 7, rev: 4 }, 7, { rev: 4 })).toBe(false);
    expect(userDocRolledBack({ version: 7, rev: 4 }, 12, { rev: 5 })).toBe(false);
    expect(userDocRolledBack({ version: 7, rev: 4 }, 12, { rev: 3 })).toBe(true);
    expect(userDocRolledBack({ version: 7, rev: 4 }, 12, {})).toBe(true);
    expect(userDocRolledBack({ version: 0 }, 1, {})).toBe(false); // a browser new to the account takes what it is given
  });
});

describe("the user document against a server that kept older copies", () => {
  it("a new account's first save has the counter at 1; every save adds one", async () => {
    await loadPins();
    expect(server.puts).toBe(0);
    await startUserDoc();
    expect(await onServer()).toEqual({ version: 1, doc: { v: 2, rev: 1, pins: {} } });
    expect(seen()).toEqual({ version: 1, rev: 1 });
    await setPlacesShown(false);
    await setTotalsShown(false);
    expect(await onServer()).toMatchObject({ version: 3, doc: { v: 2, rev: 3, hide_places: true, hide_totals: true } });
    expect(seen()).toEqual({ version: 3, rev: 3 });
  });

  it("a document from before the counter opens, keeps everything, and gets its first counter at once", async () => {
    server.row = await sealedRow(before, 6);
    mem.idb.set(`userdoc.${USER}`, { version: 6 }); // what the older Petty left in this browser
    await loadPins();
    expect(status()).toMatchObject({ status: "ready", rev: 1 });
    expect(await onServer()).toEqual({ version: 7, doc: { ...before, v: 2, rev: 1 } });
    expect(seen()).toEqual({ version: 7, rev: 1 });
    expect(server.puts).toBe(1);
    // the next load writes nothing more
    reload();
    await loadPins();
    expect(server.puts).toBe(1);
  });

  it("when that first write does not go through, the document still opens, and the next load tries again", async () => {
    server.row = await sealedRow(before, 6);
    server.refusePut = true;
    await loadPins();
    expect(status()).toMatchObject({ status: "ready", rev: undefined });
    expect(seen()).toEqual({ version: 6 });
    server.refusePut = false;
    reload();
    await loadPins();
    expect(await onServer()).toMatchObject({ version: 7, doc: { v: 2, rev: 1 } });
  });

  it("an older sealed copy under a newer version number is rolled back, and nothing is saved over it", async () => {
    await startUserDoc();
    await setPlacesShown(false); // rev 2
    const old = server.row!;
    await setTotalsShown(false); // rev 3, version 3
    expect(seen()).toEqual({ version: 3, rev: 3 });
    for (const version of [3, 4, 50]) {
      server.row = { ...old, version }; // the copy with rev 2, numbered as the newest or newer
      server.puts = 0;
      reload();
      await loadPins();
      expect(status(), `as version ${version}`).toEqual({ status: "rolled_back", rev: 2, olderInside: true });
      await expect(setPlacesShown(true)).rejects.toThrow("PinsRolledBack");
      await recordDrawerVersions(new Map(), new Map(), new Map(), new Map([[DRAWER, 9]]));
      expect(server.puts).toBe(0);
      expect(seen()).toEqual({ version: 3, rev: 3 });
    }
  });

  it("a copy from before the counter, served after this browser saw a counter, is rolled back under any number", async () => {
    server.row = await sealedRow(before, 6);
    await loadPins(); // upgraded: version 7, rev 1
    for (const version of [7, 8, 60]) {
      server.row = await sealedRow(before, version);
      server.puts = 0;
      reload();
      await loadPins();
      expect(status(), `as version ${version}`).toEqual({ status: "rolled_back", rev: undefined, olderInside: true });
      expect(server.puts).toBe(0); // and it is not given a new counter
    }
  });

  it("a lower version number and a missing document are rolled back as before", async () => {
    await startUserDoc();
    const first = server.row!;
    await setPlacesShown(false);
    server.row = first;
    reload();
    await loadPins();
    expect(status()).toEqual({ status: "rolled_back", rev: 1, olderInside: false });
    server.row = null;
    reload();
    await loadPins();
    expect(status()).toMatchObject({ status: "rolled_back", olderInside: false });
  });

  it("the same copy again, and a newer one, are not rolled back", async () => {
    await startUserDoc();
    await setPlacesShown(false);
    reload();
    await loadPins();
    expect(status()).toMatchObject({ status: "ready", rev: 2 });
    // another device of the same person saved twice meanwhile
    const cur = (await onServer())!;
    server.row = await sealedRow({ ...cur.doc, rev: 4, hide_totals: true }, cur.version + 2);
    reload();
    await loadPins();
    expect(status()).toMatchObject({ status: "ready", rev: 4 });
    expect(seen()).toEqual({ version: 4, rev: 4 });
  });

  it("a save that meets a newer copy loads it and takes the counter from that copy", async () => {
    await startUserDoc();
    await setPlacesShown(false); // this page holds version 2, rev 2
    // another device saves: version 3, rev 3
    const cur = (await onServer())!;
    server.row = await sealedRow({ ...cur.doc, rev: 3, drawer_revs: { [DRAWER]: 5 } }, 3);
    await setTotalsShown(false); // refused with VersionConflict, loaded again, saved on top
    expect(await onServer()).toEqual({ version: 4, doc: { v: 2, rev: 4, pins: {}, hide_places: true, hide_totals: true, drawer_revs: { [DRAWER]: 5 } } });
    expect(seen()).toEqual({ version: 4, rev: 4 });
    expect(acceptedDocRev(DRAWER)).toBe(5);
  });

  it("a browser new to the account has nothing to compare with and takes the copy it is given", async () => {
    await startUserDoc();
    const old = server.row!;
    await setPlacesShown(false);
    server.row = { ...old, version: 2 };
    newBrowser();
    await loadPins();
    expect(status()).toMatchObject({ status: "ready", rev: 1 });
    expect(placesShown()).toBe(true);
  });

  it("starting a new list forgets the remembered counter too, and gives a copy without one its counter", async () => {
    server.row = await sealedRow(before, 6);
    await loadPins(); // version 7, rev 1
    await setPlacesShown(false); // version 8, rev 2
    server.row = await sealedRow(before, 8);
    reload();
    await loadPins();
    expect((status()).status).toBe("rolled_back");
    await acknowledgeRollback();
    expect(status()).toMatchObject({ status: "ready", rev: 1 });
    expect(await onServer()).toEqual({ version: 9, doc: { ...before, v: 2, rev: 1 } });
    expect(seen()).toEqual({ version: 9, rev: 1 });
  });

  it("with no connection, the copy this browser kept is used when it is the newest it saw", async () => {
    await startUserDoc();
    await setPlacesShown(false);
    server.down = true;
    reload();
    await expect(loadPins()).rejects.toThrow("NetworkError");
    expect(status()).toMatchObject({ status: "ready", rev: 2 });
    expect(placesShown()).toBe(false);
    // a kept copy that is older inside than what this browser remembers is not used
    mem.idb.set(`userdoc.${USER}`, { version: 2, rev: 3 });
    reload();
    await expect(loadPins()).rejects.toThrow("NetworkError");
    expect((status()).status).toBe("idle");
  });

  it("remembers the highest counter of each drawer's document, saved once, and never lowers it", async () => {
    await startUserDoc();
    await recordDrawerVersions(new Map(), new Map([[DRAWER, 3]]), new Map(), new Map([[DRAWER, 2]]));
    expect(await onServer()).toMatchObject({ version: 2, doc: { rev: 2, drawer_docs: { [DRAWER]: 3 }, drawer_revs: { [DRAWER]: 2 } } });
    await recordDrawerVersions(new Map(), new Map(), new Map(), new Map([[DRAWER, 1]])); // lower: nothing to save
    await recordDrawerVersions(new Map(), new Map(), new Map(), new Map([[DRAWER, 2]])); // the same: nothing to save
    expect(server.puts).toBe(2);
    await recordDrawerVersions(new Map(), new Map(), new Map(), new Map([[DRAWER, 6]]));
    expect(acceptedDocRev(DRAWER)).toBe(6);
    expect(await onServer()).toMatchObject({ version: 3, doc: { rev: 3, drawer_revs: { [DRAWER]: 6 } } });
  });
});

/**
 * The fields of PETTY-413 and PETTY-449 in the user document: earlier confirmed keys (`Pin.earlier`), who was in each
 * drawer (`drawer_members`) and who left it (`drawer_left`). A document from before the counter that holds them keeps
 * them through the upgrade to `v` 2, and every write that changes them follows the counter rule.
 */
describe("the user document's memory of keys and members, with the counter", () => {
  const BOB_KEYS = { ecdh_pub: "ecdh-b2", ecdsa_pub: "ecdsa-b2", sig_key_id: "id-b2" };
  const withMemory = {
    v: 1,
    pins: { bob: { ...PIN, earlier: [{ ecdsa: "ecdsa-b0", sig_key_id: "id-b0" }] } },
    drawer_members: { [DRAWER]: ["bob", "carol"] },
    drawer_left: { [DRAWER]: { dave: 2 } },
    drawer_docs: { [DRAWER]: 4 },
  };
  const people = (members: string[], key_version = 2) => [{ id: DRAWER, key_version, members: [USER, ...members], wraps: [] }];

  it("a v 1 document with earlier keys, members and leavers comes through the upgrade with all of them", async () => {
    expect(parseUserDoc(withMemory)).toEqual(withMemory);
    server.row = await sealedRow(withMemory, 6);
    await loadPins();
    expect(status()).toMatchObject({ status: "ready", rev: 1 });
    expect(await onServer()).toEqual({ version: 7, doc: { ...withMemory, v: 2, rev: 1 } });
    // and the app reads them back from the upgraded copy
    reload();
    await loadPins();
    expect(pinnedSigningKeys("bob")).toEqual(["BBBB", "ecdsa-b0"]);
    expect(leftDrawerAt(DRAWER, "dave")).toBe(2);
    expect(rotationOwed(DRAWER, 2)).toBe(true);
    expect(server.puts).toBe(1);
  });

  it("noting members, a removal and a new confirmation each store the loaded counter plus one", async () => {
    await startUserDoc(); // rev 1
    await noteMembers(people(["bob", "carol"]));
    expect(await onServer()).toMatchObject({ version: 2, doc: { v: 2, rev: 2, drawer_members: { [DRAWER]: ["bob", "carol"] } } });
    await noteMembers(people(["bob"])); // carol is gone
    expect(await onServer()).toMatchObject({ version: 3, doc: { rev: 3, drawer_members: { [DRAWER]: ["bob"] }, drawer_left: { [DRAWER]: { carol: 2 } } } });
    expect(await recordLeft(DRAWER, "bob", 2)).toBe(true);
    expect(await onServer()).toMatchObject({ version: 4, doc: { rev: 4, drawer_left: { [DRAWER]: { carol: 2, bob: 2 } } } });
    await confirmPin("carol", BOB_KEYS, DRAWER); // compared again on this drawer's Members screen
    const now = (await onServer())!;
    expect(now).toMatchObject({ version: 5, doc: { rev: 5, drawer_left: { [DRAWER]: { bob: 2 } } } });
    expect(now.doc["pins"]).toHaveProperty("carol");
    expect(seen()).toEqual({ version: 5, rev: 5 });
    expect(server.puts).toBe(5);
  });

  it("after a VersionConflict each of them applies its change to the fresh copy and takes that copy's counter", async () => {
    await startUserDoc();
    await setPlacesShown(false); // this page holds version 2, rev 2
    // another device of the same person saves meanwhile, three times: version 3 and rev 3, and so on
    const fresh = async (extra: Record<string, unknown>) => {
      const cur = (await onServer())!;
      server.row = await sealedRow({ ...cur.doc, ...extra, rev: (cur.doc["rev"] as number) + 1 }, cur.version + 1);
    };
    await fresh({ hide_totals: true });
    await noteMembers(people(["bob", "carol"]));
    expect(await onServer()).toMatchObject({ version: 4, doc: { rev: 4, hide_places: true, hide_totals: true, drawer_members: { [DRAWER]: ["bob", "carol"] } } });
    await fresh({ drawer_revs: { [DRAWER]: 5 } });
    expect(await recordLeft(DRAWER, "dave", 2)).toBe(true);
    expect(await onServer()).toMatchObject({ version: 6, doc: { rev: 6, hide_totals: true, drawer_revs: { [DRAWER]: 5 }, drawer_members: { [DRAWER]: ["bob", "carol"] }, drawer_left: { [DRAWER]: { dave: 2 } } } });
    await fresh({ line_tags: ["kept"] });
    await confirmPin("dave", BOB_KEYS, DRAWER);
    const last = (await onServer())!;
    expect(last).toMatchObject({ version: 8, doc: { v: 2, rev: 8, line_tags: ["kept"], drawer_revs: { [DRAWER]: 5 } } });
    expect(last.doc["pins"]).toHaveProperty("dave");
    expect(last.doc).not.toHaveProperty("drawer_left");
    expect(seen()).toEqual({ version: 8, rev: 8 });
  });

  it("none of them writes over a copy that is older inside", async () => {
    await startUserDoc();
    await setPlacesShown(false);
    const old = server.row!;
    await setTotalsShown(false); // rev 3
    server.row = { ...old, version: 5 }; // the copy with rev 2, numbered as newer
    reload();
    await loadPins();
    expect(status()).toMatchObject({ status: "rolled_back", olderInside: true });
    server.puts = 0;
    await noteMembers(people(["bob"]));
    expect(await recordLeft(DRAWER, "bob", 2)).toBe(false);
    await expect(confirmPin("bob", BOB_KEYS, DRAWER)).rejects.toThrow("PinsRolledBack");
    expect(server.puts).toBe(0);
  });
});
