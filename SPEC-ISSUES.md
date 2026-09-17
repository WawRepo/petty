# Petty — spec problems found before build

Sources read: `petty-app-spec.md`, `petty.html`, `petty-spec-review.md`, `CLAUDE.md`,
`petty-build-prompts.md`.

Six items needed a decision. They are marked **Decided** below, with the reason. The build
plan follows them. Everything else I will implement as "Resolution" says unless you object.

---

## A. Contradictions — both statements cannot be true

### A1. "UPDATE and DELETE revoked on entries" vs. key rotation and line deletion
- Spec / CLAUDE.md rule 8: the entries table rejects UPDATE and DELETE at the database level.
- Spec, Key rotation: rotation re-encrypts "N entry rows" — that is an UPDATE.
- Spec, Deletion: "Deleting the line removes [its entries] with it" — that is a DELETE. Drawer
  deletion and account deletion also delete entries.
- **Resolution**: two database roles. `petty_api` (used for every request) has SELECT and INSERT
  only on `entries`. `petty_maint` may UPDATE only the columns `ciphertext, nonce, key_version`
  (a trigger refuses any other column change and refuses `key_version` going down) and may
  DELETE only inside `SECURITY DEFINER` functions `delete_line(drawer_id, line_id)` and
  `delete_drawer(drawer_id)`. The API connects as `petty_maint` only inside those two
  operations. "Append-only" then means exactly: content never changes; rows leave only with
  their line.

### A2. Linear hash chain vs. lock-free concurrent appends
- Spec: "each entry includes the hash of the previous entry in its line", and "two clients Add
  simultaneously — both entries survive".
- Both clients see the same previous entry and write the same `prev_hash`. The chain forks. A
  verifier that demands one chain reports every concurrent write as tampering.
- Also: a chain alone cannot detect deletion of the *newest* entries (tail truncation). The
  spec says deletion is "detectable"; that is only true for entries something later points at.
- **Resolution**: `prev_hash` = hash of the newest entry the author had seen on that line. The
  log is a DAG. The server assigns a per-line `seq`. Verifier rules: every `prev_hash` must
  resolve to a fetched entry or to the last-Adjust boundary; the referenced entry must have a
  lower `seq`. The client keeps the last seen head `(line_id, seq, hash)` in IndexedDB (a hash
  of a payload that contains a random UUID — not plaintext) and warns if the server later
  returns a shorter log. This is the truncation detector the chain cannot provide.

### A3. ECDH keys cannot sign
- Spec: one ECDH P-256 keypair per user, and "each entry is signed by its author's private key".
  WebCrypto ECDH keys cannot produce signatures.
- **Resolution**: a second keypair, ECDSA P-256, generated at signup, wrapped by the same
  passphrase-derived key and by the recovery code. The safety number is the fingerprint of
  *both* public keys. Consequences the spec misses:
  - Public keys must never be deleted — old entries must still verify after revocation, after
    account deletion, and after a user makes a new keypair following passphrase loss. Every
    entry stores `sig_key_id`; a `user_keys` history table keeps every public key ever
    published.
  - The signature must cover the plaintext (identity fields + content), not the ciphertext, so
    key rotation does not break it. The server cannot verify it; the client verifies it against
    the pinned key for the plaintext `author_id` the server stamped from the session.

### A4. Reverse vs. Adjust checkpoints
- Spec: the fold starts at the last Adjust; a Reverse adds the opposite amount "like any
  signed amount".
- If the reversed entry is *older* than the last Adjust, the count already absorbed the
  mistake and the Reverse corrects it twice. Example: balance 100 → Withdraw 500 (typo) → −400
  → Adjust to 50 (counted) → Reverse the 500 → fold says 550, drawer holds 50.
- Also "an entry can be reversed once" cannot be enforced by a server that sees only
  ciphertext; two people can reverse the same entry at the same moment and both land.
- **Resolution**: Reverse is refused for any entry older than the line's latest Adjust (UI:
  "already reconciled by a count on <date>"). Plaintext column `reverses_entry_id` with a
  UNIQUE constraint enforces reverse-once. Leak: the server learns which entries are reversals.
  **Decided**: plaintext UNIQUE. Reason: it is the only way to make "reverse once" true; the
  leak is one boolean per entry and is listed in the privacy text.

### A5. "Stored balance mismatch = possible tampering"
- Spec's own example: two concurrent Adds from 100 both store balance 150. The rule
  "recomputed ≠ stored → tampering signal" fires on every benign concurrent write.
- **Resolution**: entries store no balance at all. The fold is the only balance. Tampering
  signals are A2 (chain) and AAD. CLAUDE.md rule 6 should read "no stored balances".

### A6. "Home-screen totals are nearly free — balances are already in the document"
- False. Balances are folded from entry rows; entries are not in the document. The home screen
  needs, for every line of every drawer, all entries since the last Adjust.
- Still fine at household scale, but it changes the API: one bootstrap call returning every
  document plus every line's entries since its last Adjust. That requires the server to know
  where each line's last Adjust is → B1.

