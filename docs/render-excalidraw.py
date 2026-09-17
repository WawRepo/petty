#!/usr/bin/env python3
"""Minimal renderer for our own .excalidraw files (rectangles with bound text, free text, straight arrows) → SVG."""
import json, sys, html
src, out = sys.argv[1], sys.argv[2]
d = json.load(open(src))
els = d["elements"]
byid = {e["id"]: e for e in els}
xs = [e["x"] for e in els] + [e["x"] + e.get("width", 0) for e in els]
ys = [e["y"] for e in els] + [e["y"] + e.get("height", 0) for e in els]
W, H = max(xs) + 40, max(ys) + 40
o = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W:.0f}" height="{H:.0f}" viewBox="0 0 {W:.0f} {H:.0f}" font-family="Helvetica, Arial, sans-serif">',
     '<defs><marker id="ah" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#1e1e1e"/></marker></defs>',
     f'<rect width="{W:.0f}" height="{H:.0f}" fill="#ffffff"/>']
def text_lines(e):
    return e["text"].split("\n")
for e in els:
    if e["type"] == "rectangle":
        o.append(f'<rect x="{e["x"]}" y="{e["y"]}" width="{e["width"]}" height="{e["height"]}" rx="8" fill="{e["backgroundColor"]}" stroke="{e["strokeColor"]}" stroke-width="1.2"/>')
for e in els:
    if e["type"] == "arrow":
        (x0, y0), (dx, dy) = e["points"]
        x1, y1, x2, y2 = e["x"] + x0, e["y"] + y0, e["x"] + dx, e["y"] + dy
        dash = ' stroke-dasharray="6,5"' if e.get("strokeStyle") == "dashed" else ""
        o.append(f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" stroke="{e["strokeColor"]}" stroke-width="1.4" marker-end="url(#ah)"{dash}/>')
for e in els:
    if e["type"] != "text": continue
    lines = text_lines(e); fs = e["fontSize"]; lh = fs * 1.25
    if e.get("containerId") and e["containerId"] in byid and byid[e["containerId"]]["type"] == "rectangle":
        c = byid[e["containerId"]]
        cx = c["x"] + c["width"] / 2; cy = c["y"] + c["height"] / 2 - (len(lines) - 1) * lh / 2
        for i, ln in enumerate(lines):
            o.append(f'<text x="{cx:.1f}" y="{cy + i * lh:.1f}" font-size="{fs}" text-anchor="middle" dominant-baseline="middle" fill="{e["strokeColor"]}">{html.escape(ln)}</text>')
    elif e.get("containerId") and e["containerId"] in byid and byid[e["containerId"]]["type"] == "arrow":
        # arrow label: white background box at the midpoint
        tw = max(len(ln) for ln in lines) * fs * 0.55 + 10
        o.append(f'<rect x="{e["x"] + e["width"] / 2 - tw/2:.1f}" y="{e["y"]:.1f}" width="{tw:.1f}" height="{lh:.1f}" fill="#ffffff"/>')
        for i, ln in enumerate(lines):
            o.append(f'<text x="{e["x"] + e["width"] / 2:.1f}" y="{e["y"] + lh/2 + i*lh:.1f}" font-size="{fs}" text-anchor="middle" dominant-baseline="middle" fill="{e["strokeColor"]}">{html.escape(ln)}</text>')
    else:
        for i, ln in enumerate(lines):
            o.append(f'<text x="{e["x"]}" y="{e["y"] + fs + i * lh:.1f}" font-size="{fs}" fill="{e["strokeColor"]}">{html.escape(ln)}</text>')
o.append("</svg>")
open(out, "w").write("\n".join(o))
print(f"wrote {out} ({W:.0f}x{H:.0f})")
