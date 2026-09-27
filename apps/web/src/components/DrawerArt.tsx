import type { CSSProperties, ReactNode } from "react";
import type { Line } from "@petty/ledger";
import { KIND_CLASS, PIcon, lineIcon } from "../lib/icons.js";
import { orbit } from "./UseCaseArt.js";

/**
 * The app's pictures (PETTY-250), in the landing page's look: bubbles round a middle, joined by
 * dashed spokes, drawn by the same CSS as the landing's (base.css, "the picture"). Bubbles are keyed
 * by what they show, so a reorder sends them round the middle to their new places, a new one pops in
 * and the others make room. More than six show as five and a "+N".
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

function fit<T>(all: readonly T[]): { shown: readonly T[]; more: number; n: number } {
  const more = all.length > MAX ? all.length - (MAX - 1) : 0;
  const shown = more ? all.slice(0, MAX - 1) : all;
  return { shown, more, n: shown.length + (more ? 1 : 0) };
}
/** A balanced start for each count: one on top, two side by side, three as a triangle, four as an X. */
const start = (n: number) => (n % 2 === 0 ? -90 + 180 / n : -90);
/** The shared view-transition name of a bubble and of what it grows into. */
export const vtName = (kind: "d" | "l", id: string) => `${kind}-${id}`;
const vtStyle = (vt: string | undefined): CSSProperties | undefined => (vt ? { viewTransitionName: vt } : undefined);

/** The invisible button over a disc, and the name that shows on hover. `vt`: the name its disc takes when tapped. */
function Hit({ name, vt, onClick }: { name: string; vt?: string | undefined; onClick: () => void }) {
  return (
    <button type="button" className="uc-bub-hit" tabIndex={-1} aria-hidden="true" onClick={(e) => {
      if (vt) (e.currentTarget.parentElement as HTMLElement).style.viewTransitionName = vt;
      onClick();
    }}>
      <span className="uc-bub-tip">{name}</span>
    </button>
  );
}

function Bubble({ cls, style, vt, name, onClick, children }: { cls: string; style: CSSProperties; vt?: string; name?: string; onClick?: () => void; children: ReactNode }) {
  return (
    <span className={`uc-bub sat ${cls}`} style={style} aria-hidden="true">
      <span className="uc-bub-float">
        <span className={`uc-bub-disc${onClick ? " clickable" : ""}`}>
          {children}
          {onClick && name ? <Hit name={name} vt={vt} onClick={onClick} /> : null}
        </span>
      </span>
    </span>
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
  const { shown, more, n } = fit(lines);
  const geo = { rot: start(n), rx: 30, ry: 33, wobble: n >= 4 ? 0.08 : 0 };
  const vt = vtName("d", drawerId);
  return (
    <div className="uc-art app-art drawer-art" data-testid={testId} data-count={lines.length}>
      <span className="uc-halo" aria-hidden="true" />
      {shown.map((l, i) => <span key={l.id} className="uc-spoke" style={orbit(geo, n, i)} aria-hidden="true" />)}
      {more ? <span key="more" className="uc-spoke" style={orbit(geo, n, n - 1)} aria-hidden="true" /> : null}
      {shown.map((l, i) => (
        <Bubble key={l.id} cls={KIND_CLASS[l.kind]} style={orbit(geo, n, i)} vt={vtName("l", l.id)} name={l.name} onClick={() => onLine(l)}>
          <PIcon name={lineIcon(l)} />
        </Bubble>
      ))}
      {more ? <Bubble key="more" cls="k-plain" style={orbit(geo, n, n - 1)}><span className="uc-more">+{more}</span></Bubble> : null}
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
  const { shown, more, n } = fit(drawers);
  const geo = { rot: start(n), rx: 36, ry: 36 };
  return (
    <div className="uc-art app-art home-art" aria-hidden="true" data-testid="home-art" data-count={drawers.length}>
      <span className="uc-orbit" style={{ "--uc-rx": geo.rx, "--uc-ry": geo.ry } as CSSProperties} />
      {shown.map((d, i) => <span key={d.id} className="uc-spoke" style={orbit(geo, n, i)} />)}
      {shown.map((d, i) => (
        <Bubble key={d.id} cls="k-case" style={orbit(geo, n, i)} vt={vtName("d", d.id)} name={d.name} onClick={() => onDrawer(d.id)}>
          <PIcon name={d.icon} />
        </Bubble>
      ))}
      {more ? <Bubble key="more" cls="k-case" style={orbit(geo, n, n - 1)}><span className="uc-more">+{more}</span></Bubble> : null}
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
