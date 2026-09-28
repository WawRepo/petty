import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Archive, ChevronDown, CircleCheck, Eye, MapPin, Pause, Play, Users } from "lucide-react";
import { formatAmount } from "@petty/ledger";
import { PIcon } from "../lib/icons.js";
import { Roll } from "./Roll.js";
import { SCENES, UseCaseArt, caseIcon, finaleScene } from "./UseCaseArt.js";

/**
 * "One idea, many uses" on the landing page (PETTY-248). Every example is built from the three pieces
 * the app is made of — places in a tree, drawers in places, items in drawers — but each has its own
 * shape: a deep tree or a wide one, one drawer with many items or many drawers with one each. Each
 * example has a picture (UseCaseArt) and a live mini app; going to the next example the picture's
 * bubbles travel to their new places while each line of the app reshapes (a place becomes a drawer
 * card, a card splits in two) and its words fade over to the new ones, top to bottom. After the six
 * examples a last step puts them together: one drawer from each, every one in its place. The examples
 * are picked from a row of their symbols joined to the picture (the same symbol as its middle); a
 * thumb slides to the one showing, and a ring round it fills until the next.
 *
 * Item colours mean something: money, things (counted) and notes (single items) — the app's three
 * kinds of line. Badges show sharing, a confirmed count and read-only access. Nothing here is a
 * feature the app lacks. Words come from the i18n dictionaries; amounts and currency codes are data,
 * and the examples use no local names or currency.
 *
 * Autoplay (WCAG 2.2.2): it plays by default, as soon as a little of the picture or the phone is in
 * view (PETTY-251), and a Pause button in the row stops it (and the picture's gentle floating, which
 * also stops off screen). It holds while a mouse is over the phone or the icon row — not anywhere over
 * the wide section, where a resting pointer would hold it for good — while keyboard focus is in it (a
 * mouse click's focus does not count, so a pick plays on), and while the tab is hidden. Picking an
 * example jumps there and plays on from it. Under reduced motion it still plays, but nothing slides,
 * pops or floats: things change place at once and the words and icons cross-fade (base.css).
 */

type Kind = "money" | "things" | "notes";
type Badge = "shared" | "confirmed" | "readonly";
interface Item { readonly key: string; readonly kind: Kind; readonly icon: string; readonly money?: readonly [minor: number, exponent: number, currency: string] }
interface Drawer { readonly key: string; readonly icon: string; readonly badge?: Badge; readonly items: readonly Item[] }
interface Place { readonly key: string; readonly drawers?: readonly Drawer[]; readonly kids?: readonly Place[] }
interface UseCase { readonly key: string; readonly root: Place }

const cash = (key: string, icon: string, minor: number, currency: string): Item => ({ key, kind: "money", icon, money: [minor, 2, currency] });
const thing = (key: string, icon: string): Item => ({ key, kind: "things", icon });
const note = (key: string, icon: string): Item => ({ key, kind: "notes", icon });

