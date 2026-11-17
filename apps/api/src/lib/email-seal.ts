import type pg from "pg";
import { config } from "../config.js";
import type { Queryable } from "./tx.js";

/**
 * PETTY-359: stored emails sealed with a server key, so a copy of the database (a leaked backup, a stolen
 * disk or branch, an SQL injection that reads tables) shows no address. It does not help against code
 * running in the API process: that has the key (docs/threat-model.md).
 *
 * EMAIL_KEY is 32 random bytes. HKDF-SHA-256 derives three values from it: an AES-256-GCM key that seals
 * an address, an HMAC-SHA-256 key for the blind index (the address in lower case, hashed, so a lookup by
 * address still finds its row), and the key id stored next to each sealed value. The id says which key
 * opens a row, so a new key can take over while EMAIL_KEY_OLD still reads the rows of the old one.
 *
 * A sealed value is 0x01 (the format) || 12-byte random nonce || ciphertext and tag. Its additional data
 * binds it to its table, column, row id and key id: copied into another row, it does not open.
 *
 * Every read and write of an address goes through this file: it seals or opens a row's columns, builds
 * the WHERE that finds an address in either form, and moves rows to the current form (`rewriteEmails`,
 * in each housekeeping run). With no EMAIL_KEY, an address is written plain, exactly as before.
 * Never log an address or a key; a key id is not secret.
 */

const subtle = globalThis.crypto.subtle;
const utf8 = new TextEncoder();
const FORMAT = 1;
const NONCE_BYTES = 12;

export class EmailKeyError extends Error {
  override name = "EmailKeyError";
}

interface EmailKey { id: string; seal: CryptoKey; index: CryptoKey }
interface Keys {
  /** The key new values are sealed with; null = they are written plain. */
  current: EmailKey | null;
  /** Every key this instance can open with, by id: the current one and EMAIL_KEY_OLD. */
  byId: Map<string, EmailKey>;
}

function rawKey(name: string, b64: string): Uint8Array<ArrayBuffer> {
  const raw = Buffer.from(b64, "base64");
  if (raw.length !== 32 || raw.toString("base64").replace(/=+$/, "") !== b64.replace(/=+$/, "")) {
    throw new EmailKeyError(`${name} must be 32 random bytes in base64, as \`openssl rand -base64 32\` prints them`);
  }
  return new Uint8Array(raw);
}

async function deriveKey(raw: Uint8Array<ArrayBuffer>): Promise<EmailKey> {
  const ikm = await subtle.importKey("raw", raw, "HKDF", false, ["deriveKey", "deriveBits"]);
  const hkdf = (info: string) => ({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8.encode(info) });
  const seal = await subtle.deriveKey(hkdf("petty email seal v1"), ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const index = await subtle.deriveKey(hkdf("petty email index v1"), ikm, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign"]);
  const id = Buffer.from(await subtle.deriveBits(hkdf("petty email key id v1"), ikm, 64)).toString("hex");
  return { id, seal, index };
}

let cached: { source: string; keys: Promise<Keys> } | null = null;
/** The keys from EMAIL_KEY and EMAIL_KEY_OLD, derived once (again when the configuration changes, for tests). */
export function emailKeys(): Promise<Keys> {
  const source = `${config.emailKey}|${config.emailKeysOld.join(",")}`;
  if (cached?.source !== source) {
    const keys = (async (): Promise<Keys> => {
      const current = config.emailKey ? await deriveKey(rawKey("EMAIL_KEY", config.emailKey)) : null;
      const byId = new Map<string, EmailKey>();
      for (const old of config.emailKeysOld) { const k = await deriveKey(rawKey("EMAIL_KEY_OLD", old)); byId.set(k.id, k); }
      if (current) byId.set(current.id, current);
      return { current, byId };
    })();
    cached = { source, keys };
  }
  return cached.keys;
}

type Table = "users" | "join_links";
const aad = (table: Table, rowId: string, keyId: string) => utf8.encode(`petty-email/v${FORMAT}\n${table}.email\n${rowId}\n${keyId}`);
/** Only the app compares addresses, so lower case here is the rule; plain rows keep SQL's lower(email). */
const normal = (email: string) => email.toLowerCase();

async function hmac(key: EmailKey, purpose: string, email: string): Promise<Buffer> {
  return Buffer.from(await subtle.sign("HMAC", key.index, utf8.encode(`${purpose}\n${normal(email)}`)));
}

async function sealWith(key: EmailKey, table: Table, rowId: string, email: string): Promise<Buffer> {
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ct = await subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad(table, rowId, key.id) }, key.seal, utf8.encode(email));
  return Buffer.concat([Buffer.from([FORMAT]), nonce, Buffer.from(ct)]);
}

