# Petty — Spec Review Findings

Three independent reviews of `petty-app-spec.md`: security/cryptography, product
& data model, and engineering feasibility. Each reviewer was asked to find gaps,
not to praise. This document consolidates their findings.

**Overall verdict**: the spec is a good product document and a thin architecture
document. Two findings make the headline security claim **untrue as written**,
and several others are decisions that get vastly more expensive after data
exists. None of this is fatal — but a meaningful amount must be settled before
implementation starts.

---

## Blockers — resolve before writing application code

### 1. Server-substituted public keys defeat the entire encryption scheme
The inviter wraps a drawer's data key with a public key **the server hands
them**. A malicious Supabase, or anyone with DB write access, substitutes their
own key, receives a wrapped data key they can open, and re-wraps to the real
invitee so nothing looks wrong to either party. There is no fingerprint check,
no key-change warning, no trust-on-first-use pinning.

This is the single most important finding: the spec claims safety against "anyone
with raw database access", and this is exactly that adversary. Every re-wrap
(rotation, ownership transfer, revocation) gives the attacker another attempt —
so revocation *triggers* the attack.

**Fix**: key fingerprints compared out-of-band (Signal safety-number style),
TOFU pinning, loud warnings on key change. Or soften the claim to "encrypted at
rest against passive database access", which is a materially weaker product.

### 2. Nothing authenticates the ledger — the server can silently tamper with it
AES-GCM authenticates each ciphertext *in isolation*, not its position in the
database. Anyone with write access to Postgres — **no key needed** — can delete
entries, reorder them, roll a drawer back to a previous state, or copy a
ciphertext from one line into another. It all decrypts perfectly.

For a ledger about money, where "append-only, never edited or deleted" is a core
promise, silent truncation is arguably worse than disclosure.

**Fix**: bind every ciphertext to its identity with AES-GCM additional
authenticated data (`AAD = table || row_id || drawer_id || key_version`). Costs
nothing, closes the entire cut-and-paste class — but is **not retrofittable**
once ciphertext exists. Consider per-entry signatures for authorship too.

### 3. Photos and drawer names are outside the encryption scope
The security section lists "line names, balances, entries, comments, notes" —
photos go to Supabase Storage with no mention of encryption, and drawer names
are absent too. A photo of the inside of a cash drawer is plausibly the most
sensitive artifact in the app, and phone photos carry GPS EXIF data pointing at
the user's home. "Basement safe" as a drawer name is not non-sensitive either.

Encrypting photos also breaks CDN caching, image transforms, and direct URLs —
that cost needs acknowledging.

### 4. The invitation flow is logically impossible as written
The spec says both "no key is shared until they accept" **and** "the access row
and wrapped key are created together, atomically". These cannot both be true:
wrapping requires the plaintext data key, which only an existing member's
*browser* holds. When the invitee accepts, the owner may be asleep.

Also: a user who has never signed up has no public key, so "invite someone new by
email" is unbuildable as described. Pick one — pre-wrap at invite time, or accept
an honest "waiting for owner" pending state.

### 5. Concurrent writes silently corrupt balances
Each entry stores its resulting balance, computed client-side. Two people log
+50 from a balance of 100 at the same time; both write 150; one operation's money
vanishes. Normally the database would catch this — but it only sees ciphertext,
so no constraint, trigger, or generated column can help.

**Fix**: never treat the stored balance as authoritative. Derive it by folding
the entry log client-side, with Adjust entries as absolute checkpoints. This
also makes offline sync correct almost for free.

### 6. "Adjust" has no concurrent-write semantics
Adjust sets an absolute counted value, not a delta. Add and Withdraw commute and
can be merged; **two concurrent Adjusts cannot** — one person's physical count
silently erases the other's. The spec never addresses this. Probable answer:
reject the second Adjust and force a re-count.

### 7. Offline support is absent, and it is the core use case
"Standing at a drawer in a basement" is a no-signal scenario. The spec has zero
words on PWA, service workers, offline caching, or write queuing. This also makes
IndexedDB caching of the encrypted key blob **mandatory**, not "optional" as the
spec currently says — otherwise the app is a brick exactly where it's meant to be
used.

