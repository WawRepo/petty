#!/usr/bin/env python3
"""Generates docs/petty-keys.excalidraw. Layout rule: one arrow per row, no arrow crosses a box; every text line fits its box."""
import json, random
random.seed(11)
els = []
def nid(): return "%08x" % random.getrandbits(32)
def seed(): return random.getrandbits(31)
def base(t, x, y, w, h, **k):
    e = {"id": nid(), "type": t, "x": x, "y": y, "width": w, "height": h, "angle": 0, "strokeColor": "#1e1e1e", "backgroundColor": "transparent", "fillStyle": "solid", "strokeWidth": 1, "strokeStyle": "solid", "roughness": 0, "opacity": 100, "groupIds": [], "frameId": None, "roundness": None, "seed": seed(), "version": 1, "versionNonce": seed(), "isDeleted": False, "boundElements": [], "updated": 1, "link": None, "locked": False}
    e.update(k); els.append(e); return e
def box(x, y, w, h, text, bg="#ffffff", font=15):
    for ln in text.split("\n"):
        assert len(ln) * font * 0.55 <= w - 12, f"line too wide for box: {ln!r}"
    b = base("rectangle", x, y, w, h, backgroundColor=bg, roundness={"type": 3})
    t = base("text", x + 6, y + 6, w - 12, h - 12, text=text, fontSize=font, fontFamily=1, textAlign="center", verticalAlign="middle", containerId=b["id"], originalText=text, autoResize=False, lineHeight=1.25)
    b["boundElements"] = [{"id": t["id"], "type": "text"}]
    return {"id": b["id"], "x": x, "y": y, "w": w, "h": h}
def label(x, y, text, font=14, color="#1e1e1e"):
    base("text", x, y, len(text) * font * 0.55, font * 1.25, text=text, fontSize=font, fontFamily=1, textAlign="left", verticalAlign="top", strokeColor=color, originalText=text, autoResize=True, lineHeight=1.25)
def arrow(a, b, text="", side="lr", dashed=False):
    if side == "lr": x1, y1, x2, y2 = a["x"] + a["w"], a["y"] + a["h"] / 2, b["x"], b["y"] + b["h"] / 2
    elif side == "tb": x1, y1, x2, y2 = a["x"] + a["w"] / 2, a["y"] + a["h"], b["x"] + b["w"] / 2, b["y"]
    else: x1, y1, x2, y2 = a["x"], a["y"] + a["h"] / 2, b["x"] + b["w"], b["y"] + b["h"] / 2
    ar = base("arrow", x1, y1, abs(x2 - x1), abs(y2 - y1), points=[[0, 0], [x2 - x1, y2 - y1]], lastCommittedPoint=None, startBinding={"elementId": a["id"], "focus": 0, "gap": 2}, endBinding={"elementId": b["id"], "focus": 0, "gap": 2}, startArrowhead=None, endArrowhead="arrow", elbowed=False, roundness={"type": 2}, strokeStyle="dashed" if dashed else "solid")
    if text:
        w = len(text) * 13 * 0.6 + 8
        t = base("text", (x1 + x2) / 2 - w / 2, (y1 + y2) / 2 - 12, w, 24, text=text, fontSize=13, fontFamily=1, textAlign="center", verticalAlign="middle", containerId=ar["id"], originalText=text, autoResize=True, lineHeight=1.25)
        ar["boundElements"] = [{"id": t["id"], "type": "text"}]

DEV, SRV, MEM, KEY, LOCK, BAD = "#e0f2e9", "#fde9d9", "#e3ecfa", "#fff3c4", "#f1f1f1", "#fbe4e0"
C1, C2, C3, SX, MX = 40, 360, 550, 820, 1320
label(40, 20, "PETTY — where the keys come from, where they live, how they are used", 24)
label(40, 60, "Green = your device, memory only (never on disk).  Yellow = a secret made on your device.  Grey = server database (locked blobs + metadata only).  Blue = a member's device.", 13, "#555555")
box(C1, 100, 680, 44, "YOUR DEVICE (browser)", DEV, 18)
box(SX, 100, 440, 44, "SERVER DATABASE (Postgres)", SRV, 18)
box(MX, 100, 360, 44, "MEMBER'S DEVICE", MEM, 18)

label(40, 180, "1  SIGN-UP (join link)", 18)
typed = box(C1, 215, 300, 70, "You type:\nemail + login password", DEV)
users = box(SX, 215, 440, 70, "users: email + Argon2id HASH of the login password\n(proves who you are — touches no data)", LOCK, 14)
arrow(typed, users, "sent")
pp = box(C1, 305, 300, 70, "You type: VAULT PASSPHRASE\n(never leaves the device)", KEY)
wa = box(C2, 305, 170, 70, "Argon2id(passphrase)\n= wrap key A", DEV, 13)
vault = box(C3, 305, 170, 70, "VAULT = private keys\nlocked with A\n(AES-256-GCM)", DEV, 13)
svault = box(SX, 305, 440, 70, "users.vault  (locked blob)\nthe server cannot open it", LOCK, 14)
arrow(pp, wa); arrow(wa, vault); arrow(vault, svault, "sent")
gen = box(C1, 400, 300, 130, "Device generates (random):\n• ECDH P-256 keypair\n   → receives drawer keys\n• ECDSA P-256 keypair → signs entries\n• RECOVERY CODE (30 letters,\n   shown once)", KEY, 14)
pub = box(SX, 430, 440, 70, "user_keys: ecdh_pub, ecdsa_pub, sig_key_id\n(public; kept forever so old entries still verify)", LOCK, 14)
arrow(gen, pub, "public halves only")
wb = box(C2, 560, 170, 70, "HKDF(recovery code)\n= wrap key B", DEV, 13)
rvault = box(C3, 560, 170, 70, "RECOVERY VAULT =\nsame private keys\nlocked with B", DEV, 13)
srv2 = box(SX, 560, 440, 70, "users.recovery_vault  (locked blob)", LOCK, 14)
arrow(gen, wb); arrow(wb, rvault); arrow(rvault, srv2, "sent")
label(40, 650, "Private keys exist in the clear only inside your device. A database thief holds two locked blobs and can only guess passphrases, about 1 second per guess.", 13, "#8a6d1f")

