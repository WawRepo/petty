import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, CircleCheck, Eye, Pause, Play, Users } from "lucide-react";
import { formatAmount } from "@petty/ledger";
import { PIcon } from "../lib/icons.js";

/**
 * "One idea, many uses" on the landing page (PETTY-248). Every example is built from the three pieces
 * the app is made of — places in a tree, drawers in places, items in drawers — but each has its own
 * shape: a deep tree or a wide one, one drawer with many items or many drawers with one each. One
 * example turns into the next line by line: each line of the stage reshapes (a place becomes a drawer
 * card, a card splits in two) and its words roll to the new ones, top to bottom.
 *
 * Item colours mean something: money, things (counted) and notes (single items) — the app's three
 * kinds of line. Badges show sharing, a confirmed count and read-only access. Nothing here is a
 * feature the app lacks. Words come from the i18n dictionaries; amounts and currency codes are data,
 * and the examples use no local names or currency.
 *
 * Autoplay (WCAG 2.2.2): a Pause button; it also holds while a mouse is over the section or keyboard
 * focus is in it, while the demo is off screen or the tab is hidden; it never starts under reduced
 * motion; and picking an example stops it for good.
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

/** The stage is one list of lines: a place, a drawer card's head, or an item inside the card above it. */
type Line =
  | { readonly t: "place"; readonly lvl: number; readonly key: string; readonly leaf: boolean }
  | { readonly t: "drawer"; readonly lvl: number; readonly key: string; readonly icon: string; readonly badge?: Badge; readonly solo: boolean }
  | { readonly t: "item"; readonly lvl: number; readonly item: Item; readonly last: boolean };
function flatten(p: Place, lvl = 0, out: Line[] = []): Line[] {
  out.push({ t: "place", lvl, key: p.key, leaf: !!p.drawers?.length });
  for (const d of p.drawers ?? []) {
    out.push({ t: "drawer", lvl: lvl + 1, key: d.key, icon: d.icon, ...(d.badge ? { badge: d.badge } : {}), solo: d.items.length === 0 });
    d.items.forEach((item, i) => out.push({ t: "item", lvl: lvl + 1, item, last: i === d.items.length - 1 }));
  }
  for (const k of p.kids ?? []) flatten(k, lvl + 1, out);
  return out;
}
const LINES = CASES.map((c) => flatten(c.root));
const SLOTS = Math.max(...LINES.map((l) => l.length));
export const USE_CASE_KEYS = CASES.map((c) => c.key);

const STEP_MS = 5500;   // how long one example stays
const ROLL_MS = 470;    // the new words finish rolling in by then (90 ms offset + 380 ms, .morph-in in base.css)
const STAGGER_MS = 45;  // each line starts a beat after the one above it
const BADGE_ICON: Record<Badge, ReactNode> = {
  shared: <Users size={13} strokeWidth={2.2} aria-hidden="true" />,
  confirmed: <CircleCheck size={13} strokeWidth={2.2} aria-hidden="true" />,
  readonly: <Eye size={13} strokeWidth={2.2} aria-hidden="true" />,
};

const reducedQuery = () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null);

/**
 * One line of the demo. When `k` changes, the previous content rolls up and out while the new rolls
 * in, after `delay` ms. Only the current content is live; the leaving copy is hidden from assistive tech.
 */
function Roll({ k, delay = 0, className = "", children }: { k: string; delay?: number; className?: string; children: ReactNode }) {
  const last = useRef<{ k: string; node: ReactNode }>({ k, node: children });
  const [prev, setPrev] = useState<{ k: string; node: ReactNode } | null>(null);
  useLayoutEffect(() => {
    if (last.current.k !== k) setPrev(last.current);
    last.current = { k, node: children };
  }, [k, children]);
  useEffect(() => {
    if (!prev) return;
    const h = window.setTimeout(() => setPrev(null), ROLL_MS + delay + 40);
    return () => window.clearTimeout(h);
  }, [prev, delay]);
  const style = { "--d": `${delay}ms` } as CSSProperties;
  return (
    <span className={`morph ${className}`}>
      {prev ? <span key={`out-${prev.k}`} className="morph-out" style={style} aria-hidden="true">{prev.node}</span> : null}
      <span key={`in-${k}`} className={prev ? "morph-in" : "morph-now"} style={style}>{children}</span>
    </span>
  );
}

