import {
  delegationCovers,
  fromB64,
  hashEntry,
  importEcdsaPublic,
  openDocument,
  openEntryUnverified,
  openPatBundle,
  sealDocument,
  sealEntry,
  signEntry,
  splitPatToken,
  toB64,
  unwrapDrawerKey,
  verifyDelegation,
  verifyEntry,
  type EntryPayloadV1,
  type SignedEntryV1,
  type Bytes,
  type PatBundleV1,
  type RecordIdentity,
} from "@petty/crypto";
import { applyOps, assertCurrencyCode, fold, formatAmount, foldText, LedgerError, lineTagsOf, MAX_TAGS, nextRev, normalizeTags, parseAmount, readDocument, reverseOf, seedExponent, tagsOf, verifyChain, type ReverseRefusal, type DocumentOp, type DrawerDocument, type LedgerEntry, type Line } from "@petty/ledger";
import { EntriesPage, EntryRow, TokenBootstrap, type AccessTokenSelf, type EntryAuthor } from "@petty/protocol";

/**
 * A headless Petty client for an access token (PETTY-165). Everything a tool needs — MCP for
 * Claude Desktop, a command line, a hosted connector — sits on top of this, so the format lives
 * in one place: the same crypto and ledger packages the web app uses.
 *
 * The token is `petty_pat_<id>.<secret>`. Only the id half is ever sent. The secret opens the key
 * bundle in this process, and the keys stay in memory: nothing here writes plaintext to disk or
 * logs content (spec rules 1 and 2).
 */
export class TokenError extends Error {
  constructor(readonly code: "WrongToken" | "TokenRevoked" | "ReadOnly" | "OutOfScope" | "NotFound" | "Ambiguous" | "Offline" | "RecountRequired" | "Conflict" | "Refused", message: string) {
    super(message);
    this.name = "TokenError";
  }
}

/**
 * PETTY-414: text that a member or the server wrote (a name, a tag, a comment, a currency code, an item
 * id) goes into a message or a tool's answer only as one quoted JSON string on one line. `JSON.stringify`
 * leaves DEL, the C1 control characters and the Unicode line separators as they are; here they are
 * escaped too, and the value read back is the same. Quoting marks the text as someone's data. It does
 * not stop a model from following what the text says.
 */