const CASES: readonly UseCase[] = [
  { key: "workshop", root: { key: "home", kids: [{ key: "basement", kids: [{ key: "workshop", drawers: [
    { key: "desk", icon: "box", items: [thing("zipties", "box"), thing("tape", "box")] },
    { key: "pegboard", icon: "wrench", items: [note("hammer", "wrench"), note("drill", "wrench")] },
  ] }] }] } },
  { key: "trip", root: { key: "trips", kids: [
    { key: "malaysia", drawers: [{ key: "kitty", icon: "plane", badge: "shared", items: [cash("anna", "wallet", 60000, "MYR"), cash("ben", "wallet", 15000, "MYR"), cash("cara", "wallet", 4500, "MYR")] }] },
    { key: "thailand", drawers: [{ key: "next", icon: "plane", items: [thing("passes", "card")] }] },
  ] } },
  { key: "accounts", root: { key: "paperwork", drawers: [
    { key: "pension", icon: "bank", badge: "confirmed", items: [cash("fund", "bank", 4820000, "EUR")] },
    { key: "brokerage", icon: "briefcase", badge: "confirmed", items: [cash("shares", "briefcase", 315000, "USD"), cash("cash", "wallet", 42000, "USD")] },
    { key: "savings", icon: "piggy-bank", badge: "confirmed", items: [cash("deposit", "piggy-bank", 1240000, "EUR")] },
  ] } },
  { key: "cash", root: { key: "home", kids: [
    { key: "kitchen", drawers: [{ key: "tin", icon: "coins", badge: "confirmed", items: [cash("groceries", "banknote", 24000, "EUR"), cash("coins", "coins", 3650, "EUR")] }] },
    { key: "bedroom", drawers: [{ key: "envelope", icon: "archive", items: [cash("emergency", "banknote", 50000, "EUR"), cash("holiday", "plane", 15000, "USD")] }] },
  ] } },
  { key: "lent", root: { key: "home", kids: [{ key: "garage", drawers: [
    { key: "lent", icon: "tag", badge: "shared", items: [note("drill", "wrench"), note("ladder", "box"), thing("chairs", "box")] },
    { key: "borrowed", icon: "gift", items: [note("tent", "backpack")] },
  ] }] } },
  { key: "family", root: { key: "home", kids: [{ key: "bedroom", kids: [{ key: "wardrobe", kids: [{ key: "safe", drawers: [
    { key: "documents", icon: "note", badge: "readonly", items: [thing("passports", "note"), thing("certificates", "note")] },
    { key: "valuables", icon: "gem", badge: "readonly", items: [note("ring", "gem"), note("carkey", "key")] },
  ] }] }] }] } },
];

/**
 * The stage is one list of lines: a place, a drawer card's head, or an item inside the card above it.
 * `ck` is the example whose words the line shows; a drawer with a `path` shows the places it is in.
 */
type Line =
  | { readonly t: "place"; readonly ck: string; readonly lvl: number; readonly key: string; readonly leaf: boolean }
  | { readonly t: "drawer"; readonly ck: string; readonly lvl: number; readonly key: string; readonly icon: string; readonly badge?: Badge; readonly solo: boolean; readonly path?: readonly string[] }
  | { readonly t: "item"; readonly ck: string; readonly lvl: number; readonly item: Item; readonly last: boolean };
function flatten(ck: string, p: Place, lvl = 0, out: Line[] = []): Line[] {
  out.push({ t: "place", ck, lvl, key: p.key, leaf: !!p.drawers?.length });
  for (const d of p.drawers ?? []) {
    out.push({ t: "drawer", ck, lvl: lvl + 1, key: d.key, icon: d.icon, ...(d.badge ? { badge: d.badge } : {}), solo: d.items.length === 0 });
    d.items.forEach((item, i) => out.push({ t: "item", ck, lvl: lvl + 1, item, last: i === d.items.length - 1 }));
  }
  for (const k of p.kids ?? []) flatten(ck, k, lvl + 1, out);
  return out;
}
/** A drawer and the places it is in, from the top of the tree. */
function locate(p: Place, key: string, above: readonly string[] = []): { d: Drawer; path: readonly string[] } | null {
  const path = [...above, p.key];
  const d = p.drawers?.find((x) => x.key === key);
  if (d) return { d, path };
  for (const k of p.kids ?? []) {
    const found = locate(k, key, path);
    if (found) return found;
  }
  return null;
}

/**
 * The last step: one drawer from each example, each card saying where it is — the places under the
 * top of its tree ("Basement › Workshop", not "Home › Basement › Workshop").
 */
const FINALE_DRAWERS: Readonly<Record<string, string>> = { workshop: "pegboard", trip: "kitty", accounts: "pension", cash: "tin", lent: "lent", family: "documents" };
const FINALE_LINES: readonly Line[] = CASES.map((c) => {
  const { d, path } = locate(c.root, FINALE_DRAWERS[c.key]!)!;
  return { t: "drawer", ck: c.key, lvl: 0, key: d.key, icon: d.icon, ...(d.badge ? { badge: d.badge } : {}), solo: true, path: path.length > 1 ? path.slice(1) : path };
});

