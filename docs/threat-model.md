# Threat model

**Current as of v1.3.1 (2026-09-25).** This is the maintained description of what Petty protects,
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
  and on "Lock now" or sign-out.
- **A stolen mailbox or login password.** They let an attacker sign in, not open the vault. Actions
  that could destroy a user's keys or data also require proof of the vault key (see "Custody proofs").
- **A removed collaborator, going forward.** After removal the drawer key is rotated; they cannot
  read anything written afterwards.
- **A leaked access token of limited scope.** A tool token can read the drawers in its scope and,
  with the write role, append entries — nothing else (see "Access tokens").

## What Petty does not defend against

Users should be told these plainly.

- **A malicious frontend build.** Whoever serves the web app can serve JavaScript that captures the
  vault passphrase or keys. This is the fundamental limit of browser-delivered end-to-end encryption:
  **with a hosted instance you trust its operator to serve the published code.** Mitigations are
  partial: a strict Content-Security-Policy with no inline or third-party script (Clerk's code is
  bundled at a pinned version, not fetched at run time), subresource integrity, no analytics, pinned
  dependencies, and published, attested release images. Self-hosting from a verified image removes
  the third party, not the risk class.
- **A malicious collaborator.** Anyone you share a drawer with can read and copy everything in it.
  Removal stops future access, never past access.
- **Script injection (XSS) in the app itself.** Injected code in the page can reach keys held in
  memory. Countered by the strict CSP, Trusted Types in local mode, no raw HTML rendering, and
  non-extractable `CryptoKey`s — reduced, not eliminated.
- **The identity provider, in Clerk mode.** Clerk can sign a user in, and so could anyone who
  controls the Clerk account. It still cannot open the vault — the vault key is Petty's alone.
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
- **Resetting the login password never restores vault access**, and the app says so at reset.

## Key verification

The server hands out public keys, so it could substitute its own. Petty makes that **detectable**:

- Every user has a **safety number** (a fingerprint of both public keys).
- Before sharing, the inviter compares the invitee's safety number out of band.
- Keys are **pinned on first use**; if a contact's key changes, the app warns and refuses further
  wraps to them until the new number is confirmed.

## Integrity

- **Bound ciphertext.** Every ciphertext's additional authenticated data is
  `record_type || record_id || drawer_id || line_id || author_id || key_version || schema_version`,
  so it cannot be decrypted in any other row, line, drawer, author or key generation.
- **Signed entries.** Each entry is signed (ECDSA) by its author's key, or by an access token's own
  delegated key; public keys are never deleted, so old entries still verify after revocation or
  account deletion.
- **Hash-linked history.** Each entry carries the hash of the newest entry its author had seen on
  that line (concurrent writers make it a tree). The client pins the last head it saw and warns if
  the server returns a shorter log.
- **Append-only at the database.** `UPDATE` and `DELETE` on entries are revoked from the request role;
  mistakes are reversed by a new entry.

## Key rotation

When a member is removed or leaves, a remaining member's **client** makes a new drawer key, wraps it
for everyone left and re-encrypts the drawer in resumable, idempotent batches; the server only tracks
progress through the plaintext `key_version`. Rotation protects **future** content only.

## Access tokens

A token lets a tool on the owner's machine (for example the Claude Desktop add-on) read, and
optionally write, the owner's drawers without breaking end-to-end encryption. The token string holds
a secret that opens a key bundle on the tool's machine; the server stores only the bundle it cannot
open and a hash of the token id. A token has its own signing key, vouched for by the owner's account
key. It **can never** touch the vault, the account, sharing, admin or export, or create another token —
the server refuses every route not on its allow-list. Creating one requires the custody proof. Details
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
  person and per address, only a signed-in and unlocked person can allow one, and a token can never
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
