# Petty — App Specification

Petty is a ledger for physical cash kept in different places (a kitchen drawer, a
basement box, etc.), across multiple currencies. It is a ledger, not a budget app:
no categories, no bank sync, no exchange-rate conversion.

This document describes the target architecture for turning the working prototype
(built as a single-file browser artifact) into a real multi-user app.

**Scale assumption**: this is a household-scale app. A handful of users per
drawer, a few drawers per user. Several design decisions below trade theoretical
scalability for simplicity, and are correct *only* under this assumption.

---

## Data model

- **Drawer** — a physical place. Has a name, an optional photo, an ordered list
  of lines, and a log of "confirm state" verifications (timestamp, author,
  comment, snapshot of line balances).
- **Line** — one item inside a drawer, one of three kinds:
  - **Money** — a currency pile. Has a currency code and a running balance.
  - **Countable** — a counted item with no currency (e.g. "56 glass balls"). Has
    an optional unit label and a running count.
  - **Single item** — a one-off thing with no quantity (e.g. a passport). Has
    free text, editable in place.
- **Entry** — one logged operation on a Money or Countable line. Append-only,
  never edited or deleted. Stores: timestamp, **author**, operation type
  (Add / Withdraw / Adjust / Reverse), amount, optional comment, and for a
  Reverse, the id of the entry it cancels.

### Amounts are integers — no decimal point

Amounts are stored as **integers in the currency's minor unit**: 12.34 EUR is
stored as `1234`, and 1000 JPY (which has no minor unit) is stored as `1000`.

This is not for accounting precision — it is because floating-point money is
lossy, and because **once amounts are encrypted, no server-side migration can
ever fix the representation.** This is a one-way door and it is now closed.

**The exponent belongs to the line, not to the currency code.** When a money
line is created, its decimal places are fixed and stored on the line itself —
seeded from ISO 4217 where the code is recognised (EUR = 2, JPY = 0, PLN = 2),
defaulting to 2 otherwise. It never changes afterwards.

This matters because the currency code is editable (below). If the exponent were
looked up from the code each time it were displayed, relabelling a line from EUR
to JPY would silently reinterpret a stored `1000` from 10.00 to 1000 — a
hundredfold error across the entire history. Pinning the exponent to the line
makes the code a pure label, so changing it can never alter what the numbers
mean.

Countable lines store plain integers with no exponent — counts are whole things.
Fractional counts are rejected at input.

### Deletion is permanent

Deleting a drawer or a line deletes it — no trash, no soft delete, no retention
window, no undo. This is a simple app for simple use, and a trash can is a whole
second lifecycle (restore, purge, "where did it go") for a rare event.

Consequences, accepted deliberately:

- The confirmation dialog is the only safety net, so it must state plainly what
  is being destroyed and how much history goes with it.
- The delete control must not sit within easy mis-tap distance of the row's main
  tap target on a phone. The prototype currently places a small ✕ inches from the
  row — that needs revisiting.
- Any member with write access can delete a line. Only the owner can delete a
  drawer.

Entries remain the exception: they are append-only and cannot be deleted
individually, even by the owner. Deleting the *line* removes them with it.

### Correcting a mistake: Reverse

Entries are immutable, so a mistyped entry is corrected by **adding** one, never
by editing. A fourth operation exists for exactly this:

**Reverse** — select a past entry, confirm, and the app appends a new entry with
the opposite amount, carrying the id of the entry it cancels.

Withdrawing 500 when you meant 50 therefore reads:

```
Withdraw   −500 PLN   (reversed)
Reverse    +500 PLN   → cancels the entry above
Withdraw    −50 PLN
```

Rules:

- The reversed entry is shown **struck through and dimmed**; the Reverse entry
  links back to it. Both stay permanently visible.
- An entry can be reversed **once**. Reversing a Reverse, or re-reversing an
  already-cancelled entry, is refused.
- **Adjust entries cannot be reversed.** An Adjust asserts a physically counted
  value; if it was wrong, the honest correction is another count, not a
  cancellation.
- **An entry older than the line's latest Adjust cannot be reversed.** The count
  already absorbed it; reversing it would correct the mistake twice. The UI says
  "already reconciled by a count on <date>".
- "Reversed once" is enforced by the server: the reversed entry's id is a
  plaintext column with a UNIQUE constraint. The server therefore learns which
  entries are reversals (see "What the server still learns").
- A Reverse records its own author and timestamp, which may differ from the
  original entry's — useful when one person fixes another's mistake.

**Why this rather than only Adjust**: without Reverse, the only correction is to
recount and Adjust, which leaves a history reading "withdrew 500, then adjusted
to 340" — indistinguishable from actually having found cash. Reverse separates
"I mistyped" from "the money genuinely moved", which is the difference between a
ledger you trust and one you squint at. It costs one link field and one button,
and it does not weaken the append-only guarantee at all: nothing is edited, an
entry is added that points at another.

### What can be edited after creation

| Field | Editable? |
|---|---|
| Drawer name, drawer photo | Always |
| Line name, unit label | Always |
| Single item text | Always |
| **Line currency code** | **Always** |
| Line decimal places | Never — fixed at creation |
| Line kind (money / countable / single) | Only while the line has no entries |

**Renaming is always allowed.** Changing "USD kitchen" to "USD kitchen top shelf"
makes nothing in the history wrong.

**The currency code is always editable**, because it is a label describing what
is physically in the drawer — and the user is the authority on that. The common
real case is discovering that a line labelled USD has actually held euros all
along; the amounts were always correct, the label was wrong, and forbidding the
fix would only force a pointless new line.

This is safe **only** because the exponent is pinned to the line at creation (see
"Amounts are integers" above). Editing the code changes what is printed next to
the number, never the number's meaning. If it were looked up from the code
instead, this would be a hundredfold-error bug waiting to happen.

**Kind still locks on the first entry.** Money → countable → single are
structurally different: an entry of "56" is meaningless on a passport line, and a
single item has no entries at all. Before the first entry there is no history to
break, so it stays editable — which covers the realistic "picked the wrong type,
noticed immediately" moment. Afterwards, the answer is a new line.