const STEP_MS = 5500;    // how long one example stays
const FINALE_MS = 8000;  // the last picture stays longer
const STEPS: readonly { key: string; lines: readonly Line[]; ms: number }[] = [
  ...CASES.map((c) => ({ key: c.key, lines: flatten(c.key, c.root), ms: STEP_MS })),
  { key: "all", lines: FINALE_LINES, ms: FINALE_MS },
];
const SLOTS = Math.max(...STEPS.map((s) => s.lines.length));
const STAGGER_MS = 45;   // each line starts a beat after the one above it; the last is done by 9 × 45 + SWAP_MS
const BADGE_ICON: Record<Badge, ReactNode> = {
  shared: <Users size={13} strokeWidth={2.2} aria-hidden="true" />,
  confirmed: <CircleCheck size={13} strokeWidth={2.2} aria-hidden="true" />,
  readonly: <Eye size={13} strokeWidth={2.2} aria-hidden="true" />,
};

const keyboardFocus = (el: EventTarget | null): boolean => {
  try { return el instanceof Element && el.matches(":focus-visible"); } catch { return true; }
};

const reducedQuery = () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null);

export function UseCases() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const [reduced, setReduced] = useState(() => reducedQuery()?.matches ?? false);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [onScreen, setOnScreen] = useState(false);
  // the picture unfolds the first time it comes into view (at once under reduced motion)
  const [seen, setSeen] = useState(() => reducedQuery()?.matches ?? false);
  const [tabVisible, setTabVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  const sectionRef = useRef<HTMLElement>(null);
  const artRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const running = playing && !hover && !focus && onScreen && tabVisible;

  useEffect(() => {
    const q = reducedQuery();
    if (!q) return;
    const on = () => { setReduced(q.matches); if (q.matches) setSeen(true); };
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  useEffect(() => {
    const on = () => setTabVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  // A mouse over the phone or the icon row holds the autoplay (someone reading or picking). A finger's
  // tap does not count as hover, so a phone never gets stuck paused.
  useEffect(() => {
    const els = [stageRef.current, dockRef.current].filter((e): e is HTMLDivElement => !!e);
    const over = new Set<EventTarget>();
    const enter = (e: PointerEvent) => { if (e.pointerType === "mouse" && e.currentTarget) { over.add(e.currentTarget); setHover(true); } };
    const leave = (e: PointerEvent) => { if (e.currentTarget) over.delete(e.currentTarget); setHover(over.size > 0); };
    for (const el of els) { el.addEventListener("pointerenter", enter); el.addEventListener("pointerleave", leave); }
    return () => { for (const el of els) { el.removeEventListener("pointerenter", enter); el.removeEventListener("pointerleave", leave); } };
  }, []);
  // Keyboard focus in the section holds it too; only focus a keyboard put there (:focus-visible), since
  // a mouse click also focuses the button it hits.
  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const focusIn = (e: FocusEvent) => setFocus(keyboardFocus(e.target));
    const focusOut = (e: FocusEvent) => { if (!el.contains(e.relatedTarget as Node | null)) setFocus(false); };
    el.addEventListener("focusin", focusIn);
    el.addEventListener("focusout", focusOut);
    return () => {
      el.removeEventListener("focusin", focusIn);
      el.removeEventListener("focusout", focusOut);
    };
  }, []);
  // The demo is on screen while a little (15%) of its picture or its phone is in view: on a laptop the
  // demo starts low on the first screen, and what can be seen should move (PETTY-251). On a phone the
  // two are far apart, and either one alone is worth playing for.
  useEffect(() => {
    const els = [artRef.current, stageRef.current].filter((e): e is HTMLDivElement => !!e);
    if (typeof IntersectionObserver === "undefined") { setOnScreen(true); setSeen(true); return; }
    const inView = new Map<Element, boolean>();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) inView.set(e.target, e.intersectionRatio >= 0.15);
      const visible = [...inView.values()].some(Boolean);
      setOnScreen(visible);
      if (visible) setSeen(true);
    }, { threshold: [0, 0.15, 0.5, 1] });
    for (const el of els) io.observe(el);
    return () => io.disconnect();
  }, []);

  const next = useCallback(() => setIdx((i) => (i + 1) % STEPS.length), []);
  useEffect(() => {
    if (!running) return;
    const h = window.setTimeout(next, STEPS[idx]!.ms);
    return () => window.clearTimeout(h);
  }, [running, idx, next]);
  const pick = (i: number) => setIdx(i);

  const step = STEPS[idx]!;
  const title = t(`landing.uses.cases.${step.key}.title`);
  const scene = step.key === "all" ? finaleScene((key) => t(`landing.uses.cases.${key}.chip`)) : SCENES[step.key]!;
  const at = (slot: number) => (reduced ? 0 : slot * STAGGER_MS);

  const content = (l: Line): ReactNode => {
    const k = `landing.uses.cases.${l.ck}`;
    if (l.t === "place") {
      return (
        <span className="uc-place">
          <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
          <span className={`uc-place-name${l.leaf ? " leaf" : ""}`}>{t(`${k}.places.${l.key}`)}</span>
        </span>
      );
    }
    if (l.t === "drawer") {
      return (
        <span className="uc-row">
          <span className="tile k-drawer" aria-hidden="true"><PIcon name={l.icon} size={18} /></span>
          <span className="uc-txt">
            <span className="uc-dname" data-testid="use-case-drawer">{t(`${k}.drawers.${l.key}.name`)}</span>
            {l.path
              ? <span className="uc-meta uc-path" data-testid="use-case-path"><MapPin size={12} strokeWidth={2.2} aria-hidden="true" />{l.path.map((p) => t(`${k}.places.${p}`)).join(" › ")}</span>
              : <span className={`uc-meta${l.badge ? ` b-${l.badge}` : ""}`}>{l.badge ? BADGE_ICON[l.badge] : null}{t(`${k}.drawers.${l.key}.meta`)}</span>}
          </span>
          {l.path && l.badge ? <span className={`uc-badge b-${l.badge}`} aria-hidden="true">{BADGE_ICON[l.badge]}</span> : null}
        </span>
      );
    }
    const it = l.item;
    const ik = `${k}.items.${it.key}`;
    const itemNote = i18n.exists(`${ik}.note`) ? t(`${ik}.note`) : null;
    const value = it.money
      ? <>{formatAmount(it.money[0], it.money[1], locale)} <span className="cur">{it.money[2]}</span></>
      : i18n.exists(`${ik}.value`) ? t(`${ik}.value`) : null;
    return (
      <span className="uc-row">
        <span className={`tile k-${it.kind}`} aria-hidden="true"><PIcon name={it.icon} size={15} /></span>
        <span className="uc-txt">
          <span className="uc-iname">{t(`${ik}.name`)}</span>
          {itemNote ? <span className="uc-note">{itemNote}</span> : null}
        </span>
        {value ? <span className="uc-val">{value}</span> : null}
      </span>
    );
  };

  return (
    <section ref={sectionRef} className={`usecases${playing && onScreen && tabVisible ? "" : " paused"}`} aria-labelledby="uses-title" data-testid="use-cases">
      <div className="uc-intro">
        <h2 id="uses-title" className="landing-h2">{t("landing.uses.title")}</h2>
        <p className="hint m0">{t("landing.uses.sub")}</p>
        {/* the idea in one line, in the picture's colours: a plain place, the drawer, coloured items */}
        <p className="uc-formula" aria-hidden="true">
          <span className="uc-f"><MapPin size={14} strokeWidth={2.2} />{t("landing.uses.legend.place")}</span>
          <span className="sep">›</span>
          <span className="uc-f uc-f-drawer"><Archive size={14} strokeWidth={2.2} />{t("landing.uses.legend.drawer")}</span>
          <span className="sep">›</span>
          <span className="uc-f"><span className="dot k-money" /><span className="dot k-things" /><span className="dot k-notes" />{t("landing.uses.legend.items")}</span>
        </p>
      </div>

      <UseCaseArt ref={artRef} scene={scene} sceneKey={step.key} seen={seen} />

      <div ref={dockRef} className="uc-dock" role="group" aria-label={t("landing.uses.pick")} style={{ "--sel": idx } as CSSProperties}>
        <span className="uc-dock-thumb" aria-hidden="true">
          {running ? (
            <svg key={idx} className="uc-ring" viewBox="0 0 40 40"><circle cx="20" cy="20" r="17" pathLength={100} style={{ animationDuration: `${step.ms}ms` }} /></svg>
          ) : null}
        </span>
        {STEPS.map((x, i) => {
          const Icon = caseIcon(x.key);
          return (
            <button type="button" key={x.key} className="uc-tab" aria-pressed={i === idx} aria-controls="uc-stage" onClick={() => pick(i)} data-testid={`use-case-${x.key}`}>
              <Icon size={19} strokeWidth={2} aria-hidden="true" />
              <span className="uc-tab-name">{t(`landing.uses.cases.${x.key}.chip`)}</span>
            </button>
          );
        })}
        <span className="uc-dock-sep" aria-hidden="true" />
        <button type="button" className="uc-tab uc-toggle" onClick={() => setPlaying((p) => !p)} data-testid="use-case-toggle">
          {playing ? <Pause size={18} strokeWidth={2.2} aria-hidden="true" /> : <Play size={18} strokeWidth={2.2} aria-hidden="true" />}
          <span className="uc-tab-name">{playing ? t("landing.uses.pause") : t("landing.uses.play")}</span>
        </button>
      </div>

      <Roll k={`${step.key}-${locale}-caption`} className="uc-caption">
        <span className="uc-caption-body" data-testid="use-case-caption">
          <span className="uc-kicker">{t(`landing.uses.cases.${step.key}.chip`)}</span>
          <span className="uc-title">{title}</span>
          <span className="hint">{t(`landing.uses.cases.${step.key}.body`)}</span>
        </span>
      </Roll>

      <div
        ref={stageRef}
        id="uc-stage"
        className="uc-stage"
        role="group"
        aria-label={t("landing.uses.demo", { title })}
        aria-live={running ? "off" : "polite"}
        data-testid="use-case-stage"
        data-case={step.key}
      >
        <ul className="uc-lines" aria-label={t("landing.uses.legend.all")}>
          {Array.from({ length: SLOTS }, (_, i) => {
            const l = step.lines[i];
            const cls = !l ? "t-none"
              : `t-${l.t}${l.lvl > 0 && l.t !== "item" ? " nested" : ""}${l.t === "drawer" && l.solo ? " solo" : ""}${l.t === "item" && l.last ? " last" : ""}`;
            return (
              <li key={i} className={`uc-line ${cls}`} style={{ "--lvl": l?.lvl ?? 0, "--d": `${at(i)}ms` } as CSSProperties} aria-hidden={l ? undefined : true}>
                <Roll k={l ? `${step.key}-${locale}-${i}` : `none-${i}`} delay={at(i)} className="uc-line-body">{l ? content(l) : null}</Roll>
              </li>
            );
          })}
        </ul>
        <p className="uc-kinds">
          <span className="k-money">{t("landing.uses.legend.money")}</span>
          <span className="k-things">{t("landing.uses.legend.things")}</span>
          <span className="k-notes">{t("landing.uses.legend.notes")}</span>
        </p>
      </div>
    </section>
  );
}
