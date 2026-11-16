/**
 * PETTY-442: every base64 field a request may carry has a size. A wrong size would lock people out of
 * saving, so each one is checked here against what the clients really make: fresh values from
 * @petty/crypto, and every blob of the permanent compatibility corpus.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createDrawerKey, createPasskeyVault, createRecoveryVault, createVault, exportPublicKeys, fromB64, generateRecoveryCode, generateUserKeys, patSecret, seal, sealPatBundle,
  signCustodyChallenge, signDelegation, signingKeyId, toB64, type DrawerKeyWrapV1, type RecordIdentity, type VaultBlobV1,
} from "@petty/crypto";
import {
  AccessTokenCreate, AccessTokenKeysBody, AddPasskeyBody, Bootstrap, CreateDrawerBody, CustodyProof, DeleteLineBody, DOCUMENT_MIN_CIPHERTEXT, DrawerKeyWrap, ENTRY_MAX_CIPHERTEXT, ENTRY_MIN_CIPHERTEXT, EntryRow, FIELD_BYTES,
  InviteBody, Me, PasskeyVault, PostEntryBody, PutUserDocBody, PutVaultBody, RotationBatchBody, SealedBody, SignedDelegation, SignupBody, StartRotationBody, StoredDrawerKeyWrap, StoredVaultBlob,
  TOKEN_BUNDLE_MAX_CIPHERTEXT, USER_DOC_MAX_CIPHERTEXT, UserDelegations, VaultBlob, b64ByteLength, b64Sized,
} from "../src/index.js";

const corpus = fileURLToPath(new URL("../../crypto/corpus/v1/", import.meta.url));
const load = <T>(f: string): T => JSON.parse(readFileSync(corpus + f, "utf8")) as T;
const id = "00000000-0000-4000-8000-000000000001";
const bytes = (n: number) => toB64(new Uint8Array(n).fill(7));
const big = "A".repeat(1_900_000); // about 1.4 MB once decoded
const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) => schema.safeParse(value).success;
const within = (field: keyof typeof FIELD_BYTES, value: string) => { const n = b64ByteLength(value); return n >= FIELD_BYTES[field][0] && n <= FIELD_BYTES[field][1]; };

describe("b64Sized", () => {
  it("counts decoded bytes and refuses anything outside the range, whatever the padding", () => {
    const nonce = b64Sized(12);
    expect(ok(nonce, bytes(12))).toBe(true);
    for (const bad of [bytes(11), bytes(13), "", `${bytes(12)}=`, `${bytes(12)}A`, "AAAAAAAAAAAAAAA", "AAAAAAAAAAAAAAA!", big]) expect(ok(nonce, bad)).toBe(false);
    const salt = b64Sized(16, 64);
    for (const n of [16, 17, 32, 63, 64]) expect(ok(salt, bytes(n))).toBe(true);
    for (const n of [0, 15, 65, 4096]) expect(ok(salt, bytes(n))).toBe(false);
    for (const n of [0, 1, 2, 3, 12, 91, 154]) expect(b64ByteLength(bytes(n))).toBe(n);
    expect(b64ByteLength(bytes(16).slice(0, 22))).toBe(16); // without its padding
  });

  it("answers at once whatever the string holds", () => {
    const started = performance.now();
    for (const odd of [`${"=".repeat(1_900_000)}A`, "=".repeat(1_900_000), `${"A=".repeat(950_000)}`, big]) {
      expect(ok(b64Sized(12), odd)).toBe(false);
      expect(ok(b64Sized(0, 300_000), odd)).toBe(false);
      expect(b64ByteLength(odd)).toBeGreaterThanOrEqual(0);
    }
    expect(performance.now() - started).toBeLessThan(5_000); // a pattern that backtracks would take minutes
  });
});

describe("what the clients make fits the request schemas", () => {
  it("fresh keys, vault copies, wraps, proofs, delegations, bundles and sealed records, at the exact sizes named in FIELD_BYTES", async () => {
    const keys = await generateUserKeys();
    const pub = await exportPublicKeys(keys);
    const sigKeyId = await signingKeyId(pub.ecdsa);
    const vault = await createVault("vault alice 2026 drawer", keys);
    const recovery = await createRecoveryVault(generateRecoveryCode(), keys);
    const passkeyVault = await createPasskeyVault(crypto.getRandomValues(new Uint8Array(32)), keys);
    const passkey = { credential_id: bytes(16), prf_salt: toB64(crypto.getRandomValues(new Uint8Array(32))), vault: passkeyVault, label: "Phone", transports: ["internal"] };
    const sender = { ecdhPrivate: keys.ecdh.privateKey, ecdhPublicB64: pub.ecdh };
    const { key, selfWrap } = await createDrawerKey(sender, id, 1);
    const challenge = toB64(crypto.getRandomValues(new Uint8Array(32)));
    const proof = { challenge, signature: await signCustodyChallenge(keys.ecdsa.privateKey, challenge) };
    const tokenPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const tokenPub = toB64(new Uint8Array(await crypto.subtle.exportKey("spki", tokenPair.publicKey)));
    const delegation = await signDelegation(keys.ecdsa.privateKey, { user_id: id, account_sig_key_id: sigKeyId, token_ecdsa_pub: tokenPub, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86_400_000).toISOString() });
    const bundle = await sealPatBundle(patSecret(), "a-token-id-of-24-chars__", { v: 1, user_id: id, drawers: [] });
    const identity = (record_type: RecordIdentity["record_type"]): RecordIdentity => ({ record_type, record_id: id, drawer_id: id, line_id: record_type === "entry" ? id : null, author_id: id, key_version: 1, schema_version: 1 });
    const sealed = async (record_type: RecordIdentity["record_type"], n: number) => { const s = await seal(key, identity(record_type), new Uint8Array(n)); return { key_version: 1, schema_version: 1, nonce: toB64(s.nonce), ciphertext: toB64(s.ciphertext) }; };
    const entry = await sealed("entry", 1);
    const document = await sealed("document", 1);

    // the sizes, one by one
    expect(b64ByteLength(pub.ecdh)).toBe(91);
    expect(b64ByteLength(pub.ecdsa)).toBe(91);
    for (const v of [vault, recovery, passkeyVault]) {
      expect([b64ByteLength(v.kdf.salt), b64ByteLength(v.ecdh.iv), b64ByteLength(v.ecdsa.iv), b64ByteLength(v.ecdh.ct), b64ByteLength(v.ecdsa.ct)]).toEqual([16, 12, 12, 154, 154]);
      expect(within("salt", v.kdf.salt) && within("nonce", v.ecdh.iv) && within("wrappedPrivateKey", v.ecdh.ct) && within("publicKey", v.pub.ecdh)).toBe(true);
    }
    expect([b64ByteLength(selfWrap.sender_ecdh_pub), b64ByteLength(selfWrap.salt), b64ByteLength(selfWrap.wrapped)]).toEqual([91, 32, 40]);
    expect([b64ByteLength(proof.challenge), b64ByteLength(proof.signature), b64ByteLength(delegation.sig)]).toEqual([32, 64, 64]);
    expect([b64ByteLength(entry.nonce), b64ByteLength(entry.ciphertext), b64ByteLength(document.ciphertext), b64ByteLength(bundle.nonce)]).toEqual([12, ENTRY_MIN_CIPHERTEXT, DOCUMENT_MIN_CIPHERTEXT, 12]);
    // an entry with the longest comment a client signs (2000 bytes) stays far under the entry limit
    expect(b64ByteLength((await sealed("entry", 4000)).ciphertext)).toBeLessThan(ENTRY_MAX_CIPHERTEXT);

    // the bodies the web app, the command line and the add-on send
    expect(ok(SignupBody, { email: "a@b.test", password: "password-1", display_name: "Ann", keys: { ecdh_pub: pub.ecdh, ecdsa_pub: pub.ecdsa, sig_key_id: sigKeyId }, vault, passkey, recovery_vault: recovery })).toBe(true);
    expect(ok(PutVaultBody, { proof, vault, recovery_vault: recovery })).toBe(true);
    expect(ok(AddPasskeyBody, { proof, passkey })).toBe(true);
    expect(ok(CreateDrawerBody, { id, document, self_wrap: selfWrap })).toBe(true);
    expect(ok(InviteBody, { invitee_id: id, role: "write", wrap: selfWrap })).toBe(true);
    expect(ok(PostEntryBody, { id, line_id: id, is_checkpoint: false, reverses_entry_id: null, ...entry })).toBe(true);
    expect(ok(PutUserDocBody, { base_version: 0, schema_version: 1, nonce: document.nonce, ciphertext: document.ciphertext })).toBe(true);
    expect(ok(StartRotationBody, { to_version: 2, wraps: [{ user_id: id, wrap: { ...selfWrap, key_version: 2 } }], proof })).toBe(true);
    expect(ok(RotationBatchBody, { to_version: 2, entries: [{ id, nonce: entry.nonce, ciphertext: entry.ciphertext }], document, photo: document, proof })).toBe(true);
    expect(ok(DeleteLineBody, { document: { ...document, base_version: 1 }, proof })).toBe(true);
    expect(ok(AccessTokenKeysBody, { keys: [{ drawer_id: id, key_version: 1, wrap: selfWrap }] })).toBe(true);
    expect(ok(AccessTokenCreate, { token_id: "a-token-id-of-24-chars__", ecdh_pub: pub.ecdh, name: "tool", role: "write", scope: null, expires_at: delegation.expires_at, bundle, proof, signing: { ecdsa_pub: tokenPub, delegation } })).toBe(true);
    // a bundle with 1000 drawer keys, far more than a household has, is under its limit
    const many = await sealPatBundle(patSecret(), "a-token-id-of-24-chars__", { v: 1, user_id: id, drawers: Array.from({ length: 1000 }, () => ({ drawer_id: crypto.randomUUID(), key_version: 12, key: bytes(32) })), ecdsa: bytes(138), ecdh: bytes(138), owner_ecdh: pub.ecdh, sig_key_id: sigKeyId });
    expect(b64ByteLength(many.ciphertext)).toBeLessThan(TOKEN_BUNDLE_MAX_CIPHERTEXT / 2);
  }, 60_000);

  it("every blob of the compatibility corpus fits: vault copies, passkey vaults, wraps and sealed records", () => {
    const users = load<{ users: Array<{ pub: { ecdh: string; ecdsa: string }; sig_key_id: string; vault: VaultBlobV1; recovery_vault: VaultBlobV1 }> }>("users.json").users;
    const passkeys = load<{ users: Array<{ credential_id: string; prf_salt: string; vault: VaultBlobV1 }> }>("passkey.json").users;
    const drawer = load<{ wraps: Array<DrawerKeyWrapV1 & { recipient: string }>; records: Array<{ identity: RecordIdentity; sealed: { nonce: string; ciphertext: string } }> }>("drawer.json");
    expect(users.length).toBeGreaterThan(0);
    for (const u of users) {
      expect(ok(VaultBlob, u.vault)).toBe(true);
      expect(ok(VaultBlob, u.recovery_vault)).toBe(true);
      expect(ok(SignupBody, { email: "a@b.test", password: "password-1", display_name: "Ann", keys: { ecdh_pub: u.pub.ecdh, ecdsa_pub: u.pub.ecdsa, sig_key_id: u.sig_key_id }, vault: u.vault, recovery_vault: u.recovery_vault })).toBe(true);
    }
    expect(passkeys.length).toBeGreaterThan(0);
    for (const p of passkeys) expect(ok(PasskeyVault, { credential_id: p.credential_id, prf_salt: p.prf_salt, vault: p.vault })).toBe(true);
    expect(drawer.wraps.length).toBeGreaterThan(0);
    for (const w of drawer.wraps) expect(ok(DrawerKeyWrap, { v: w.v, drawer_id: id, key_version: w.key_version, sender_ecdh_pub: w.sender_ecdh_pub, salt: w.salt, wrapped: w.wrapped })).toBe(true);
    const kinds = new Set<string>();
    for (const r of drawer.records) {
      kinds.add(r.identity.record_type);
      expect(ok(SealedBody, { key_version: r.identity.key_version, schema_version: r.identity.schema_version, ...r.sealed })).toBe(true);
      const n = fromB64(r.sealed.ciphertext).length;
      if (r.identity.record_type === "entry") { expect(n).toBeGreaterThanOrEqual(ENTRY_MIN_CIPHERTEXT); expect(n).toBeLessThanOrEqual(ENTRY_MAX_CIPHERTEXT); }
      if (r.identity.record_type === "document") { expect(n).toBeGreaterThanOrEqual(DOCUMENT_MIN_CIPHERTEXT); expect(n).toBeLessThanOrEqual(USER_DOC_MAX_CIPHERTEXT); }
    }
    expect([...kinds].sort()).toEqual(["document", "entry", "photo"]);
  });
});

describe("what does not fit is refused", () => {
  const wrap = { v: 1 as const, drawer_id: id, key_version: 2, sender_ecdh_pub: bytes(91), salt: bytes(32), wrapped: bytes(40) };
  const proof = { challenge: bytes(32), signature: bytes(64) };
  const sealed = { key_version: 1, schema_version: 1, nonce: bytes(12), ciphertext: bytes(DOCUMENT_MIN_CIPHERTEXT) };
  const vault = { v: 1 as const, kind: "passphrase" as const, kdf: { name: "argon2id" as const, m: 65536, t: 3, p: 1, salt: bytes(16) }, pub: { ecdh: bytes(91), ecdsa: bytes(91) }, ecdh: { iv: bytes(12), ct: bytes(154) }, ecdsa: { iv: bytes(12), ct: bytes(154) } };

  it("key rotation and deleting a line carry a custody proof", () => {
    expect(ok(StartRotationBody, { to_version: 2, wraps: [{ user_id: id, wrap }], proof })).toBe(true);
    expect(ok(StartRotationBody, { to_version: 2, wraps: [{ user_id: id, wrap }] })).toBe(false);
    expect(ok(RotationBatchBody, { to_version: 2, entries: [], proof })).toBe(true);
    expect(ok(RotationBatchBody, { to_version: 2, entries: [] })).toBe(false);
    expect(ok(DeleteLineBody, { document: { ...sealed, base_version: 1 }, proof })).toBe(true);
    expect(ok(DeleteLineBody, { document: { ...sealed, base_version: 1 } })).toBe(false);
  });

  it("a field of the wrong size, in every request body that stores one", () => {
    const entry = { id, line_id: id, is_checkpoint: false, reverses_entry_id: null, ...sealed };
    const cases: [string, { safeParse: (v: unknown) => { success: boolean } }, unknown, unknown][] = [
      ["an entry's nonce", PostEntryBody, entry, { ...entry, nonce: big }],
      ["a batch entry's nonce", RotationBatchBody, { to_version: 2, entries: [{ id, nonce: bytes(12), ciphertext: bytes(528) }], proof }, { to_version: 2, entries: [{ id, nonce: bytes(16), ciphertext: bytes(528) }], proof }],
      ["a batch document's nonce", RotationBatchBody, { to_version: 2, entries: [], document: sealed, proof }, { to_version: 2, entries: [], document: { ...sealed, nonce: big }, proof }],
      ["a wrap's salt", StartRotationBody, { to_version: 2, wraps: [{ user_id: id, wrap }], proof }, { to_version: 2, wraps: [{ user_id: id, wrap: { ...wrap, salt: big } }], proof }],
      ["a wrapped key", InviteBody, { invitee_id: id, role: "read", wrap }, { invitee_id: id, role: "read", wrap: { ...wrap, wrapped: bytes(48) } }],
      ["a wrap's sender key", CreateDrawerBody, { id, document: sealed, self_wrap: wrap }, { id, document: sealed, self_wrap: { ...wrap, sender_ecdh_pub: big } }],
      ["a token key's wrap and version", AccessTokenKeysBody, { keys: [{ drawer_id: id, key_version: 2, wrap }] }, { keys: [{ drawer_id: id, key_version: 2, wrap: { ...wrap, salt: big } }] }],
      ["a token key's version", AccessTokenKeysBody, { keys: [{ drawer_id: id, key_version: 2, wrap }] }, { keys: [{ drawer_id: id, key_version: 0, wrap }] }],
      ["the user document", PutUserDocBody, { base_version: 0, schema_version: 1, nonce: bytes(12), ciphertext: bytes(USER_DOC_MAX_CIPHERTEXT) }, { base_version: 0, schema_version: 1, nonce: bytes(12), ciphertext: bytes(USER_DOC_MAX_CIPHERTEXT + 1) }],
      ["a vault's salt", PutVaultBody, { proof, vault }, { proof, vault: { ...vault, kdf: { ...vault.kdf, salt: bytes(8) } } }],
      ["a vault's wrapped key", PutVaultBody, { proof, vault }, { proof, vault: { ...vault, ecdsa: { ...vault.ecdsa, ct: big } } }],
      ["a vault's public key", PutVaultBody, { proof, vault }, { proof, vault: { ...vault, pub: { ...vault.pub, ecdsa: big } } }],
      ["a proof's signature", CustodyProof, proof, { ...proof, signature: bytes(65) }],
      ["a proof's challenge", CustodyProof, proof, { ...proof, challenge: big }],
    ];
    for (const [name, schema, good, bad] of cases) {
      expect(ok(schema, good), `${name}: the real size`).toBe(true);
      expect(ok(schema, bad), `${name}: the wrong size`).toBe(false);
    }
    const delegation = { v: 1, user_id: id, account_sig_key_id: "0".repeat(32), token_ecdsa_pub: bytes(91), token_sig_key_id: "0".repeat(32), created_at: "2026-11-10T12:00:00.000Z", expires_at: null, sig: bytes(64) };
    expect(ok(SignedDelegation, delegation)).toBe(true);
    for (const bad of [{ sig: big }, { token_ecdsa_pub: big }, { account_sig_key_id: big }, { created_at: `2026-11-10T12:00:00.${"0".repeat(100)}Z` }]) expect(ok(SignedDelegation, { ...delegation, ...bad })).toBe(false);
  });
});

describe("answers do not depend on the request sizes", () => {
  it("a row stored before the sizes existed still answers: the schemas for answers take any length", () => {
    const odd = { v: 1, drawer_id: id, key_version: 1, sender_ecdh_pub: bytes(65), salt: bytes(8), wrapped: bytes(48), sender_id: id };
    expect(ok(DrawerKeyWrap, odd)).toBe(false);
    expect(ok(StoredDrawerKeyWrap, odd)).toBe(true);
    const row = { id, drawer_id: id, line_id: id, seq: 1, author_id: id, is_checkpoint: false, reverses_entry_id: null, key_version: 1, schema_version: 1, nonce: bytes(4096), ciphertext: bytes(3), received_at: "2026-01-01T00:00:00.000Z" };
    expect(ok(EntryRow, row)).toBe(true);
    const vault = { v: 1, kind: "passphrase", kdf: { name: "argon2id", m: 65536, t: 3, p: 1, salt: bytes(8) }, pub: { ecdh: bytes(300), ecdsa: bytes(300) }, ecdh: { iv: bytes(16), ct: bytes(1000) }, ecdsa: { iv: bytes(16), ct: bytes(1000) } };
    expect(ok(VaultBlob, vault)).toBe(false);
    expect(ok(StoredVaultBlob, vault)).toBe(true);
    const keys = { ecdh_pub: bytes(300), ecdsa_pub: bytes(300), sig_key_id: "x", created_at: "2026-01-01T00:00:00.000Z", retired_at: null };
    const me = { id, email: "a@b.test", display_name: "Ann", locale: "en", keys, pub: { ecdh: bytes(300), ecdsa: bytes(300) }, vault, passkeys: [{ id, created_at: "2026-01-01T00:00:00.000Z", credential_id: bytes(16), prf_salt: bytes(8), vault: { ...vault, kind: "passkey" }, label: "", transports: [] }], is_admin: false };
    expect(ok(Me, me)).toBe(true);
    const sealedRow = { key_version: 1, schema_version: 1, nonce: bytes(4096), ciphertext: bytes(3), author_id: id, updated_at: "2026-01-01T00:00:00.000Z" };
    expect(ok(Bootstrap, { me, drawers: [], documents: { [id]: sealedRow }, wraps: [odd], members: {}, entries: [row], invitations: [], transfers: [] })).toBe(true);
    expect(ok(UserDelegations, { delegations: [{ delegation: { v: 1, user_id: id, account_sig_key_id: "anything", token_ecdsa_pub: bytes(300), token_sig_key_id: "0".repeat(32), created_at: "2026-11-10T12:00:00.000Z", expires_at: null, sig: bytes(300) }, revoked_at: null }] })).toBe(true);
  });
});
