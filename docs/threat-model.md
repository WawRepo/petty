# Threat model

**Current as of 2026-09-30 (after v1.5.6).** This is the maintained description of what Petty protects,
from whom, and what it does not. It replaces the "Security" section of [petty-app-spec.md](history/petty-app-spec.md), which is
kept as history. The settled design choices behind it are in [decisions.md](decisions.md); how the
keys and access tokens work, with diagrams, is in [README.md](README.md).

"The operator" below means whoever runs a given Petty instance — you, if you self-host; the
provider, if you use a hosted one. The same code runs in both cases.

## What Petty defends against

- **A passive database reader.** Anyone reading raw Postgres rows or a database dump — hosting
  staff, a leaked backup, a subpoena on the host — gets drawer content, photos and vaults only as
  ciphertext. They do see the metadata listed under "What the server still learns".
- **An active database writer.** Anyone who can change rows cannot forge, reorder, move between
  drawers or lines, re-attribute, or silently drop ledger entries without the client noticing (see
  "Integrity").
- **A curious or compromised backend.** The API enforces permissions but never holds a key, so it
  cannot read drawer content.
- **The operator's staff and admins.** An admin can list, block and unblock accounts, revoke their
  sessions, restore a replaced vault blob and grant admin — and can read no drawer content.
- **A lost or stolen device.** Nothing readable is written to disk; the vault locks after 24 hours
  and on "Lock now" or sign-out. While it is open, the browser profile holds the key handles (see
  "Session lock"): someone who gets the device unlocked, or a copy of that profile, inside those
  24 hours can use them in that browser.
- **A stolen mailbox or login password.** They let an attacker sign in, not open the vault. Actions
  that could destroy a user's keys or data also require proof of the vault key (see "Custody proofs").
- **A removed collaborator, going forward.** After removal the drawer key is replaced; they cannot
  read anything written under the new key. The app of the person who removes a member replaces the
  key at once and does not wait for the server to ask for it. What is written before the new key is
  there is still under the old one; "Key rotation" says when that takes longer.
- **A leaked access token of limited scope.** A tool token can read the drawers in its scope. With
  the write role it can also add entries and replace a drawer's sealed document: its name, items,
  tags and places (the drawer's 30-day history can restore them). Nothing else (see "Access tokens").

## What Petty does not defend against

Users should be told these plainly.

- **A malicious frontend build.** Whoever serves the web app can serve JavaScript that captures the
  vault passphrase or keys. This is the fundamental limit of browser-delivered end-to-end encryption:
  **with a hosted instance you trust its operator to serve the published code.** Mitigations are
  partial: a strict Content-Security-Policy with no inline script and no third-party script outside
  Clerk's sign-in pages (Clerk's code is bundled at a pinned version, not fetched at run time; see the
  bot check below), subresource integrity, no analytics, pinned
  dependencies, and release images published with build provenance and an SBOM (v1.5.1–v1.5.6 were
  built by hand while CI could not run; their provenance names no source revision). Self-hosting from a verified image removes
  the third party, not the risk class.
- **A malicious collaborator.** Anyone you share a drawer with can read and copy everything in it.
  Removal stops future access, never past access.
- **Script injection (XSS) in the app itself.** Injected code in the page can reach keys held in
  memory. Countered by the strict CSP, Trusted Types in local mode, no raw HTML rendering, and
  non-extractable `CryptoKey`s — reduced, not eliminated.
- **The identity provider, in Clerk mode.** Clerk can sign a user in, and so could anyone who
  controls the Clerk account. It still cannot open the vault — the vault key is Petty's alone.
- **Clerk's bot check, in Clerk mode.** While someone signs up, Clerk loads Cloudflare Turnstile from
  Cloudflare: the one third-party script, with no pinned version and no integrity check. Only the
  sign-in and sign-up pages (`/login`, `/join`) allow it (PETTY-404). The app leaves them with a full
  page load, so vault setup and unlock always run in a fresh page that allows no third-party script,
  and no key is in memory while the bot check runs. It still runs on Petty's origin: a malicious
  Turnstile could change what the browser keeps for Petty (the offline copy of the app, IndexedDB) or
  open a Petty page and read it. Removing it fully means signing in on another origin (Clerk's hosted
  pages) or turning the bot check off. Local mode loads no third-party script.