### Currency codes: free text with suggestions

The currency field is a **free-text input with a preselected list**. The list
offers the full ISO 4217 set, searchable, with recently used and locale-likely
codes at the top — but the user can type anything.

- A recognised ISO code seeds the line's decimal places from its official
  exponent and formats via `Intl.NumberFormat` with the active locale.
- An unrecognised code (BTC, chips, an old currency, a made-up token) is accepted
  as a plain label, gets **2 decimal places** by default, and falls back to
  simple locale-aware number formatting plus the code as typed.

Refusing unknown codes would mean telling someone they cannot record what is
actually in their drawer, which is the wrong answer for a personal ledger. The
fallback costs almost nothing: print the number, print the code.

### Negative balances: warn, allow, flag

A negative balance is always an error — you cannot physically remove cash that
is not there. But it is an error about the *records*, not about the user, and the
app treats it that way.

- **Warn before committing.** If a Withdraw would take the line below zero, the
  confirm step says so plainly: "This takes the balance to −60 PLN. There may be
  more cash here than recorded, or the amount may be wrong." The user can go back
  or continue.
- **Allow it.** Continuing records the entry as given.
- **Flag it after.** The line shows its negative balance in the danger colour,
  and the drawer surfaces it too, until an Adjust brings it back to a counted
  value. It cannot be quietly forgotten.

**Why not block it.** Blocking optimises for the database looking tidy over the
user recording what actually happened. Someone standing at a drawer who has just
taken 400 PLN out of a line the app thinks holds 340 has learned something true:
the ledger drifted. Refusing the entry until they recount forces a chore at the
worst moment and risks them simply not logging it — which is strictly worse than
a visible negative number.

The negative balance is therefore treated as a **signal to reconcile**, in the
same family as "changed since verify", rather than as an invalid state to
prevent.

The same rule applies to countable lines.

### Verification staleness: any change makes it stale

A drawer shows "changed since verify" if **anything about it changed** after the
last verification — any entry logged, any line added, removed, renamed or
reordered, any single item's text edited, the photo added, replaced or removed,
the drawer renamed.

