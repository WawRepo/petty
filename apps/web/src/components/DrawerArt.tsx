import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { MapPin } from "lucide-react";
import type { Line } from "@petty/ledger";
import { KIND_CLASS, PIcon, colorClass, lineIcon } from "../lib/icons.js";
import { orbit } from "./UseCaseArt.js";

/**
 * The app's pictures (PETTY-250), in the landing page's look: bubbles round a middle, joined by
 * dashed spokes, drawn by the same CSS as the landing's (base.css, "the picture"). Bubbles are keyed
 * by what they show, so a reorder sends them round the middle to their new places, a new one pops in
 * and the others make room. A ring holds six: past that, a "+N" stands for the rest (useRing).
 *
 * Every bubble is a shortcut, as the landing's pictures are: a tap opens what it shows, and its bubble
 * grows into the next screen's picture (useMorph; `vt` is the shared view-transition name). Only the
 * tapped bubble takes the name, at the tap: a named bubble on the arriving screen would be frozen
 * mid-pop by the browser for the length of the change. The targets (a drawer's middle, a line's
 * bubble) carry their names always. The shortcuts repeat the screen's own list (a drawer's lines, the
 * Home drawers, the ⋯ options), so they stay out of the tab order and the accessibility tree; the list
 * is the keyboard and screen-reader path. Their names show on hover.
 */
const MAX = 6;

/** A balanced start for each count: one on top, two side by side, three as a triangle, four as an X. */
const start = (n: number) => (n % 2 === 0 ? -90 + 180 / n : -90);
/** The shared view-transition name of a bubble and of what it grows into. */
export const vtName = (kind: "d" | "l", id: string) => `${kind}-${id}`;
const vtStyle = (vt: string | undefined): CSSProperties | undefined => (vt ? { viewTransitionName: vt } : undefined);

/**
 * A ring with room for six. With more items, one "+N" bubble stands for a run of N of them. Pointing at
 * it (or tapping it) opens it: the N items come out of it — it bursts as they leave — while N items on
 * the far side of the ring slide together into a new "+N" there. Every item keeps its own bubble all the
 * time (a hidden one waits folded where its "+N" is), so each change is one glide: out of the "+N",
 * round the ring, or into the new "+N".
 */
function useRing(total: number) {
  const hidden = total > MAX ? total - (MAX - 1) : 0;
  const [runStart, setRunStart] = useState<number | null>(null);
  const [burst, setBurst] = useState<{ key: string; slot: number; n: number } | null>(null);
  const opened = useRef(-Infinity); // when a "+N" last opened (performance.now())
  useEffect(() => {
    if (!burst) return;
    const h = window.setTimeout(() => setBurst(null), 450);
    return () => window.clearTimeout(h);
  }, [burst]);
  const s = hidden ? (((runStart ?? total - hidden) % total) + total) % total : 0;
  const inRun = (i: number) => hidden > 0 && (i - s + total) % total < hidden;
  const order: (number | "more")[] = [];
  for (let i = 0; i < total; i++) if (!inRun(i)) order.push(i); else if (i === s) order.push("more");
  const moreSlot = order.indexOf("more");
  return {
    hidden, inRun, moreSlot, burst,
    slots: order.length,
    rot: start(order.length),
    moreKey: `more-${s}`,
    slotOf: (i: number) => (inRun(i) ? moreSlot : order.indexOf(i)),
    open: () => {
      if (!hidden) return;
      opened.current = performance.now();
      setBurst({ key: `burst-${s}-${opened.current}`, slot: moreSlot, n: hidden });
      setRunStart((s + Math.round(total / 2)) % total);
    },
    /** A click right after opening would land on a bubble that has just arrived under the pointer. */
    settling: () => performance.now() - opened.current < 450,
  };
}
type Ring = ReturnType<typeof useRing>;

/**
 * The invisible button over a disc, and the name that shows on hover — above the disc when `up` (a bubble
 * in the top half of a small picture, so the name does not cover the middle). `vt`: the name its disc
 * takes when tapped. `onEnter`: what a mouse pointing at it does (a "+N" opens).
 */
function Hit({ name, vt, up = false, onClick, onEnter }: { name: string; vt?: string | undefined; up?: boolean; onClick: () => void; onEnter?: (() => void) | undefined }) {
  return (
    <button type="button" className={`uc-bub-hit${up ? " up" : ""}`} tabIndex={-1} aria-hidden="true"
      onPointerEnter={onEnter ? (e) => { if (e.pointerType === "mouse") onEnter(); } : undefined}
      onClick={(e) => {
        if (vt) (e.currentTarget.parentElement as HTMLElement).style.viewTransitionName = vt;
        onClick();
      }}>
      <span className="uc-bub-tip">{name}</span>
    </button>
  );
}

