import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { Line } from "@petty/ledger";
import { KIND_CLASS, PIcon, lineIcon } from "../lib/icons.js";
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

function Bubble({ cls, style, vt, name, up, onClick, onEnter, children }: {
  cls: string; style: CSSProperties; vt?: string; name?: string; up?: boolean; onClick?: () => void; onEnter?: () => void; children: ReactNode;
}) {
  return (
    <span className={`uc-bub sat ${cls}`} style={style} aria-hidden="true">
      <span className="uc-bub-float">
        <span className={`uc-bub-disc${onClick ? " clickable" : ""}`}>
          {children}
          {onClick ? <Hit name={name ?? ""} vt={vt} up={up ?? false} onClick={onClick} onEnter={onEnter} /> : null}
        </span>
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
export function DrawerArt({ drawerId, lines, center, icon, centerName, onCenter, onLine, testId }: {
  drawerId: string; lines: readonly Line[]; center: ReactNode; icon: string | null; centerName: string;
  onCenter: () => void; onLine: (line: Line) => void; testId?: string;
}) {
  const ring = useRing(lines.length);
  const geo = { rot: ring.rot, rx: 30, ry: 33, wobble: ring.slots >= 4 ? 0.08 : 0 };
  const vt = vtName("d", drawerId);
  return (
    <div className="uc-art app-art drawer-art" data-testid={testId} data-count={lines.length}>
      <span className="uc-halo" aria-hidden="true" />
      {lines.map((l, i) => <span key={l.id} className={`uc-spoke${ring.inRun(i) ? " off" : ""}`} style={orbit(geo, ring.slots, ring.slotOf(i))} aria-hidden="true" />)}
      {ring.hidden ? <span key={ring.moreKey} className="uc-spoke" style={orbit(geo, ring.slots, ring.moreSlot)} aria-hidden="true" /> : null}
      {lines.map((l, i) => (
        <Bubble key={l.id} cls={`${KIND_CLASS[l.kind]}${ring.inRun(i) ? " off" : ""}`} style={orbit(geo, ring.slots, ring.slotOf(i))} vt={vtName("l", l.id)} name={l.name}
          onClick={() => { if (!ring.settling()) onLine(l); }}>
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
  drawers: readonly { readonly id: string; readonly icon: string; readonly name: string }[];
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
        <Bubble key={d.id} cls={`k-case${ring.inRun(i) ? " off" : ""}`} style={orbit(geo, ring.slots, ring.slotOf(i))} vt={vtName("d", d.id)} name={d.name} up={up(ring.slotOf(i))}
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