export function UseCases() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const [reduced, setReduced] = useState(() => reducedQuery()?.matches ?? false);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(() => !(reducedQuery()?.matches ?? false));
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [onScreen, setOnScreen] = useState(false);
  const [tabVisible, setTabVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  const sectionRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const running = playing && !hover && !focus && onScreen && tabVisible;

  useEffect(() => {
    const q = reducedQuery();
    if (!q) return;
    const on = () => { setReduced(q.matches); if (q.matches) setPlaying(false); };
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  useEffect(() => {
    const on = () => setTabVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  // A mouse over the section, or keyboard focus in it, holds the autoplay. A finger's tap does not
  // count as hover, so a phone never gets stuck paused.
  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const enter = (e: PointerEvent) => { if (e.pointerType === "mouse") setHover(true); };
    const leave = () => setHover(false);
    const focusIn = () => setFocus(true);
    const focusOut = (e: FocusEvent) => { if (!el.contains(e.relatedTarget as Node | null)) setFocus(false); };
    el.addEventListener("pointerenter", enter);
    el.addEventListener("pointerleave", leave);
    el.addEventListener("focusin", focusIn);
    el.addEventListener("focusout", focusOut);
    return () => {
      el.removeEventListener("pointerenter", enter);
      el.removeEventListener("pointerleave", leave);
      el.removeEventListener("focusin", focusIn);
      el.removeEventListener("focusout", focusOut);
    };
  }, []);
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof IntersectionObserver === "undefined") { setOnScreen(true); return; }
    const io = new IntersectionObserver(([e]) => setOnScreen(!!e && e.intersectionRatio >= 0.5), { threshold: [0, 0.5, 1] });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const next = useCallback(() => setIdx((i) => (i + 1) % CASES.length), []);
  useEffect(() => {
    if (!running) return;
    const h = window.setTimeout(next, STEP_MS);
    return () => window.clearTimeout(h);
  }, [running, idx, next]);
  const pick = (i: number) => { setPlaying(false); setIdx(i); };

  const c = CASES[idx]!;
  const lines = LINES[idx]!;
  const k = `landing.uses.cases.${c.key}`;
  const title = t(`${k}.title`);
  const at = (slot: number) => (reduced ? 0 : slot * STAGGER_MS);

  const content = (l: Line): ReactNode => {
    if (l.t === "place") {
      return (
        <span className="uc-place">
          <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
          <span className="uc-place-name">{t(`${k}.places.${l.key}`)}</span>
        </span>
      );
    }
    if (l.t === "drawer") {
      return (
        <span className="uc-row">
          <span className="tile k-drawer" aria-hidden="true"><PIcon name={l.icon} size={18} /></span>
          <span className="uc-txt">
            <span className="uc-dname" data-testid="use-case-drawer">{t(`${k}.drawers.${l.key}.name`)}</span>
            <span className={`uc-meta${l.badge ? ` b-${l.badge}` : ""}`}>{l.badge ? BADGE_ICON[l.badge] : null}{t(`${k}.drawers.${l.key}.meta`)}</span>
          </span>
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
    <section ref={sectionRef} className="usecases" aria-labelledby="uses-title" data-testid="use-cases">
      <div className="uc-intro">
        <h2 id="uses-title" className="landing-h2">{t("landing.uses.title")}</h2>
        <p className="hint m0">{t("landing.uses.sub")}</p>
      </div>

      <div
        ref={stageRef}
        id="uc-stage"
        className="uc-stage"
        role="group"
        aria-label={t("landing.uses.demo", { title })}
        aria-live={running ? "off" : "polite"}
        data-testid="use-case-stage"
        data-case={c.key}
      >
        <p className="uc-legend" aria-hidden="true">
          <span>{t("landing.uses.legend.place")}</span><span className="sep">›</span><span>{t("landing.uses.legend.drawer")}</span><span className="sep">›</span><span>{t("landing.uses.legend.items")}</span>
        </p>
        <ul className="uc-lines" aria-label={t("landing.uses.legend.all")}>
          {Array.from({ length: SLOTS }, (_, i) => {
            const l = lines[i];
            const cls = !l ? "t-none"
              : `t-${l.t}${l.lvl > 0 && l.t !== "item" ? " nested" : ""}${l.t === "place" && l.leaf ? " leaf" : ""}${l.t === "drawer" && l.solo ? " solo" : ""}${l.t === "item" && l.last ? " last" : ""}`;
            return (
              <li key={i} className={`uc-line ${cls}`} style={{ "--lvl": l?.lvl ?? 0, "--d": `${at(i)}ms` } as CSSProperties} aria-hidden={l ? undefined : true}>
                <Roll k={l ? `${c.key}-${locale}-${i}` : `none-${i}`} delay={at(i)} className="uc-line-body">{l ? content(l) : null}</Roll>
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

      <Roll k={`${c.key}-${locale}-caption`} className="uc-caption">
        <span className="uc-caption-body" data-testid="use-case-caption">
          <span className="uc-title">{title}</span>
          <span className="hint">{t(`${k}.body`)}</span>
        </span>
      </Roll>

      <div className="uc-controls">
        <div className="uc-chips" role="group" aria-label={t("landing.uses.pick")}>
          {CASES.map((x, i) => (
            <button type="button" key={x.key} className="tag-chip uc-chip" aria-pressed={i === idx} aria-controls="uc-stage" onClick={() => pick(i)} data-testid={`use-case-${x.key}`}>
              {t(`landing.uses.cases.${x.key}.chip`)}
              {i === idx && running && !reduced ? <span key={idx} className="uc-progress" style={{ animationDuration: `${STEP_MS}ms` }} aria-hidden="true" /> : null}
            </button>
          ))}
        </div>
        <button type="button" className="btn btn-ghost uc-toggle" onClick={() => setPlaying((p) => !p)} data-testid="use-case-toggle">
          {playing ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
          {playing ? t("landing.uses.pause") : t("landing.uses.play")}
        </button>
      </div>
    </section>
  );
}
