#!/usr/bin/env python3
"""Generates docs/petty-token.excalidraw — a companion to petty-keys for ACCESS TOKENS
(PETTY-164/169/181/184). Same layout rule: one arrow per row, no arrow crosses a box; every
text line fits its box. Reuses the same helpers/colours as generate-keys-diagram.py."""
import json, random
random.seed(23)
els = []
def nid(): return "%08x" % random.getrandbits(32)
def seed(): return random.getrandbits(31)
def base(t, x, y, w, h, **k):
    e = {"id": nid(), "type": t, "x": x, "y": y, "width": w, "height": h, "angle": 0, "strokeColor": "#1e1e1e", "backgroundColor": "transparent", "fillStyle": "solid", "strokeWidth": 1, "strokeStyle": "solid", "roughness": 0, "opacity": 100, "groupIds": [], "frameId": None, "roundness": None, "seed": seed(), "version": 1, "versionNonce": seed(), "isDeleted": False, "boundElements": [], "updated": 1, "link": None, "locked": False}
    e.update(k); els.append(e); return e
def box(x, y, w, h, text, bg="#ffffff", font=15):
    for ln in text.split("\n"):
        assert len(ln) * font * 0.55 <= w - 12, f"line too wide for box ({w}): {ln!r}"
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

DEV, SRV, TOOL, KEY, LOCK, BAD = "#e0f2e9", "#fde9d9", "#e3ecfa", "#fff3c4", "#f1f1f1", "#fbe4e0"
C1, C2, SX, TX = 40, 360, 820, 1320
label(40, 20, "PETTY ACCESS TOKENS — how a tool gets keys without ever giving up end-to-end encryption", 24)
label(40, 60, "Green = your device (the Petty app), memory only.  Yellow = a secret made on your device.  Grey = server database (locked blobs + metadata only).  Blue = the tool's machine (Claude Desktop / MCP).", 13, "#555555")
box(C1, 100, 680, 44, "YOUR DEVICE (browser)", DEV, 18)
box(SX, 100, 440, 44, "SERVER DATABASE (Postgres)", SRV, 18)
box(TX, 100, 360, 44, "THE TOOL'S MACHINE", TOOL, 18)

# 1  MAKE A TOKEN
label(40, 175, "1  MAKE A TOKEN  (Settings -> Access tokens)", 18)
typed = box(C1, 210, 300, 70, "You: name it, pick read or write,\nconfirm with passphrase or passkey", DEV, 14)
proof = box(SX, 210, 440, 70, "POST /me/tokens needs a CUSTODY PROOF:\na challenge signed by your account key\n(a stolen session alone cannot make one)", LOCK, 13)
arrow(typed, proof, "proof")
gen = box(C1, 300, 300, 92, "Device makes (all random):\n- token id + secret\n- the token's own ECDH keypair\n- write token: its own ECDSA keypair", KEY, 13)
bundle = box(C2, 300, 400, 92, "BUNDLE = drawer keys you can open + the token's\nECDH private key (+ the write ECDSA key), sealed\nwith HKDF(secret), AES-256-GCM. The server is\nhanded a blob it cannot open.", DEV, 13)
sbundle = box(SX, 300, 440, 92, "access_tokens: token_hash = SHA-256(id half),\nsealed bundle (nonce + ciphertext),\necdh_pub, and for a write token\necdsa_pub + sig_key_id + delegation (all public)", LOCK, 13)
arrow(gen, bundle); arrow(bundle, sbundle, "sent")
deleg = box(C1, 412, 300, 76, "A write token also gets its OWN\nECDSA key. Your account key signs a\ndelegation vouching for it.", DEV, 13)
trust = box(C2, 412, 400, 76, "Recorded in your sealed user document:\nthe token's key fingerprint + its scope.\nOnly tokens you listed here ever get keys.", DEV, 13)
arrow(deleg, trust)
note1 = box(SX, 412, 440, 76, "The secret half NEVER reaches the server.\nOnly the id half does. The delegation is public,\nso others can later check what the token signed.", LOCK, 13)
arrow(trust, note1, "id half only")