Landmine: iOS Safari evicts IndexedDB after ~7 days of non-use for non-installed
PWAs, silently wiping cached keys *and* any pending write queue.

### 8. Key rotation has no failure model and no cost ceiling
"Re-encrypt all drawer content" is written as though it were one step. There is
no `key_version` column, no resumability, no progress UI, no drawer freeze. A
rotation that dies partway — phone sleeps, tab closes — leaves mixed-generation
ciphertext with no recovery procedure. The work is unbounded: a years-old drawer
means tens of thousands of rows re-encrypted on the owner's phone, plus every
photo, which the spec forgets entirely.

### 9. Entries have no author
The data model stores timestamp, type, amount, comment, balance — **no actor**.
Fine for a single-user prototype; in a shared drawer, "who took the money" is the
single most important question and the model cannot answer it. Same for
verifications and every line/drawer mutation.

### 10. No threat model section exists
The only named adversary is "someone with raw database access". The spec never
states what it does *not* defend against, and the omissions are the important
ones: compromised hosting or CI, malicious npm dependency, XSS, compromised
endpoint, malicious collaborator.

Related and unacknowledged: **Vercel serves the JavaScript that handles the vault
passphrase.** Anyone who can push a build can serve a version that exfiltrates
it. Bitwarden and Signal — cited as precedent in the spec — ship native apps
precisely for this reason. Mitigations for a web app are partial at best.

### 11. Read/write roles are not cryptographically enforced, and RLS is never designed
A read-only member holds the *same* symmetric data key as a write member, so
nothing cryptographic stops them writing ciphertext straight to Postgres. Every
guarantee in the sharing model depends entirely on RLS policies the spec does not
contain. Note also: a `drawer_members` policy referencing `drawer_members`
recurses infinitely — this needs `SECURITY DEFINER` helper functions.

### 12. The free tier does not work for this usage pattern
**Supabase free projects pause after ~7 days of inactivity.** A cash ledger opened
monthly means the project is paused nearly every time you reach for it. Free tier
also has **no automated backups** — for a household ledger with no key recovery,
that's a real data-loss posture. Budget ~$25/mo for Pro, or self-host.

---

## Important — decisions that get expensive later

- **Money is stored as a float with hardcoded 2 decimals.** JPY (zero decimals)
  renders as `1000.00 JPY`. Because amounts are encrypted, a later server-side
  migration is *impossible*. Decide integer-minor-units or decimal strings now.
- **Verification staleness is undefined in the data model.** The prototype's rule
  is also inconsistent: reordering lines (which changes nothing physical) marks a
  drawer stale, while changing a photo or editing a passport's text does not.
- **Confirm-state snapshots exclude single items entirely** — so "I checked this
  drawer" never records whether the passport was actually there.
- **Account deletion and drawer lifecycle are unspecified.** What happens when
  someone who owns shared drawers deletes their account? GDPR erasure conflicts
  with "entries are never deleted" — the answer is crypto-shredding, but it needs
  stating.
- **Hard delete only, no trash, no undo** — in an app otherwise obsessive about
  audit trails. A write collaborator can destroy years of history with two taps.
- **Line ordering has no data model.** Multi-user drag-to-reorder needs fractional
  indexing (keep `position` plaintext — it leaks nothing and lets Postgres sort).
- **No invitation delivery mechanism.** The spec never says how an invited user
  learns they were invited. Email? In-app? Nothing?
- **Vault passphrase has no onboarding or unlock UX.** Typing a long passphrase
  while standing in a basement to log a 20 PLN withdrawal is a product-killing
  amount of friction. Needs biometric/WebAuthn unlock and a session policy.
- **KDF is unspecified** ("Argon2id or PBKDF2", no parameters). The server holds
  the encrypted key blob, so a breach means unlimited *offline* guessing. Pin
  Argon2id with concrete costs.
- **Recovery should be mandatory, not an open question.** A printed recovery code
  at onboarding. Also worth writing down: for *shared* drawers, other members can
  re-wrap to a forgetful user's new keypair — that solves most of the problem
  the spec agonizes over.