/** A row's email columns. */
export interface EmailColumns { email: string | null; email_sealed: Buffer | null; email_key_id: string | null }
export interface UserEmailColumns extends EmailColumns { email_index: Buffer | null }

/** The columns that store `email` in users row `rowId`: sealed with EMAIL_KEY, or plain when there is none. */
export async function userEmailColumns(rowId: string, email: string): Promise<UserEmailColumns> {
  const { current } = await emailKeys();
  if (!current) return { email, email_sealed: null, email_key_id: null, email_index: null };
  return { email: null, email_sealed: await sealWith(current, "users", rowId, email), email_key_id: current.id, email_index: await hmac(current, "users.email", email) };
}
/** The columns that store a join link's optional address. */
export async function linkEmailColumns(rowId: string, email: string | null): Promise<EmailColumns> {
  const { current } = await emailKeys();
  if (!email || !current) return { email, email_sealed: null, email_key_id: null };
  return { email: null, email_sealed: await sealWith(current, "join_links", rowId, email), email_key_id: current.id };
}

/** A row as selected with `emailColumnsSql`, plus its id. */
export interface StoredEmail { id: string; email: string | null; email_sealed: Buffer | null; email_key_id: string | null }
/** The SQL that selects what `openEmail` needs (the row's id is selected apart, as `id`). */
export const emailColumnsSql = (alias: string) => `${alias}.email, ${alias}.email_sealed, ${alias}.email_key_id`;

/**
 * The address a row stores, or null when it has none or this instance cannot open it (no key with its id,
 * or a value that does not open in this row). Startup refuses a database sealed with a key it does not
 * have (`checkEmailKeys`), so null for a sealed row means the moment another instance with a key sealed
 * it; callers then skip the mail, and a join link with an address it cannot read is refused.
 */
