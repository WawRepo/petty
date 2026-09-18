import {
  fromB64,
  openDocument,
  openEntryUnverified,
  openPatBundle,
  sealEntry,
  signEntry,
  splitPatToken,
  toB64,
  unwrapDrawerKey,
  type EntryPayloadV1,
  type Bytes,
  type PatBundleV1,
  type RecordIdentity,
} from "@petty/crypto";
import { assertDocumentShape, fold, formatAmount, foldText, lineTagsOf, parseAmount, tagsOf, type DrawerDocument, type LedgerEntry, type Line } from "@petty/ledger";
import { Bootstrap, type AccessTokenSelf } from "@petty/protocol";

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
  constructor(readonly code: "WrongToken" | "TokenRevoked" | "ReadOnly" | "OutOfScope" | "NotFound" | "Ambiguous" | "Offline" | "RecountRequired" | "Refused", message: string) {
    super(message);
    this.name = "TokenError";
  }
}

export interface ConnectOptions {
  readonly token: string;
  /** Where the API lives, for example https://petty.example.com/api */
  readonly apiUrl: string;
  readonly fetch?: typeof fetch;
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
  readonly amount: string;
  readonly comment: string;
  readonly at: string;
  readonly mine: boolean;
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
  private keys = new Map<string, { key: CryptoKey; keyVersion: number }>();
  private signing: CryptoKey | null = null;
  /** The last seq seen per drawer:line, which an Adjust must state (the server refuses a stale count). */
  private heads = new Map<string, number>();

  constructor(opts: ConnectOptions) {
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
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
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
    if (res.status === 403) throw new TokenError("Refused", "this token may not do that");
    if (res.status === 404) throw new TokenError("NotFound", "not found");
    if (res.status === 409) {
      const body = (await res.json().catch(() => ({}))) as { code?: string };
      if (body.code === "RecountRequired") throw new TokenError("RecountRequired", "the item changed since it was read; count it again");
      throw new TokenError("Refused", body.code ?? "the server refused this entry");
    }
    if (!res.ok) throw new TokenError("Refused", `the server answered ${res.status}`);
    return res.status === 204 ? undefined : await res.json();
  }

  /** Every drawer this token can open, with its lines and balances. */
  async drawers(): Promise<AgentDrawer[]> {
    const boot = Bootstrap.parse(await this.call("GET", "/bootstrap"));
    const entriesByLine = new Map<string, LedgerEntry[]>();
    const out: AgentDrawer[] = [];
    for (const d of boot.drawers) {
      const held = this.keys.get(d.id);
      const sealedDoc = boot.documents[d.id];
      if (!held || !sealedDoc) continue; // no key in the bundle, or no document yet: not this token's business
      let doc: DrawerDocument;
      try {
        const opened = await openDocument(held.key, this.identityFor(d.id, null, sealedDoc.key_version, sealedDoc.schema_version, "document", d.id), sealed(sealedDoc));
        assertDocumentShape(opened);
        doc = opened;
      } catch {
        continue;
      }
      for (const row of boot.entries.filter((e) => e.drawer_id === d.id)) {
        try {
          const entry = await openEntryUnverified(held.key, this.identityFor(d.id, row.line_id, row.key_version, row.schema_version, "entry", row.id, row.author_id), sealed(row));
          const list = entriesByLine.get(row.line_id) ?? [];
          list.push({ seq: row.seq, received_at: row.received_at, entry });
          entriesByLine.set(row.line_id, list);
          this.heads.set(`${d.id}:${row.line_id}`, Math.max(this.heads.get(`${d.id}:${row.line_id}`) ?? 0, row.seq));
        } catch {
          // an entry this token cannot open is skipped, never guessed at
        }
      }
      out.push({
        id: d.id,
        name: doc.name,
        place: tagsOf(doc),
        role: d.role,
        lines: doc.lines.map((l) => this.line(l, entriesByLine.get(l.id) ?? [])),
      });
    }
    return out;
  }

  private line(l: Line, entries: readonly LedgerEntry[]): AgentLine {
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
    if (hits.length === 0) throw new TokenError("NotFound", `nothing matches "${query}"`);
    if (hits.length > 1) throw new TokenError("Ambiguous", `"${query}" matches ${hits.map((h) => `${h.drawer.name} / ${h.line.name}`).join(", ")}`);
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
    const list = Bootstrap.shape.entries.parse(rows.entries ?? []);
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
    return {
      id,
      seq: 0,
      op,
      amount: `${formatAmount(after, line.exponent, LOCALE)}${line.currency ? ` ${line.currency}` : ""}`,
      comment,
      at: payload.logged_at,
      mine: true,
    };
  }

  private sigKeyIdCache: string | null = null;
  private async sigKeyId(): Promise<string> {
    if (this.sigKeyIdCache) return this.sigKeyIdCache;
    const boot = Bootstrap.parse(await this.call("GET", "/bootstrap"));
    this.sigKeyIdCache = boot.me.keys.sig_key_id;
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
