/**
 * Dev/test helpers that drive the real API with real ciphertext. Used by the seed
 * and the API tests. Not imported by any route.
 */
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import pg from "pg";
import {
  createDrawerKey, createRecoveryVault, createVault, exportPublicKeys, generateRecoveryCode, generateUserKeys,
  sealDocument, sealEntry, signCustodyChallenge, signEntry, signingKeyId, toB64, wrapDrawerKey, unwrapDrawerKey,
  type EntryPayloadV1, type RecordIdentity, type Sealed, type Sender, type UserKeyPairs,
} from "@petty/crypto";
import { newDocument, type DrawerDocument } from "@petty/ledger";
import { config } from "../config.js";
import { randomToken, sha256 } from "../lib/bytes.js";

export interface UserMaterial {
  email: string; password: string; passphrase: string; display_name: string; recovery_code: string;
  keys: UserKeyPairs; pub: { ecdh: string; ecdsa: string }; sig_key_id: string;
  signupBody: Record<string, unknown>;
}

export async function userMaterial(name: string, over: Partial<Pick<UserMaterial, "email" | "password" | "passphrase">> = {}): Promise<UserMaterial> {
  const keys = await generateUserKeys();
  const pub = await exportPublicKeys(keys);
  const passphrase = over.passphrase ?? `vault ${name} 2026 drawer`;
  const recovery_code = generateRecoveryCode();
  const vault = await createVault(passphrase, keys);
  const recovery_vault = await createRecoveryVault(recovery_code, keys);
  const email = over.email ?? `${name}@petty.local`;
  const password = over.password ?? `password-${name}`;
  const sig_key_id = await signingKeyId(pub.ecdsa);
  return {
    email, password, passphrase, display_name: name[0]!.toUpperCase() + name.slice(1), recovery_code, keys, pub, sig_key_id,
    signupBody: { email, password, display_name: name[0]!.toUpperCase() + name.slice(1), keys: { ecdh_pub: pub.ecdh, ecdsa_pub: pub.ecdsa, sig_key_id }, vault, recovery_vault },
  };
}

/** Inserts a join link straight into the database (owner role). Returns the token. */
export async function makeJoinLink(email: string | null = null): Promise<string> {
  const token = randomToken(24);
  const owner = new pg.Client({ connectionString: config.ownerDatabaseUrl });
  await owner.connect();
  try {
    await owner.query("insert into join_links (token_hash, email, expires_at) values ($1, $2, now() + interval '1 day')", [sha256(token), email]);
  } finally {
    await owner.end();
  }
  return token;
}

export class Client {
  cookie: string | null = null;
  /** Clerk mode (PETTY-88): a session token sent as bearer instead of the cookie. */
  bearer: string | null = null;
  constructor(readonly app: FastifyInstance, readonly user: UserMaterial, public id = "") {}