/** Where a bubble's name sits: on the side away from the middle; at the left and right of a full ring, beside it. */
type Side = "above" | "below" | "left" | "right";

function Bubble({ cls, style, vt, name, up, label, onClick, onEnter, children }: {
  cls: string; style: CSSProperties; vt?: string; name?: string; up?: boolean; label?: { text: string; side: Side };
  onClick?: () => void; onEnter?: () => void; children: ReactNode;
}) {
  return (
    <span className={`uc-bub sat ${cls}`} style={style} aria-hidden="true">
      <span className="uc-bub-float">
        {/* data-vt: a morph back to this screen finds the bubble it shrinks into (useMorphBack) */}
        <span className={`uc-bub-disc${onClick ? " clickable" : ""}`} data-vt={vt}>
          {children}
          {onClick ? <Hit name={name ?? ""} vt={vt} up={up ?? false} onClick={onClick} onEnter={onEnter} /> : null}
        </span>
        {label ? <span className={`uc-bub-name ${label.side}`}>{label.text}</span> : null}
      </span>
    </span>
  );
}

/** The ring's "+N", and the burst of the one that just opened. */
function More({ ring, geo, cls, up }: { ring: Ring; geo: { rot: number; rx: number; ry: number; wobble?: number }; cls: string; up?: (slot: number) => boolean }) {
  return (
    <>
      {ring.burst ? (
        <span key={ring.burst.key} className={`uc-bub sat ${cls} uc-more-burst`} style={orbit(geo, ring.slots, ring.burst.slot)} aria-hidden="true">
          <span className="uc-bub-float"><span className="uc-bub-disc"><span className="uc-more">+{ring.burst.n}</span></span></span>
        </span>
      ) : null}
      {ring.hidden ? (
        <Bubble key={ring.moreKey} cls={`${cls} uc-more-bub`} style={orbit(geo, ring.slots, ring.moreSlot)} up={up?.(ring.moreSlot) ?? false} onClick={ring.open} onEnter={ring.open}>
          <span className="uc-more">+{ring.hidden}</span>
        </Bubble>
      ) : null}
    </>
  );
}

/**
 * A drawer: its photo or icon in the middle, its lines around it, each in its kind's colour. A line's
 * bubble opens the line; the middle opens the drawer's options. `center` is the middle's content — the
 * photo with its alt text and test id, or the icon — inside a disc that carries the drawer's
 * view-transition name (the Home bubble grows into it) and the `.tile[data-icon]` the tests read.
 */
export function DrawerArt({ drawerId, lines, center, icon, color, centerName, onCenter, onLine, testId }: {
  drawerId: string; lines: readonly Line[]; center: ReactNode; icon: string | null; color: string | null; centerName: string;
  onCenter: () => void; onLine: (line: Line) => void; testId?: string;
}) {
  const ring = useRing(lines.length);
  // PETTY-269: every line shows its name, so the ring is flatter and wider, with room above and below it
  const geo = { rot: ring.rot, rx: 32, ry: 25, wobble: ring.slots >= 4 ? 0.08 : 0 };
  const side = (slot: number): Side => {
    const a = ((geo.rot + (360 / ring.slots) * slot) * Math.PI) / 180;
    if (Math.sin(a) < -0.5) return "above";
    if (Math.sin(a) > 0.5 || ring.slots < 5) return "below";
    return Math.cos(a) > 0 ? "right" : "left";
  };
  const vt = vtName("d", drawerId);
  return (
    <div className={`uc-art app-art drawer-art named ${colorClass(color)}`} data-testid={testId} data-count={lines.length}>
      <span className="uc-halo" aria-hidden="true" />
      {lines.map((l, i) => <span key={l.id} className={`uc-spoke${ring.inRun(i) ? " off" : ""}`} style={orbit(geo, ring.slots, ring.slotOf(i))} aria-hidden="true" />)}
      {ring.hidden ? <span key={ring.moreKey} className="uc-spoke" style={orbit(geo, ring.slots, ring.moreSlot)} aria-hidden="true" /> : null}
      {lines.map((l, i) => (
        <Bubble key={l.id} cls={`${KIND_CLASS[l.kind]}${ring.inRun(i) ? " off" : ""}`} style={orbit(geo, ring.slots, ring.slotOf(i))} vt={vtName("l", l.id)} name={l.name}
          label={{ text: l.name, side: side(ring.slotOf(i)) }} onClick={() => { if (!ring.settling()) onLine(l); }}>
          <PIcon name={lineIcon(l)} />
        </Bubble>
      ))}
      <More ring={ring} geo={geo} cls="k-plain" />
      <span className="uc-bub center">
        <span className="uc-bub-float">
          <span className={`uc-bub-disc clickable${icon ? " tile" : " photo"}`} style={vtStyle(vt)} data-vt={vt} {...(icon ? { "data-icon": icon, "aria-hidden": true } : {})}>
            {center}
            <Hit name={centerName} onClick={onCenter} />
          </span>
        </span>
      </span>
    </div>
  );
}