export async function openEmail(table: Table, row: StoredEmail): Promise<string | null> {
  if (row.email !== null) return row.email;
  if (!row.email_sealed || !row.email_key_id) return null;
  const key = (await emailKeys()).byId.get(row.email_key_id);
  const b = new Uint8Array(row.email_sealed);
  if (!key || b.length < 1 + NONCE_BYTES + 16 || b[0] !== FORMAT) return null;
  try {
    const plain = await subtle.decrypt({ name: "AES-GCM", iv: b.subarray(1, 1 + NONCE_BYTES), additionalData: aad(table, row.id, key.id) }, key.seal, b.subarray(1 + NONCE_BYTES));
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

/**
 * Finds users by address in either form: `emailMatchSql("u", 1)` is the WHERE part, with $1 = the address
 * and $2 = its blind indexes under every key this instance has (`emailMatchParams`).
 */
export const emailMatchSql = (alias: string, first: number) => `(lower(${alias}.email) = lower($${first}) or ${alias}.email_index = any($${first + 1}::bytea[]))`;
export async function emailMatchParams(email: string): Promise<[string, Buffer[]]> {
  const { byId } = await emailKeys();
  return [email, await Promise.all([...byId.values()].map((k) => hmac(k, "users.email", email)))];
}

/**
 * What a rate-limit key holds for an address (login, forgot, join-link mails). With a key it is an HMAC, so
 * the counters table shows no address either; without one, the address as the caller wrote it, as before.
 */
export async function emailRateTag(address: string): Promise<string> {
  const { current } = await emailKeys();
  return current ? `k:${(await hmac(current, "rate", address)).toString("base64url")}` : address;
}

/** The address and language a mail to this user goes to; null address = none to send to (see openEmail). */
export async function mailAddressOf(db: Queryable, userId: string): Promise<{ email: string | null; locale: string } | undefined> {
  const r = (await db.query<StoredEmail & { locale: string }>(`select u.id, ${emailColumnsSql("u")}, u.locale from users u where u.id = $1`, [userId])).rows[0];
  return r && { email: await openEmail("users", r), locale: r.locale };
}

type Db = Queryable | pg.Client;

/**
 * Refuses to go on when stored emails are sealed with a key this instance does not have: with EMAIL_KEY
 * missing or wrong, sign-in by address and every mail would fail, and new rows would be written in a form
 * the rest cannot be matched with. Called before the API takes requests (index.ts).
 */
export async function checkEmailKeys(db: Db): Promise<void> {
  const { byId } = await emailKeys();
  const { rows } = await db.query<{ email_key_id: string; n: number }>(
    `select email_key_id, count(*)::int as n from (
       select email_key_id from users where email_key_id is not null
       union all select email_key_id from join_links where email_key_id is not null) s
     group by email_key_id`,
  );
  const unknown = rows.filter((r) => !byId.has(r.email_key_id));
  if (unknown.length) {
    const n = unknown.reduce((a, r) => a + r.n, 0);
    throw new EmailKeyError(
      `${n} stored email(s) are sealed with a key this instance does not have (key id ${unknown.map((r) => r.email_key_id).join(", ")}). ` +
      "Set EMAIL_KEY, or EMAIL_KEY_OLD, to the key they were sealed with; without it no address can be read.",
    );
  }
}

/**
 * Rows moved to the current form, by table; `unknown`: rows sealed with a key this instance does not have
 * (left alone); `unreadable`: rows under a key it has that do not open; `conflicts`: an address stored twice.
 */
export interface RewriteResult { users: number; join_links: number; unknown: number; unreadable: number; conflicts: number }
const BATCH = 200;

/**
 * Moves every email to the current form, in batches: sealed with EMAIL_KEY when it is set (plain rows and
 * rows under an EMAIL_KEY_OLD key), else plain (rows under an EMAIL_KEY_OLD key: the way back). Rows under
 * a key this instance does not have are left alone. Each row is written only if it is still what was read,
 * so two instances can run this at once. `only` limits it to these row ids (tests share one database).
 */
export async function rewriteEmails(db: Queryable, opts: { only?: string[] } = {}): Promise<RewriteResult> {
  const { current, byId } = await emailKeys();
  const known = [...byId.keys()];
  const out: RewriteResult = { users: 0, join_links: 0, unknown: 0, unreadable: 0, conflicts: 0 };
  out.unknown = (await db.query<{ n: number }>(
    // `is not null` first: with no key at all, `x <> all('{}')` is true even for null, and every plain row counted
    `select ((select count(*) from users t where t.email_key_id is not null and t.email_key_id <> all($1::text[]) ${opts.only ? "and t.id = any($2::uuid[])" : ""})
           + (select count(*) from join_links t where t.email_key_id is not null and t.email_key_id <> all($1::text[]) ${opts.only ? "and t.id = any($2::uuid[])" : ""}))::int as n`,
    opts.only ? [known, opts.only] : [known],
  )).rows[0]!.n;
  if (!current && !known.length) return out; // no key: nothing this instance could read or write
  for (const table of ["users", "join_links"] as const) {
    // rows not yet in the current form that this instance can read: $1 = the keys it has, $2 = the current one
    const pending = current
      ? "(t.email is not null or (t.email_key_id <> $2::text and t.email_key_id = any($1::text[])))"
      : "t.email_key_id = any($1::text[])";
    const params: unknown[] = current ? [known, current.id] : [known];
    const only = opts.only ? `and t.id = any($${params.push(opts.only)}::uuid[])` : "";
    const afterParam = params.push(null);
    let after = "00000000-0000-0000-0000-000000000000";
    for (;;) {
      params[afterParam - 1] = after;
      const { rows } = await db.query<StoredEmail>(
        `select t.id, ${emailColumnsSql("t")} from ${table} t
          where ${pending} ${only} and t.id > $${afterParam}::uuid
          order by t.id limit ${BATCH}`,
        params,
      );
      for (const r of rows) {
        const email = await openEmail(table, r);
        if (email === null) { out.unreadable++; continue; }
        try {
          let done: pg.QueryResult;
          if (table === "users") {
            const n = await userEmailColumns(r.id, email);
            done = await db.query(
              `update users set email = $2, email_sealed = $3, email_key_id = $4, email_index = $5
                where id = $1 and email is not distinct from $6 and email_sealed is not distinct from $7`,
              [r.id, n.email, n.email_sealed, n.email_key_id, n.email_index, r.email, r.email_sealed],
            );
          } else {
            const n = await linkEmailColumns(r.id, email);
            done = await db.query(
              `update join_links set email = $2, email_sealed = $3, email_key_id = $4
                where id = $1 and email is not distinct from $5 and email_sealed is not distinct from $6`,
              [r.id, n.email, n.email_sealed, n.email_key_id, r.email, r.email_sealed],
            );
          }
          if (done.rowCount) out[table]++;
        } catch (e) {
          // a plain and a sealed row with the same address (two sign-ins that raced across a key change): left for a person
          if ((e as { code?: string }).code === "23505") { out.conflicts++; continue; }
          throw e;
        }
      }
      if (rows.length < BATCH) break;
      after = rows[rows.length - 1]!.id;
    }
  }
  return out;
}
