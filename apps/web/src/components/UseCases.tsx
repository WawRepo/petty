import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Pause, Play } from "lucide-react";
import { formatAmount } from "@petty/ledger";
import { PIcon } from "../lib/icons.js";

/**
 * "One idea, many uses" on the landing page (PETTY-248). Every example has the same shape — three
 * levels of places, a drawer in the last one, four items in the drawer — which is all the app is.
 * One example turns into the next slot by slot: each place, the drawer and each item roll from the
 * old words to the new, top to bottom, so nothing is ever blank. Nothing here is a feature the app
 * lacks. Words come from the i18n dictionaries; amounts and currency codes are data, and the examples
 * use no local names or currency.
 *
 * Autoplay (WCAG 2.2.2): a Pause button; it also holds while the pointer or keyboard focus is in the
 * section, while the demo is off screen or the tab is hidden; it never starts under reduced motion;
 * and picking an example stops it for good.
 */

type Item = { readonly key: string; readonly icon: string; readonly money?: readonly [minor: number, exponent: number, currency: string] };
interface UseCase { readonly key: string; readonly icon: string; readonly items: readonly [Item, Item, Item, Item] }

const CASES: readonly UseCase[] = [
  { key: "workshop", icon: "wrench", items: [{ key: "hammer", icon: "wrench" }, { key: "zipties", icon: "box" }, { key: "tape", icon: "box" }, { key: "screws", icon: "box" }] },
  { key: "trip", icon: "plane", items: [{ key: "anna", icon: "wallet", money: [60000, 2, "MYR"] }, { key: "ben", icon: "wallet", money: [15000, 2, "MYR"] }, { key: "cara", icon: "wallet", money: [4500, 2, "MYR"] }, { key: "dan", icon: "wallet", money: [12000, 2, "MYR"] }] },
  { key: "accounts", icon: "bank", items: [{ key: "pension", icon: "bank", money: [4820000, 2, "EUR"] }, { key: "brokerage", icon: "briefcase", money: [315000, 2, "USD"] }, { key: "savings", icon: "piggy-bank", money: [1240000, 2, "EUR"] }, { key: "gold", icon: "coins" }] },
  { key: "cash", icon: "coins", items: [{ key: "groceries", icon: "banknote", money: [124000, 2, "EUR"] }, { key: "holiday", icon: "plane", money: [15000, 2, "USD"] }, { key: "jar", icon: "coins", money: [3650, 2, "EUR"] }, { key: "emergency", icon: "banknote", money: [50000, 2, "EUR"] }] },
  { key: "lent", icon: "tag", items: [{ key: "drill", icon: "wrench" }, { key: "book", icon: "book" }, { key: "chairs", icon: "box" }, { key: "ladder", icon: "box" }] },
  { key: "family", icon: "archive", items: [{ key: "passports", icon: "note" }, { key: "ring", icon: "gem" }, { key: "carkey", icon: "key" }, { key: "insurance", icon: "note" }] },
];
const LEVELS = 3;

const STEP_MS = 5000;   // how long one example stays
const ROLL_MS = 460;    // one slot rolling from the old words to the new (matches .morph-in/.morph-out in base.css)
const STAGGER_MS = 60;  // each slot starts a beat after the one above it

const reducedQuery = () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null);

/**
 * One slot of the demo. When `k` changes, the previous content rolls up and out while the new rolls
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
  const k = `landing.uses.cases.${c.key}`;
  const place = t(`${k}.place`, { returnObjects: true }) as string[];
  const title = t(`${k}.title`);
  // top to bottom: the three places, the drawer, then the four items
  const at = (slot: number) => (reduced ? 0 : slot * STAGGER_MS);
  const slotKey = (slot: number | string) => `${c.key}-${slot}-${locale}`;

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
        <ol className="uc-tree" aria-label={t("landing.uses.legend.place")} data-testid="use-case-place">
          {Array.from({ length: LEVELS }, (_, i) => (
            <li key={i} className={`uc-node${i === LEVELS - 1 ? " leaf" : ""}`} style={{ "--lvl": i } as CSSProperties}>
              <ChevronDown size={15} strokeWidth={2} aria-hidden="true" />
              <Roll k={slotKey(`p${i}`)} delay={at(i)} className="uc-node-name"><span>{place[i]}</span></Roll>
            </li>
          ))}
        </ol>
        <div className="uc-drawer" style={{ "--lvl": LEVELS } as CSSProperties}>
          <div className="uc-drawer-head">
            <span className="tile"><Roll k={slotKey("icon")} delay={at(LEVELS)}><PIcon name={c.icon} size={20} /></Roll></span>
            <Roll k={slotKey("drawer")} delay={at(LEVELS)} className="uc-drawer-text">
              <span className="uc-drawer-name" data-testid="use-case-drawer">{t(`${k}.drawer`)}</span>
              <span className="uc-drawer-meta">{t(`${k}.meta`)}</span>
            </Roll>
          </div>
          <ul className="uc-items" aria-label={t("landing.uses.legend.items")} data-testid="use-case-items">
            {c.items.map((it, i) => {
              const ik = `${k}.items.${it.key}`;
              const note = i18n.exists(`${ik}.note`) ? t(`${ik}.note`) : null;
              const value = it.money
                ? <>{formatAmount(it.money[0], it.money[1], locale)} <span className="cur">{it.money[2]}</span></>
                : i18n.exists(`${ik}.value`) ? t(`${ik}.value`) : null;
              const d = at(LEVELS + 1 + i);
              return (
                <li key={i} className="uc-item">
                  <span className="tile" aria-hidden="true"><Roll k={slotKey(`i${i}-icon`)} delay={d}><PIcon name={it.icon} size={17} /></Roll></span>
                  <Roll k={slotKey(`i${i}`)} delay={d} className="uc-item-main">
                    <span className="uc-item-name">{t(`${ik}.name`)}</span>
                    {note ? <span className="uc-item-note">{note}</span> : null}
                  </Roll>
                  <Roll k={slotKey(`i${i}-v`)} delay={d} className="uc-item-value">{value ? <span>{value}</span> : null}</Roll>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      <Roll k={slotKey("caption")} className="uc-caption">
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