/**
 * The home with the drawers of the view on one ring round it — the landing's last picture, small, for
 * the Home total. A drawer's bubble opens the drawer; while a place is picked, the home clears it.
 */
export function HomeArt({ drawers, onDrawer, onHome, homeName }: {
  drawers: readonly { readonly id: string; readonly icon: string; readonly name: string; readonly color: string | null }[];
  onDrawer: (id: string) => void; onHome?: (() => void) | undefined; homeName: string;
}) {
  const ring = useRing(drawers.length);
  const geo = { rot: ring.rot, rx: 36, ry: 36 };
  const up = (slot: number) => Math.sin(((geo.rot + (360 / ring.slots) * slot) * Math.PI) / 180) < -0.3;
  return (
    <div className="uc-art app-art home-art" aria-hidden="true" data-testid="home-art" data-count={drawers.length}>
      <span className="uc-orbit" style={{ "--uc-rx": geo.rx, "--uc-ry": geo.ry } as CSSProperties} />
      {drawers.map((d, i) => <span key={d.id} className={`uc-spoke${ring.inRun(i) ? " off" : ""}`} style={orbit(geo, ring.slots, ring.slotOf(i))} />)}
      {ring.hidden ? <span key={ring.moreKey} className="uc-spoke" style={orbit(geo, ring.slots, ring.moreSlot)} /> : null}
      {drawers.map((d, i) => (
        <Bubble key={d.id} cls={`k-case ${colorClass(d.color)}${ring.inRun(i) ? " off" : ""}`} style={orbit(geo, ring.slots, ring.slotOf(i))} vt={vtName("d", d.id)} name={d.name} up={up(ring.slotOf(i))}
          onClick={() => { if (!ring.settling()) onDrawer(d.id); }}>
          <PIcon name={d.icon} />
        </Bubble>
      ))}
      <More ring={ring} geo={geo} cls="k-case" up={up} />
      <span className="uc-bub center">
        <span className="uc-bub-float">
          <span className={`uc-bub-disc${onHome ? " clickable" : ""}`}>
            <PIcon name="home" />
            {onHome ? <Hit name={homeName} onClick={onHome} /> : null}
          </span>
        </span>
      </span>
    </div>
  );
}

/**
 * PETTY-257: the Home picture with places. The place in view is the middle — the home at the top, the
 * picked place below that. Its places and the drawers kept right in it stand on the first ring; round
 * each place a fan of small bubbles shows what is in it (its places and drawers; a "+N" for more than
 * fit). A place's bubble picks it, as its chip does, and the picture goes one level down: the place
 * glides to the middle and its small bubbles grow into the first ring, while the levels above wait as
 * small bubbles in the top-left corner. The middle, or a corner bubble, goes back up.
 *
 * A level that holds one place and nothing else would draw one lonely bubble (a house with every room in
 * "Home"): the first ring shows what is in that place instead, and its name labels the middle.
 *
 * Every place and drawer keeps one bubble all the time: one out of view folds into its nearest bubble in
 * view (the place it is in, the "+N" it is counted in, or a corner bubble), so each change is one glide.
 * The bubbles are shortcuts for the chips and the list, like the other pictures: out of the tab order.
 */
export interface ArtDrawer { readonly id: string; readonly icon: string; readonly name: string; readonly color: string | null }
export interface ArtPlace { readonly path: readonly string[]; readonly name: string; readonly places: readonly ArtPlace[]; readonly drawers: readonly ArtDrawer[] }

