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
  and on "Lock now" or sign-out, in every open tab of that browser. While it is open, the browser
  profile holds the key handles (see "Session lock"): someone who gets the device unlocked, or a
  copy of that profile, inside those 24 hours can use them in that browser.
- **A stolen mailbox or login password.** They let an attacker sign in, not open the vault. Actions
  that could destroy a user's keys or data also require proof of the vault key (see "Custody proofs").
- **A removed collaborator, going forward.** After removal the drawer key is rotated; they cannot
  read anything written afterwards.
- **Another site open in your browser.** A page of another site cannot make your browser change
  anything with your sign-in, also not a page on another host under the same domain as the instance.
  A browser marks where a request comes from (`Sec-Fetch-Site`), and the API takes a request that
  changes something only when that mark says Petty's own pages (`same-origin`). Besides that, a
  request body must be JSON, and the session cookie is `SameSite=Lax`. A browser too old to send the
  mark is covered by these two only; a program that is not a browser sends none and is not limited
  by it.
- **A leaked access token of limited scope.** A tool token can read the drawers in its scope. With
  the write role it can also add entries and replace a drawer's sealed document: its name, items,
  tags and places (the drawer's 30-day history can restore them). Nothing else. Its owner sets that
  scope when they make it: the drawers they tick, or all of them if they choose so (see "Access tokens").

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
  Removal stops future access, never past access. A member who may write can also store content the
  app cannot show, such as amounts that no longer add up to an exact number. The web app then lists
  that drawer as damaged, with the reason, and shows no number for it; the other drawers and the rest
  of the app keep working. The damaged drawer's screen offers its owner the 30-day history and
  deleting it, and every other member a way to leave.
- **Text in a shared drawer that steers an AI assistant.** Anyone who may write to a drawer can put a
  sentence that reads like an instruction into a name, a tag, a note or a comment. The AI add-on hands
  all such text to the model as quoted values, and the command line shows its control characters as
  `?`. That marks the text as data; it does not stop a model from following it. An assistant that also
  has other tools (the web, mail, a shell) could be talked into sending out what its token can read.
  See [agent.md](agent.md), *What this does and does not protect*.
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
  unlock is bound to one Clerk session (PETTY-140). "Lock now" and sign-out clear it at once, and
  reach every open tab of that browser: the other tabs drop the keys and the opened drawers from
  memory (a browser without `BroadcastChannel` locks the one tab). With local sign-in, a sign-out made
  while offline is remembered, with nothing secret stored, and sent to the server before any other
  request: at the next start, or when the network is back.
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
- Your sealed user document remembers, for each drawer, the newest key version you accepted and a
  fingerprint of every key you accepted. So the server can neither push a key of its own, nor put
  another key in the place of one you accepted, nor go back to an older key that a removed member may
  still hold. A key you accepted stays open without a new confirmation. A user document from before
  the fingerprints (or one that an older copy of the web app saved, which drops them) lists only the
  version: the app takes the key at that version once more as it did before, remembers its
  fingerprint, and re-seals nothing under it unless you or a confirmed member wrapped it.
- The pins live in that sealed user document, so a server could try to drop it or serve an older
  copy. The server's version number of the document is a plain number that the server writes, so the
  document also carries a counter inside the encryption (PETTY-439): every save stores the counter it
  loaded plus one. Each browser remembers the newest version number and the highest counter it saw,
  also across a sign-out or an expired session (PETTY-402), and warns loudly when the server has none,
  a lower number, or a copy whose counter is lower or gone: an older sealed copy under a newer number
  is caught too. A document from before the counter gets its first one the next time the web app loads
  it; until that load only the number is compared. A document with a counter says so inside (`v` 2): a
  web app from before the counter does not open it and saves nothing, so it cannot put a copy without
  the counter, or without a field it does not know, in its place. An account with
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
  delegated key; public keys are never deleted, so old entries still verify after revocation or
  account deletion.
- **Hash-linked history.** Each entry carries the hash of the newest entry its author had seen on
  that line (concurrent writers make it a tree). The client pins the last head it saw and warns if
  the server returns a shorter log, also an empty one for a line the drawer still lists.
- **Drawer versions.** The server's version number of a drawer's document is not inside the encryption,
  so each document also carries a counter that is (PETTY-422): every write stores the counter it loaded
  plus one. Your sealed user document remembers, for each drawer, the newest version number and the
  highest counter of the document you opened. The app refuses a document with a lower number, with a
  lower counter, or with no counter after it saw one, and never saves a change on top of one. So a
  server cannot go back to a state where later lines are missing, also not by labelling an older sealed
  document with a newer number. The limits:
  - What is remembered is what your app opened when it last started. A change made since then is
    covered from the next start on.
  - A document from before the counter has none until the web app next saves that drawer's document
    (an item added, a rename, a count). Until then only the number is compared for that drawer.
  - A document with a counter is a new format (`schema_version` 2, part of the additional authenticated
    data). A web app, command line or add-on from before it cannot open such a drawer, and so cannot
    save a document without the counter over it; the server also refuses a write in the older format.
    Only the web app starts a counter. A tool keeps the format it finds, because a tool is updated apart
    from the instance and must not write what the instance's own web app may not know yet.
  - An earlier version is put back by the owner's app: it opens the kept copy and saves it as a normal
    write with a counter above every one it knows. The server no longer copies an old sealed document
    into place.
  - A counter is not accepted further ahead of the version number than writes explain (each write
    raises both by one). So nobody who holds the drawer key, a tool with a leaked token included, can
    use the counter up, and an earlier version can always be put back.
  - Tools remember no counters: a tool takes the document the server gives it.
- **Append-only at the database.** `UPDATE` and `DELETE` on entries are revoked from the request role;
  mistakes are reversed by a new entry.
- **What the pinned head is, and what it catches.** Each browser remembers, per line, the hash of the
  newest entry it saw and of the first entry of the rows it saw it in. The sequence number of a row is
  the server's plain column, so the app finds the remembered entry by its hash: it warns when that
  entry is gone, whatever numbers the other rows carry, and when it is still there under another
  number. After a count the rows start at that count; the app then looks for the remembered entry in
  the rows before it, and warns when the server does not give them (offline it looks at the next
  load). It remembers one entry per line and per browser. A browser that never opened a line has
  nothing to compare with, an entry written at the same moment as another and linked to by nothing
  later can still be removed unnoticed, and the order of entries written at the same moment is the
  server's.
- **Counts.** A balance is folded from the latest sealed count. Which rows the server sends first
  depends on its own plain "count" column, which a writer sets and nothing signs. A row whose column
  says otherwise than its sealed content is reported, and the app reads back to the latest real count
  instead of starting the balance at that row. The first row a balance starts from is a count or the
  line's first entry. The same entry sent twice is refused, not counted twice.
- **The command line and the AI add-on check less than the web app.** They check that every row opens
  in its own row, line, drawer and key version, every signature, the hash links between the rows since
  the latest count, and the count rules above. They name what did not open or verify (on the command
  line's error output, and at the end of the add-on's answers) and leave it out of the balance. Since
  PETTY-445 an entry they write carries the hash of the newest entry they checked, as the web app's
  do. They do **not** remember anything between two runs: no pinned head, no drawer version and no
  pinned keys (they check signatures against the keys the server lists for an author). So a server
  can show a tool a shorter history or an older state of a drawer, and the tool cannot tell; its next
  entry then links to whatever it was shown. The web app, which keeps all three, is the place to
  check. Entries that tools wrote before PETTY-445 carry no link: the web app and the tools accept an
  unlinked entry signed by a token's key without a warning, so such an entry says nothing about the
  entries before it. An unlinked entry signed by an account key, on a line where that account already
  wrote, is still reported.

## Key rotation

When a member is removed or leaves, a remaining member's **client** makes a new drawer key, wraps it
for everyone left and re-encrypts the drawer in resumable, idempotent batches; the server only tracks
progress through the plaintext `key_version`. Rotation protects **future** content only.

A batch replaces rows in place, and the server cannot tell a re-encrypted row from random bytes. So
publishing the new key and every batch need a custody proof from the member whose client sends them
(see "Custody proofs"): a session without the vault key can neither start a rotation nor continue one.
A rotation that one member began can be finished by another, each with a proof of their own key.

## Access tokens

A token lets a tool on the owner's machine (for example the Claude Desktop add-on) read, and
optionally write, the owner's drawers without breaking end-to-end encryption. The token string holds
a secret that opens a key bundle on the tool's machine; the server stores only the bundle it cannot
open and a hash of the token id. The bundle also holds the owner's public key, so the tool opens a drawer key
sent later only if the owner wrapped it. A token has its own signing key, vouched for by the owner's account
key. With the write role it may add entries and replace a drawer's document; the server cannot see
what changed inside the sealed document, so such a token can rename, retag, move or drop items, and
the owner can restore an earlier version from the drawer's 30-day history. The web app reaches that
history also for a document it cannot show: the drawer is listed as damaged, and its screen offers
"Earlier versions". It **can never** touch the
vault, the account, sharing, admin or export, delete a line, rotate a drawer key, or create another
token — the server refuses every route not on its allow-list. Creating one requires the custody proof.
An account holds at most 50 live tokens; the sealed bundle and the wrapped drawer keys of a token
that was revoked or has expired are erased on the server. Details and diagram: [README.md](README.md).

**Making a token (PETTY-452).** The owner says which drawers it may use: only the ones they tick, or
all drawers, later ones included. Nothing is chosen for them. The server keeps that list and refuses
the token every other drawer. The app puts only those drawers' keys into the bundle, and wraps the key
of a later drawer for a token only when the token was made for all drawers; the list it goes by is its
own copy in the sealed user document, not the server's. A token ends after 90 days unless the owner
picks another time or "Never". Making any token, also one that only reads, opens the vault again with
the passphrase or a passkey: the function that makes the token does this itself, stops on a wrong
passphrase or a cancelled prompt before anything is made, and signs the custody proof with the keys
that door gave. So someone who finds Petty unlocked cannot make a token through the app. This is the
app's own rule, not the server's: the server sees a custody proof signed by the account key and cannot
tell whether the vault was just opened or the key came from the open session. Code that runs in the
page (see *Script injection*), or someone who can run their own code in the unlocked browser, is not
stopped by it.

## Device login

`petty auth login` (PETTY-274) signs the command line in through the web app, the way `gh auth login`
does (RFC 8628). The server cannot make a token, because it has no keys, so the web app makes an
ordinary access token and seals it to a one-time key that only the command line holds. The server
relays the sealed blob once and deletes the request; it never sees the token.

- **A server or database that swaps the key.** To receive the token, it would have to put a key of
  its own in the request. The code a person sees is derived (SHA-256) from the command line's key and
  from the address of the Petty it signs in to. The command line makes it; the page works it out
  again from the key it was given and from its own address, and refuses a mismatch; the command line
  refuses any other code in the server's answer. The code has 20 letters from 20 (PETTY-451), so a
  substitute key with the same code for that address takes about 2^86 tries, each a new key and a
  hash. It does not matter when the tries are made, and tries made for one address are of no use for
  another. For scale, an estimate: at a billion tries a second (about one fast graphics card), 2^86
  tries take some 2 billion years, and 2^66 tries made ahead of time (some 2,000 years of that card)
  would fit about one sign-in in a million. The earlier 12-letter code is no longer made or taken by
  the command line, the page or the server, so none of them can be moved back to it; a command line
  and a Petty of different ages stop with a message instead ([cli.md](cli.md)). A server that ships
  altered web-app code is the *malicious frontend build* above, as everywhere in the app.
- **Phishing** ("please allow this code"). The page shows what asks (its name, address and time) and
  what it gets (read or write, which drawers, expiry), says to allow only a request the person
  started, and every token needs the passphrase or a passkey. Someone who allows an attacker's
  request gives that attacker a token, as with any device login; revoking it in Settings stops it at
  once.
- **Guessing codes.** 20 letters from 20 (about 2^86), one-time, 15 minutes. Lookups are limited per
  person, only a signed-in and unlocked person can allow one, and a token can never
  allow a token. Asking for codes is limited per address (an IPv6 client counts by its /64 network,
  as for every per-address limit).
- **The login on disk.** `~/.petty/hosts.json`, readable by its user only, like the MCP program's
  token file. What a person types (names, amounts, notes) stays in their shell's history, outside
  Petty's control; [cli.md](cli.md) says how to keep notes out of it.

## Custody proofs

Calls that could destroy keys or data — replacing the vault, deleting the account, deleting a drawer,
deleting a line (its entries go with it), publishing a new drawer key and every batch of the
re-encryption that follows, adding or removing a passkey, creating a token — require a server-issued
challenge **signed with the account key**, in addition to the session. Replacing the vault, changing
passkeys and deleting the account also ask for the login password in local mode. There is one
challenge per person; it is valid five minutes and works once. The login password
can be reset from an email link; the vault key cannot be reset by anyone. Replaced vault blobs are kept
30 days (an admin can put one back), and the owner is emailed on a password reset and a vault change.

A proof shows that the caller holds the account key, not that what they send is good. A member with
the write role and an open vault can delete a line, as before, and the server cannot check a
re-encryption: it is as good as the app that runs it.

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