- **Metadata.** See below.
- **Operator retention.** Backups, logs and telemetry are configured by the operator. The app ships
  no backup job and no retention policy; how long a copy of your email, encrypted vault and
  ciphertext survives — including after you delete your account — is the operator's choice.
- **A lost vault on an unshared drawer.** If every door to the vault is lost (passkeys, passphrase
  and recovery code) and nobody else holds that drawer, the content is unrecoverable by design.

## Keys and custody

- **Drawer key.** Each drawer has its own random AES-256-GCM key. It encrypts the drawer document,
  every entry and every photo.
- **Per-user keypairs**, generated on the device: ECDH P-256 to receive wrapped drawer keys, and
  ECDSA P-256 to sign entries. Both public keys feed the safety number. Private keys never leave the
  device unencrypted.
- **The vault** is the private keys, wrapped with AES-256-GCM (the public keys are in the additional
  authenticated data, so the server cannot swap a published key without the vault failing to open).
  It has several independent doors, each a separately wrapped copy:
  - **Passkeys** — the first door since PETTY-102: a key derived (HKDF) from the WebAuthn PRF output
    of a passkey; one copy per device. The server never sees the PRF output.
  - **Vault passphrase** — optional or added later; Argon2id (m = 64 MiB, t = 3, p = 1, per-user
    salt, versioned parameters). It must differ from the login password; the app rejects reuse.
  - **Recovery code** — mandatory, shown once at sign-up, can be regenerated from Settings.
- **Session lock.** An unlocked vault stays open for 24 hours (a non-extractable key handle cached in
  IndexedDB, never raw key bytes or decrypted content), then asks again. In Clerk mode the cached
  unlock is bound to one Clerk session (PETTY-140). "Lock now" and sign-out clear it at once.
  Non-extractable means the page cannot read the key bytes out; it does not mean the handle stays
  off the disk. IndexedDB is part of the browser profile, and the 24 hours are counted by the app,
  not by the browser. So the unlock screen lets you keep the vault open only in that page's memory
  (PETTY-405): it then locks when you close or reload Petty. A Clerk session that ended while Petty
  was closed has its cached unlock and cache wiped at the next start.
- **Resetting the login password never restores vault access**, and the app says so at reset.

## Key verification

The server hands out public keys, so it could substitute its own. Petty makes that **detectable**:

- Every user has a **safety number** (a fingerprint of both public keys).
- Before sharing, the inviter compares the invitee's safety number out of band.
- Your **own** public keys come from your vault (its additional authenticated data binds them), never
  from the server's copy. If the two differ, the vault does not open.
- Keys are **pinned on first use**; if a contact's key changes, the app warns and refuses further
  wraps to them until the new number is confirmed. A pin that you did not confirm shows a later
  change of key; it opens no drawer.
- The server also lists a drawer's **members**, so a member it adds could be the server itself. A
  **drawer key that someone else wrapped** is therefore taken only when you confirmed that person's
  safety number (PETTY-438). That holds for the first key of a drawer, where accepting the invitation
  confirms the inviter, and for every later one. A **new drawer key** (after someone leaves) is given
  only to members whose safety number you confirmed, and a drawer is re-sealed only under a key that
  you or such a member wrapped.
- A confirmed safety number outlives a membership. So your sealed user document also remembers who
  was in each drawer, and who left it or was removed (PETTY-449). A drawer key that such a person
  wrapped, newer than the last one they held as a member, stays closed, and your device gives them
  no new key, also when the server lists them as a member again. That ends when you compare their
  safety number again in Members or, as the owner, invite them again. Keys they wrapped while they
  were a member still open what was sealed under them. Only the owner knows of a removal first-hand.
  Every other member learns it from the member list, which the server gives: a server that never
  shows a member's app that someone is gone is not caught by that app.
- An **invitation** shows the inviter's safety number, and accepting it confirms the inviter. When
  the inviter's keys are not the ones you already pinned for that person, the invitation shows the
  key change and cannot be accepted until you accepted the new key as a changed key (PETTY-447).
- Your sealed user document remembers, for each drawer, the newest key version you accepted and a
  fingerprint of every key you accepted. So the server can neither push a key of its own, nor put
  another key in the place of one you accepted, nor go back to an older key that a removed member may
  still hold. A key you accepted stays open without a new confirmation. A user document from before
  the fingerprints (or one that an older copy of the web app saved, which drops them) lists only the
  version: the app takes the key at that version once more as it did before, remembers its
  fingerprint, and re-seals nothing under it unless you or a confirmed member wrapped it.