type SpotKind = "center" | "crumb" | "place" | "sub" | "drawer" | "sat" | "more" | "more2";
interface Spot { readonly kind: SpotKind; readonly x: number; readonly y: number; readonly size: number; readonly label?: "above" | "below"; readonly text?: string }
interface Link { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number; readonly style: "spoke" | "thin" | "crumb" }
type Item = { readonly p: ArtPlace } | { readonly d: ArtDrawer };

const placeKey = (path: readonly string[]) => `p:${path.join("\u0001")}`;
const drawerKey = (id: string) => `d:${id}`;
const itemKey = (it: Item) => ("p" in it ? placeKey(it.p.path) : drawerKey(it.d.id));
const itemsOf = (p: ArtPlace): Item[] => [...p.places.map((q) => ({ p: q })), ...p.drawers.map((d) => ({ d }))];
const countIn = (p: ArtPlace): number => p.drawers.length + p.places.reduce((a, q) => a + countIn(q), 0);
/** The place whose content a ring shows: through every level that holds one place and nothing else. */
const through = (p: ArtPlace): ArtPlace => (p.places.length === 1 && p.drawers.length === 0 ? through(p.places[0]!) : p);

/** Where each bubble stands for this view, in px of a picture `w` wide. `turn` turns the first ring when it holds more than six. */
export function placesLayout(view: ArtPlace, trail: readonly ArtPlace[], w: number, turn: number) {
  const s = w / 306;
  const top = trail.length ? 30 * s : 0;
  const cx = w / 2, cy = top + 150 * s, rx = 100 * s, ry = 90 * s, r2 = 40 * s;
  const spots = new Map<string, Spot>(), links = new Map<string, Link>(), fold = new Map<string, string>();
  const more: { key: string; n: number; place: ArtPlace | null }[] = [];
  trail.forEach((p, i) => {
    const x = (18 + i * 34) * s, y = 16 * s;
    spots.set(placeKey(p.path), { kind: "crumb", x, y, size: 26 * s });
    if (i > 0) links.set(placeKey(p.path), { x1: x - 34 * s, y1: y, x2: x, y2: y, style: "crumb" });
  });
  const inner = through(view);
  spots.set(placeKey(view.path), { kind: "center", x: cx, y: cy, size: 62 * s, ...(inner !== view || view.path.length ? { label: "below" as const, text: inner.name } : {}) });
  // the first ring: six at most, else five and a "+N" that the rest fold into
  const items = itemsOf(inner);
  const hidden = items.length > 6 ? items.length - 5 : 0;
  const from = hidden ? ((turn % items.length) + items.length) % items.length : 0;
  const shown = hidden ? [...items.slice(from), ...items.slice(0, from)].slice(0, 5) : items;
  const moreKey = `m:${placeKey(view.path)}`;
  if (hidden) for (const it of items) if (!shown.includes(it)) fold.set(itemKey(it), moreKey);
  const n = shown.length + (hidden ? 1 : 0);
  [...shown, ...(hidden ? [null] : [])].forEach((it, i) => {
    const deg = (n % 2 === 0 ? -90 + 180 / n : -90) + (360 / n) * i;
    const sin = Math.sin((deg * Math.PI) / 180), cos = Math.cos((deg * Math.PI) / 180);
    const x = cx + rx * cos, y = cy + ry * sin;
    const key = it ? itemKey(it) : moreKey;
    links.set(key, { x1: cx, y1: cy, x2: x, y2: y, style: "spoke" });
    if (!it) { spots.set(key, { kind: "more", x, y, size: 38 * s }); more.push({ key, n: hidden, place: null }); return; }
    if ("d" in it) { spots.set(key, { kind: "drawer", x, y, size: 38 * s, label: sin < -0.3 ? "above" : "below" }); return; }
    // a place: its name on the side away from its small bubbles; at the left and right the fan turns up and the name goes below
    const side = Math.abs(sin) <= 0.3;
    spots.set(key, { kind: "place", x, y, size: 44 * s, label: side || sin < 0 ? "below" : "above" });
    const inner = itemsOf(it.p), cap = n >= 5 ? 3 : 4;
    const fan = inner.length > cap ? inner.slice(0, cap - 1) : inner;
    const rest = inner.length > cap ? inner.length - (cap - 1) : 0;
    const more2 = `m2:${key}`;
    if (rest) for (const q of inner) if (!fan.includes(q)) fold.set(itemKey(q), more2);
    const m = fan.length + (rest ? 1 : 0);
    const spread = m <= 1 ? 0 : Math.min(48 * (m - 1), n >= 5 ? 110 : 150);
    const at = side ? deg - 45 * Math.sign(cos) : deg;
    [...fan, ...(rest ? [null] : [])].forEach((q, j) => {
      const d2 = (((at - spread / 2 + (m <= 1 ? 0 : (spread / (m - 1)) * j)) * Math.PI) / 180);
      const sx = x + r2 * Math.cos(d2), sy = y + r2 * Math.sin(d2);
      const k = q ? itemKey(q) : more2;
      links.set(k, { x1: x, y1: y, x2: sx, y2: sy, style: "thin" });
      if (!q) { spots.set(k, { kind: "more2", x: sx, y: sy, size: Math.max(20, 22 * s) }); more.push({ key: k, n: rest, place: it.p }); }
      else spots.set(k, { kind: "p" in q ? "sub" : "sat", x: sx, y: sy, size: Math.max(20, 22 * s) });
    });
  });
  // the height fits what is drawn — the ring, the bubbles and their names — right under the corner bubbles
  const pad = 8 * s, name = 24;
  let lo = cy - ry, hi = cy + ry;
  for (const sp of spots.values()) {
    if (sp.kind === "crumb") continue;
    lo = Math.min(lo, sp.y - sp.size / 2 - (sp.label === "above" ? name : 0));
    hi = Math.max(hi, sp.y + sp.size / 2 + (sp.label === "below" ? name : 0));
  }
  const up = lo - pad - top;
  for (const [k, sp] of spots) if (sp.kind !== "crumb") spots.set(k, { ...sp, y: sp.y - up });
  for (const [k, l] of links) if (l.style !== "crumb") links.set(k, { ...l, y1: l.y1 - up, y2: l.y2 - up });
  return { w, h: Math.round(hi - up + pad), cx, cy: cy - up, rx, ry, spots, links, fold, more };
}