# the token string, handed to the tool
shown = box(TX, 300, 360, 92, "petty_pat_<id>.<secret>\nShown once. You paste it into the tool.\n<id> = names the token to the server\n<secret> = opens the bundle, on this machine", KEY, 13)

label(40, 545, "The server stores a locked bundle and an id hash. Without the secret it cannot open the bundle or read any drawer.", 13, "#8a6d1f")

# 2  THE TOOL USES IT
label(40, 590, "2  THE TOOL USES IT  (petty-mcp / the agent, on your computer)", 18)
hold = box(TX, 625, 360, 70, "Holds the token string. Sends only:\nAuthorization: Bearer petty_pat_<id>\n(the secret half stays on this machine)", TOOL, 13)
look = box(SX, 625, 440, 70, "Looks up the token by SHA-256(id half),\nreturns the sealed bundle + who it belongs to.\nRefused if revoked, expired or out of scope.", LOCK, 13)
arrow(hold, look, "id half", side="rl")
openb = box(TX, 715, 360, 70, "HKDF(secret) -> open the bundle ->\ndrawer keys + ECDH private (+ ECDSA private),\nin memory on this machine only", TOOL, 13)
arrow(look, openb, "bundle back", side="lr", dashed=True)
readt = box(TX, 805, 360, 70, "Reads: unwrap the drawer key -> decrypt\nthe document + entries, verify signatures,\nfold the balance -- all in memory here", TOOL, 13)
arrow(openb, readt, side="tb")
writet = box(TX, 895, 360, 76, "Write token: signs each entry with ITS OWN\nECDSA key (never your account key), then\nencrypts it with the drawer key and appends it", TOOL, 13)
arrow(readt, writet, side="tb")
sentries = box(SX, 895, 440, 76, "entries: ciphertext + line id, seq, author,\nsig_key_id (the token's).  Append-only:\nno UPDATE, no DELETE for the app role.", LOCK, 13)
arrow(writet, sentries, "append", side="rl")

# 3  DRAWERS MADE LATER
label(40, 1000, "3  DRAWERS MADE LATER reach the token by themselves", 18)
later = box(C1, 1035, 300, 76, "You make a drawer, or one is shared.\nYour app wraps its key for the token's\nECDH public key, like for a member.", DEV, 13)
swrap = box(SX, 1035, 440, 76, "access_token_keys: one wrap per drawer\nand key version, made by you for this token.\nA token can never widen past your own drawers.", LOCK, 13)
arrow(later, swrap, "sent")
tunwrap = box(TX, 1035, 360, 76, "Unwraps with the token's ECDH private key\n-> sees the new drawer next time it starts.\nNo new token needed.", TOOL, 13)
arrow(swrap, tunwrap, "on next start", side="lr")

# 4  TRUST, REVOKE, DELETE
label(40, 1140, "4  TRUST, REVOKE, DELETE", 18)
verify = box(C1, 1175, 300, 92, "A member's app checks a token-signed\nentry through the account-signed\ndelegation: accepted only while the\ntoken has not expired or been revoked.", DEV, 13)
revoke = box(SX, 1175, 440, 92, "Revoke: the id stops working at once.\nAccount delete ERASES the bundle and the wraps,\nbut keeps the public delegation, so entries the\ntoken already wrote still verify for everyone.", LOCK, 13)
arrow(verify, revoke)
limits = box(TX, 1175, 360, 92, "A token is weaker than a session.\nIt can never open the vault, the account,\nsharing, admin, export, or make another token.\nThe server refuses every route off its list.", BAD, 13)
arrow(revoke, limits, "allow-list")

label(40, 1290, "Same promise as a person's keys: the plaintext lives only on a machine that holds the secret. The server, and anyone who reads its database, sees ciphertext.", 13, "#8a6d1f")

open("docs/petty-token.excalidraw", "w").write(json.dumps({"type": "excalidraw", "version": 2, "source": "petty docs", "elements": els, "appState": {"viewBackgroundColor": "#ffffff", "gridSize": None}, "files": {}}, indent=1))
print("elements", len(els))