  async call(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, body?: unknown): Promise<LightMyRequestResponse> {
    const res: LightMyRequestResponse = await this.app.inject({
      method, url, cookies: this.cookie ? { petty_session: this.cookie } : {},
      headers: { ...(this.bearer ? { authorization: `Bearer ${this.bearer}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
    const set = res.headers["set-cookie"];
    const raw = Array.isArray(set) ? set[0] : set;
    if (raw) {
      const m = /petty_session=([^;]*)/.exec(raw);
      this.cookie = m && m[1] ? m[1] : null;
    }
    return res;
  }

  async signup(joinToken: string) {
    const res = await this.call("POST", "/auth/signup", { ...this.user.signupBody, join_token: joinToken });
    if (res.statusCode === 201) this.id = res.json().id;
    return res;
  }
  async login() {
    const res = await this.call("POST", "/auth/login", { email: this.user.email, password: this.user.password });
    if (res.statusCode === 200) this.id = res.json().id;
    return res;
  }
  /** Custody proof (SR-2): a fresh challenge signed with this user's ECDSA key. */
  async proof(key: CryptoKey = this.user.keys.ecdsa.privateKey) {
    const c = (await this.call("POST", "/me/custody-challenge")).json();
    return { challenge: c.challenge, signature: await signCustodyChallenge(key, c.challenge) };
  }

  get sender(): Sender {
    return { ecdhPrivate: this.user.keys.ecdh.privateKey, ecdhPublicB64: this.user.pub.ecdh };
  }

  /** Creates a drawer with a real sealed document and self-wrap. Returns the id, the key and the document. */
  async createDrawer(name: string, doc?: DrawerDocument) {
    const id = crypto.randomUUID();
    const { key, selfWrap } = await createDrawerKey(this.sender, id, 1);
    const document = doc ?? newDocument(name);
    const identity: RecordIdentity = { record_type: "document", record_id: id, drawer_id: id, line_id: null, author_id: this.id, key_version: 1, schema_version: 1 };
    const sealed = await sealDocument(key, identity, document);
    const res = await this.call("POST", "/drawers", { id, document: sealedBody(sealed, 1), self_wrap: selfWrap });
    return { id, key, document, res };
  }

  async sealDoc(drawerId: string, key: CryptoKey, doc: DrawerDocument, keyVersion = 1): Promise<Sealed> {
    return sealDocument(key, { record_type: "document", record_id: drawerId, drawer_id: drawerId, line_id: null, author_id: this.id, key_version: keyVersion, schema_version: 1 }, doc);
  }

  /** Signs and seals an entry, then posts it. */
  async postEntry(drawerId: string, key: CryptoKey, lineId: string, op: EntryPayloadV1["op"], amount: number, opts: { id?: string; reverses?: string | null; prev_hash?: string | null; expected_head_seq?: number; keyVersion?: number; delta_hint?: number | null } = {}) {
    const id = opts.id ?? crypto.randomUUID();
    const payload: EntryPayloadV1 = {
      v: 1, id, drawer_id: drawerId, line_id: lineId, op, amount, exponent: 2, comment: "", logged_at: new Date().toISOString(),
      reverses: opts.reverses ?? null, prev_hash: opts.prev_hash ?? null, delta_hint: op === "adjust" ? (opts.delta_hint ?? null) : null,
      author_id: this.id, sig_key_id: this.user.sig_key_id,
    };
    const signed = await signEntry(payload, this.user.keys.ecdsa.privateKey);
    const kv = opts.keyVersion ?? 1;
    const sealed = await sealEntry(key, { record_type: "entry", record_id: id, drawer_id: drawerId, line_id: lineId, author_id: this.id, key_version: kv, schema_version: 1 }, signed);
    const body: Record<string, unknown> = { id, line_id: lineId, is_checkpoint: op === "adjust", reverses_entry_id: opts.reverses ?? null, ...sealedBody(sealed, kv) };
    if (opts.expected_head_seq !== undefined) body["expected_head_seq"] = opts.expected_head_seq;
    return { id, signed, res: await this.call("POST", `/drawers/${drawerId}/entries`, body) };
  }

  async wrapFor(key: CryptoKey, recipientEcdhPub: string, drawerId: string, keyVersion: number) {
    return wrapDrawerKey(key, this.sender, recipientEcdhPub, drawerId, keyVersion);
  }

  async unwrap(wrap: Parameters<typeof unwrapDrawerKey>[0], senderEcdhPub: string, extractable = false) {
    return unwrapDrawerKey(wrap, this.user.keys.ecdh.privateKey, { drawer_id: wrap.drawer_id, key_version: wrap.key_version, senderEcdhPublicB64: senderEcdhPub }, { extractable });
  }
}

export function sealedBody(s: Sealed, keyVersion: number) {
  return { key_version: keyVersion, schema_version: 1, nonce: toB64(s.nonce), ciphertext: toB64(s.ciphertext) };
}