label(40, 695, "2  UNLOCK / SESSION (every device, every 24 h)", 18)
unlock = box(C1, 730, 300, 90, "Passphrase → Argon2id → open VAULT\n→ private keys as NON-EXPORTABLE\nCryptoKey handles (bytes unreachable\neven from JavaScript)", DEV, 13)
idb = box(C2, 730, 360, 90, "IndexedDB keeps: key handles (24 h expiry),\nthe vault blob, bootstrap ciphertext (offline).\nNever a passphrase, a key, or decrypted data.", DEV, 13)
arrow(unlock, idb)
sess = box(SX, 730, 440, 90, "sessions: a login cookie hash\n(who you are — not what you can read)", LOCK, 14)
arrow(idb, sess, "login only")

label(40, 855, "3  A DRAWER: create, write, read", 18)
dkey = box(C1, 890, 300, 70, "Random DRAWER KEY\n(AES-256-GCM, one per drawer)", KEY, 14)
wrap = box(C2, 890, 360, 70, "Wrap the drawer key for MY public key\n(ECDH → HKDF → AES-KW)", DEV, 14)
swrap = box(SX, 890, 440, 70, "drawer_keys: my wrap\n(sender = me, key version)", LOCK, 14)
arrow(dkey, wrap); arrow(wrap, swrap, "sent")
doc = box(C1, 980, 300, 70, "Drawer document (name, lines,\nverifications) encrypted\nwith the drawer key", DEV, 13)
sdoc = box(SX, 980, 440, 70, "drawer_documents: ciphertext + version (optimistic lock)\nAAD binds it to this drawer", LOCK, 13)
arrow(doc, sdoc, "sent")
ent = box(C2, 1070, 360, 70, "Entry: signed with my ECDSA key,\nthen encrypted with the drawer key", DEV, 14)
sent = box(SX, 1070, 440, 70, "entries: ciphertext + line id, seq, author, is_checkpoint\n(never the amount, comment or line name)", LOCK, 13)
arrow(ent, sent, "append only")
read = box(C1, 1160, 680, 80, "READ: fetch my wrap → unwrap the drawer key with my private key\n→ decrypt document + entries → verify every signature and the hash links\n→ fold the balance. All of it in memory.", DEV, 14)
arrow(sent, read, "ciphertext back", side="rl", dashed=True)

label(40, 1285, "4  SHARING", 18)
share = box(C1, 1320, 680, 80, "Invite: look up the member → compare their SAFETY NUMBER\n(a fingerprint of their public keys) out of band → pin it\n→ unwrap the drawer key → re-wrap it for THEIR public key", DEV, 14)
mwrap = box(SX, 1320, 440, 80, "the invitation carries the wrap; on accept →\ndrawer_keys: their wrap (sender = me);\ntheir device checks the sender against its PINNED key", LOCK, 13)
arrow(share, mwrap, "sent")
mread = box(MX, 1320, 360, 80, "Unwrap with THEIR private key\n→ same reads and writes as in 3", MEM)
arrow(mwrap, mread, "on accept")
rot = box(MX, 1430, 360, 90, "Member removed → any writer makes\na NEW drawer key, wraps it for everyone left,\nand re-encrypts the old rows. The old key\nopens nothing written afterwards.", MEM, 13)
arrow(mread, rot, "removal", side="tb", dashed=True)

label(40, 1565, "5  NEW DEVICE / LOST PASSPHRASE — keys are never regenerated", 18)
nd = box(C1, 1600, 330, 90, "New device: login → the VAULT arrives\nfrom users.vault → passphrase → Argon2id\n→ the SAME private keys (same safety\nnumber, same wraps work)", DEV, 13)
rc = box(410, 1600, 310, 90, "Lost passphrase: the RECOVERY CODE\nopens users.recovery_vault → choose a\nnew passphrase → new VAULT uploaded;\nkeys unchanged", DEV, 13)
lost = box(SX, 1600, 440, 90, "Lost passphrase AND recovery code, drawer shared with\nnobody: unrecoverable, by design. Members of a shared\ndrawer can re-wrap its key for your new keypair.", BAD, 13)
open("docs/petty-keys.excalidraw", "w").write(json.dumps({"type": "excalidraw", "version": 2, "source": "petty docs", "elements": els, "appState": {"viewBackgroundColor": "#ffffff", "gridSize": None}, "files": {}}, indent=1))
print("elements", len(els))