- The pins live in that sealed user document, so a server could try to drop it or serve an older
  copy. Each browser remembers the newest version it saw, also across a sign-out or an expired
  session (PETTY-402), and warns loudly when the server has none or an older one. An account with
  drawers always has this document (the app starts it before it makes a drawer, and accepting an
  invitation saves the inviter's pin), so "none" also warns on a browser that never used the account.
  Until you acknowledge the warning, and whenever the document cannot be loaded, the app opens only
  drawer keys that you wrapped yourself, pins nothing on first sight, wraps no key and starts or
  continues no key rotation. When you start a new list, the drawers that others shared open again
  after you confirm their safety number. A new list remembers no key versions yet, so for a drawer
  whose keys you made yourself it cannot tell an older key from the newest. With no connection, the
  app uses the sealed copy that this device kept from its last load. A browser that never used the
  account has no older version to compare with: it takes the copy the server gives it.

## Integrity

- **Bound ciphertext.** Every ciphertext's additional authenticated data is
  `record_type || record_id || drawer_id || line_id || author_id || key_version || schema_version`,
  so it cannot be decrypted in any other row, line, drawer, author or key generation.
- **Signed entries.** Each entry is signed (ECDSA) by its author's key, or by an access token's own
  delegated key. The web app checks the signature against a key that **you hold** for the author
  (PETTY-413): your own key from your vault, the key you pinned for them, or an earlier key of theirs
  that you had confirmed before you accepted a new one. A key that only the server lists for an
  author you pinned is not used, and a token's key counts only when a key you hold for the author
  vouches for it. An entry under the name of someone you pinned that is signed with any other key is
  reported and left out of the balance. The server never deletes a public key or a delegation, and
  your pins stay when a person leaves a drawer or deletes the account, so old entries still verify
  after a token is revoked or an account is deleted. Someone you never pinned, such as a person who
  left before you joined, cannot be checked this way: the app checks their entries against the key
  the server lists, counts them, and marks them "author not confirmed". A person who holds the
  drawer key and can write the database can therefore still add an entry under a name you never
  pinned; it carries that mark. A signature says who wrote an entry, not that they were allowed to:
  roles are enforced by the server alone.
- **Hash-linked history.** Each entry carries the hash of the newest entry its author had seen on
  that line (concurrent writers make it a tree). The client pins the last head it saw and warns if
  the server returns a shorter log, also an empty one for a line the drawer still lists.
- **Drawer versions.** Your sealed user document remembers the newest version of each drawer's document
  you opened. The app refuses an older one, so a server cannot go back to a state where later lines are
  missing, and never saves a change on top of one. The version number is not inside the encryption: a
  server that labels an older document with a newer number is not caught.
- **Append-only at the database.** `UPDATE` and `DELETE` on entries are revoked from the request role;
  mistakes are reversed by a new entry.

## Key rotation

When a member is removed or leaves, a remaining member's **client** makes a new drawer key, wraps it
for everyone left and re-encrypts the drawer in resumable, idempotent batches; the server only tracks
progress through the plaintext `key_version`. Rotation protects **future** content only.

The app does not wait for the server to say that a new key is needed (PETTY-449). The app of the owner
who removes a member replaces the key right after the removal. It also notes the removal in the
owner's sealed user document, so another device or a later session of the owner replaces the key when
the first one could not. Every other member's app keeps, in that member's user document, who it saw
in the drawer; when someone is no longer listed, a write member's app replaces the key as well. The
note lives in the user document because only its owner can write it; the drawer document is sealed
with the drawer key, which the removed person still holds. What remains of the wait:

- Entries written after the removal and before the new key are under the old key, which the removed
  person holds.
- A device gives a new key only to members whose safety number its user confirmed. While one is not
  confirmed, that device waits, and the drawer and its Members screen say whom to confirm. Another
  write member who confirmed everyone can replace the key in the meantime.
- A read-only member cannot replace a key. A drawer that only read-only members open keeps its key
  until a write member opens it.
- While the user document is missing or rolled back, no key is replaced. A list of trusted keys that
  was started over, or one that an older copy of the web app saved (it drops what it does not know),
  no longer remembers who left; then a new key waits for the server's word, as it did before.
- A member who leaves by themselves, or deletes their account, is noticed from the member list,
  which the server gives.
- A member's app compares the list with what it saw the last time. When the key was replaced in
  between, it takes that key to be the one that followed the removal. Had the person left only after
  it, this app would not replace the key once more. The owner's app, which removes at a moment it
  knows, does.
- A key that the leaver wrapped, and that your app first sees together with their leaving, counts as
  one they held as a member: the app opens it, so that nothing they re-encrypted is lost, and
  replaces it like any key they hold. A key from them that comes later stays closed.

## Access tokens

A token lets a tool on the owner's machine (for example the Claude Desktop add-on) read, and
optionally write, the owner's drawers without breaking end-to-end encryption. The token string holds
a secret that opens a key bundle on the tool's machine; the server stores only the bundle it cannot
open and a hash of the token id. The bundle also holds the owner's public key, so the tool opens a drawer key
sent later only if the owner wrapped it. A token has its own signing key, vouched for by the owner's account
key. With the write role it may add entries and replace a drawer's document; the server cannot see
what changed inside the sealed document, so such a token can rename, retag, move or drop items, and
the owner can restore an earlier version from the drawer's 30-day history. It **can never** touch the
vault, the account, sharing, admin or export, or create another token — the server refuses every
route not on its allow-list. Creating one requires the custody proof. Details
and diagram: [README.md](README.md).

## Device login

`petty auth login` (PETTY-274) signs the command line in through the web app, the way `gh auth login`
does (RFC 8628). The server cannot make a token, because it has no keys, so the web app makes an
ordinary access token and seals it to a one-time key that only the command line holds. The server
relays the sealed blob once and deletes the request; it never sees the token.

- **A server or database that swaps the key.** To receive the token, it would have to put a key of
  its own in the request. The code a person sees is derived from the command line's key; the page
  works it out again from the key it was given and refuses a mismatch, and the command line checks
  the code the server returns. A substitute key with the same 12-letter code takes about 2^52 tries
  within the request's 15 minutes. A server that ships altered web-app code is the *malicious
  frontend build* above, as everywhere in the app.
- **Phishing** ("please allow this code"). The page shows what asks (its name, address and time) and
  what it gets (read or write, expiry), says to allow only a request the person started, and a token
  that may write needs the passphrase or passkey. Someone who allows an attacker's request gives that
  attacker a token, as with any device login; revoking it in Settings stops it at once.
- **Guessing codes.** 12 letters from 20 (about 2^52), one-time, 15 minutes. Lookups are limited per
  person, only a signed-in and unlocked person can allow one, and a token can never
  allow a token. Asking for codes is limited per address.
- **The login on disk.** `~/.petty/hosts.json`, readable by its user only, like the MCP program's
  token file. What a person types (names, amounts, notes) stays in their shell's history, outside
  Petty's control; [cli.md](cli.md) says how to keep notes out of it.

## Custody proofs

Calls that could destroy keys or data — replacing the vault, deleting the account, deleting a drawer,
adding or removing a passkey, creating a token — require a server-issued challenge **signed with the
account key**, in addition to the session (and the login password in local mode). The login password
can be reset from an email link; the vault key cannot be reset by anyone. Replaced vault blobs are kept
30 days (an admin can put one back), and the owner is emailed on a password reset and a vault change.

## What the server still learns

The operator can see: emails and display names; how many drawers each user has and how many lines each
holds; the full sharing graph and roles; who wrote each entry, when, on which line, and whether it was a
count or a reversal; per-line write counts; and exact timestamps — a pattern of when cash moves. Entry
ciphertext is padded to 256-byte buckets so amounts cannot be read from sizes; a long comment grows the
row in 256-byte steps.

Logs and traces carry route names, statuses, user ids and SQL shapes — never content. Treat them as
personal data ([monitoring.md](monitoring.md)).

## Operator responsibilities

Running an instance, hosted or self-hosted, also means: serving the published code unmodified, TLS in
front of the app, backups that are encrypted and actually restore-tested, a stated retention policy,
access control on logs and telemetry, and a working security contact. [deploy.md](deploy.md) covers the
mechanics.
