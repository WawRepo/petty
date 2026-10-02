import { generateDrawerKey, generateUserKeys, exportPublicKeys, signingKeyId, signEntry, type Author, type EntryPayloadV1, type RecordIdentity, type SignedEntryV1, type UserKeyPairs } from "../src/index.js";

export const DRAWER = "11111111-1111-4111-8111-111111111111";
export const LINE = "22222222-2222-4222-8222-222222222222";
export const AUTHOR = "user-default";

export interface TestAuthor { keys: UserKeyPairs; id: string; sigKeyId: string; ecdhPub: string; author: Author }

export async function author(id = "user-" + crypto.randomUUID().slice(0, 8)): Promise<TestAuthor> {
  const keys = await generateUserKeys();
  const pub = await exportPublicKeys(keys);
  const sigKeyId = await signingKeyId(pub.ecdsa);
  return { keys, id, sigKeyId, ecdhPub: pub.ecdh, author: { author_id: id, sig_key_id: sigKeyId, ecdsaPublic: keys.ecdsa.publicKey } };
}

export function entryIdentity(id: string, extra: Partial<RecordIdentity> = {}): RecordIdentity {
  return { record_type: "entry", record_id: id, drawer_id: DRAWER, line_id: LINE, author_id: AUTHOR, key_version: 1, schema_version: 1, ...extra };
}
export function docIdentity(extra: Partial<RecordIdentity> = {}): RecordIdentity {
  return { record_type: "document", record_id: DRAWER, drawer_id: DRAWER, line_id: null, author_id: AUTHOR, key_version: 1, schema_version: 1, ...extra };
}

export async function makeEntry(a: TestAuthor, over: Partial<EntryPayloadV1> = {}): Promise<SignedEntryV1> {
  const payload: EntryPayloadV1 = {
    v: 1,
    id: over.id ?? "e-" + crypto.randomUUID().slice(0, 10),
    drawer_id: DRAWER,
    line_id: LINE,
    op: "add",
    amount: 5000,
    exponent: 2,
    comment: "",
    logged_at: "2026-08-28T10:00:00.000Z",
    reverses: null,
    prev_hash: null,
    delta_hint: null,
    author_id: a.id,
    sig_key_id: a.sigKeyId,
    ...over,
  };
  return signEntry(payload, a.keys.ecdsa.privateKey);
}

export { generateDrawerKey };
