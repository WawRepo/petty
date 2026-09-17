# Petty docs

## `petty-keys.excalidraw` / `petty-keys.svg` — where the keys come from, where they live, how they are used

Open the `.excalidraw` in any Excalidraw:
https://excalidraw.com, or the
VS Code "Excalidraw" extension. `petty-keys.svg` is the same picture, viewable
anywhere. Three lanes: your device (green, memory only), the server database
(grey, locked blobs and metadata), a member's device (blue); yellow = a secret
made on your device.

The diagram is generated: `python3 docs/generate-keys-diagram.py` rewrites the
`.excalidraw` (it refuses text that would not fit its box), and
`python3 docs/render-excalidraw.py docs/petty-keys.excalidraw docs/petty-keys.svg`
renders the SVG. Edit the generator, not the files.

## The same flow in text

**1. Sign-up.** You type an email and a login password (sent; the server keeps a
hash) and a vault passphrase (never sent). Your device generates two random
keypairs — ECDH to receive drawer keys, ECDSA to sign entries — and a 30-letter
recovery code shown once. Argon2id turns the passphrase into wrap key A; HKDF
turns the recovery code into wrap key B. The **vault** is the private keys
locked with A; the **recovery vault** is the same private keys locked with B.
Both locked blobs and the public keys go to the server. The server cannot open
either blob.

**1b. Passkeys (Phase 14; the first door since PETTY-102).** A new vault is
normally created with a passkey on the device (Face ID, Touch ID, Windows Hello,
PIN or a security key); a passphrase is the alternative first door, or a backup
added later. The device asks the authenticator for a 32-byte PRF output — a
secret it computes from a per-passkey salt only after it has verified you — and
HKDF turns that into wrap key C. The **passkey vault** is the same private keys
locked with C, stored on the server with the passkey's id, the salt and a label
("iPhone"). One account holds several: one per device, each with its own salt
and its own wrapped copy. Unlocking with a passkey means: authenticator → PRF
output → C → the vault opens. The server never sees the PRF output and does not
check the passkey's signature; the passkey is a key holder, not a login. A new
device without a passkey unlocks through the phone (the browser's QR code), the
passphrase or the recovery code, and then adds its own passkey. Adding or
removing a passkey takes the custody proof of section 5 (and the login password
in local mode). Removing a passkey deletes that copy; the keys were never
exposed, so nothing needs rotating. The last passkey cannot be removed while
the account has no passphrase.

**2. Unlock.** Passphrase → Argon2id → the vault opens → the private keys sit in
memory as browser key handles that cannot be exported. IndexedDB caches those
handles (24 h expiry), the vault blob and the bootstrap ciphertext for offline
use. Plaintext is never written to disk.

**3. A drawer.** A random AES-256-GCM drawer key is made per drawer and wrapped
with your public key ("your wrap"). The drawer document is encrypted with the
drawer key; every entry is signed with your ECDSA key and then encrypted. The
server stores ciphertext plus a few plain columns (line id, sequence, author,
whether it is a count). Reading = unwrap the drawer key with your private key,
decrypt, verify every signature and the hash links, fold the balance.

**4. Sharing.** You compare the member's safety number out of band, pin their
public keys, unwrap the drawer key and re-wrap it with their public key. On
accept the server stores their wrap; their device unwraps it with their private
key and reads and writes exactly as you do. Removing a member: a writer makes a
new drawer key, wraps it for everyone left and re-encrypts the old rows.

**5. New device.** Login → the vault arrives → passphrase → the same private keys.
Keys are never regenerated. Lost passphrase → the recovery code opens the
recovery vault → you choose a new passphrase → a new vault is uploaded, keys
unchanged. Lost both on a drawer shared with nobody: unrecoverable, by design.