export function PlacesArt({ root, selected, onPick, onDrawer, backName }: {
  root: ArtPlace; selected: readonly string[];
  onPick: (path: readonly string[]) => void; onDrawer: (id: string) => void; backName: (to: ArtPlace) => string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  // The width is measured before the picture is first drawn (a layout effect, before the paint). Drawn at
  // a guess and then at its real width, every bubble glided across and the list below jumped, each time
  // Home opened — Back from a drawer too, under its morph (PETTY-271).
  const [w, setW] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const fit = (width: number) => setW(Math.max(250, Math.min(400, Math.round(width))));
    fit(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => { if (e) fit(e.contentRect.width); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // the place in view (a path that no longer exists stops at its longest live part), and the levels above it
  const trail: ArtPlace[] = [];
  let view = root;
  for (const seg of selected) {
    const next = view.places.find((p) => p.path[p.path.length - 1] === seg);
    if (!next) break;
    trail.push(view); view = next;
  }
  const viewKey = placeKey(view.path);
  const [turn, setTurn] = useState({ view: viewKey, by: 0 });
  const by = turn.view === viewKey ? turn.by : 0;
  if (w === null) return <div className="places-art-wrap" ref={wrap} />;
  const L = placesLayout(view, trail, w, by);

  // every place and drawer, in one order that does not change with the view (a moved node would not glide)
  const all: { key: string; parent: string | null; item: Item }[] = [];
  const walk = (p: ArtPlace, parent: string | null) => {
    const k = placeKey(p.path);
    all.push({ key: k, parent, item: { p } });
    for (const q of p.places) walk(q, k);
    for (const d of p.drawers) all.push({ key: drawerKey(d.id), parent: k, item: { d } });
  };
  walk(root, null);
  const parentOf = new Map(all.map((a) => [a.key, a.parent]));
  const home = (key: string): Spot => {
    let k: string | null | undefined = key;
    while (k && !L.spots.has(k)) k = L.fold.get(k) ?? parentOf.get(k);
    return L.spots.get(k ?? "") ?? L.spots.get(placeKey(view.path))!;
  };
  // Only transforms and opacity animate, so the browser moves layers without laying the page out again
  // on every frame: a bubble is a point moved by translate, its disc scales from its old size (PaDisc),
  // and the lines are redrawn where they belong, fading in once the bubbles have arrived.
  const line = (key: string, l: Link) => {
    const a = (Math.atan2(l.y2 - l.y1, l.x2 - l.x1) * 180) / Math.PI;
    return <span key={`s${key}`} className={`pa-spoke ${l.style}`} style={{ transform: `translate(${l.x1}px, ${l.y1}px) rotate(${a}deg)`, width: Math.hypot(l.x2 - l.x1, l.y2 - l.y1) }} />;
  };
  const at = (sp: Spot): CSSProperties => ({ transform: `translate3d(${sp.x}px, ${sp.y}px, 0)` });
  const sizeOf = (sp: Spot, shown: boolean) => (shown ? sp.size : Math.min(12, sp.size));
  const label = (sp: Spot | undefined, size: number, text: string) =>
    sp?.label ? <span className={`pa-label ${sp.label}`} style={{ "--off": `${size / 2 + 4}px` } as CSSProperties}>{text}</span> : null;
  const up = (sp: Spot) => sp.y < L.cy - 8;
  const parentPath = trail.length ? trail[trail.length - 1]! : null;

  return (
    <div className="places-art-wrap" ref={wrap}>
      <div className="places-art" aria-hidden="true" data-testid="places-art" data-view={view.path.join("/")} data-count={countIn(view)} style={{ width: L.w, height: L.h }}>
        <span className="pa-lines" key={`${viewKey}:${by}`}>
          <span className="pa-halo" style={{ left: L.cx - L.rx * 1.2, top: L.cy - L.rx * 1.2, width: L.rx * 2.4, height: L.rx * 2.4 }} />
          <span className="pa-orbit" style={{ left: L.cx - L.rx, top: L.cy - L.ry, width: L.rx * 2, height: L.ry * 2 }} />
          {[...L.links].map(([k, l]) => line(k, l))}
        </span>
        {all.map(({ key, item }) => {
          const sp = L.spots.get(key), shown = !!sp, where = sp ?? home(key), size = sizeOf(where, shown);
          if ("d" in item) {
            const d = item.d, vt = vtName("d", d.id);
            return (
              <span key={key} className={`pa-bub ${sp?.kind ?? "sat"} ${colorClass(d.color)}${shown ? "" : " off"}`} style={at(where)} data-key={key}>
                <PaDisc size={size} vt={vt}>
                  <PIcon name={d.icon} />
                  {shown ? <Hit name={d.name} vt={vt} up={up(where)} onClick={() => onDrawer(d.id)} /> : null}
                </PaDisc>
                {label(sp, size, d.name)}
              </span>
            );
          }
          const p = item.p, kind = sp?.kind ?? "sub";
          const pick = kind === "center" ? (parentPath ? () => onPick(parentPath.path) : null) : () => onPick(p.path);
          const tip = kind === "center" ? (parentPath ? backName(parentPath) : "") : kind === "crumb" ? backName(p) : p.name;
          return (
            <span key={key} className={`pa-bub ${kind}${shown ? "" : " off"}`} style={at(where)} data-key={key}>
              <PaDisc size={size}>
                {p.path.length ? <MapPin size={22} strokeWidth={1.8} aria-hidden="true" /> : <PIcon name="home" />}
                {shown && pick ? <Hit name={tip} up={up(where)} onClick={pick} /> : null}
              </PaDisc>
              {label(sp, size, sp?.text ?? p.name)}
            </span>
          );
        })}
        {L.more.map((m) => {
          const sp = L.spots.get(m.key)!;
          return (
            <span key={m.key} className={`pa-bub ${sp.kind}`} style={at(sp)} data-key={m.key}>
              <PaDisc size={sp.size}>
                <span className="pa-more">+{m.n}</span>
                <Hit name="" up={up(sp)} onClick={m.place ? () => onPick(m.place!.path) : () => setTurn({ view: viewKey, by: by + 5 })} />
              </PaDisc>
            </span>
          );
        })}
      </div>
    </div>
  );
}

/**
 * A bubble's disc, centred on its bubble. A new size is set at once and played as a scale from the old
 * one (FLIP), so the disc grows or shrinks on the GPU and nothing is laid out again frame by frame.
 * `vt`: the view-transition name a morph back to Home looks for (data-vt), not set as a style.
 */
function PaDisc({ size, vt, children }: { size: number; vt?: string; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const was = useRef(size);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || was.current === size) return;
    const from = was.current / size;
    was.current = size;
    el.style.transition = "none";
    el.style.transform = `scale(${from})`;
    void el.offsetWidth; // the old size is on screen before the transition starts
    el.style.transition = "";
    el.style.transform = "";
  }, [size]);
  return (
    <span ref={ref} className="pa-disc" data-vt={vt} style={{ width: size, height: size, left: -size / 2, top: -size / 2, "--sz": `${size}px` } as CSSProperties}>
      {children}
    </span>
  );
}
