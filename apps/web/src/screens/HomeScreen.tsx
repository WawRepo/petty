import { Fragment, useEffect, useRef } from "react";
import { useFlip } from "../lib/flip.js";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { colorOf, foldText, formatAmount, iconOf, lineCounted, lineTagsOf, normalizeCurrencyCode, placeLabel, totals as ledgerTotals, type Totals } from "@petty/ledger";
import { TopBar } from "../components/TopBar.js";
import { Button } from "../components/Button.js";
import { createDrawer, drawerWarnings, homeTotals, lineBalance, loadAll, loadPhoto, useDrawers, type DrawerView, loadIfIdle } from "../lib/drawers.js";
import { VerifyBadge } from "../components/VerifyBadge.js";
import { PendingArea } from "../components/PendingArea.js";
import { OfflineBanner } from "../components/OfflineBanner.js";
import { SyncReport } from "../components/SyncReport.js";
import { Nudges } from "../components/Nudges.js";
import { HomeSkeleton, rememberHomeShape } from "../components/Skeleton.js";
import { PinsWarning } from "../components/PinsWarning.js";
import { excludedFromTotal, pictureShown, placesShown, totalsShown, usePins, verificationShown } from "../lib/pins.js";
import { TagChip } from "../components/TagChip.js";
import { DEFAULT_DRAWER_ICON, KIND_CLASS, PIcon, colorClass } from "../lib/icons.js";
import { Coins, ListTree, MapPin } from "lucide-react";
import { HomeArt, PlacesArt, vtName, type ArtDrawer, type ArtPlace } from "../components/DrawerArt.js";
import { useMorph } from "../lib/nav.js";
import { PlacePicker } from "../components/PlacePicker.js";
import { Sheet } from "../components/Sheet.js";
import { TextField } from "../components/TextField.js";
import { addPlace, flatten, pathKey, placeOfView, savePlaceTree, usePlaceTree, type PlaceNode, type PlacePath } from "../lib/places.js";
import { homePlace, setHomePlace } from "../lib/homePlace.js";
import { quantityLabel } from "../lib/format.js";
import { lineBalance as balanceOf } from "../lib/drawers.js";
import { searchDrawers } from "../lib/search.js";
import { syncTokenWrapsOnce } from "../lib/accessTokens.js";
import { storageErrorKey } from "../lib/storage.js";
import { useState } from "react";
import type { Line } from "@petty/ledger";

/** The totals of one group of drawers, in the same shape as the home TOTAL but smaller. */
function GroupTotals({ tot, lang }: { tot: Totals; lang: string }) {
  if (!tot.byCurrency.length) return null;
  return <ul className="group-totals">{tot.byCurrency.map((c) => <li key={c.code} className={c.amount < 0 ? "negative" : undefined}><span className="num">{formatAmount(c.amount, c.exponent, lang)}</span> <span className="cur">{normalizeCurrencyCode(c.code)}</span></li>)}</ul>;
}