### A7. "Rotation is performed by the backend, so it does not depend on the owner's tab"
- The backend holds no keys. Only a member's client can re-encrypt. The client does the long
  job; the backend can only apply each batch atomically.
- **Resolution**: (1) owner's client creates the new drawer key, wraps it for every remaining
  member, and the backend publishes `key_version + 1`; (2) every new write uses the new version
  immediately; (3) the client re-encrypts old rows in resumable batches of ~200, sending
  `(entry_id, key_version, nonce, ciphertext)`; the backend accepts a batch only if each row's
  current version is lower. No write freeze. Progress = count of rows still at the old version,
  which the server can report because `key_version` is plaintext.

### A8. GDPR "crypto-shredding" claim
- Entries a user wrote in a *shared* drawer are encrypted with the drawer key, which the other
  members hold. Destroying the user's keypair does not make those entries unreadable.
- **Resolution**: state what is actually erased — private keys, sole-owner drawers,
  email, display name, sessions. Their `author_id` on shared entries stays as an opaque id.
  Do not claim full erasure in the privacy text.

### A9. "Vault passphrase must not equal the login password — checked and rejected"
- Only checkable when both strings are in memory: at signup, and at change-passphrase when the
  login password is re-asked. Enforce at those two points; the spec should say so.

---

## B. Ambiguities that change the schema — settle before Phase 4

### B1. What is plaintext on an entry row
- To (a) fetch since the last Adjust, (b) reject a concurrent Adjust, (c) bootstrap home
  totals, the server must know per entry: `line_id`, `seq`, `is_checkpoint` (this is an
  Adjust). None of these appear in the spec's "what the server still learns" list.
- **Resolution**: add them as plaintext columns. Add `line_id` to the entry AAD — without it an
  entry can be moved between two lines of the *same* drawer (same key) undetected. The
  Phase 2 review also added `author_id` (server-stamped) to the AAD of every record, so a
  row's author column cannot be rewritten either. Add to the
  privacy text: per-line write counts, when counts happen, which entries are counts or
  reversals.

### B2. Adjust conflict = conditional insert
- Client sends `expected_head_seq` for the line. Server inserts only if the line's current max
  `seq` equals it, else `409 RecountRequired`.
- "Adjust while another Adds — deterministic outcome" then means: whichever lands first wins.
  Add first → the Adjust is 409. Adjust first → the Add appends after it and counts on top of
  the new checkpoint. **Decided**: yes. Reason: it is the only rule the server can enforce
  without reading content, and it never destroys a physical count.

### B3. Staleness clock
- "One `lastModifiedAt` bumped by every write" — client clock or server clock? Offline clients
  have wrong clocks; two clients disagree.
- **Resolution**: server-stamped `last_write_at` on the drawer row, bumped by document writes
  and by entry inserts (trigger). A verification stores the server time returned by its own
  write, plus each line's head `seq`. Stale iff `last_write_at > last_verification.server_time`.
  The per-line `seq` lets the UI say *which* line moved.

### B4. Offline document edits need an operation log, not snapshots
- Optimistic-lock retry "re-applies the change" only works if the outbox stores operations
  (rename line X, move X to index 3, set photo, append verification), not whole documents.
  Confirm-state offline is a document edit and goes in the same queue.
- **Resolution**: outbox = ordered list of ops. Replay = GET document → apply ops → PUT with
  version → on 409 repeat. Ops that no longer apply (line deleted meanwhile) are reported, not
  silently dropped.

### B5. Wrap the drawer key at invite time, not at accept time
- Spec wraps when the invitee accepts, which creates the "accepted — waiting for owner" state.
- At invite time the owner is online, holds the invitee's pinned public key, and has just
  confirmed the safety number. Wrapping then and storing the wrap on the invitation row removes
  the pending state entirely. The server turns the invitation into a membership on accept with
  no cryptography. A declined invitee holds a wrap they cannot use, because the server refuses
  them the drawer.
- **Decided**: wrap at invite. Two-phase (join app first, then be added) stays. Reason: it
  removes a whole pending state and a whole class of "why can't I open it" support cases.

### B6. Photo inside the drawer document
- ~300 KB JPEG → ~400 KB base64 → re-encrypted and re-uploaded on every rename, reorder and
  verification, and again on every optimistic-lock retry. The home screen downloads every photo
  to render the list.
- The Decisions log says "inside the document". Its goals (no object storage, no plain bucket,
  same key, same rotation path) are met equally by one extra encrypted row
  `drawer_photos(drawer_id, key_version, nonce, ciphertext)` under the same drawer key.
- **Decided**: separate encrypted row `drawer_photos`. This departs from the Decisions log
  entry "Base64 inside the encrypted drawer document" — saying so, not hiding it. Every goal
  behind that entry still holds: no object storage, no plain bucket, same drawer key, same
  AAD scheme, same rotation path. What changes: a rename no longer re-uploads 400 KB, and the
  home screen loads photos only for drawers that have one, on demand.

