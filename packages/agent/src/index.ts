import {
  delegationCovers,
  fromB64,
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
import { applyOps, assertDocumentShape, fold, formatAmount, foldText, lineTagsOf, MAX_TAGS, normalizeTags, parseAmount, tagsOf, type DocumentOp, type DrawerDocument, type LedgerEntry, type Line } from "@petty/ledger";
import { EntryRow, TokenBootstrap, type AccessTokenSelf, type EntryAuthor } from "@petty/protocol";

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

export interface ConnectOptions {
  readonly token: string;
  /** Where the API lives, for example https://petty.example.com/api */
  readonly apiUrl: string;
  readonly fetch?: typeof fetch;
  /** Tests only: allow a plain-http API address that is not this machine. */
  readonly allowInsecureHttp?: boolean;
}

/** PETTY-191 (NR-11): the token travels in every request, so only https, or http to this machine. */
export function checkApiUrl(apiUrl: string, allowInsecureHttp = false): void {
  let u: URL;
  try { u = new URL(apiUrl); } catch { throw new TokenError("Refused", `not an address: ${apiUrl}`); }
  const local = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(u.hostname);
  if (u.protocol === "https:" || (u.protocol === "http:" && (local || allowInsecureHttp))) return;
  throw new TokenError("Refused", `the Petty address must start with https:// (got ${u.protocol}//${u.host})`);
}

export interface AgentLine {
  readonly id: string;
  readonly name: string;
  readonly kind: Line["kind"];
  readonly currency: string | null;
  readonly exponent: number;
  readonly tags: readonly string[];
  /** Minor units for money, a count for countable things, and 0 for a single item. */
  readonly balance: number;
  /** The balance as a person reads it, for example "1,209.50 EUR". */
  readonly amount: string;
  readonly countedInTotal: boolean;
  /** Entries left out of the balance because their signature did not check out (PETTY-191). */
  readonly unverified: number;
}

export interface AgentDrawer {
  readonly id: string;
  readonly name: string;
  readonly place: readonly string[];
  readonly role: "owner" | "write" | "read";
  readonly lines: readonly AgentLine[];
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
  /** The last seq seen per drawer:line, which an Adjust must state (the server refuses a stale count). */
  private heads = new Map<string, number>();

  constructor(opts: ConnectOptions) {
    checkApiUrl(opts.apiUrl, opts.allowInsecureHttp);
    const split = splitPatToken(opts.token);
    this.tokenId = split.tokenId;
    this.secret = split.secret;
    this.api = opts.apiUrl.replace(/\/$/, "");
    this.bearer = `petty_pat_${split.tokenId}`;
    this.doFetch = opts.fetch ?? fetch;
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
    if (this.bundle.ecdh) {
      const mine = await crypto.subtle.importKey("pkcs8", new Uint8Array(fromB64(this.bundle.ecdh)), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits", "deriveKey"]);
      const owner = self.owner_ecdh_pub;
      if (owner) {
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
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      const why = cause?.code ?? cause?.message ?? (e as Error).message;
      throw new TokenError("Offline", `cannot reach ${this.api}: ${(e as Error).message} (${why})`);
    }
    if (res.status === 401) throw new TokenError("TokenRevoked", "this token is unknown, revoked or expired");
    if (res.status === 403) {
      const body = (await res.json().catch(() => ({}))) as { code?: string };
      if (body.code === "TokenNeedsRenewal") throw new TokenError("Refused", "this token is from before tokens got their own signing key; make a new token in Petty Settings and revoke this one");
      throw new TokenError("Refused", "this token may not do that");
    }
    if (res.status === 404) throw new TokenError("NotFound", "not found");
    if (res.status === 409) {
      const body = (await res.json().catch(() => ({}))) as { code?: string };
      if (body.code === "RecountRequired") throw new TokenError("RecountRequired", "the item changed since it was read; count it again");
      if (body.code === "VersionConflict") throw new TokenError("Conflict", "the drawer changed meanwhile");
      throw new TokenError("Refused", body.code ?? "the server refused this entry");
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

  /** Every drawer this token can open, with its lines and balances. */
  async drawers(): Promise<AgentDrawer[]> {
    const boot = TokenBootstrap.parse(await this.call("GET", "/me/token/bootstrap"));
    this.authors = boot.authors;
    const entriesByLine = new Map<string, LedgerEntry[]>();
    const unverified = new Map<string, number>();
    const out: AgentDrawer[] = [];
    for (const d of boot.drawers) {
      const held = this.keys.get(d.id);
      const sealedDoc = boot.documents[d.id];
      if (!held || !sealedDoc) continue; // no key in the bundle, or no document yet: not this token's business
      let doc: DrawerDocument;
      try {
        // the document's author is whoever wrote it last, which in a shared drawer may be another member
        const opened = await openDocument(held.key, this.identityFor(d.id, null, sealedDoc.key_version, sealedDoc.schema_version, "document", d.id, sealedDoc.author_id), sealed(sealedDoc));
        assertDocumentShape(opened);
        doc = opened;
      } catch {
        continue;
      }
      for (const row of boot.entries.filter((e) => e.drawer_id === d.id)) {
        try {
          const entry = await openEntryUnverified(held.key, this.identityFor(d.id, row.line_id, row.key_version, row.schema_version, "entry", row.id, row.author_id), sealed(row));
          this.heads.set(`${d.id}:${row.line_id}`, Math.max(this.heads.get(`${d.id}:${row.line_id}`) ?? 0, row.seq));
          // an entry whose signature does not check out must not move a balance silently
          if (!(await this.signatureOk(entry, row.received_at))) { unverified.set(row.line_id, (unverified.get(row.line_id) ?? 0) + 1); continue; }
          const list = entriesByLine.get(row.line_id) ?? [];
          list.push({ seq: row.seq, received_at: row.received_at, entry });
          entriesByLine.set(row.line_id, list);
        } catch {
          // an entry this token cannot open is skipped, never guessed at
        }
      }
      out.push({
        id: d.id,
        name: doc.name,
        place: tagsOf(doc),
        role: d.role,
        lines: doc.lines.map((l) => this.line(l, entriesByLine.get(l.id) ?? [], unverified.get(l.id) ?? 0)),
      });
    }
    return out;
  }

  private line(l: Line, entries: readonly LedgerEntry[], unverified = 0): AgentLine {
    const balance = l.kind === "single" ? 0 : fold(entries).balance;
    const exponent = l.kind === "money" ? l.exponent : 0;
    const currency = l.kind === "money" ? l.currency : null;
    return {
      id: l.id,
      name: l.name,
      kind: l.kind,
      currency,
      exponent,
      tags: lineTagsOf(l),
      balance,
      amount: l.kind === "single" ? "" : `${formatAmount(balance, exponent, LOCALE)}${currency ? ` ${currency}` : ""}`,
      countedInTotal: l.kind === "single" ? false : l.counted !== false,
      unverified,
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
    if (hits.length === 0) throw new TokenError("NotFound", `nothing matches ${JSON.stringify(query)}`);
    if (hits.length > 1) throw new TokenError("Ambiguous", `${JSON.stringify(query)} matches ${hits.map((h) => `${JSON.stringify(h.drawer.name)} / ${JSON.stringify(h.line.name)}`).join(", ")}`);
    return hits[0]!;
  }

  /** The recent history of one item, newest first. */
  async history(drawerId: string, lineId: string, limit = 20): Promise<AgentEntry[]> {
    const drawer = (await this.drawers()).find((d) => d.id === drawerId);
    if (!drawer) throw new TokenError("OutOfScope", "this token cannot open that drawer");
    const line = drawer.lines.find((l) => l.id === lineId);
    if (!line) throw new TokenError("NotFound", "no such item");
    const held = this.keys.get(drawerId)!;
    const rows = (await this.call("GET", `/drawers/${drawerId}/lines/${lineId}/entries?limit=${limit}`)) as { entries: unknown[] };
    const list = EntryRow.array().parse(rows.entries ?? []);
    const out: AgentEntry[] = [];
    for (const row of list) {
      try {
        const entry = await openEntryUnverified(held.key, this.identityFor(drawerId, lineId, row.key_version, row.schema_version, "entry", row.id, row.author_id), sealed(row));
        out.push({
          id: row.id,
          seq: row.seq,
          op: entry.op,
          amount: `${formatAmount(entry.amount, entry.exponent, LOCALE)}${line.currency ? ` ${line.currency}` : ""}`,
          comment: entry.comment,
          at: row.received_at,
          mine: row.author_id === this.identity.userId,
          verified: await this.signatureOk(entry, row.received_at),
        });
      } catch {
        // unreadable rows are left out rather than half-reported
      }
    }
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

  private async append(drawerId: string, lineId: string, op: EntryPayloadV1["op"], amount: string, comment: string): Promise<AgentEntry> {
    if (this.identity.role !== "write" || !this.signing) throw new TokenError("ReadOnly", "this token may only read");
    const drawer = (await this.drawers()).find((d) => d.id === drawerId);
    if (!drawer) throw new TokenError("OutOfScope", "this token cannot open that drawer");
    const line = drawer.lines.find((l) => l.id === lineId);
    if (!line) throw new TokenError("NotFound", "no such item");
    if (line.kind === "single") throw new TokenError("Refused", "this item holds no amount");
    // The sign lives in the amount: a withdrawal is negative, so the fold just adds every entry up.
    const magnitude = Math.abs(parseAmount(amount, line.exponent));
    const minor = op === "withdraw" ? -magnitude : magnitude;
    const held = this.keys.get(drawerId)!;
    const id = crypto.randomUUID();
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
      reverses: null,
      prev_hash: null,
      delta_hint: op === "adjust" ? minor - line.balance : null,
      author_id: this.identity.userId,
      sig_key_id: await this.sigKeyId(),
    };
    const signedEntry = await signEntry(payload, this.signing);
    const sealedEntry = await sealEntry(held.key, this.identityFor(drawerId, lineId, held.keyVersion, 1, "entry", id), signedEntry);
    await this.call("POST", `/drawers/${drawerId}/entries`, {
      id,
      line_id: lineId,
      is_checkpoint: op === "adjust",
      reverses_entry_id: null,
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
    if (loose.length === 0) throw new TokenError("NotFound", `no drawer matches "${target}"`);
    if (loose.length > 1) throw new TokenError("Ambiguous", `"${target}" matches ${loose.map((d) => d.name).join(", ")}`);
    return loose[0]!;
  }

  /**
   * Changes a drawer's document the way the app does (PETTY-175): read it, apply the operations with
   * the ledger's own rules, seal it with the drawer key, and send it with the version it was read at.
   * If someone changed the drawer meanwhile, read it again and repeat.
   */
  async mutate(drawerId: string, ops: readonly DocumentOp[]): Promise<void> {
    if (this.identity.role !== "write") throw new TokenError("ReadOnly", "this token may only read");
    const held = this.keys.get(drawerId);
    if (!held) throw new TokenError("OutOfScope", "this token cannot open that drawer");
    for (let attempt = 0; attempt < 4; attempt++) {
      const got = (await this.call("GET", `/drawers/${drawerId}`)) as { drawer: { version: number; key_version: number }; document: { key_version: number; schema_version: number; nonce: string; ciphertext: string; author_id: string } };
      const opened = await openDocument(held.key, this.identityFor(drawerId, null, got.document.key_version, got.document.schema_version, "document", drawerId, got.document.author_id), sealed(got.document));
      assertDocumentShape(opened);
      const next = applyOps(opened, ops, { lineHasEntries: () => true });
      const out = await sealDocument(held.key, this.identityFor(drawerId, null, got.drawer.key_version, 1, "document", drawerId), next);
      try {
        await this.call("PUT", `/drawers/${drawerId}/document`, {
          base_version: got.drawer.version,
          key_version: got.drawer.key_version,
          schema_version: 1,
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
    if (!changed) throw new TokenError("NotFound", `no item carries the tag "${from}"`);
    return changed;
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
