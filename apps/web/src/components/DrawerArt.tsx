import type { CSSProperties, ReactNode } from "react";
import type { Line } from "@petty/ledger";
import { KIND_CLASS, PIcon, lineIcon } from "../lib/icons.js";
import { orbit } from "./UseCaseArt.js";

/**
 * The app's pictures (PETTY-250), in the landing page's look: bubbles round a middle, joined by
 * dashed spokes, drawn by the same CSS as the landing's (base.css, "the picture"). Bubbles are keyed
 * by what they show, so a reorder sends them round the middle to their new places, a new one pops in
 * and the others make room. More than six show as five and a "+N".
 */
const MAX = 6;

function fit<T>(all: readonly T[]): { shown: readonly T[]; more: number; n: number } {
  const more = all.length > MAX ? all.length - (MAX - 1) : 0;
  const shown = more ? all.slice(0, MAX - 1) : all;
  return { shown, more, n: shown.length + (more ? 1 : 0) };
}
/** A balanced start for each count: one on top, two side by side, three as a triangle, four as an X. */
const start = (n: number) => (n % 2 === 0 ? -90 + 180 / n : -90);

function Bubble({ cls, style, children }: { cls: string; style: CSSProperties; children: ReactNode }) {
  return (
    <span className={`uc-bub sat ${cls}`} style={style} aria-hidden="true">
      <span className="uc-bub-float"><span className="uc-bub-disc">{children}</span></span>
    </span>
  );
}

/**
 * A drawer: its photo or icon in the middle, its lines around it, each in its kind's colour. The lines
 * are decorative here (the list below names them); `center` is the middle — the photo with its alt text
 * and test id, or the icon tile (`.tile[data-icon]`, which the drawer tests read).
 */
export function DrawerArt({ lines, center, testId }: { lines: readonly Line[]; center: ReactNode; testId?: string }) {
  const { shown, more, n } = fit(lines);
  const geo = { rot: start(n), rx: 30, ry: 33, wobble: n >= 4 ? 0.08 : 0 };
  return (
    <div className="uc-art app-art drawer-art" data-testid={testId} data-count={lines.length}>
      <span className="uc-halo" aria-hidden="true" />
      {shown.map((l, i) => <span key={l.id} className="uc-spoke" style={orbit(geo, n, i)} aria-hidden="true" />)}
      {more ? <span key="more" className="uc-spoke" style={orbit(geo, n, n - 1)} aria-hidden="true" /> : null}
      {shown.map((l, i) => <Bubble key={l.id} cls={KIND_CLASS[l.kind]} style={orbit(geo, n, i)}><PIcon name={lineIcon(l)} /></Bubble>)}
      {more ? <Bubble key="more" cls="k-plain" style={orbit(geo, n, n - 1)}><span className="uc-more">+{more}</span></Bubble> : null}
      <span className="uc-bub center"><span className="uc-bub-float">{center}</span></span>
    </div>
  );
}

/** The home with every drawer around it on one ring — the landing's last picture, small, for the Home total. */
export function HomeArt({ drawers }: { drawers: readonly { readonly id: string; readonly icon: string }[] }) {
  const { shown, more, n } = fit(drawers);
  const geo = { rot: start(n), rx: 36, ry: 36 };
  return (
    <div className="uc-art app-art home-art" aria-hidden="true" data-testid="home-art" data-count={drawers.length}>
      <span className="uc-orbit" style={{ "--uc-rx": geo.rx, "--uc-ry": geo.ry } as CSSProperties} />
      {shown.map((d, i) => <span key={d.id} className="uc-spoke" style={orbit(geo, n, i)} />)}
      {shown.map((d, i) => <Bubble key={d.id} cls="k-case" style={orbit(geo, n, i)}><PIcon name={d.icon} /></Bubble>)}
      {more ? <Bubble key="more" cls="k-case" style={orbit(geo, n, n - 1)}><span className="uc-more">+{more}</span></Bubble> : null}
      <span className="uc-bub center"><span className="uc-bub-float"><span className="uc-bub-disc"><PIcon name="home" /></span></span></span>
    </div>
  );
}
