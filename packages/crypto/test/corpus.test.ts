/**
 * The permanent compatibility check. Every fixture in corpus/v1 must open,
 * verify, and equal its recorded plaintext, on every build, forever.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  fromB64, fromHex, hashEntry, openArchive, openDocument, openEntry, openPhoto, safetyNumber, signingKeyId, toB64,
  unlockPasskeyVault, unlockVault, unwrapDrawerKey, verifyEntry, importEcdsaPublic,
  type DrawerKeyWrapV1, type ExportArchiveV1, type RecordIdentity, type SignedEntryV1, type VaultBlobV1,
} from "../src/index.js";

const dir = fileURLToPath(new URL("../corpus/v1/", import.meta.url));
const load = <T>(f: string): T => JSON.parse(readFileSync(dir + f, "utf8")) as T;

interface CorpusUser {
  id: string; passphrase: string; recovery_code: string;
  jwk: { ecdh_private: JsonWebKey; ecdsa_private: JsonWebKey };
  pub: { ecdh: string; ecdsa: string }; safety_number: string; sig_key_id: string;
  vault: VaultBlobV1; recovery_vault: VaultBlobV1;
}
interface CorpusRecord { identity: RecordIdentity; sealed: { nonce: string; ciphertext: string }; plaintext: unknown }
interface CorpusDrawer { drawer_id: string; keys: Record<string, string>; wraps: Array<DrawerKeyWrapV1 & { recipient: string }>; records: CorpusRecord[]; chain: string[] }

const users = load<{ users: CorpusUser[] }>("users.json").users;
const drawer = load<CorpusDrawer>("drawer.json");
const archive = load<{ password: string; payload: unknown; archive: ExportArchiveV1 }>("archive.json");
const passkey = load<{ users: Array<{ id: string; prf_output: string; pub: { ecdh: string; ecdsa: string }; vault: VaultBlobV1 }> }>("passkey.json");
const sealedOf = (r: CorpusRecord) => ({ nonce: fromB64(r.sealed.nonce), ciphertext: fromB64(r.sealed.ciphertext) });

async function rawKey(version: number): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromHex(drawer.keys[String(version)] ?? ""), "AES-GCM", false, ["decrypt"]);
}

describe("corpus v1: users", () => {
  for (const u of users) {
    it(`${u.id}: passphrase vault, recovery vault, safety number, sig key id`, async () => {
      const a = await unlockVault(u.vault, u.passphrase);
      expect(a.pub).toEqual(u.pub);
      const b = await unlockVault(u.recovery_vault, u.recovery_code);
      expect(b.pub).toEqual(u.pub);
      expect(await safetyNumber(u.pub)).toBe(u.safety_number);
      expect(await signingKeyId(u.pub.ecdsa)).toBe(u.sig_key_id);
    }, 30_000);
  }
});

describe("corpus v1: passkey vaults (Phase 14)", () => {
  for (const p of passkey.users) {
    it(`${p.id}: the recorded PRF output opens the passkey vault; unlockVault refuses it`, async () => {
      const u = await unlockPasskeyVault(p.vault, fromB64(p.prf_output));
      expect(u.pub).toEqual(p.pub);
      await expect(unlockVault(p.vault, p.prf_output)).rejects.toThrow();
    });
  }
});

describe("corpus v1: drawer", () => {
  it("every wrap unwraps to the recorded raw key for its version", async () => {
    for (const w of drawer.wraps) {
      const u = users.find((x) => x.id === w.recipient)!;
      const priv = await crypto.subtle.importKey("jwk", u.jwk.ecdh_private, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
      const alice = users[0]!;
      const k = await unwrapDrawerKey(w, priv, { drawer_id: drawer.drawer_id, key_version: w.key_version, senderEcdhPublicB64: alice.pub.ecdh }, { extractable: true });
      expect(toB64(new Uint8Array(await crypto.subtle.exportKey("raw", k)))).toBe(toB64(fromHex(drawer.keys[String(w.key_version)] ?? "")));
    }
  });

  it("every record opens under its key version and equals its plaintext; entries verify", async () => {
    for (const r of drawer.records) {
      const key = await rawKey(r.identity.key_version);
      if (r.identity.record_type === "entry") {
        const pt = r.plaintext as SignedEntryV1;
        const author = users.find((x) => x.id === pt.author_id)!;
        const e = await openEntry(key, r.identity, sealedOf(r), { author_id: author.id, sig_key_id: author.sig_key_id, ecdsaPublic: await importEcdsaPublic(author.pub.ecdsa) });
        expect(e).toEqual(pt);
      } else if (r.identity.record_type === "document") {
        expect(await openDocument(key, r.identity, sealedOf(r))).toEqual(r.plaintext);
      } else {
        const photo = await openPhoto(key, r.identity, sealedOf(r));
        expect(toB64(photo)).toBe((r.plaintext as { photo_b64: string }).photo_b64);
        expect(photo[0]).toBe(0xff); expect(photo[1]).toBe(0xd8); // JPEG SOI
      }
    }
  });

  it("the recorded hash chain links", async () => {
    const entries = drawer.records.filter((r) => r.identity.record_type === "entry" && r.identity.key_version === 1).map((r) => r.plaintext as SignedEntryV1);
    const byId = new Map(entries.map((e) => [e.id, e]));
    for (let i = 1; i < drawer.chain.length; i++) {
      const prev = byId.get(drawer.chain[i - 1]!)!;
      const cur = byId.get(drawer.chain[i]!)!;
      expect(cur.prev_hash).toBe(await hashEntry(prev));
      const au = users.find((x) => x.id === cur.author_id)!;
      await expect(verifyEntry(cur, { author_id: au.id, sig_key_id: au.sig_key_id, ecdsaPublic: await importEcdsaPublic(au.pub.ecdsa) })).resolves.toBeUndefined();
    }
  });
});

describe("corpus v1: archive", () => {
  it("opens under the recorded password", async () => {
    expect(await openArchive(archive.password, archive.archive)).toEqual(archive.payload);
  }, 30_000);
});