### B7. Ordering and timestamps
- "Ordered by server timestamp" — timestamps tie. Order by `seq` (B1). Store `logged_at`
  (client, inside ciphertext) and `received_at` (server, plaintext). Display order = `seq`.

### B8. Adjust delta display
- The prototype shows "change: −160" for an Adjust. That needs the pre-Adjust balance, which
  the "fetch back to last Adjust" rule does not load for the latest Adjust.
- **Resolution**: the Adjust payload carries `delta_hint`, display-only, never folded.

### B9. Import of an export archive is unspecified
- Original authors cannot re-sign imported entries.
- **Resolution**: import creates new drawers with new keys; entries keep the original author as
  a text label inside the payload, are signed by the importer, and are flagged `imported`.
  Cloud backup to Drive/iCloud is out of the first build.

### B10. Signup: open or invite-only
- Not stated. **Decided**: invite-only via join links; the first user is created by the
  seed/CLI. Reason: open signup on a household app mostly attracts bots.

---

## C. Conflicts between the spec and CLAUDE.md / build prompts

### C1. libsodium vs. the spec's algorithms
- CLAUDE.md: prefer libsodium. Spec: ECDH P-256, HKDF, AES-KW, AES-256-GCM, and
  *non-extractable `CryptoKey`* objects.
- libsodium.js has no P-256, no AES-KW, its AES-GCM needs hardware AES (absent in WASM), and its
  keys are plain bytes — readable by any XSS.
- **Resolution**: WebCrypto for every primitive the spec names (native, reviewed,
  non-extractable), `hash-wasm` for Argon2id. No hand-assembled crypto; no libsodium.

### C2. Supabase Auth vs. "no cloud account, runs fully offline"
- Build prompt Phase 1 forbids a Supabase account. The spec names Supabase Auth.
- Options were: (A) backend-owned auth — email + password (server-side Argon2id), httpOnly
  session cookie, one container; (B) Supabase CLI local stack (GoTrue + ~10 containers).
- **Decided**: A. Reason: one container, runs offline, and it removes "the one genuine
  lock-in" the spec worries about. Supabase remains a Postgres host option.

---

## D. Smaller items — will implement as stated

- Currency code: trim + uppercase before "group by code as written", else `eur` and `EUR`
  split one total.
- Account deletion also rotates every shared drawer the user was a member of (same as leave).
  Spec silent.
- "Old wrapped keys retained" applies to remaining members only; the revoked member's wraps
  are deleted when rotation starts.
- Argon2id parameters (spec leaves them open): m = 64 MiB, t = 3, p = 1, 16-byte salt,
  parameters stored in the blob header. About 1 s on a 2020 mid-range phone. Passphrase floor:
  12 characters and zxcvbn score ≥ 3.
- Safety number: 30 digits (six groups of five) from SHA-256("petty/safety-number/v1" ‖ ecdh_pub ‖ ecdsa_pub).
- Padding: entry plaintext to a multiple of 256 B; document plaintext to a multiple of 16 KiB.
- i18n library: react-i18next + i18next-icu with JSON dictionaries keyed by semantic ids
  (Phase 5 changed this from lingui: no macro/extractor build step, and the missing-key
  check is a 30-line script comparing en.json and pl.json). ICU plurals work the same.
- Passphrase floor at signup (Phase 5): ≥ 12 characters, not equal to the login password,
  not containing the email's local part, not a single repeated character or keyboard run,
  ≥ 5 distinct characters. zxcvbn was not added (Phase 13 kept it out: ~400 KB for a
  household app; the rule-based floor plus Argon2id at 64 MiB is the accepted posture).
- Phase 13 hardening as built: CSP `script-src 'self' 'wasm-unsafe-eval'` (Argon2id is
  WebAssembly), `style-src 'self'` (all inline style attributes were replaced by classes),
  `require-trusted-types-for 'script'` with a default policy that admits only `/sw.js`,
  single-file service worker (no importScripts), SRI (sha384) on the built assets, HSTS on
  HTTPS, nosniff, no-referrer, frame-ancestors none. Verified by the `prod` Playwright project
  which fails on any CSP violation. Backups: nightly `pg_dump` to the NAS kept 30 days (not
  point-in-time); restore drill documented in the deployment runbook. Still open: SMTP provider
  (emails logged as failed), Argo CD adoption of the manifests.
- Private-key custody uses AES-256-GCM, not AES-KW (spec: "AES-KW to wrap"). AES-KW needs
  input that is a multiple of 8 bytes; PKCS#8 EC private keys are not, and browsers reject
  the call. AES-GCM with an AAD naming the slot is the portable choice. AES-KW is kept where
  its reason applies: wrapping the raw 32-byte drawer keys for members. (Phase 2.)
- WebCrypto can only wrap an *extractable* key. Private keys are extractable for the moment
  between generation and wrapping, then dropped; every later unlock is non-extractable.
  A drawer key is unwrapped non-extractable for reading and, only when a wrap for another
  member is needed, unwrapped a second time with `extractable: true` and discarded after.
  (Phase 2.)
- Display names and emails are plaintext server-side (needed for invitation lists). Add to the
  metadata list.