- **Renaming is undefined**, and the prototype can't do it at all for money lines.
  Changing a line's currency after entries exist retroactively falsifies history.
- **Export/Import is a real feature mentioned only as two button labels.** Is the
  export plaintext? If so it's the trivial bypass of the whole design.
- **Ciphertext length leaks amounts** — `50` vs `1250000` are distinguishable.
  Fix is fixed-size padding; trivial, but must be a requirement.
- **Metadata inventory missing**: even with perfect crypto, the server learns the
  full social graph, drawer/line counts, and exact timestamps of every cash
  movement.
- **Accessibility is not mentioned once.** Reordering is drag-only with no
  keyboard alternative; modals have no focus trap; delete buttons are bare "✕"
  with no accessible name.
- **Session lock/timeout absent.** No idle auto-lock, no "Lock now".

---

## Architecture callouts

**Is Supabase right?** Qualified yes — but not for the reasons implied. What
survives encryption: Auth, RLS (access control is metadata, not content),
Realtime, and Storage as a dumb blob store. What's lost: SQL filtering on
content, full-text search, database functions, CHECK constraints on amounts,
server-side aggregation. Postgres is being used as a wrapped-blob store with a
good permission system. That's legitimate — the permission system is the hard
part — but the spec should stop implying it gets Postgres's data features.

**Is Next.js right?** Probably not. With E2EE, Server Components render chrome
and nothing else. Dead on arrival: RSC data fetching, Server Actions, route
handlers, `next/image`. Every meaningful component is `"use client"`. A **Vite +
React SPA would ship faster** and has a much better PWA story — which matters a
lot given the offline gap. Next.js's remaining argument is the statically
rendered localized shell via `next-intl`.

**Migration path from the prototype**: it's a rewrite, and that's fine. Nothing
structural survives (`innerHTML` rebuilds, one localStorage blob, direct DOM
drag manipulation). What *does* survive and is valuable: the CSS and visual
design, the domain logic (keypad→confirm flow, Adjust semantics, staleness
badges), `readImageResized`, and a `importLegacyLocalStorage()` for existing
data. Treat the prototype as spec-by-example, not as code.

**Missing operationally**: no CI/CD, no migrations story, no backups, no error
states (especially a "Degraded — some drawers undecryptable" state, which *will*
happen), no observability plan. On that last point: assume every string is a
secret, so session replay is effectively forbidden; make crypto failures a typed
taxonomy (`WrongPassphrase` / `AuthTagMismatch` / `UnknownSchemaVersion`) and log
the class plus IDs, never content.

**Testing**: the single most valuable asset is a **checked-in ciphertext
compatibility corpus** — fixtures from format v1 that every future build must
still decrypt, in CI. Nobody writes this until after they've broken production.
Write it first. RLS tests are the security-critical ones and fail silently when
wrong.

---

## Prototype bug found and fixed

`openAddDrawer` created drawers without a `verifications` array, while
`renderDrawerBlock` immediately read `d.verifications.length`. Adding your
**first drawer** threw a TypeError after the DOM had already been cleared,
leaving a blank screen until reload. It self-healed on refresh, which is why it
went unnoticed. Fixed in `petty.html` by running new drawers through
`migrateDrawer()` so defaults are applied in one place.

The deeper lesson: the spec's data model states no required fields, defaults, or
invariants — exactly the class of problem that becomes a NOT NULL / migration
crisis once data is encrypted and the server can't inspect or repair it.

---

## Suggested order of work

1. **Write the threat model.** Everything else follows from it, including how
   hard to work on items 1 and 10.
2. **Settle the crypto format**: AAD binding, `key_version`, `schema_version`,
   padding, pinned algorithms and KDF parameters. None of this is retrofittable.
3. **Solve key verification** (item 1) or soften the security claim.
4. **Decide the money representation** (integer minor units). One-way door.
5. **Design the schema and RLS policies**, including the invitation state machine.
6. **Decide offline/PWA**, since it changes the client architecture.
7. Then build.