/** The lines of one drawer that match the search, listed under its card (PETTY-47). */
function SearchHits({ view, lines }: { view: DrawerView; lines: readonly Line[] }) {
  const { t, i18n } = useTranslation();
  const nav = useNavigate();
  const id = view.summary.id;
  return (
    <ul className="search-hits" aria-label={t("home.search.hitsIn", { name: view.doc?.name ?? "…" })}>
      {lines.map((l) => {
        const bal = l.kind === "single" ? 0 : balanceOf(view, l.id);
        const label = quantityLabel(l, bal, i18n.language, t);
        const sub = l.kind === "single" ? l.text.split("\n")[0]?.slice(0, 60) : null;
        return (
          <li key={l.id}>
            <button type="button" className="search-hit" data-testid="search-hit" onClick={() => nav(l.kind === "single" ? `/drawers/${id}` : `/drawers/${id}/lines/${l.id}`)}>
              <span className="rowmain">
                <span className="rowtitle">{l.name}</span>
                {sub ? <span className="rowsub">{sub}</span> : null}
                {lineTagsOf(l).length ? <span className="row-tags" data-testid="search-hit-tags">{lineTagsOf(l).map((tg) => <TagChip key={tg} label={tg} />)}</span> : null}
              </span>
              {label ? <span className={`rowbalance${bal < 0 ? " negative" : ""}`}>{label}</span> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Small line icons for the cards (PETTY-63/64, Lucide). Decorative: every one is aria-hidden. */
const Icon = {
  coins: <Coins size={14} strokeWidth={2} aria-hidden="true" />,
  pin: <MapPin size={11} strokeWidth={2.4} aria-hidden="true" />,
};
const drawerIcon = (v: DrawerView | undefined) => (v?.doc ? iconOf(v.doc) ?? DEFAULT_DRAWER_ICON : DEFAULT_DRAWER_ICON);

function DrawerRow({ view, counted, dim = false, place = "", placeTestId = "row-place" }: { view: DrawerView; counted: boolean; dim?: boolean; place?: string; placeTestId?: string }) {
  const { t, i18n } = useTranslation();
  const pinsDoc = usePins().doc;
  const showVerification = verificationShown(pinsDoc);
  const showTotals = totalsShown(pinsDoc);
  const nav = useNavigate();
  const name = view.doc?.name ?? "…";
  const w = drawerWarnings(view);
  const attention = w.problems > 0 || w.chain !== "ok" || w.negative || w.skipped > 0;
  useEffect(() => { if (view.summary.has_photo && !view.photo && view.key) void loadPhoto(view.summary.id); }, [view.summary.has_photo, view.photo, view.key, view.summary.id]);
  // One amount per currency, summed as the Home and drawer totals sum it (one code, "eur" is "EUR", at
  // the finer exponent); the first is the card's headline, the rest are counted in the meta row. In
  // their order too, largest first (PETTY-279: the card led with another currency).
  const sums = new Map<string, { amount: number; exponent: number }>();
  for (const l of view.doc?.lines ?? []) {
    if (l.kind !== "money" || !lineCounted(l)) continue;
    const code = normalizeCurrencyCode(l.currency), cur = sums.get(code), bal = lineBalance(view, l.id);
    const exp = Math.max(cur?.exponent ?? 0, l.exponent);
    sums.set(code, { amount: (cur ? cur.amount * 10 ** (exp - cur.exponent) : 0) + bal * 10 ** (exp - l.exponent), exponent: exp });
  }
  const subtotals = [...sums];
  const maxExp = Math.max(0, ...subtotals.map(([, v]) => v.exponent));
  subtotals.sort(([ac, a], [bc, b]) => b.amount * 10 ** (maxExp - b.exponent) - a.amount * 10 ** (maxExp - a.exponent) || ac.localeCompare(bc));
  const head = subtotals[0];
  return (
    <button type="button" className={`row${dim ? " dim" : ""}`} onClick={() => nav(`/drawers/${view.summary.id}`)} aria-label={t("drawer.open", { name })} data-testid="drawer-row">
      {view.photo ? <img className="row-thumb" src={view.photo} alt="" /> : <span className={`tile ${colorClass(view.doc ? colorOf(view.doc) : null)}`} aria-hidden="true" data-icon={drawerIcon(view)}><PIcon name={drawerIcon(view)} /></span>}
      <span className="rowmain">
        <span className="rowtitle">{name}{place ? <span className="row-sub" data-testid={placeTestId}>{Icon.pin}{place}</span> : null}</span>
        {view.error ? <span className="degraded" role="status">{t(`home.degradedReason.${view.error}`)}</span> : (
          <>
            {/* Every currency on the card (PETTY-120, audit F13): the first as the headline, the others under it. */}
            {head ? <span className={`rowamount${head[1].amount < 0 ? " negative" : ""}`} data-testid="row-amount">{formatAmount(head[1].amount, head[1].exponent, i18n.language)} <span className="cur">{head[0]}</span></span> : null}
            {subtotals.length > 1 ? (
              <span className="rowamount-more" data-testid="row-amount-more">
                {subtotals.slice(1).map(([code, c]) => <span key={code} className={c.amount < 0 ? "negative" : undefined}>{formatAmount(c.amount, c.exponent, i18n.language)} <span className="cur">{code}</span></span>)}
              </span>
            ) : null}
            <span className="rowmeta">
              {/* PETTY-250: one dot per line in its kind's colour — money, things, notes — as on the landing page */}
              <span>{view.doc?.lines.length ? <span className="kind-dots" aria-hidden="true">{view.doc.lines.slice(0, 8).map((l) => <i key={l.id} className={`kd ${KIND_CLASS[l.kind]}`} />)}</span> : null}{t("home.items", { count: view.doc?.lines.length ?? 0 })}</span>
            </span>
          </>
        )}
        {view.error || !showVerification ? null : <VerifyBadge view={view} />}
        {counted || !showTotals ? null : <span className="rowsub" data-testid="not-in-total">{t("home.notInTotal")}</span>}{/* PETTY-141: a total marker, so it follows the Totals switch */}
        {attention ? <span className={w.negative || w.problems || w.chain !== "ok" ? "degraded" : "rowwarn"} role="status" data-testid="drawer-attention">⚠ {t("home.warn")}</span> : null}
      </span>
      <span className="chev" aria-hidden="true">›</span>
    </button>
  );
}

/** Add drawer (PETTY-54/66): a name and a place picked from the tree; a new place can be typed right there. */
function AddDrawerSheet({ open, tree, onClose, onCreate }: { open: boolean; tree: ReturnType<typeof usePlaceTree>; onClose: () => void; onCreate: (name: string, place: PlacePath | null) => Promise<void> }) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [place, setPlace] = useState<PlacePath | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setName(""); setPlace(null); setError(null); } }, [open]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setError(t("drawer.errors.nameRequired")); return; }
    setBusy(true);
    try { await onCreate(name.trim(), place); onClose(); } catch (err) { setError(t(storageErrorKey(err) ?? "errors.unknown")); } finally { setBusy(false); }
  }
  return (
    <Sheet open={open} title={t("home.addDrawerTitle")} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <TextField label={t("home.drawerName")} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("home.drawerNamePlaceholder")} error={error} autoComplete="off" autoFocus />
        <p className="label mb6">{t("places.choose")}</p>
        <PlacePicker tree={tree} value={place} onChange={setPlace} emptyLabel={t("places.none")} onCreate={async (parent, n) => { const r = addPlace(tree, parent, n); await savePlaceTree(r.tree); return r.path; }} testId="add-place-picker" />
        <div className="actions">
          <Button variant="secondary" onClick={onClose}>{t("app.cancel")}</Button>
          <Button type="submit" busy={busy}>{t("app.save")}</Button>
        </div>
      </form>
    </Sheet>
  );
}

export function HomeScreen() {
  const { t, i18n } = useTranslation();
  const nav = useNavigate();
  const morph = useMorph();
  const state = useDrawers();
  const [adding, setAdding] = useState(false);
  // Search (PETTY-47): the field shows on demand; matching waits ~300 ms after the last keystroke.
  // PETTY-169: give every live access token the drawers it is missing, quietly, once per session.
  useEffect(() => { if (state.status === "ready") void syncTokenWrapsOnce(); }, [state.status]);

  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => { const h = window.setTimeout(() => setDebounced(query), 300); return () => window.clearTimeout(h); }, [query]);
  useEffect(() => { if (searching) searchRef.current?.focus(); }, [searching]);
  const closeSearch = () => { setSearching(false); setQuery(""); setDebounced(""); };
  useEffect(() => { if (state.status === "idle") loadIfIdle(); }, [state.status]);
  const pinsDoc = usePins().doc;
  const excluded = excludedFromTotal(pinsDoc);
  // Places (PETTY-59): a drawer's tags are an ORDERED path — room, shelf, box. The selection is a path prefix:
  // tapping a chip goes one level down, tapping a selected chip goes back up above it. "All" clears.
  const showPlaces = placesShown(pinsDoc);
  const showTotals = totalsShown(pinsDoc); // PETTY-84: the Total value card and subtotals are optional
  const tree = usePlaceTree();
  // Rooms and sub-places follow the order of the tree (PETTY-66), not the alphabet.
  const treeOrder = new Map(flatten(tree).map((f, i) => [f.key, i]));
  // PETTY-269: the picked place outlives the screen (in memory), so Back from a drawer lands on its level
  const [picked, setPickedHere] = useState<string[]>(() => [...homePlace()]);
  const setPicked = (path: string[]) => { setHomePlace(path); setPickedHere(path); };
  const paths = new Map<string, readonly string[]>();  // drawer id -> folded path
  const labels = new Map<string, string>();            // folded segment -> display spelling (first wins)
  for (const id of state.order) {
    const v = state.drawers.get(id);
    const place = v ? placeOfView(v) : [];
    paths.set(id, place.map(foldText));
    for (const seg of place) { const k = foldText(seg); if (!labels.has(k)) labels.set(k, seg); }
  }
  const startsWith = (p: readonly string[], prefix: readonly string[]) => prefix.every((k, i) => p[i] === k);
  const labelOf = (k: string) => labels.get(k) ?? k;
  // A selection that no drawer starts with any more (a place was renamed) falls back to its longest live prefix.
  let selected: string[] = showPlaces ? picked : [];
  while (selected.length && !state.order.some((id) => startsWith(paths.get(id)!, selected))) selected = selected.slice(0, -1);
  const filtering = selected.length > 0;
  const visibleIds = filtering ? state.order.filter((id) => startsWith(paths.get(id)!, selected)) : state.order;
  // With a place selected the other drawers are not removed: they sink below the matching ones, greyed (PETTY-55).
  const restIds = filtering ? state.order.filter((id) => !visibleIds.includes(id)) : [];
  const [othersOpen, setOthersOpen] = useState(false);
  const orderedIds = [...visibleIds, ...restIds];
  // Chips: the selected path, then the next level below it (the rooms when nothing is selected), with counts.
  const children = new Map<string, string[]>();
  for (const id of visibleIds) { const k = paths.get(id)![selected.length]; if (k) (children.get(k) ?? children.set(k, []).get(k)!).push(id); }
  const childList = [...children.entries()].sort((a, b) => (treeOrder.get(pathKey([...selected, a[0]])) ?? 1e9) - (treeOrder.get(pathKey([...selected, b[0]])) ?? 1e9) || labelOf(a[0]).localeCompare(labelOf(b[0]), i18n.language));
  const selectedLabels = placeLabel(selected.map(labelOf));
  const listRef = useRef<HTMLDivElement>(null);
  useFlip(listRef);
  const only = filtering ? new Set(visibleIds) : null;
  const counted = visibleIds.some((id) => !excluded.has(id));
  const tot = homeTotals(excluded, only);
  const groupTotals = (ids: readonly string[]): Totals => ledgerTotals(ids.map((id) => state.drawers.get(id)).filter((v): v is DrawerView => !!v && !excluded.has(v.summary.id)).map((v) => ({
    ok: v.error === null && v.doc !== null && v.entryProblems.length === 0,
    moneyLines: v.doc ? v.doc.lines.flatMap((l) => (l.kind === "money" && lineCounted(l) ? [{ line: l, balance: balanceOf(v, l.id) }] : [])) : [],
  })));
  const untagged = state.order.filter((id) => paths.get(id)!.length === 0);
  // The "All" view groups by room; inside a room the drawers sort by their path, deeper ones indented under a sub-place label.
  const byPath = (ids: readonly string[]) => [...ids].sort((a, b) => (treeOrder.get(paths.get(a)!.join("\0")) ?? 1e9) - (treeOrder.get(paths.get(b)!.join("\0")) ?? 1e9) || paths.get(a)!.join("\0").localeCompare(paths.get(b)!.join("\0")) || state.order.indexOf(a) - state.order.indexOf(b));
  const grouped = showPlaces && !filtering && (childList.length >= 2 || childList.some(([, ids]) => ids.some((id) => paths.get(id)!.length > 1)));
  const placeText = (id: string) => (showPlaces ? placeLabel(paths.get(id)!.map(labelOf)) : "");
  // Rows below a place (PETTY-59/60 → PETTY-121): sorted by path; a drawer deeper than `base` carries the part of its
  // place below `base` as a small label in its card. Used by the room groups and by the filtered view, where `base` is the selected place.
  const placedRows = (ids: readonly string[], base: number, dim = false) => {
    return byPath(ids).map((id) => {
      const v = state.drawers.get(id);
      if (!v) return null;
      const sub = paths.get(id)!.slice(base);
      // PETTY-121 (audit F14): the sub-place is a small label inside the card, next to the name — one row per drawer, no orphan chips.
      return <Fragment key={id}><div className="flip-item" data-flip-id={id}><DrawerRow view={v} counted={!excluded.has(id)} dim={dim} place={sub.length ? placeLabel(sub.map(labelOf)) : ""} placeTestId="sub-place" /></div></Fragment>;
    });
  };
  // PETTY-250: the home with the drawers of this view around it, as on the landing page — beside the total
  // when there is one; each bubble opens its drawer, the home clears a picked place.
  // PETTY-257: with places, the picture is the place tree under the total instead; off in Settings, no picture.
  const artDrawer = (id: string): ArtDrawer => { const v = state.drawers.get(id); return { id, icon: drawerIcon(v), name: v?.doc?.name ?? "…", color: v?.doc ? colorOf(v.doc) : null }; };
  const openDrawer = (id: string) => morph(`/drawers/${id}`, `.drawer-art [data-vt="${vtName("d", id)}"]`);
  const artPlaces = (nodes: readonly PlaceNode[], prefix: readonly string[]): ArtPlace[] => nodes.flatMap((n) => {
    const path = [...prefix, foldText(n.name)];
    if (!state.order.some((id) => startsWith(paths.get(id)!, path))) return []; // a place with no drawer under it is not drawn
    const here = state.order.filter((id) => paths.get(id)!.length === path.length && startsWith(paths.get(id)!, path));
    return [{ path, name: n.name, places: artPlaces(n.children, path), drawers: here.map(artDrawer) }];
  });
  const treeArt = showPlaces && labels.size > 0;
  const homeArt = !pictureShown(pinsDoc) ? null : treeArt ? (
    <PlacesArt root={{ path: [], name: t("home.tags.all"), places: artPlaces(tree, []), drawers: untagged.map(artDrawer) }} selected={selected}
      onPick={(p) => setPicked([...p])} onDrawer={openDrawer}
      backName={(to) => (to.path.length ? t("home.picture.back", { place: to.name }) : t("home.picture.backAll"))} />
  ) : (
    <HomeArt drawers={visibleIds.map(artDrawer)} onDrawer={openDrawer} onHome={filtering ? () => setPicked([]) : undefined} homeName={t("home.tags.all")} />
  );
  const result = searchDrawers(visibleIds.map((id) => state.drawers.get(id)).filter((v): v is DrawerView => !!v), searching ? debounced : "");
  const active = searching && debounced.trim() !== "";
  // PETTY-280 (M11): the skeleton's size next time: the top card's height as drawn, and whether chips show
  useEffect(() => {
    if (state.status !== "ready" || searching) return;
    const frame = requestAnimationFrame(() => {
      const top = document.querySelector('[data-testid="home-totals"], .home-picture');
      rememberHomeShape(top ? Math.round(top.getBoundingClientRect().height) : 0, !!document.querySelector('[data-testid="tag-bar"]'));
    });
    return () => cancelAnimationFrame(frame);
  });
  const totalCard = state.status === "ready" && !active && showTotals && counted && (tot.byCurrency.length > 0 || tot.incomplete);
  return (
    <>
      <TopBar title={t("app.name")} brand actions={
        <button type="button" className="icon-btn" aria-label={searching ? t("home.search.close") : t("home.search.open")} aria-pressed={searching} data-testid="home-search-toggle" onClick={() => (searching ? closeSearch() : setSearching(true))} disabled={state.status !== "ready"}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        </button>
      } />
      {/* data-status: a screen going back to Home waits for "ready" — then its picture is drawn, or will not be (PETTY-279) */}
      <main data-testid="home" data-status={state.status}>
        {state.status === "failed" ? <p className="error" role="alert">{t("home.loadFailed")} <Button variant="ghost" onClick={() => void loadAll()}>{t("app.retry")}</Button></p> : null}
        {state.status === "loading" ? <HomeSkeleton /> : null}
        <OfflineBanner />
        <PinsWarning />
        <SyncReport />
        {searching ? (
          <div className="search-box" data-testid="home-search">
            <input ref={searchRef} type="search" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") closeSearch(); }}
              placeholder={t("home.search.placeholder")} aria-label={t("home.search.label")} autoComplete="off" enterKeyHint="search" />
            <button type="button" className="search-clear" aria-label={t("home.search.close")} onClick={closeSearch}>✕</button>
            {active ? <p className="hint m0 search-count" role="status" data-testid="search-count">{result.drawers ? t("home.search.count", { lines: result.lines, drawers: result.drawers }) : t("home.search.none")}</p> : null}
          </div>
        ) : null}
        {state.status === "ready" ? <PendingArea /> : null}
        {state.status === "ready" && state.order.length === 0 ? <div className="empty" data-testid="home-empty">{t("home.empty")}<br />{t("home.emptyHint")}</div> : null}
        {/* PETTY-117 (audit F10): while a search is typed, the page is the results — no totals, chips, nudges or non-matching drawers. */}
        {totalCard ? (
          <section className={`total-card${homeArt && treeArt ? " tree" : ""}`} data-testid="home-totals">
            <div className="tmain">
              <h2 className="label">{filtering ? t("home.totalsIn", { tag: selectedLabels }) : t("home.totals")}</h2>
              {tot.byCurrency.length ? (
                <ul className={`totals-list${tot.byCurrency.length === 1 ? " single" : " multi"}`} aria-label={t("home.totalsCount", { count: tot.byCurrency.length })}>
                  {tot.byCurrency.map((c) => (
                    <li key={`${c.code}:${c.amount}`} className={`val-in${c.amount < 0 ? " negative" : ""}`}>
                      <span className="num">{formatAmount(c.amount, c.exponent, i18n.language)}</span> <span className="cur">{normalizeCurrencyCode(c.code)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="tsub m0" data-testid="totals-across">{t("home.across", { count: visibleIds.filter((id) => !excluded.has(id)).length })}</p>
              {tot.incomplete ? <div className="warn" role="status" data-testid="totals-incomplete">{t("home.incomplete")}</div> : null}
            </div>
            {homeArt}
          </section>
        ) : null}
        {/* no total to show (no money yet, or totals switched off): the picture stands on its own */}
        {!totalCard && homeArt && state.status === "ready" && !active && visibleIds.length > 0 ? <section className={`home-picture${treeArt ? " tree" : ""}`}>{homeArt}</section> : null}
        {active || state.status !== "ready" ? null : <Nudges />}
        {state.status === "ready" && !active && showPlaces && labels.size > 0 ? (
          <div className="tag-bar" role="group" aria-label={t("home.tags.label")} data-testid="tag-bar">
            <button type="button" className="tag-chip" aria-pressed={!filtering} onClick={() => setPicked([])}>{t("home.tags.all")}<span className="tag-count">{state.order.length}</span></button>
            {selected.map((k, i) => <TagChip key={k} label={labelOf(k)} count={state.order.filter((id) => startsWith(paths.get(id)!, selected.slice(0, i + 1))).length} pressed onClick={() => setPicked(selected.slice(0, i))} />)}
            {childList.map(([k, ids]) => <TagChip key={k} label={labelOf(k)} count={ids.length} pressed={false} onClick={() => setPicked([...selected, k])} />)}
            <button type="button" className="tag-chip tag-edit" onClick={() => nav("/places")} data-testid="edit-places"><ListTree size={17} aria-hidden="true" />{t("places.manage")}</button>
          </div>
        ) : null}
        <div ref={listRef}>
        {state.status === "ready" && grouped && !active ? (
          <div className="stack" data-testid="tag-groups">
            {[...childList.map(([k, ids]) => ({ key: k, label: labelOf(k), ids })), ...(untagged.length ? [{ key: "", label: t("home.tags.elsewhere"), ids: untagged }] : [])].map((g) => {
              return (
                <section className="tag-group" key={g.key || "elsewhere"} data-testid="tag-group">
                  <header className="group-h">
                    {/* PETTY-132 (audit F25): the heading reads "Kitchen, 1 drawer" to a screen reader, not "Kitchen 1 drawer". */}
                    <h2 className="m0" aria-label={`${g.label}, ${t("home.count", { count: g.ids.length })}`}>{g.key ? <TagChip label={g.label} /> : <span className="tag-chip tag-none">{g.label}</span>} <span className="hint m0">{t("home.count", { count: g.ids.length })}</span></h2>
                    {showTotals ? <GroupTotals tot={groupTotals(g.ids)} lang={i18n.language} /> : null}
                  </header>
                  <div className="stack enter">{placedRows(g.ids, 1)}</div>
                </section>
              );
            })}
          </div>
        ) : (
        <div className="stack enter">
          {state.status === "ready" && !active && state.order.length > 0 ? (
            <header className="group-h" data-testid="drawers-header">
              <h2 className="m0">{filtering ? <TagChip label={selectedLabels} /> : t("home.drawersTitle")}</h2>
              <span className="hint m0">{t("home.count", { count: filtering ? visibleIds.length : state.order.length })}</span>
            </header>
          ) : null}
          {filtering && !active ? placedRows(visibleIds, selected.length) : null}
          {/* PETTY-116 (audit F9): the drawers outside the chosen place sit behind one labelled, collapsed row. */}
          {filtering && !active && restIds.length ? (
            <div className="others" data-testid="other-drawers">
              <button type="button" className="others-toggle" aria-expanded={othersOpen} onClick={() => setOthersOpen((o) => !o)}>
                <span>{t("home.otherDrawers", { count: restIds.length })}</span><span className="hint m0">{t("home.count", { count: restIds.length })}</span><span className="chev" aria-hidden="true">{othersOpen ? "▾" : "▸"}</span>
              </button>
              {othersOpen ? <div className="stack mt8">{placedRows(restIds, 99, true)}</div> : null}
            </div>
          ) : null}
          {filtering && !active ? null : orderedIds.map((id) => {
            const v = state.drawers.get(id);
            if (!v) return null;
            const inTag = !filtering || visibleIds.includes(id);
            if (!active) return <div className="flip-item" data-flip-id={id} key={id}><DrawerRow view={v} counted={!excluded.has(id)} dim={!inTag} place={placeText(id)} /></div>;
            const hits = inTag ? result.hits.get(id) : undefined;
            if (!hits && !(inTag && v.error)) return null; // search mode lists only the drawers that answer
            return (
              <div className={`flip-item drawer-group${hits ? " has-hits" : ""}`} key={id} data-flip-id={id} data-testid="drawer-group">
                <DrawerRow view={v} counted={!excluded.has(id)} dim={!hits} place={placeText(id)} />
                {hits ? (hits.length ? <SearchHits view={v} lines={hits} /> : null) : inTag && v.error ? <p className="hint m0 search-unavailable">{t("home.search.unavailable")}</p> : null}
              </div>
            );
          })}
        </div>
        )}
        </div>
        <button type="button" className="addbtn" onClick={() => setAdding(true)} disabled={state.status !== "ready"}>+ {t("home.addDrawer")}</button>
      </main>
      <AddDrawerSheet open={adding} tree={tree} onClose={() => setAdding(false)} onCreate={async (name, place) => { const id = await createDrawer(name, place ?? []); nav(`/drawers/${id}`); }} />
    </>
  );
}