The rule is deliberately blunt: one server-stamped `last_write_at` on the
drawer row, bumped by every document write and every entry insert, compared
against the server time of the latest verification (which the verification
stores, along with each line's head `seq`, so the UI can say which line moved).
Client clocks are never used for this. No per-action carve-outs deciding which changes "really" count —
that is where the prototype became inconsistent (reordering marked a drawer
stale while replacing its photo did not).

The message means "something moved since you last counted this", which is
exactly the prompt to go and look.

### Verification covers single items too

The "confirm state" snapshot records **every line in the drawer**, not just the
money and countable ones.

- Money and countable lines record their balance at that moment, as before.
- Single items record **present / not present**, as a tick.

Every tick **defaults to present**, so a normal confirmation is still one tap:
open the sheet, everything is already ticked, confirm. Only when something is
actually missing does the user untick it — and that is exactly the case worth
having a dated record of.

The snapshot therefore answers "was the passport in the drawer on 3 March", which
for documents is arguably the most valuable thing this app produces. A
verification where an item was ticked absent should be visibly flagged in the
verification history, not blended in with the clean ones.

### Balances are derived, never stored as truth

The prototype stored a `resulting balance` on every entry. That is unsafe under
concurrent writes: two Adds from 100 both store 150. **Entries store no balance
at all.** The only balance is the fold of the entry log:

- Start from the most recent **Adjust** entry (an absolute checkpoint).
- Apply every Add, Withdraw and Reverse after it, ordered by the server-assigned
  per-line `seq`.
- An Adjust carries a display-only `delta_hint` (the difference the author saw),
  because the pre-Adjust balance is not loaded. It is never folded.

A Reverse is applied like any other signed amount — it cancels its target
arithmetically rather than removing it, so the fold stays a simple sum and the
cancelled entry remains in the history.

**Adjust entries are checkpoints, and that is what keeps this cheap.** Because
the fold only needs entries *since* the last Adjust, the client never has to
read a line's entire history to know its balance — however old the drawer is.

### History loading

Entry history is **paginated for display, but always fetched back to the last
Adjust** for correctness.

- On opening a line, fetch every entry since its most recent Adjust. That is the
  minimum needed to compute the balance, and for a drawer that gets counted
  occasionally it is dozens of entries, not thousands.
- Display the most recent ~50; load older pages on scroll.
- If a line has never been adjusted, fall back to fetching from its first entry —
  correct, and still small for a young line.

This matters more here than in a typical app because the server cannot help:
every entry is ciphertext, so filtering, counting and summing all happen on the
client after decryption. Fetching a bounded slice is the difference between
opening a five-year-old drawer instantly and waiting while a phone decrypts
thousands of rows.

A useful side effect: it gives the app a real reason to encourage periodic
Adjusts, since each one both keeps the ledger honest and shortens every future
fold.

Because the server only sees ciphertext, it cannot validate arithmetic — so the
client always recomputes. Tampering signals are the hash chain, the AAD, and a
log shorter than the last head the client pinned (see "Integrity").

---

## Storage shape: one encrypted document per drawer, plus an append-only entry log

This is the central architectural decision, and it resolves several problems at
once.

**The drawer document.** Everything mutable about a drawer — its name, photo,
lines (names, currencies, units, order), and verification log — is serialized to
a single JSON document, encrypted as one blob, and stored in one row.

- The **photo is its own encrypted row** (`drawer_photos`, one per drawer),
  sealed under the same drawer key with the same AAD scheme and rotated on the
  same path. No object storage, no unencrypted bucket, no signed URLs. Keeping it
  out of the document means a rename or reorder does not re-upload ~400 KB, and
  the home screen loads photos only on demand. The document carries a
  `has_photo` flag.
- Photos are **downscaled and re-compressed client-side before encoding** (max
  ~1000px on the long edge, JPEG quality ~0.75, target well under 300 KB) and
  **EXIF is stripped** — phone photos carry GPS coordinates pointing at the
  user's home. Re-encoding through a canvas, as the prototype already does,
  drops EXIF as a side effect; this must stay deliberate rather than incidental.
- Line ordering is just array order in the document. Drag-to-reorder rewrites the
  document. No fractional indexing needed.
- Every entry row also carries plaintext `line_id`, `seq` (server-assigned per
  line), `is_checkpoint` (it is an Adjust), `reverses_entry_id`, `author_id` and
  `received_at`. The server needs these to fetch "since the last Adjust", to
  reject a concurrent Adjust, and to bootstrap the home screen.

**The entry log.** Entries are *not* in the document. Each entry is its own row,
individually encrypted, insert-only.

- Concurrent entries never conflict — two people logging operations at the same
  time insert two independent rows.
- The append-only guarantee is enforced by the backend refusing updates and
  deletes, not merely by convention.

**Why split them this way**: entries are the part that must be append-only, must
support concurrent writes, and grows without bound. Everything else is small,
changes rarely, and is far simpler to treat as one document. A pure per-row
schema would pay full complexity for query capability that encryption denies
anyway.

### Concurrency

**Drawer document**: optimistic locking. Each document row carries a plaintext
integer `version`. A write sends the version it was based on; the backend rejects
the write if the stored version has moved on. The client then re-reads, re-applies
the change, and retries. For rename/reorder/photo edits at household frequency,
conflicts will be rare and a retry is invisible.

**Entries**: no locking needed. Inserts are independent and the balance is folded
from the log, so ordering resolves naturally by server timestamp.

**Concurrent Adjust is the one real conflict.** Add and Withdraw commute — two
people can each log one and both are correct. Two Adjusts do not: each asserts an
absolute counted value, so the second silently invalidates the first person's
physical count. Rule: the client sends the line's `expected_head_seq` with every Adjust; the
server inserts only if the line's current head `seq` equals it, else returns
`409 RecountRequired` and the user is told to re-count. Adjust vs. concurrent
Add: whichever lands first wins — Add first means the Adjust is rejected; Adjust
first means the Add counts on top of the new checkpoint.

**Required test scenarios** (these must exist in the test suite, not be left to
manual testing):

- Two clients Add to the same line simultaneously — both entries survive, the
  folded balance is the sum.
- Two clients Adjust the same line simultaneously — the second is rejected with a
  re-count prompt.
- One client Adjusts while another Adds — defined, deterministic outcome.
- Two clients reorder lines in the same drawer — one wins, the other retries
  cleanly, neither corrupts the document.
- A client edits the drawer document based on a stale version — rejected and
  retried, no lost update.
- An offline client reconnects with queued entries that interleave with entries
  written by another user while it was away.

---

## Tech stack

- **Frontend**: **Vite + React + React Router**, deployed as a static SPA
  (Vercel, Netlify, or any static host).

  Next.js was the earlier choice and has been dropped. With end-to-end
  encryption, the server can never render user content — it only ever holds
  ciphertext — so Server Components, Server Actions, and `next/image` are all
  inert. Every meaningful component would be `"use client"` anyway. Petty is a
  private app behind a login, so there is no SEO argument either. Vite also has a
  materially better PWA/offline story (`vite-plugin-pwa`), which matters given
  the offline requirements below.

- **Backend**: a thin API service. **All writes go through it** — clients never
  write to the database directly (see "Why a backend" below).
- **Database**: Postgres, plain. Supabase is one possible host; nothing
  Supabase-specific is used. Provider portability is an explicit requirement
  (see below).
- **Auth**: owned by the backend — email + password (Argon2id server-side),
  httpOnly session cookie. Signup is **invite-only** via join links. Supabase
  Auth was dropped: it was the one lock-in, and the local environment must run
  with no cloud account.
- **i18n**: dictionary files per language, English and Polish at launch. Since
  Next.js is gone, use `react-i18next` or `lingui` rather than `next-intl`.

### Why a backend, and not direct-to-database

The earlier design had clients talking to Supabase directly, with row-level
security enforcing permissions. That had a hole: **a read-only member holds the
same decryption key as a write member**, so nothing cryptographic stopped them
from writing ciphertext straight to Postgres. Read-only was a UI convention, not
a guarantee.

With all writes behind an API:

- Read vs write access is enforced server-side, where it cannot be bypassed.
- Append-only is enforced by the API refusing UPDATE and DELETE on entries.
- Optimistic-locking version checks happen in one trusted place.
- Multi-table operations (create membership + store wrapped key together) are a
  real transaction.
- Swapping database providers becomes a change in one service rather than in
  every client.

Crucially, **the backend still cannot read anything**. It receives ciphertext,
checks "is this user allowed to write to this drawer", and stores it. It
validates permissions and structure, never content. The encryption guarantee is
unchanged; only the enforcement point moves.

### Database portability

Because all database access is behind the API, the provider is swappable. To keep
it that way:

- Use **plain Postgres features only**. No Supabase-specific extensions in
  application tables.
- Schema lives in **version-controlled migration files** run by a standard tool
  (e.g. `node-pg-migrate`, Prisma Migrate, or Atlas) — not clicked into a
  dashboard.
- Access Postgres through a standard driver/ORM, not the Supabase client SDK, in
  the backend.
- Auth lives in the backend, so there is no identity-provider lock-in.

Realistic assessment: with these rules, moving to Neon, Railway, RDS, or
self-hosted Postgres is a weekend of work, mostly re-pointing a connection string
and migrating auth. Without them, it is a rewrite.

### Hosting and cost

The Supabase free tier **pauses a project after ~7 days of inactivity** and has
**no automated backups**. A ledger opened monthly would be paused almost every
time it is reached for. Budget for the paid tier (~$25/mo) or self-host — the
free tier is not viable for this access pattern.

---

## Backup strategy

There are three distinct things to protect, and they fail differently.

**1. Server-side database backups.** Automated daily backups with point-in-time
recovery, retained ~30 days. This protects against provider failure and operator
error. It does **not** protect against key loss — the backups are ciphertext, and
without keys they are noise.

**2. User-controlled encrypted export.** A user can export their data as a single
self-describing archive containing the drawer documents (photos included) and
entry logs, plus format and schema version. It is **encrypted with a key derived
from a user-chosen export password**, independent of their vault passphrase, so
the archive is portable and openable even if the account is gone.

This is the only backup the user genuinely controls, and it is the answer to
"what if the service disappears". Plaintext export is offered too, but behind an
explicit warning, since it defeats the entire encryption design in one tap.

**3. Automatic cloud backup (Google Drive / iCloud).** Offered as an opt-in
convenience: the app periodically writes the *encrypted* archive from (2) to the
user's own cloud storage. Because the file is already encrypted client-side,
neither Google nor Apple can read it. This is a good fit — it puts a recoverable
copy somewhere the user already trusts and already backs up, without weakening
anything.

Note the honest limitation: an encrypted backup plus a forgotten passphrase is
still unrecoverable. Backups protect against losing *data*; only the recovery
code (below) protects against losing *access*.

---

## Security

### Threat model

**What Petty defends against:**

- **A passive database reader.** Anyone reading raw Postgres rows or a database
  backup — provider staff, a leaked dump, a subpoena served on the host — sees
  only ciphertext for all drawer content, including photos.
- **An active database writer.** Anyone who can modify rows cannot forge,
  reorder, transplant, or silently delete ledger entries without detection (see
  "Integrity" below).
- **A curious or compromised backend.** The API enforces permissions but holds no
  keys, so a compromised backend cannot read drawer content.
- **A lost or stolen device.** Content at rest on the device is encrypted; the
  vault stays locked without the passphrase, and auto-locks on idle.
- **A removed collaborator, going forward.** After revocation and key rotation,
  they cannot read *future* changes.

**What Petty explicitly does NOT defend against, and users should be told:**

- **A malicious frontend build.** Whoever can deploy the static site can serve
  JavaScript that steals the vault passphrase. This is the fundamental limit of
  browser-delivered E2EE — Bitwarden and Signal ship native apps partly for this
  reason. Mitigations are partial: strict CSP, zero third-party scripts, no
  analytics, subresource integrity, pinned and audited dependencies. The residual
  risk is real and should be stated plainly in the privacy policy rather than
  papered over.
- **A malicious collaborator.** Anyone you share a drawer with can read and copy
  everything in it. Revocation stops future access, never past access.
- **XSS in the app itself.** Injected script running in the page can reach keys
  in memory. Countered by strict CSP, no `dangerouslySetInnerHTML`, Trusted
  Types, and non-extractable `CryptoKey` objects wherever possible — but not
  eliminated.
- **Metadata.** See "What the server still learns" below.
- **A forgotten passphrase with no recovery code.** By design, nobody can help.

### Envelope encryption

1. **Drawer data key** — each drawer has its own random AES-256-GCM key. It
   encrypts the drawer document and every entry in that drawer.

2. **Per-user keypairs** — two, generated client-side: **ECDH P-256** for
   wrapping drawer keys (static-static ECDH → HKDF → AES-KW) and **ECDSA P-256**
   for signing entries, since ECDH keys cannot sign. Both public keys are
   published and both feed the safety number. Private keys never leave the
   device unencrypted.

3. **Private key custody** — both private keys are wrapped with AES-256-GCM
   (AES-KW cannot wrap PKCS#8 EC keys in browsers) under a key derived from a
   **vault passphrase**, distinct from the login password, using **Argon2id**
   (m = 64 MiB, t = 3, p = 1) with a per-user random salt and versioned
   parameters stored alongside the blob. The wrap's AAD includes both public
   keys, so a server cannot swap the published key without the vault failing to
   open. Only that encrypted blob reaches the server. On login from any
   device: fetch blob, prompt passphrase, derive locally, unwrap in memory.

   The server holds a blob it cannot open, so a database breach yields unlimited
   *offline* guessing against passphrases — hence Argon2id with real memory cost,
   plus a strength floor enforced at signup. The vault passphrase **must not
   equal the login password**; this is checked and rejected, not merely
   discouraged, because reusing it would hand Supabase Auth the string that
   opens the vault.

4. **Unlocking** — the drawer key is wrapped for each member's public key. The
   session unwraps the drawer keys for drawers the user can access, in memory.

### Key verification — closing the substitution hole

The original design had a fatal gap: the inviter wraps the drawer key with a
public key **fetched from the server**. A malicious server substitutes its own
key, receives a wrapped drawer key it can open, and re-wraps to the real invitee
so neither party notices. Every rotation and transfer gave it another attempt.

**Mitigation, sized for a household app:**

- Every user has a **safety number** — a short, readable fingerprint of their
  public key (six groups of five digits, Signal-style).
- Before an invitation completes, the inviter is shown the invitee's safety
  number and asked to confirm it matches out-of-band — in person, by phone,
  over any channel that isn't this app. For a family sharing a drawer, this is a
  30-second step, not a burden.
- Keys are **pinned on first use**. If a contact's public key ever changes, every
  drawer shared with them shows a prominent warning and refuses further wraps
  until the new safety number is re-confirmed.
- The user can re-check any member's safety number at any time from the drawer's
  member list.

This does not make substitution impossible — it makes it *detectable*, which is
the achievable goal for browser-delivered E2EE.

### Integrity — preventing silent tampering

AES-GCM authenticates a blob in isolation, not its position in the database. Two
additions close that gap:

- **Additional authenticated data (AAD).** Every ciphertext binds its own
  identity: `AAD = record_type || record_id || drawer_id || line_id ||
  author_id || key_version || schema_version`. A ciphertext moved to a different
  row, line, drawer, author or key generation then fails to decrypt. This costs nothing and eliminates the whole
  cut-and-paste class — but it is **not retrofittable** once ciphertext exists,
  so it must be in the first implementation.
- **Hash-linked entries.** Each entry carries `prev_hash`: the hash of the
  newest entry its author had seen on that line. Two people writing at once
  produce a fork, so the log is a tree, not a chain; the verifier checks that
  every `prev_hash` resolves to a fetched entry (or the last-Adjust boundary)
  with a lower `seq`. A chain cannot detect deletion of the newest entries, so
  the client also pins the last head it saw `(line_id, seq, hash)` and warns
  when the server returns a shorter log.
- **Author signatures.** Each entry is signed (ECDSA) over its plaintext by its
  author's signing key and names `author_id` + `sig_key_id`. The client verifies
  it against the key it has pinned for that author. Public keys are never
  deleted, so old entries verify after revocation or account deletion.

### Authorship

Every entry, verification, and drawer-document revision records its author. In
the UI this is deliberately quiet: a **small avatar/initial icon on the row,
with the author's name on hover or tap** — present when you need to ask "who took
this", invisible the rest of the time.

### Key rotation

Rotation happens when a member is removed or leaves. With the document model this
is far cheaper than it was: **one document plus N entry rows**, rather than
per-row re-encryption of everything including separately-stored photos.

- Every encrypted row carries a plaintext `key_version`.
- Rotation is **resumable and idempotent**: it records progress, and a client
  that dies partway can resume. Clients that encounter a row under a key version
  they lack fetch the new wrap rather than failing.
- Old wrapped keys are retained so in-flight readers do not break mid-rotation.
- The backend holds no keys, so a member's client does the re-encryption. Order:
  (1) the client makes the new key and wraps it for every remaining member; the
  backend publishes `key_version + 1`; (2) every new write uses it immediately;
  (3) the client re-encrypts old rows in resumable batches. No write freeze. The
  server reports progress from the plaintext `key_version` column.

**Honest framing for the UI**: rotation protects *future* content only. A removed
member may have already copied what they could see. "Remove access" must not
imply retroactive erasure.

### What the server still learns (accepted metadata leakage)

Even with perfect encryption, the operator can see: emails and display names,
how many drawers each user has, how many lines each drawer holds, the full
sharing graph (who shares what with whom, at which role), per-line write counts,
who wrote each entry and when, which entries are counts (Adjust) and which are
reversals, and the exact timestamp of every operation — a precise pattern of
when cash moves. Ciphertext length is padded to fixed buckets (256 B for
entries) so amounts cannot be inferred from size; a comment longer than a bucket
grows the row in 256 B steps.

This is accepted, and belongs in the privacy policy rather than being quietly
omitted.

### Session lock: once a day

The vault stays unlocked for **24 hours** after a successful passphrase entry.
Within that window the app opens straight into the drawer list — no prompt on
reopening, no prompt when switching back from another app, no idle timeout.
After 24 hours, the next open asks for the passphrase again.

This is a household ledger, not an enterprise system. Prompting more often would
mean typing a long passphrase while standing at a drawer, which is the fastest
way to make people stop using the app — and the realistic threat here is a lost
phone, not a colleague at a shared desk.

Details:

- The unlocked private key is held in memory, and cached in IndexedDB as a
  **non-extractable `CryptoKey`** so its raw bytes are unreachable from
  JavaScript, alongside an expiry timestamp. Reopening the app within the window
  restores the session from that cache; past it, the cache is cleared.
- Plaintext drawer content is **never** written to disk — only the key handle is
  cached, so the 24-hour window survives a page reload without leaving readable
  data behind.
- A manual **"Lock now"** is always available for the moment you hand someone
  your phone.
- Signing out clears the cache immediately, regardless of the window.
- Biometric unlock is deliberately **not** required for launch: with a once-a-day
  prompt the friction is already low enough. It stays a possible later
  convenience, not a dependency.

Accepted tradeoff, stated plainly: someone who picks up your unlocked phone
within the 24-hour window can read your drawers. That is the same exposure as
your photos or your email app, and appropriate for this threat model.

### Recovery

A **recovery code is mandatory at signup**, not optional: a high-entropy random
code that wraps a second copy of the private key. The user is required to record
it before finishing onboarding.

Additionally, and pleasantly: for a *shared* drawer, other members hold valid
wraps of the drawer key, so a member who loses their passphrase can be re-granted
access by another member re-wrapping to their new keypair. Only a sole-owner
unshared drawer with a lost passphrase and lost recovery code is truly
unrecoverable.

Note for the UI: **resetting the login password does not restore vault access.**
Users will assume it does. Say so at reset time.

---

## Sharing model

Sharing is per-drawer, and every drawer has exactly one **owner** at a time.

- **Roles**: **read** or **write**. Write can log operations, add/edit/delete
  lines, and confirm drawer state. Read can only view. Only the owner can delete
  the drawer, change sharing, or transfer ownership. These are enforced by the
  backend, not by the client.

### What read access includes

**Read means read everything.** A read member sees the drawer exactly as a write
member does — balances, line names, the photo, the full entry history with
amounts, comments and authors, the verification log, and the member list. The
only thing they cannot do besides writing is **export**.

The reasoning: a read member holds the drawer's decryption key, because that is
what lets them see anything at all. Hiding the entry history from them in the UI
would be theatre — the data is already decryptable on their device. Better to be
honest about what sharing actually grants than to imply a distinction the crypto
does not support.

Export is withheld because it is a *deliberate bulk copy*, and it is reasonable
for the owner to control who can walk away with a full archive. But this must be
understood correctly:

> Withholding export is a **speed bump with a clear signal attached, not a
> security control.** A read member can screenshot every screen or copy figures
> by hand. Blocking export raises the effort and makes the owner's intent
> explicit; it does not create a real barrier, and the spec does not pretend
> otherwise.

The genuine security boundary is the invitation itself. Anyone given access to a
drawer can read and retain its contents, and revocation stops future access, not
past copies. The sharing UI should say this plainly at the moment of inviting.

### Invitations are two-phase

A user must **already exist in Petty, with a published public key**, before they
can be added to a drawer. There is no way to wrap a drawer key for someone who
has no key — so "invite a stranger by email" is not a single step:

**Phase 1 — join the app.** If the person is not a Petty user, the owner sends
them a join link. They sign up, create their vault passphrase, record their
recovery code, and their public key is published. This phase involves no drawer
and no keys belonging to anyone else.

**Phase 2 — add to a drawer.** Now that they exist and have a key, the owner
invites them to a specific drawer with a role. The owner confirms their safety
number (see Key verification). The invitee accepts or declines.

The owner's client wraps the drawer key for the invitee **at invite time** —
the owner is online, holds the invitee's pinned key and has just confirmed the
safety number — and the wrap is stored on the invitation. On acceptance the
backend turns the invitation into a membership with no cryptography. There is
no "waiting for owner" state. A declined invitee holds a wrap it cannot use,
because the server refuses it the drawer.

- **Ownership transfer**: offered to an existing write member, accepted by them
  before it takes effect. The old owner keeps the role until acceptance is
  recorded, so a drawer is never ownerless. Afterwards the outgoing owner becomes
  a write collaborator unless they also leave.
- **Leaving / removing**: the owner can revoke anyone; a non-owner can leave.
  Either triggers key rotation.
- **Notification**: invitations, transfers, and revocations are delivered
  **in-app** (a pending-invitations area, visible on launch) **and by email**,
  since a user who is not currently in the app has no other way to learn of them.

### Account deletion

Deleting an account **blocks until every shared drawer the user owns has been
dealt with**. The delete-account screen lists those drawers, each with two
choices:

- **Give it to** a named member (offered from that drawer's existing members), or
- **Delete it** for everyone, with the usual permanent-deletion warning.

Drawers the user owns that are **not** shared with anyone are simply deleted with
the account — nobody else is affected, so there is nothing to ask about. Drawers
the user is only a *member* of are unaffected; they just lose their membership.

The reasoning: silently destroying a ledger someone else actively relies on is
the worst outcome, and silently promoting an unwitting person to owner is nearly
as bad. Forcing an explicit choice costs one extra screen on an action taken
roughly once in a lifetime.

Ownership handed over this way does **not** require the recipient to accept —
unlike a normal transfer. The outgoing owner is leaving permanently, so waiting
for an acceptance that may never come would leave the drawer ownerless. The
recipient is notified that they now own it.

**GDPR erasure**, honestly stated: deleting the account destroys the user's
private keys, sessions, email, display name and sole-owner drawers. Entries the
user wrote in *shared* drawers are encrypted with the drawer key that the other
members still hold, so they stay readable — they are the other members' ledger.
What remains of the user there is an opaque `author_id`. Their public keys are
kept so those entries still verify. Deletion also rotates every shared drawer
the user was a member of.

---

## Offline behavior

The core scenario is standing at a drawer, in a basement, on a phone, possibly
with no signal. Offline support is therefore required — but deliberately scoped.

**What works offline:**

- The app is an installable **PWA** with a service worker caching the app shell.
- Data for drawers already loaded in the session stays available and readable.
- **Vault unlock works offline**, which makes caching the encrypted private-key
  blob and wrapped drawer keys in IndexedDB **mandatory**, not optional. Without
  it the app is a brick precisely where it is needed.
- New entries can be logged offline. They queue in an encrypted local outbox.

**What happens on reconnect:**

- Queued entries are sent. Because entries are append-only with client-assigned
  UUIDs, replay is idempotent and interleaving with others' entries is safe.
- The client re-folds balances from the merged log and **reports any difference**
  it finds — if the balance changed while you were offline, you are told, rather
  than having your local view silently overwritten.
- A queued **Adjust** whose line changed while offline is rejected with a
  re-count prompt, consistent with the online rule.

**Deliberate scope limits:**

- Offline is designed for **short windows** — minutes to hours, the length of a
  visit to the basement — not for days of disconnected use.
- Only drawer-document edits and entry appends are queued. Document edits are
  queued as **operations** (rename line X, move X to index 3, append
  verification), not as document snapshots, so they can be re-applied on top of
  a newer version after a conflict. Sharing changes, key rotation, and ownership
  transfers require connectivity.
- Never cache decrypted plaintext to disk. Plaintext lives in memory only.
- **Known hazard**: iOS Safari evicts IndexedDB after ~7 days of non-use for
  PWAs that are not installed to the home screen, wiping cached keys *and* any
  pending outbox. The app should encourage installation and warn if an outbox
  has been pending unusually long.

---

## Totals and search

Both must run entirely on the client, since the server holds only ciphertext and
can neither sum nor match anything.

### Cross-drawer totals — in scope

The home screen shows **totals by currency across every drawer**: "2 340 PLN ·
615 EUR · 200 USD" above the drawer list.

Balances are not in the documents; they come from entries. The home screen
therefore uses one bootstrap call that returns every document plus, for every
line, the entries since its last Adjust. At household scale that is small.
Currency codes are trimmed and upper-cased before grouping. And "how much cash do I
actually have" is a headline question for an app whose entire premise is cash
kept in several places.

Rules:

- Totals group strictly by **currency code as written**. No conversion between
  currencies, ever — consistent with the app's non-goals.
- Countable lines are excluded; 56 glass balls do not belong in a money total.
- A drawer that fails to decrypt is **excluded and the total is marked
  incomplete**, rather than silently under-reporting. A wrong total is worse than
  an obviously partial one.

### Search — deferred

Full-text search across drawers is **not in the initial build**. Unlike totals,
it needs the complete entry logs of every drawer decrypted and held in memory —
exactly the load the history-pagination decision exists to avoid.

If it is added later, scope it in this order:

1. **Within one open drawer** — its entries are already loaded, so this is cheap
   and covers most real cases ("where's that entry about the birthday gift").
2. Across drawers, only if genuinely missed, and with an explicit "this loads
   everything" cost the user opts into.

## Places, icons and line tags

Added after the first build (PETTY-52 → 69). None of it changes the wire format:
everything below is a field inside an already-encrypted document.

### Places: one tree, each drawer in one node

A **place** is a path of names — `Clubhouse › Pool area › Locker 12`. A drawer
stores its node's path in its document (`tags: string[]`, in order), so every
member sees the same place and the server sees nothing. Names are unique among
siblings after `foldText` (case and accents ignored), so the path is the node's
identity and two places cannot overlap.

The **tree** itself is per person, in the encrypted user document (`places`),
next to the pins and the total exclusions. On read it is merged with every path
found on a drawer, so a place typed by another member shows up where its path
says, and nothing ever disappears. The Places screen (Settings › Manage places,
or the tree icon in the home chip bar) edits it: add at the top or inside a
node, rename, move (drag with the drawer's line gesture: up/down reorders,
right nests under the row above, left takes a level out; or Move to… and
Move up/down for the keyboard), delete (children move up one level).

A rename or move rewrites the path on every drawer under the node that I can
write, one encrypted write each; readers map paths through the rewrites in
flight so the old branch never reappears meanwhile. A read-only shared drawer
keeps its old path and the merge shows it there — the count says so. Depth is
capped at 5 levels (`MAX_TAGS`).

The home screen groups drawers by room (the first segment) in the tree's order;
deeper drawers sit under a sub-place label, indented; the chips drill down one
level at a time; the total narrows to the selection. A per-person switch hides
places for a plain list.

### Icons

A drawer and a line may carry an icon **slug** (`icon`, `^[a-z0-9-]{1,40}$`)
from a fixed Lucide set of 32; an unknown slug (a newer build wrote it) falls
back to the default. Colour is never per icon: the accent on a tinted tile.

### Line tags and "part of the total"

A line may carry **tags** (`tags`, normalised like drawer tags, at most 5) —
free labels such as *cash* or *valuables* that filter the drawer's list — and a
`counted: false` flag for things that are not cash (gold coins, a laptop).
These live in the document, so they are the same for every member: whether an
item is cash is a fact about the item, not a view — unlike the per-person
drawer exclusion above. An excluded line stays out of every total: the drawer
shows *Total (included)* next to *Drawer total*, and the home screen counts
only included lines.

**The tag list is per person** (PETTY-152), the way places are. The tags on an
item stay in the drawer document, shared by every member. The list of tags I
pick from is mine: saved in the encrypted user document (`line_tags`) and
merged on read with every tag found on a drawer I can read, so a tag another
member put on a shared item shows up and nothing disappears. A tag can exist
before any item carries it. The line's tag picker offers the whole list;
Manage tags (in Settings, in Drawer options and at the end of the drawer's tag
bar) makes a tag, picks its items across my writable drawers, renames it
(onto an existing name: the two merge) or removes it. A rename or removal
rewrites the tag on every drawer I can write, one encrypted write each; a
read-only shared drawer keeps the old tag, and the manager says how many did.

## Accessibility

The target is **keyboard operability and correct labelling**, built into each
component as it is written rather than added in a later pass. That is roughly
the WCAG 2.1 AA items that actually matter for an app of this shape; full
formal AA certification is not claimed.

The reasoning is the same as for i18n: doing it while writing the components is
nearly free, and retrofitting means touching every screen. What is *not*
committed to is the heavier end — formal audits, professional screen-reader
testing, a certified conformance claim — which a household-scale project cannot
honestly sustain.

**Required:**

- **Real semantic elements.** Anything clickable is a `<button>` or `<a>`, never
  a `div` with an `onclick`. This gives keyboard focus, Enter/Space activation
  and correct screen-reader roles for free. The prototype currently uses
  clickable `div`s throughout.
- **Every icon-only control has an accessible name.** The bare ✕ delete, the ⇅
  export, the ⠿ drag handle and the chevron all need `aria-label`s that say what
  they do and to what — "Delete line USD kitchen", not "Delete".
- **Modals behave like modals.** Focus moves into the sheet on open, is trapped
  while it is open, returns to the triggering control on close; Escape closes;
  `aria-modal` and a labelled title are set.
- **Visible focus indicators**, never removed for aesthetics.
- **A non-drag way to reorder lines.** This one is non-negotiable: drag-only
  reordering excludes anyone with a motor impairment completely, and it is
  awkward on a small phone regardless. Each line gets "Move up" / "Move down"
  actions in a menu, operable by keyboard and by tap.
- **Form fields have real `<label>`s**, associated properly, not placeholder text
  standing in for a label.
- **Status changes are announced.** Toasts and errors go through an ARIA live
  region, otherwise a screen-reader user gets no feedback that anything happened.
- **Respect `prefers-reduced-motion`** for the accordion and drag animations.

**Explicitly deferred**: a formal contrast audit across both themes, structured
screen-reader test passes on multiple platforms, and any published conformance
statement. Worth revisiting if the app gets real users beyond the household case.

## Internationalization (i18n)

Multi-language support is built in from the start. No user-facing string is ever
hardcoded in a component — retrofitting i18n means touching every screen.

- **Launch languages**: **English (`en`)** and **Polish (`pl`)**. English is the
  fallback when a key is missing.
- **Dictionary files**: per-language files keyed by semantic identifiers
  (`drawer.confirmState.title`, not the English text). Adding a language is one
  file, no code changes.
- **Library**: `react-i18next` or `lingui` (not `next-intl` — Next.js was
  dropped). A CI check diffs the dictionaries so a key missing from `pl.json`
  fails the build rather than silently falling back.
- **Locale detection**: from `Accept-Language` on first visit, user-overridable,
  stored on the profile so it follows across devices.
- **Plural rules**: Polish has 1 / 2–4 / 5+ forms, and the UI is full of counts
  ("3 lines", "5 entries"). Use ICU MessageFormat plurals. Never concatenate a
  number with a noun. This applies to relative time too — "3 days ago" must come
  from `Intl.RelativeTimeFormat` with proper plurals, not string joining.
- **Number and date formatting**: `Intl.NumberFormat` / `Intl.DateTimeFormat`
  with the active locale. Polish uses a comma decimal separator and a space
  thousands separator (`1 234,56`), so **input parsing must accept a comma** —
  the keypad's decimal key must be locale-aware, not hardcoded to `.`.

### Scope: what gets translated

Only the fixed UI text shipped with the app: buttons ("Add", "Withdraw",
"Adjust", "Confirm state", "Add photo", "Save", "Cancel", "Delete"), field labels
("Name", "Currency", "Unit", "Starting balance", "Comment"), headings
("History", "Confirm drawer state"), status and empty states ("Not yet
verified", "Changed since verify", "No drawers yet"), and all confirmation,
warning, and error copy.

**Not translated**: anything the user typed. A drawer named "Kuchnia" stays
"Kuchnia" in every language. Currency codes stay as ISO codes.

This keeps i18n a build-time concern with no runtime translation, and it does not
interact with the encryption design at all.

---

## Decisions log

Every open question raised by the specification review has been settled. Recorded
here so the reasoning is not re-litigated during implementation.

| Question | Decision |
|---|---|
| Key verification | Safety numbers, confirmed out-of-band, pinned on first use |
| Ledger integrity | AAD binding (incl. line and author), hash-linked entries as a tree + pinned head, ECDSA author signatures |
| Photo storage | Own encrypted row under the drawer key; downscaled, EXIF stripped |
| Invitations | Two-phase — join the app first, then be added; drawer key wrapped at invite time |
| Concurrency | Optimistic locking on the document; entries append freely |
| Offline | Short windows, PWA, encrypted outbox, reports differences on reconnect |
| Key rotation | Resumable, versioned, backend-executed |
| Authorship | Recorded on everything; shown as a small hover/tap icon |
| Threat model | Written, including what is explicitly *not* defended against |
| Write enforcement | All writes via backend API; never client-to-database |
| Money representation | Integers in minor units; exponent pinned to the line |
| Places | An ordered path of names on the drawer (`tags`); the tree per person in the user document, merged with drawer paths on read; renames/moves rewrite the writable drawers |
| Icons | A slug from a fixed Lucide set on drawers and lines; unknown slugs fall back |
| Line tags / not cash | In the document (shared): `tags` for filtering, `counted: false` keeps a line out of every total; the tag list is per person in the user document (`line_tags`), merged with drawer tags on read |
| Identity provider | Clerk for the public deployment (sign up, sign in, sessions, reset, invitations); the vault, passkey unlock and custody proofs stay Petty's; `AUTH_PROVIDER=local` keeps the self-hosted login — see `docs/auth-clerk.md` |
| Session lock | 24 hours, no idle timeout, manual "Lock now" |
| Deletion | Permanent, no trash, no undo |
| Verification staleness | Any change of any kind marks it stale |
| Single items in verification | Included, as ticks defaulting to present |
| Account deletion | Forces a per-drawer choice: hand over or delete |
| Editing after creation | Names and currency code always; kind locks on first entry |
| Correcting mistakes | Reverse operation, linked to the entry it cancels |
| Read access | Sees everything except export |
| Negative balances | Warn, allow, flag until reconciled |
| Currency codes | Free text with ISO suggestions and formatting fallback |
| History loading | Paginated, always fetched back to the last Adjust |
| Accessibility | Keyboard and labelling built in; formal audits deferred |
| Totals and search | Totals in scope; search deferred |
| Auth | Backend-owned email + password; invite-only signup |
| Concurrent Adjust | Conditional insert on `expected_head_seq`; first write wins |
| Reverse limits | Not past the latest Adjust; reverse-once enforced by a plaintext UNIQUE |
| Stored balances | None; fold only |
| Staleness clock | Server `last_write_at` vs. verification server time |
| Signing key | Separate ECDSA P-256 keypair; both keys in the safety number |
| Private-key wrap | AES-256-GCM with public keys in the AAD |

**The spec is ready to hand to an implementer.** The reasoning behind the rows
added after the spec review lives in `SPEC-ISSUES.md`; the build order in
`BUILD-PLAN.md`.

---

- **Passkey unlock (Phase 14, 2026-08-29).** A third wrapped copy of the private
  keys ("passkey vault") under a key derived (HKDF) from the WebAuthn PRF output
  of one passkey. One passkey per account; setting up on another device replaces
  it. The server stores credential id, PRF salt and ciphertext, never verifies
  assertions, and requires the login password to add or remove. The passphrase
  and recovery vaults remain mandatory; the passkey is convenience only, offered
  only when the browser reports PRF support (Firefox does not).
- **Passkey first (PETTY-102, 2026-09-16).** Supersedes "one passkey per
  account" above. A vault is created with a passkey on the device as its first
  door (a passphrase on request, or added later as a backup); the recovery code
  stays mandatory. `passkey_vaults` holds one row per credential — id, label,
  transports, PRF salt, wrapped keys — so each device has its own passkey and
  `Me.passkeys` lists them; `Me.vault` (the passphrase copy) may be null and
  `Me.pub` carries the public keys. `POST /me/passkeys` and
  `DELETE /me/passkeys/:id` take the custody proof (and the login password in
  local mode); the last passkey cannot go while there is no passphrase
  (`LastDoor`). A new device unlocks through the phone's passkey (the
  browser's QR / hybrid transport), the passphrase or the recovery code, and is
  then offered a passkey of its own while the keys are still open. Reason: the
  passphrase was the friction of a new account, a second unrecoverable secret;
  a plaintext storage mode was rejected because it breaks the product's one
  promise. The WebAuthn PRF extension is a W3C standard shipped in Chrome,
  Safari and Firefox and used the same way by Bitwarden and 1Password.
- **Proof of the vault key for destructive custody calls (security review
  SR-2, 2026-09-08).** Replacing the vault blobs (`PUT /me/vault`) and deleting
  the account (`POST /me/delete`) require, besides the login password, a
  server-issued challenge signed with the account's ECDSA key. Reason: the login
  password can be reset from an email link, so a stolen mailbox could otherwise
  destroy a user's keys and sole-owner drawers; the vault key cannot be reset by
  anyone. Every legitimate caller of those endpoints already holds the unlocked
  keys (passphrase change, recovery-code flow, account deletion all run
  unlocked). Replaced vault blobs are kept for 30 days in `vault_history`, and an
  admin can put them back; the owner is emailed on a password reset and on a
  vault replacement.

## Non-goals

- No budget categories, no bank sync, no automatic exchange-rate conversion.
- No server-side plaintext access to drawer content, by design — support and
  debugging tooling must work from error taxonomies and IDs, never content.
- Not built for scale beyond household use; several decisions above would need
  revisiting for large multi-tenant deployment.