export const jsonText = (value: unknown, indent?: number): string =>
  JSON.stringify(value, null, indent).replace(/[\u007f-\u009f\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
export const quote = (text: string): string => jsonText(text);

/**
 * The codes the server refuses a tool with that a person may be shown (PETTY-414). The server's own text
 * goes no further than this list: any other code is the one word "UnknownCode".
 */
const SERVER_CODES = ["KeyVersionMismatch", "EntryIdReused", "ReverseRefused", "DeviceKeyInvalid", "DeviceCodeTaken", "ValidationError", "BadRequest", "NotFound", "Internal"] as const;
export const serverCode = (code: unknown): string => SERVER_CODES.find((c) => c === code) ?? "UnknownCode";

/** `received_at` is the server's text. It leaves this client only as a date, in one fixed form; anything else is refused. */
function serverDate(text: string): string {
  const t = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(text) ? Date.parse(text) : NaN;
  if (Number.isNaN(t)) throw new TokenError("Refused", "the server sent a date that is not a date");
  return new Date(t).toISOString();
}

export interface ConnectOptions {
  readonly token: string;
  /** Where the API lives, for example https://petty.example.com/api */
  readonly apiUrl: string;
  readonly fetch?: typeof fetch;
  /** Tests only: allow a plain-http API address that is not this machine. */
  readonly allowInsecureHttp?: boolean;
  /** Called after every load that could not open or check something (PETTY-445), with the same list as `warnings`. */
  readonly onWarnings?: (warnings: readonly AgentWarning[]) => void;
}

/** PETTY-191 (NR-11): the token travels in every request, so only https, or http to this machine. */
export function checkApiUrl(apiUrl: string, allowInsecureHttp = false): void {
  let u: URL;
  try { u = new URL(apiUrl); } catch { throw new TokenError("Refused", `not an address: ${quote(apiUrl)}`); }
  const local = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(u.hostname);
  if (u.protocol === "https:" || (u.protocol === "http:" && (local || allowInsecureHttp))) return;
  throw new TokenError("Refused", `the Petty address must start with https:// (got ${quote(`${u.protocol}//${u.host}`)})`);
}

export interface AgentLine {
  readonly id: string;
  readonly name: string;
  readonly kind: Line["kind"];
  readonly currency: string | null;
  readonly exponent: number;
  /** A countable item's unit, such as "pcs"; null for money and single items (PETTY-339). */
  readonly unit: string | null;
  /** A single item's note, such as "blue box"; null for money and countable items (PETTY-339). */
  readonly note: string | null;
  readonly tags: readonly string[];
  /** Minor units for money, a count for countable things, and 0 for a single item. */
  readonly balance: number;
  /** The balance as a person reads it, for example "1,209.50 EUR". */
  readonly amount: string;
  readonly countedInTotal: boolean;
  /** Entries left out of the balance because their signature did not check out (PETTY-191). */
  readonly unverified: number;
  /** Rows of this item left out of the balance because they did not open (PETTY-445). */
  readonly unreadable: number;
  /** "broken" when the hash links between this item's entries do not hold: entries may have been removed or changed (PETTY-445). */
  readonly chain: "ok" | "broken";
}

export interface AgentDrawer {
  readonly id: string;
  readonly name: string;
  readonly place: readonly string[];
  readonly role: "owner" | "write" | "read";
  readonly lines: readonly AgentLine[];
  /** Rows of this drawer that did not open and belong to none of its items (PETTY-445). */
  readonly unreadable: number;
}

/**
 * Something a load could not open or check (PETTY-445). A tool must show these to the person: what is
 * named here is left out of the balances, or may have been changed on the server.
 */
export interface AgentWarning {
  readonly code: "drawer_unreadable" | "entries_unreadable" | "entries_unverified" | "history_broken";
  readonly drawerId: string;
  /** null when the drawer itself did not open */
  readonly drawer: string | null;
  readonly lineId: string | null;
  readonly item: string | null;
  /** How many rows; 1 for a drawer or a history. */
  readonly count: number;
}

/** A name as one quoted value, with no control character left to reach a terminal or pose as output. */
const quotedName = (s: string): string => JSON.stringify(s).replace(/[\u007f-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** One warning as a sentence. Names come from other people too, so each goes out as one quoted value. */
export function warningText(w: AgentWarning, quote: (s: string) => string = quotedName): string {
  if (w.code === "drawer_unreadable") return `a drawer could not be opened and is left out (id ${w.drawerId})`;
  const where = `drawer ${quote(w.drawer ?? "")}${w.item === null ? "" : ` / item ${quote(w.item)}`}`;
  const rows = `${w.count} entr${w.count === 1 ? "y" : "ies"}`;
  if (w.code === "entries_unreadable") return `${where}: ${rows} could not be opened${w.item === null ? " and belong to no item" : ""}; left out of the balance`;
  if (w.code === "entries_unverified") return `${where}: ${rows} left out of the balance, signature did not check`;
  return `${where}: the history links do not match; entries may have been removed or changed`;
}

export interface AgentEntry {
  readonly id: string;
  readonly seq: number;
  readonly op: EntryPayloadV1["op"];
  /** This entry's own amount (for an adjust: what was counted), never a balance (PETTY-191). */
  readonly amount: string;
  /** Only on an entry this client just wrote: the item's balance after it. */
  readonly balanceAfter?: string;
  readonly comment: string;
  readonly at: string;
  readonly mine: boolean;
  /** False when the signature did not check out against the author's published keys (PETTY-191). */
  readonly verified: boolean;
}

/** One tag and the items carrying it, grouped by drawer (PETTY-174). */
export interface AgentTag {
  readonly label: string;
  readonly holders: readonly { readonly drawer: string; readonly drawerId: string; readonly items: readonly { readonly id: string; readonly name: string }[] }[];
}

/** A node of the place tree built from drawer paths: Kitchen › shelf › tin. */
export interface AgentPlace {
  readonly name: string;
  readonly path: readonly string[];
  readonly drawers: readonly string[];
  readonly children: readonly AgentPlace[];
}

const LOCALE = "en-GB";

const UNDO_REFUSED: Record<ReverseRefusal, string> = {
  adjust_not_reversible: "a count (adjust) cannot be undone; count again instead",
  reverse_not_reversible: "an undo cannot be undone; add or take the amount instead",
  already_reversed: "that entry is already undone",
  before_checkpoint: "a later count already settled that entry",
};

export async function connect(opts: ConnectOptions): Promise<AgentClient> {
  const client = new AgentClient(opts);
  await client.open();
  return client;
}

export class AgentClient {
  private readonly api: string;
  private readonly bearer: string;
  private readonly doFetch: typeof fetch;
  private readonly secret: Bytes;
  private readonly tokenId: string;
  private self: AccessTokenSelf | null = null;
  private bundle: PatBundleV1 | null = null;
  private bundleSigKeyId: string | null = null;
  private keys = new Map<string, { key: CryptoKey; keyVersion: number }>();
  private signing: CryptoKey | null = null;
  private oldBundle = false;
  /** The last seq seen per drawer:line, which an Adjust must state (the server refuses a stale count). */
  private heads = new Map<string, number>();
  /** The checked entries since each drawer:line's latest count, from the last load: what an undo looks at. */
  private lineEntries = new Map<string, LedgerEntry[]>();
  /** What the latest load could not open or check (PETTY-445). Empty when everything checked out. */
  warnings: readonly AgentWarning[] = [];
  private readonly onWarnings: ConnectOptions["onWarnings"];
  /** Ids of the rows the latest load could not open, so `history` does not count them again. */
  private unopened = new Set<string>();

  constructor(opts: ConnectOptions) {
    checkApiUrl(opts.apiUrl, opts.allowInsecureHttp);
    const split = splitPatToken(opts.token);
    this.tokenId = split.tokenId;
    this.secret = split.secret;
    this.api = opts.apiUrl.replace(/\/$/, "");
    this.bearer = `petty_pat_${split.tokenId}`;
    this.doFetch = opts.fetch ?? fetch;
    this.onWarnings = opts.onWarnings;
  }

  /**
   * Set for a token made before PETTY-397: it does not know its owner's key, so it opens only the drawers
   * copied in when it was made, never a drawer added or re-keyed later.
   */
  get notice(): string | null {
    return this.oldBundle ? "this token is from an older Petty: drawers added or re-keyed after it was made stay out of reach; make a new token in Petty Settings and revoke this one" : null;
  }

  /** Who this token belongs to, its role, and the drawers it may open. */
  get identity(): { userId: string; name: string; role: "read" | "write"; scope: readonly string[] | null } {
    if (!this.self) throw new TokenError("WrongToken", "not connected");
    return { userId: this.self.user_id, name: this.self.name, role: this.self.role, scope: this.self.scope };
  }

  async open(): Promise<void> {
    const self = (await this.call("GET", "/me/token")) as AccessTokenSelf;
    this.self = self;
    this.bundle = await openPatBundle(this.secret, this.tokenId, self.user_id, self.bundle);
    this.secret.fill(0);

    for (const d of this.bundle.drawers) {
      const key = await crypto.subtle.importKey("raw", new Uint8Array(fromB64(d.key)), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
      this.keys.set(d.drawer_id, { key, keyVersion: d.key_version });
    }
    // PETTY-169: drawers made after this token arrive as wraps for the token's own ECDH key.
    // PETTY-397: only from the owner's key sealed in the bundle, never the server's `owner_ecdh_pub`: with
    // its own key there, a server could hand the token a drawer key it knows and read what the token writes.
    this.oldBundle = !!this.bundle.ecdh && !this.bundle.owner_ecdh;
    if (this.bundle.ecdh && this.bundle.owner_ecdh) {
      const mine = await crypto.subtle.importKey("pkcs8", new Uint8Array(fromB64(this.bundle.ecdh)), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits", "deriveKey"]);
      const owner = this.bundle.owner_ecdh;
      const { keys } = (await this.call("GET", "/me/token/keys")) as { keys: { drawer_id: string; key_version: number; wrap: Parameters<typeof unwrapDrawerKey>[0] }[] };
      for (const k of keys) {
        const held = this.keys.get(k.drawer_id);
        if (held && held.keyVersion >= k.key_version) continue; // the bundle already has this or newer
        try {
          const key = await unwrapDrawerKey(k.wrap, mine, { drawer_id: k.drawer_id, key_version: k.key_version, senderEcdhPublicB64: owner });
          this.keys.set(k.drawer_id, { key, keyVersion: k.key_version });
        } catch {
          // a wrap this token cannot open is ignored: the drawer simply stays invisible
        }
      }
    }
    if (this.bundle.ecdsa) {
      this.signing = await crypto.subtle.importKey("pkcs8", new Uint8Array(fromB64(this.bundle.ecdsa)), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    }
    // PETTY-193 (NR-13): the keys now live as non-extractable CryptoKeys; drop the plain copies.
    this.bundleSigKeyId = this.bundle.sig_key_id ?? null;
    this.bundle = null;
  }

  private async call(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await this.doFetch(`${this.api}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.bearer}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (e) {
      // Node's fetch hides the real reason in `cause` (EHOSTUNREACH, ENOTFOUND, a certificate error…).
      // A code such as EHOSTUNREACH is Node's own word. Any other reason (a certificate's names, say) is foreign text: quoted.
      const cause = (e as { cause?: { code?: unknown; message?: unknown } }).cause;
      const why = typeof cause?.code === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(cause.code) ? cause.code : quote(String(cause?.message ?? (e as Error).message));
      throw new TokenError("Offline", `cannot reach ${quote(this.api)}: fetch failed (${why})`);
    }
    if (res.status === 401) throw new TokenError("TokenRevoked", "this token is unknown, revoked or expired");
    if (res.status === 403) {
      const body = (await res.json().catch(() => ({}))) as { code?: string };
      if (body.code === "TokenNeedsRenewal") throw new TokenError("Refused", "this token is from before tokens got their own signing key; make a new token in Petty Settings and revoke this one");
      throw new TokenError("Refused", "this token may not do that");
    }
    if (res.status === 404) throw new TokenError("NotFound", "not found");
    if (res.status === 409) {
      const body = (await res.json().catch(() => ({}))) as { code?: unknown };
      if (body.code === "RecountRequired") throw new TokenError("RecountRequired", "the item changed since it was read; count it again");
      if (body.code === "VersionConflict") throw new TokenError("Conflict", "the drawer changed meanwhile");
      throw new TokenError("Refused", (body.code ?? null) === null ? "the server refused this entry" : serverCode(body.code));
    }
    if (!res.ok) throw new TokenError("Refused", `the server answered ${res.status}`);
    return res.status === 204 ? undefined : await res.json();
  }

  /** Published keys and delegations of entry authors, from the last start-up load. */
  private authors: Record<string, EntryAuthor> = {};
  private verifyKeys = new Map<string, CryptoKey>();

  /**
   * Does this entry's signature check out (PETTY-191, review NR-11)? Against the author's published
   * account key with that id, or a token key the author's account key signed a delegation for, as
   * long as the server received the entry before the delegation expired or was revoked. The same
   * rule as the web app. The keys come from the server, so this catches a changed database, not a
   * lying server; the web app's pinned keys are the stronger check.
   */
  private async signatureOk(entry: SignedEntryV1, receivedAt: string): Promise<boolean> {
    const a = this.authors[entry.author_id];
    if (!a) return false;
    const importKey = async (spki: string) => {
      const hit = this.verifyKeys.get(spki);
      if (hit) return hit;
      const k = await importEcdsaPublic(spki);
      this.verifyKeys.set(spki, k);
      return k;
    };
    try {
      let spki = a.keys.find((k) => k.sig_key_id === entry.sig_key_id)?.ecdsa_pub ?? null;
      if (!spki) {
        const d = a.delegations.find((x) => x.delegation.token_sig_key_id === entry.sig_key_id);
        const acct = d && a.keys.find((k) => k.sig_key_id === d.delegation.account_sig_key_id);
        if (!d || !acct) return false;
        const ok = await verifyDelegation(d.delegation, { user_id: entry.author_id, sig_key_id: acct.sig_key_id, ecdsa_pub: acct.ecdsa_pub });
        if (!delegationCovers(ok, receivedAt, d.revoked_at)) return false;
        spki = ok.token_ecdsa_pub;
      }
      await verifyEntry(entry, { author_id: entry.author_id, sig_key_id: entry.sig_key_id, ecdsaPublic: await importKey(spki) });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Opens one row and checks its signature. A row that does not open, or does not verify, is counted, never
   * guessed at and never left out without a word (PETTY-445).
   */
  private async openRow(key: CryptoKey, row: EntryRow): Promise<LedgerEntry | "unreadable" | "unverified"> {
    let entry: SignedEntryV1;
    try {
      entry = await openEntryUnverified(key, this.identityFor(row.drawer_id, row.line_id, row.key_version, row.schema_version, "entry", row.id, row.author_id), sealed(row));
    } catch {
      this.unopened.add(row.id);
      return "unreadable";
    }
    this.heads.set(`${row.drawer_id}:${row.line_id}`, Math.max(this.heads.get(`${row.drawer_id}:${row.line_id}`) ?? 0, row.seq));
    // an entry whose signature does not check out must not move a balance silently
    if (!(await this.signatureOk(entry, row.received_at))) return "unverified";
    // it verified, and not against an account key of its author: a token's own key signed it
    const byToken = !this.authors[entry.author_id]?.keys.some((k) => k.sig_key_id === entry.sig_key_id);
    return { seq: row.seq, received_at: row.received_at, entry, is_checkpoint: row.is_checkpoint, by_token: byToken };
  }

  /** Every drawer this token can open, with its lines and balances. */
  async drawers(): Promise<AgentDrawer[]> {
    const boot = TokenBootstrap.parse(await this.call("GET", "/me/token/bootstrap"));
    this.authors = boot.authors;
    this.unopened = new Set();
    const warnings: AgentWarning[] = [];
    const out: AgentDrawer[] = [];
    for (const d of boot.drawers) {
      const held = this.keys.get(d.id);
      const sealedDoc = boot.documents[d.id];
      if (!held || !sealedDoc) continue; // no key in the bundle, or no document yet: not this token's business
      let doc: DrawerDocument;
      try {
        // the document's author is whoever wrote it last, which in a shared drawer may be another member
        const opened = await openDocument(held.key, this.identityFor(d.id, null, sealedDoc.key_version, sealedDoc.schema_version, "document", d.id, sealedDoc.author_id), sealed(sealedDoc));
        doc = readDocument(opened, { schema_version: sealedDoc.schema_version, version: d.version });
      } catch {
        warnings.push({ code: "drawer_unreadable", drawerId: d.id, drawer: null, lineId: null, item: null, count: 1 });
        continue;
      }
      const entriesByLine = new Map<string, LedgerEntry[]>();
      const unverified = new Map<string, number>();
      const unreadable = new Map<string, number>();
      const firstSeq = new Map<string, number>(); // the lowest seq the server sent per line, opened or not
      const count = (m: Map<string, number>, lineId: string) => m.set(lineId, (m.get(lineId) ?? 0) + 1);
      for (const row of boot.entries.filter((e) => e.drawer_id === d.id)) {
        firstSeq.set(row.line_id, Math.min(firstSeq.get(row.line_id) ?? row.seq, row.seq));
        const opened = await this.openRow(held.key, row);
        if (opened === "unreadable") { count(unreadable, row.line_id); continue; }
        if (opened === "unverified") { count(unverified, row.line_id); continue; }
        const list = entriesByLine.get(row.line_id) ?? [];
        list.push(opened);
        entriesByLine.set(row.line_id, list);
      }
      const lines: AgentLine[] = [];
      for (const l of doc.lines) {
        const entries = entriesByLine.get(l.id) ?? [];
        // PETTY-448: the balance is folded from a real count, or from the item's first entry (rule 6): one that
        // links to nothing and that the server does not call a count either
        const start = entries.reduce<LedgerEntry | null>((a, e) => (a && a.seq < e.seq ? a : e), null);
        if (start && start.entry.op !== "adjust" && (start.entry.prev_hash !== null || start.is_checkpoint)) {
          const back = await this.backToCount(held.key, d.id, l.id, firstSeq.get(l.id) ?? start.seq);
          entries.unshift(...back.entries);
          unverified.set(l.id, (unverified.get(l.id) ?? 0) + back.unverified);
          unreadable.set(l.id, (unreadable.get(l.id) ?? 0) + back.unreadable);
        }
        this.lineEntries.set(`${d.id}:${l.id}`, entries);
        let chain: AgentLine["chain"];
        try {
          chain = (await verifyChain(entries)).status === "ok" ? "ok" : "broken";
          lines.push(this.line(l, entries, unverified.get(l.id) ?? 0, unreadable.get(l.id) ?? 0, chain));
        } catch (e) {
          // one entry under two numbers, or two under one: no balance can be told from that
          if (e instanceof LedgerError) throw new TokenError("Refused", `the server sent a history that cannot be right for an item (${e.code}); open Petty in the browser`);
          throw e;
        }
        const at = { drawerId: d.id, drawer: doc.name, lineId: l.id, item: l.name };
        if (unreadable.get(l.id)) warnings.push({ code: "entries_unreadable", ...at, count: unreadable.get(l.id)! });
        if (unverified.get(l.id)) warnings.push({ code: "entries_unverified", ...at, count: unverified.get(l.id)! });
        if (chain !== "ok") warnings.push({ code: "history_broken", ...at, count: 1 });
      }
      const listed = new Set(doc.lines.map((l) => l.id));
      const stray = [...unreadable].reduce((n, [lineId, c]) => (listed.has(lineId) ? n : n + c), 0);
      if (stray) warnings.push({ code: "entries_unreadable", drawerId: d.id, drawer: doc.name, lineId: null, item: null, count: stray });
      out.push({
        id: d.id,
        name: doc.name,
        place: tagsOf(doc),
        role: d.role,
        lines,
        unreadable: stray,
      });
    }
    this.report(warnings);
    return out;
  }

  private report(warnings: readonly AgentWarning[]): void {
    this.warnings = warnings;
    if (warnings.length) this.onWarnings?.(warnings);
  }

  /**
   * The rows before `before`, back to the item's latest real count (PETTY-448). The server picks "the rows
   * since the latest count" by a plain flag that the sealed entry may contradict, and the row at the start
   * may not open: the balance is then still folded from a count, and `verifyChain` reports the cause.
   */
  private async backToCount(key: CryptoKey, drawerId: string, lineId: string, before: number): Promise<{ entries: LedgerEntry[]; unverified: number; unreadable: number }> {
    const out = { entries: [] as LedgerEntry[], unverified: 0, unreadable: 0 };
    for (let page = 0; before > 1 && page < 20; page++) {
      let got: ReturnType<typeof EntriesPage.parse>;
      // rows that cannot be fetched leave the window as the server sent it, which verifyChain reports
      try { got = EntriesPage.parse(await this.call("GET", `/drawers/${drawerId}/lines/${lineId}/entries?limit=200&before=${before}`)); } catch { break; }
      for (const row of got.entries) { // newest first
        if (row.drawer_id !== drawerId || row.line_id !== lineId || row.seq >= before) continue;
        before = row.seq;
        const opened = await this.openRow(key, row);
        if (opened === "unreadable") out.unreadable += 1;
        else if (opened === "unverified") out.unverified += 1;
        else {
          out.entries.unshift(opened);
          if (opened.entry.op === "adjust") return out;
        }
      }
      if (!got.has_more || !got.entries.length) break;
    }
    return out;
  }

  private line(l: Line, entries: readonly LedgerEntry[], unverified = 0, unreadable = 0, chain: AgentLine["chain"] = "ok"): AgentLine {
    const balance = l.kind === "single" ? 0 : fold(entries).balance;
    const exponent = l.kind === "money" ? l.exponent : 0;
    const currency = l.kind === "money" ? l.currency : null;
    return {
      id: l.id,
      name: l.name,
      kind: l.kind,
      currency,
      exponent,
      unit: l.kind === "countable" ? l.unit : null,
      note: l.kind === "single" ? l.text : null,
      tags: lineTagsOf(l),
      balance,
      amount: l.kind === "single" ? "" : `${formatAmount(balance, exponent, LOCALE)}${currency ? ` ${currency}` : ""}`,
      countedInTotal: l.kind === "single" ? false : l.counted !== false,
      unverified,
      unreadable,
      chain,
    };
  }

  /** Finds one item by words, the way the app's search does. Throws when nothing or too much matches. */
  async find(query: string): Promise<{ drawer: AgentDrawer; line: AgentLine }> {
    const q = foldText(query.trim());
    if (!q) throw new TokenError("NotFound", "say which item");
    const hits: { drawer: AgentDrawer; line: AgentLine }[] = [];
    for (const drawer of await this.drawers()) {
      for (const line of drawer.lines) {
        const hay = foldText(`${drawer.name} ${line.name} ${line.tags.join(" ")}`);
        if (q.split(/\s+/).every((word) => hay.includes(word))) hits.push({ drawer, line });
      }
    }
    if (hits.length === 0) throw new TokenError("NotFound", `nothing matches ${quote(query)}`);
    if (hits.length > 1) throw new TokenError("Ambiguous", `${quote(query)} matches ${hits.map((h) => `${quote(h.drawer.name)} / ${quote(h.line.name)}`).join(", ")}`);
    return hits[0]!;
  }

  /** The recent history of one item, newest first. */
  async history(drawerId: string, lineId: string, limit = 20): Promise<AgentEntry[]> {
    const drawer = (await this.drawers()).find((d) => d.id === drawerId);
    if (!drawer) throw new TokenError("OutOfScope", "this token cannot open that drawer");
    const line = drawer.lines.find((l) => l.id === lineId);
    if (!line) throw new TokenError("NotFound", "no such item");
    const held = this.keys.get(drawerId)!;
    // an item's id is a member's text (PETTY-414): it goes into the address as one path part, whatever it holds
    const rows = (await this.call("GET", `/drawers/${drawerId}/lines/${encodeURIComponent(lineId)}/entries?limit=${limit}`)) as { entries: unknown[] };
    const list = EntryRow.array().parse(rows.entries ?? []);
    const out: AgentEntry[] = [];
    let unreadable = 0;
    for (const row of list) {
      try {
        const entry = await openEntryUnverified(held.key, this.identityFor(drawerId, lineId, row.key_version, row.schema_version, "entry", row.id, row.author_id), sealed(row));
        out.push({
          id: row.id,
          seq: row.seq,
          op: entry.op,
          amount: `${formatAmount(entry.amount, entry.exponent, LOCALE)}${line.currency ? ` ${line.currency}` : ""}`,
          comment: entry.comment,
          at: serverDate(row.received_at),
          mine: row.author_id === this.identity.userId,
          verified: await this.signatureOk(entry, row.received_at),
        });
      } catch {
        // an unreadable row is left out rather than half-reported, and counted (PETTY-445)
        if (!this.unopened.has(row.id)) unreadable += 1;
        this.unopened.add(row.id);
      }
    }
    if (unreadable) this.report([...this.warnings, { code: "entries_unreadable", drawerId, drawer: drawer.name, lineId, item: line.name, count: unreadable }]);
    return out.sort((a, b) => b.seq - a.seq);
  }

  /** Adds to an item. `amount` is a decimal string in the item's own units, for example "10.50". */
  add(drawerId: string, lineId: string, amount: string, comment = ""): Promise<AgentEntry> {
    return this.append(drawerId, lineId, "add", amount, comment);
  }
  /** Takes from an item. */
  withdraw(drawerId: string, lineId: string, amount: string, comment = ""): Promise<AgentEntry> {
    return this.append(drawerId, lineId, "withdraw", amount, comment);
  }
  /** Sets an item to what was actually counted. */
  adjust(drawerId: string, lineId: string, countedAmount: string, comment = ""): Promise<AgentEntry> {
    return this.append(drawerId, lineId, "adjust", countedAmount, comment);
  }

  private async append(drawerId: string, lineId: string, op: Exclude<EntryPayloadV1["op"], "reverse">, amount: string, comment: string): Promise<AgentEntry> {
    const line = await this.writableLine(drawerId, lineId);
    // The sign lives in the amount: a withdrawal is negative, so the fold just adds every entry up.
    const magnitude = Math.abs(parseAmount(amount, line.exponent));
    return this.post(drawerId, line, op, op === "withdraw" ? -magnitude : magnitude, comment, null);
  }

  /** A fresh look at one item this token may write an entry on. */
  private async writableLine(drawerId: string, lineId: string): Promise<AgentLine> {
    if (this.identity.role !== "write" || !this.signing) throw new TokenError("ReadOnly", "this token may only read");
    const drawer = (await this.drawers()).find((d) => d.id === drawerId);
    if (!drawer) throw new TokenError("OutOfScope", "this token cannot open that drawer");
    const line = drawer.lines.find((l) => l.id === lineId);
    if (!line) throw new TokenError("NotFound", "no such item");
    if (line.kind === "single") throw new TokenError("Refused", "this item holds no amount");
    return line;
  }

  /**
   * Undoes one entry (PETTY-339) the way the app's "Reverse" does: a new entry of the opposite amount
   * that names the one it cancels. Nothing is deleted; the log only grows (rule 8). The same rules as
   * the app and the server: a count (adjust) or an undo cannot be undone, an entry only once, and not
   * one a later count already settled.
   */
  async undo(drawerId: string, lineId: string, entryId: string, comment = ""): Promise<AgentEntry & { readonly undone: AgentEntry }> {
    const line = await this.writableLine(drawerId, lineId);
    const entries = this.lineEntries.get(`${drawerId}:${lineId}`) ?? [];
    const target = entries.find((e) => e.entry.id === entryId.trim());
    if (!target) throw new TokenError("Refused", "that entry is not among this item's entries since its latest count; older entries are settled by that count and cannot be undone");
    const r = reverseOf(target, fold(entries));
    if (!r.ok) throw new TokenError("Refused", UNDO_REFUSED[r.code]);
    const fmt = (n: number) => `${formatAmount(n, line.exponent, LOCALE)}${line.currency ? ` ${line.currency}` : ""}`;
    const t = target.entry;
    const undone: AgentEntry = { id: t.id, seq: target.seq, op: t.op, amount: fmt(t.amount), comment: t.comment, at: serverDate(target.received_at), mine: t.author_id === this.identity.userId, verified: true };
    return { ...(await this.post(drawerId, line, "reverse", r.amount, comment, r.reverses)), undone };
  }

  private async post(drawerId: string, line: AgentLine, op: EntryPayloadV1["op"], minor: number, comment: string, reverses: string | null): Promise<AgentEntry> {
    const lineId = line.id;
    const held = this.keys.get(drawerId)!;
    const id = crypto.randomUUID();
    // PETTY-445: the new entry links to the newest entry this client checked on the item, as the web app's do
    const newest = (this.lineEntries.get(`${drawerId}:${lineId}`) ?? []).reduce<LedgerEntry | null>((a, e) => (a && a.seq > e.seq ? a : e), null);
    const payload: EntryPayloadV1 = {
      v: 1,
      id,
      drawer_id: drawerId,
      line_id: lineId,
      op,
      amount: minor,
      exponent: line.exponent,
      comment,
      logged_at: new Date().toISOString(),
      reverses,
      prev_hash: newest ? await hashEntry(newest.entry) : null,
      delta_hint: op === "adjust" ? minor - line.balance : null,
      author_id: this.identity.userId,
      sig_key_id: await this.sigKeyId(),
    };
    if (!this.signing) throw new TokenError("ReadOnly", "this token may only read");
    const signedEntry = await signEntry(payload, this.signing);
    const sealedEntry = await sealEntry(held.key, this.identityFor(drawerId, lineId, held.keyVersion, 1, "entry", id), signedEntry);
    await this.call("POST", `/drawers/${drawerId}/entries`, {
      id,
      line_id: lineId,
      is_checkpoint: op === "adjust",
      reverses_entry_id: reverses,
      ...(op === "adjust" ? { expected_head_seq: this.heads.get(`${drawerId}:${lineId}`) ?? 0 } : {}),
      key_version: held.keyVersion,
      schema_version: 1,
      nonce: toB64(sealedEntry.nonce),
      ciphertext: toB64(sealedEntry.ciphertext),
    });
    const after = op === "adjust" ? minor : line.balance + minor;
    const fmt = (n: number) => `${formatAmount(n, line.exponent, LOCALE)}${line.currency ? ` ${line.currency}` : ""}`;
    return {
      id,
      seq: 0,
      op,
      amount: fmt(minor),
      balanceAfter: fmt(after),
      comment,
      at: payload.logged_at,
      mine: true,
      verified: true, // signed here, just now
    };
  }

  /** Every tag on the items this token can see, with the items that carry it (PETTY-174). */
  async tags(): Promise<AgentTag[]> {
    const map = new Map<string, { label: string; holders: Map<string, { drawer: string; drawerId: string; items: { id: string; name: string }[] }> }>();
    for (const d of await this.drawers()) {
      for (const l of d.lines) {
        for (const tg of l.tags) {
          const k = foldText(tg);
          const t = map.get(k) ?? { label: tg, holders: new Map() };
          const h = t.holders.get(d.id) ?? { drawer: d.name, drawerId: d.id, items: [] };
          h.items.push({ id: l.id, name: l.name });
          t.holders.set(d.id, h);
          map.set(k, t);
        }
      }
    }
    return [...map.values()].map((t) => ({ label: t.label, holders: [...t.holders.values()] })).sort((a, b) => a.label.localeCompare(b.label));
  }

  /** The place tree, built from each drawer's path (PETTY-174). Drawers without a place are left out. */
  async places(): Promise<AgentPlace[]> {
    interface Node { name: string; path: string[]; drawers: string[]; children: Node[] }
    const roots: Node[] = [];
    for (const d of await this.drawers()) {
      let level = roots;
      let node: Node | null = null;
      d.place.forEach((name, i) => {
        let next = level.find((n) => foldText(n.name) === foldText(name));
        if (!next) { next = { name, path: d.place.slice(0, i + 1), drawers: [], children: [] }; level.push(next); }
        node = next;
        level = next.children;
      });
      if (node) (node as Node).drawers.push(d.name);
    }
    return roots;
  }

  /** One drawer by id or by name (words), for tools that name a drawer rather than an item. */
  async findDrawer(target: string): Promise<AgentDrawer> {
    const all = await this.drawers();
    const byId = all.find((d) => d.id === target);
    if (byId) return byId;
    const q = foldText(target.trim());
    const hits = all.filter((d) => foldText(d.name) === q);
    const loose = hits.length ? hits : all.filter((d) => q.split(/\s+/).every((w) => foldText(d.name).includes(w)));
    if (loose.length === 0) throw new TokenError("NotFound", `no drawer matches ${quote(target)}`);
    if (loose.length > 1) throw new TokenError("Ambiguous", `${quote(target)} matches ${loose.map((d) => quote(d.name)).join(", ")}`);
    return loose[0]!;
  }

  /**
   * Changes a drawer's document the way the app does (PETTY-175): read it, apply the operations with
   * the ledger's own rules, seal it with the drawer key, and send it with the version it was read at.
   * If someone changed the drawer meanwhile, read it again and repeat.
   *
   * PETTY-422: a document with a counter inside is saved with the counter it was read with, plus one. A document from
   * before the counter is saved as it was, without one: the web app gives a document its first counter. A tool is
   * updated apart from the instance, and must not write a format that the instance's own web app may not know yet.
   */
  async mutate(drawerId: string, ops: readonly DocumentOp[]): Promise<void> {
    if (this.identity.role !== "write") throw new TokenError("ReadOnly", "this token may only read");
    const held = this.keys.get(drawerId);
    if (!held) throw new TokenError("OutOfScope", "this token cannot open that drawer");
    for (let attempt = 0; attempt < 4; attempt++) {
      const got = (await this.call("GET", `/drawers/${drawerId}`)) as { drawer: { version: number; key_version: number }; document: { key_version: number; schema_version: number; nonce: string; ciphertext: string; author_id: string } };
      const opened = await openDocument(held.key, this.identityFor(drawerId, null, got.document.key_version, got.document.schema_version, "document", drawerId, got.document.author_id), sealed(got.document));
      const read = readDocument(opened, { schema_version: got.document.schema_version, version: got.drawer.version });
      const changed = applyOps(read, ops, { lineHasEntries: () => true });
      const next = read.rev === undefined ? changed : nextRev(changed);
      const out = await sealDocument(held.key, this.identityFor(drawerId, null, got.drawer.key_version, got.document.schema_version, "document", drawerId), next);
      try {
        await this.call("PUT", `/drawers/${drawerId}/document`, {
          base_version: got.drawer.version,
          key_version: got.drawer.key_version,
          schema_version: got.document.schema_version,
          nonce: toB64(out.nonce),
          ciphertext: toB64(out.ciphertext),
          verification: false,
        });
        return;
      } catch (e) {
        if (e instanceof TokenError && e.code === "Conflict") continue;
        throw e;
      }
    }
    throw new TokenError("Conflict", "the drawer kept changing; try again");
  }

  /** Puts a tag on an item. At most five tags per item, spelled like an existing tag when one matches. */
  async tagItem(drawerId: string, lineId: string, tag: string): Promise<readonly string[]> {
    const drawer = await this.findDrawer(drawerId);
    const line = drawer.lines.find((l) => l.id === lineId);
    if (!line) throw new TokenError("NotFound", "no such item");
    if (line.tags.some((t) => foldText(t) === foldText(tag))) return line.tags;
    if (line.tags.length >= MAX_TAGS) throw new TokenError("Refused", `an item holds at most ${MAX_TAGS} tags`);
    const existing = (await this.tags()).find((t) => foldText(t.label) === foldText(tag))?.label;
    const next = normalizeTags([...line.tags, existing ?? tag]);
    await this.mutate(drawer.id, [{ type: "set_line_tags", line_id: lineId, tags: [...next] }]);
    return next;
  }

  async untagItem(drawerId: string, lineId: string, tag: string): Promise<readonly string[]> {
    const drawer = await this.findDrawer(drawerId);
    const line = drawer.lines.find((l) => l.id === lineId);
    if (!line) throw new TokenError("NotFound", "no such item");
    const next = line.tags.filter((t) => foldText(t) !== foldText(tag));
    if (next.length === line.tags.length) return line.tags;
    await this.mutate(drawer.id, [{ type: "set_line_tags", line_id: lineId, tags: [...next] }]);
    return next;
  }

  /** Renames a tag on every item this token can change; a name that exists already merges the two. Returns how many items changed. */
  async renameTag(from: string, to: string): Promise<number> {
    const target = (await this.tags()).find((t) => foldText(t.label) === foldText(to))?.label ?? to.trim();
    return this.rewriteTag(from, () => target);
  }

  /** Removes a tag from every item this token can change. Returns how many items changed. */
  removeTag(tag: string): Promise<number> {
    return this.rewriteTag(tag, () => null);
  }

  private async rewriteTag(from: string, to: () => string | null): Promise<number> {
    const key = foldText(from);
    let changed = 0;
    for (const d of await this.drawers()) {
      const ops = d.lines.flatMap((l) => {
        if (!l.tags.some((t) => foldText(t) === key)) return [];
        const next = normalizeTags(l.tags.flatMap((t) => (foldText(t) !== key ? [t] : to() === null ? [] : [to()!])));
        return [{ type: "set_line_tags" as const, line_id: l.id, tags: [...next] }];
      });
      if (!ops.length) continue;
      await this.mutate(d.id, ops);
      changed += ops.length;
    }
    if (!changed) throw new TokenError("NotFound", `no item carries the tag ${quote(from)}`);
    return changed;
  }

  /**
   * Adds a new item to a drawer (PETTY-336), the way the app's "Add item" does: money in one currency,
   * whose exponent is set now from the currency and stored on the item, never looked up again (rule 5);
   * a countable thing with an optional unit; or a single item with a note. A starting amount becomes
   * the item's first entry, an "add" signed by this token like any other. Only a drawer this token can
   * already open and write: a new drawer is a different matter (its key would be new, PETTY-337).
   */
  async addItem(drawerRef: string, item: { kind: Line["kind"]; name: string; currency?: string; unit?: string; text?: string; start?: string; comment?: string }): Promise<{ drawer: AgentDrawer; line: AgentLine }> {
    if (this.identity.role !== "write" || !this.signing) throw new TokenError("ReadOnly", "this token may only read");
    const drawer = await this.findDrawer(drawerRef);
    if (drawer.role === "read") throw new TokenError("ReadOnly", "you may only read this drawer");
    const name = item.name.trim();
    if (!name) throw new TokenError("Refused", "an item needs a name");
    if (drawer.lines.some((l) => foldText(l.name) === foldText(name))) throw new TokenError("Refused", `the drawer already has an item called ${quote(name)}`);
    const id = crypto.randomUUID();
    const start = item.kind === "single" ? "" : (item.start ?? "").trim();
    let line: Line;
    try {
      if (item.kind === "money") {
        const currency = assertCurrencyCode(item.currency ?? "");
        line = { id, kind: "money", name, currency, exponent: seedExponent(currency) };
      } else if (item.kind === "countable") {
        line = { id, kind: "countable", name, unit: (item.unit ?? "").trim() };
      } else {
        line = { id, kind: "single", name, text: (item.text ?? "").trim() };
      }
      // checked before anything is written, so a bad amount leaves no item behind
      if (start) parseAmount(start, line.kind === "money" ? line.exponent : 0);
    } catch (e) {
      throw new TokenError("Refused", e instanceof LedgerError ? `not a valid item: ${e.code}` : "not a valid item");
    }
    await this.mutate(drawer.id, [{ type: "add_line", line }]);
    if (start && parseAmount(start, line.kind === "money" ? line.exponent : 0) > 0) await this.append(drawer.id, id, "add", start, item.comment ?? "");
    const after = (await this.drawers()).find((d) => d.id === drawer.id);
    const made = after?.lines.find((l) => l.id === id);
    if (!after || !made) throw new TokenError("Conflict", "the item was added but could not be read back; list the drawer again");
    return { drawer: after, line: made };
  }

  /**
   * Changes an item (PETTY-339) the way the app's item options do: its name, a money item's currency
   * code, a countable item's unit, a single item's note, and whether it counts in the drawer's total.
   * The currency code is a label: the item keeps its exponent, so no amount is rescaled (rule 5).
   */
  async editItem(drawerId: string, lineId: string, change: { name?: string; currency?: string; unit?: string; note?: string; counted?: boolean }): Promise<{ drawer: AgentDrawer; line: AgentLine }> {
    if (this.identity.role !== "write") throw new TokenError("ReadOnly", "this token may only read");
    const drawer = (await this.drawers()).find((d) => d.id === drawerId);
    if (!drawer) throw new TokenError("OutOfScope", "this token cannot open that drawer");
    if (drawer.role === "read") throw new TokenError("ReadOnly", "you may only read this drawer");
    const line = drawer.lines.find((l) => l.id === lineId);
    if (!line) throw new TokenError("NotFound", "no such item");
    const only = (kind: Line["kind"], what: string) => { if (line.kind !== kind) throw new TokenError("Refused", `only a ${kind} item has ${what}; this one is ${line.kind}`); };
    const ops: DocumentOp[] = [];
    if (change.name !== undefined) {
      const name = change.name.trim();
      if (!name) throw new TokenError("Refused", "an item needs a name");
      if (drawer.lines.some((l) => l.id !== lineId && foldText(l.name) === foldText(name))) throw new TokenError("Refused", `the drawer already has an item called ${quote(name)}`);
      ops.push({ type: "rename_line", line_id: lineId, name });
    }
    if (change.currency !== undefined) { only("money", "a currency"); ops.push({ type: "set_currency", line_id: lineId, currency: change.currency }); }
    if (change.unit !== undefined) { only("countable", "a unit"); ops.push({ type: "set_unit", line_id: lineId, unit: change.unit.trim() }); }
    if (change.note !== undefined) { only("single", "a note"); ops.push({ type: "set_text", line_id: lineId, text: change.note.trim() }); }
    if (change.counted !== undefined) {
      if (line.kind === "single") throw new TokenError("Refused", "a single item is never in a total");
      ops.push({ type: "set_line_counted", line_id: lineId, counted: change.counted });
    }
    if (!ops.length) throw new TokenError("Refused", "say what to change");
    try {
      await this.mutate(drawerId, ops);
    } catch (e) {
      // the ops are applied before anything is sealed or sent, so a bad value leaves the item as it was
      if (e instanceof LedgerError) throw new TokenError("Refused", `not a valid change: ${e.code}`);
      throw e;
    }
    const after = (await this.drawers()).find((d) => d.id === drawerId);
    const edited = after?.lines.find((l) => l.id === lineId);
    if (!after || !edited) throw new TokenError("Conflict", "the item was changed but could not be read back; list the drawer again");
    return { drawer: after, line: edited };
  }

  /** Moves a drawer to a place path such as ["Kitchen", "shelf"]; an empty path takes it out of every place. */
  async moveDrawer(drawerId: string, path: readonly string[]): Promise<readonly string[]> {
    const drawer = await this.findDrawer(drawerId);
    const next = normalizeTags(path.map((p) => p.trim()).filter(Boolean));
    await this.mutate(drawer.id, [{ type: "set_tags", tags: [...next] }]);
    return next;
  }

  private sigKeyIdCache: string | null = null;
  private async sigKeyId(): Promise<string> {
    if (this.sigKeyIdCache) return this.sigKeyIdCache;
    // PETTY-184 (NR-4): the token signs with its own key, named in its bundle. An older bundle has
    // the account key instead; the server refuses its writes, so fall back only to report that well.
    if (this.bundleSigKeyId) return (this.sigKeyIdCache = this.bundleSigKeyId);
    const boot = TokenBootstrap.parse(await this.call("GET", "/me/token/bootstrap"));
    this.sigKeyIdCache = boot.sig_key_id;
    return this.sigKeyIdCache;
  }

  private identityFor(drawerId: string, lineId: string | null, keyVersion: number, schemaVersion: number, type: "entry" | "document", recordId: string, authorId?: string): RecordIdentity {
    return {
      record_type: type,
      record_id: recordId,
      drawer_id: drawerId,
      line_id: lineId,
      author_id: authorId ?? this.identity.userId,
      key_version: keyVersion,
      schema_version: schemaVersion,
    };
  }
}

const sealed = (row: { nonce: string; ciphertext: string }) => ({ nonce: fromB64(row.nonce), ciphertext: fromB64(row.ciphertext) });
