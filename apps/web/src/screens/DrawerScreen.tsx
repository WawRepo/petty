import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { useBack } from "../lib/nav.js";
import { ISO_4217, assertCurrencyCode, newEntryAmount, parseAmount, seedExponent, staleness, LedgerError, type Line, type Verification, placeLabel, tagsOf, foldText, formatAmount, iconOf, lineCounted, lineTagsOf, normalizeCurrencyCode, totals as ledgerTotals, type Totals } from "@petty/ledger";
import { ConfirmStateSheet } from "../components/ConfirmStateSheet.js";
import { OfflineBanner } from "../components/OfflineBanner.js";
import { SyncReport } from "../components/SyncReport.js";
import { relativeTime } from "../lib/time.js";
import { Button } from "../components/Button.js";
import { ConfirmSheet } from "../components/ConfirmSheet.js";
import { PromptSheet } from "../components/PromptSheet.js";
import { Sheet } from "../components/Sheet.js";
import { excludedFromTotal, setCountedInTotal, totalsShown, usePins, verificationShown } from "../lib/pins.js";
import { TextField } from "../components/TextField.js";
import { TopBar } from "../components/TopBar.js";
import { ReadOnlyHint } from "../components/ReadOnlyHint.js";
import { SwitchRow } from "../components/SwitchRow.js";
import { TagManager } from "../components/TagManager.js";
import { useToast } from "../components/Toast.js";
import { DocumentHistorySheet } from "../components/DocumentHistorySheet.js";
import { appendEntry, deleteDrawer, lineBalance, loadAll, loadPhoto, memberName, mutateDocument, OpsNoLongerApply, removePhoto, setPhoto, useDrawers, type DrawerView } from "../lib/drawers.js";
import { quantityLabel } from "../lib/format.js";
import { DEFAULT_DRAWER_ICON, IconPicker, KIND_CLASS, PIcon, lineIcon } from "../lib/icons.js";
import { DrawerArt } from "../components/DrawerArt.js";
import { TagChip } from "../components/TagChip.js";
import { Coins, Tags } from "lucide-react";
import { PlacePicker } from "../components/PlacePicker.js";
import { addPlace, savePlaceTree, usePlaceTree } from "../lib/places.js";
import { processPhoto } from "../lib/photo.js";
import { storageErrorKey } from "../lib/storage.js";
import { ApiError } from "../lib/api.js";

type Kind = Line["kind"];

/** Add-line sheet: kind, name, and the fields that kind needs. A starting amount becomes the first entry. */
const LAST_CURRENCY = "petty.lastCurrency";
const COMMON_CURRENCIES = ["PLN", "EUR", "USD", "GBP", "CHF"];
/** PETTY-124 (audit F17): the currency starts filled — the drawer's own, else the last one used on this device, else the locale's. */
function defaultCurrency(view: DrawerView, locale: string): string {
  const inDrawer = view.doc?.lines.find((l) => l.kind === "money");
  if (inDrawer && inDrawer.kind === "money") return inDrawer.currency;
  try { const last = localStorage.getItem(LAST_CURRENCY); if (last) return last; } catch { /* ignore */ }
  return locale === "pl" ? "PLN" : "EUR";
}

function AddLineSheet({ open, onClose, view }: { open: boolean; onClose: () => void; view: DrawerView }) {
  const { t, i18n } = useTranslation();
  const [kind, setKind] = useState<Kind>("money");
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState("");
  const quick = [...new Set([...(view.doc?.lines.flatMap((l) => (l.kind === "money" ? [l.currency] : [])) ?? []), ...COMMON_CURRENCIES])].slice(0, 6);
  const [start, setStart] = useState("");
  const [unit, setUnit] = useState("");
  const [text, setText] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setKind("money"); setName(""); setCurrency(defaultCurrency(view, i18n.language)); setStart(""); setUnit(""); setText(""); setErrors({}); } }, [open, view, i18n.language]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!name.trim()) errs["name"] = t("drawer.errors.nameRequired");
    let line: Line | null = null;
    let starting = 0;
    const id = crypto.randomUUID();
    try {
      if (kind === "money") {
        const code = assertCurrencyCode(currency);
        try { localStorage.setItem(LAST_CURRENCY, code); } catch { /* ignore */ }
        const exponent = seedExponent(code);
        line = { id, kind: "money", name: name.trim(), currency: code, exponent };
        if (start.trim()) starting = parseAmount(start, exponent);
      } else if (kind === "countable") {
        line = { id, kind: "countable", name: name.trim(), unit: unit.trim() };
        if (start.trim()) starting = parseAmount(start, 0);
      } else {
        line = { id, kind: "single", name: name.trim(), text };
      }
    } catch (err) {
      if (err instanceof LedgerError && err.code === "bad_currency_code") errs["currency"] = t("drawer.errors.currencyRequired");
      else if (err instanceof LedgerError && err.code === "too_many_decimals" && kind === "countable") errs["start"] = t("drawer.errors.countInteger");
      else errs["start"] = t("drawer.errors.amountInvalid");
    }
    setErrors(errs);
    if (Object.keys(errs).length || !line) return;
    setBusy(true);
    try {
      await mutateDocument(view.summary.id, [{ type: "add_line", line }]);
      if (starting > 0) await appendEntry(view.summary.id, line, "add", newEntryAmount("add", starting));
      onClose();
    } catch (err) {
      setErrors({ name: t(storageErrorKey(err) ?? "errors.unknown") });
    } finally { setBusy(false); }
  }

  return (
    <Sheet open={open} title={t("drawer.addLine")} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <div className="field">
          <span className="hint block mb6 fw600" id="kind-label">{t("drawer.fields.type")}</span>
          <div className="kind-select" role="group" aria-labelledby="kind-label">
            {(["money", "countable", "single"] as Kind[]).map((k) => (
              <button type="button" key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>{t(`drawer.kind.${k}`)}</button>
            ))}
          </div>
        </div>
        <TextField label={t("drawer.fields.name")} value={name} onChange={(e) => setName(e.target.value)} placeholder={t(`drawer.fields.namePlaceholder.${kind}`)} error={errors["name"]} autoFocus />
        {kind === "money" ? (
          <>
            <TextField label={t("drawer.fields.currency")} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} list="iso-currencies" autoCapitalize="characters" autoComplete="off" maxLength={12} hint={t("drawer.fields.currencyHint")} error={errors["currency"]} />
            <datalist id="iso-currencies">{ISO_4217.map((c) => <option key={c.code} value={c.code} />)}</datalist>
            <div className="tag-bar currency-quick" role="group" aria-label={t("drawer.fields.currencyQuick")} data-testid="currency-quick">
              {quick.map((c) => <TagChip key={c} label={c} pressed={currency === c} onClick={() => setCurrency(c)} />)}
            </div>
            <TextField label={t("drawer.fields.startingBalance")} value={start} onChange={(e) => setStart(e.target.value)} inputMode="decimal" placeholder="0" error={errors["start"]} />
          </>
        ) : null}
        {kind === "countable" ? (
          <>
            <TextField label={t("drawer.fields.unit")} value={unit} onChange={(e) => setUnit(e.target.value)} placeholder={t("drawer.fields.unitPlaceholder")} />
            <TextField label={t("drawer.fields.startingCount")} value={start} onChange={(e) => setStart(e.target.value)} inputMode="numeric" placeholder="0" error={errors["start"]} />
          </>
        ) : null}
        {kind === "single" ? <TextField label={t("drawer.fields.text")} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("drawer.fields.textPlaceholder")} /> : null}
        <div className="actions">
          <Button variant="secondary" onClick={onClose}>{t("app.cancel")}</Button>
          <Button type="submit" busy={busy}>{t("home.add")}</Button>
        </div>
      </form>
    </Sheet>
  );
}

export function DrawerScreen() {
  const { t, i18n } = useTranslation();
  const nav = useNavigate();
  const back = useBack("/");
  const toast = useToast();
  const { id = "" } = useParams();
  const pinsDoc = usePins().doc;
  const counted = !excludedFromTotal(pinsDoc).has(id);
  const showVerification = verificationShown(pinsDoc); // PETTY-83: the bar, the history and the badges are optional
  const showTotals = totalsShown(pinsDoc); // PETTY-84: the totals card, the in-total chips and the row status are optional
  const state = useDrawers();
  const view = state.drawers.get(id);
  const [moved, setMoved] = useState(""); // live-region text for keyboard reorders (PETTY-130)
  const [sheet, setSheet] = useState<null | "options" | "rename" | "tags" | "icon" | "delete" | "addLine" | "confirmState" | "lineTags" | "history">(null);
  // Line filters (PETTY-64): by "part of the total" and by one line tag.
  const [status, setStatus] = useState<"all" | "in" | "out">("all");
  const [lineTag, setLineTag] = useState<string | null>(null);
  // PETTY-155: Manage tags opens a drawer filtered by a tag (?tag=); the link is read once, then dropped
  const [params, setParams] = useSearchParams();
  const tagParam = params.get("tag");
  useEffect(() => {
    if (tagParam === null) return;
    setLineTag(tagParam ? foldText(tagParam) : null);
    setParams((p) => { const n = new URLSearchParams(p); n.delete("tag"); return n; }, { replace: true });
  }, [id, tagParam, setParams]);
  const tree = usePlaceTree();
  const [showHistory, setShowHistory] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const dragging = useRef<{ id: string; pointerId: number; startY: number; from: number; target: number; slide: number; gap: number; blocks: HTMLElement[]; mids: number[]; heights: number[] } | null>(null);
  const pendingDrop = useRef<{ ids: string[]; blocks: HTMLElement[] } | null>(null);
  // After a drop, the transforms stay until the list re-renders in the new order — clearing
  // them earlier repaints the OLD order for a frame (visible flicker). This runs before paint.
  useLayoutEffect(() => {
    const p = pendingDrop.current;
    if (!p) return;
    const d = state.drawers.get(id)?.doc;
    if (d && d.lines.map((l) => l.id).join() === p.ids.join()) {
      for (const b of p.blocks) { b.style.transition = ""; b.style.transform = ""; }
      pendingDrop.current = null;
      setDragId(null);
    }
  });

  useEffect(() => { if (state.status === "idle") void loadAll(); }, [state.status]);
  useEffect(() => { if (view?.summary.has_photo && !view.photo && view.key) void loadPhoto(id); }, [view?.summary.has_photo, view?.photo, view?.key, id]);

  if (state.status === "loading" || state.status === "idle") return <><TopBar title={t("app.name")} onBack={back} /><main><p className="empty">{t("app.loading")}</p></main></>;
  if (!view) return <><TopBar title={t("app.name")} onBack={back} /><main><p className="empty">{t("errors.unknown")}</p></main></>;
  if (!view.doc) return <><TopBar title={t("app.name")} onBack={back} /><main><p className="error" role="alert">{t(`home.degradedReason.${view.error ?? "decrypt_failed"}`)}</p>{view.error === "sender_key_changed" ? <Button variant="secondary" onClick={() => nav(`/drawers/${id}/members`)}>{t("members.open")}</Button> : null}</main></>;
  const doc = view.doc;
  const canWrite = view.summary.role !== "read";
  const isOwner = view.summary.role === "owner";
  const lines = doc.lines;
  // Totals (PETTY-64): "included" folds only the lines that count; "all" folds every money line.
  const okForTotals = view.error === null && view.entryProblems.length === 0;
  const moneyOf = (keep: (l: Line) => boolean) => lines.flatMap((l) => (l.kind === "money" && keep(l) ? [{ line: l, balance: lineBalance(view, l.id) }] : []));
  const totIncluded = ledgerTotals([{ ok: okForTotals, moneyLines: moneyOf(lineCounted) }]);
  const totAll = ledgerTotals([{ ok: okForTotals, moneyLines: moneyOf(() => true) }]);
  const totExcluded = ledgerTotals([{ ok: okForTotals, moneyLines: moneyOf((l) => !lineCounted(l)) }]);
  const excludedCount = lines.filter((l) => !lineCounted(l)).length;
  const lineTagIndex = new Map<string, { label: string; count: number }>();
  for (const l of lines) for (const tg of lineTagsOf(l)) { const k = foldText(tg); const cur = lineTagIndex.get(k); if (cur) cur.count++; else lineTagIndex.set(k, { label: tg, count: 1 }); }
  const lineTagList = [...lineTagIndex.entries()].sort((a, b) => a[1].label.localeCompare(b[1].label, i18n.language));
  const tagSel = lineTag && lineTagIndex.has(lineTag) ? lineTag : null;
  const filtered = status !== "all" || tagSel !== null;
  const shown = lines.filter((l) => (!showTotals || status === "all" || (status === "in") === lineCounted(l)) && (!tagSel || lineTagsOf(l).some((x) => foldText(x) === tagSel)));
  // a changed amount fades in (PETTY-250): its element is keyed by the value, so a new value is a new element
  const amounts = (tot: Totals, small = false) => tot.byCurrency.length ? (
    <ul className={`tlist${tot.byCurrency.length > 1 ? " multi" : ""}${small ? " small" : ""}`}>{tot.byCurrency.map((c) => <li key={`${c.code}:${c.amount}`} className={`val-in${c.amount < 0 ? " negative" : ""}`}>{formatAmount(c.amount, c.exponent, i18n.language)} <span className="cur">{normalizeCurrencyCode(c.code)}</span></li>)}</ul>
  ) : <span className="tnone">{t("drawer.totals.none")}</span>;
  const st = staleness(doc, view.summary);
  const when = view.summary.last_verified_at ? relativeTime(view.summary.last_verified_at, i18n.language, t) : "";
  const commentSuffix = st.last?.comment ? t("verify.bar.withComment", { comment: st.last.comment }) : "";
  const verifyText = st.status === "never" ? t("verify.bar.never") : st.status === "stale" ? t("verify.bar.stale", { when }) + commentSuffix : t("verify.bar.verified", { when }) + commentSuffix;
  const verifications = [...doc.verifications].reverse();
  const lineName = (lid: string) => doc.lines.find((l) => l.id === lid)?.name ?? "?";
  const verificationSummary = (v: Verification) => v.lines.map((vl) => {
    const l = doc.lines.find((x) => x.id === vl.line_id);
    if (!l) return null;
    if (l.kind === "single") return `${l.name}: ${vl.present === false ? t("verify.row.absent") : t("verify.row.present")}`;
    return `${l.name}: ${quantityLabel(l, vl.balance ?? 0, i18n.language, t)}`;
  }).filter(Boolean).join(" · ");

  async function run(fn: () => Promise<void>) {
    try { await fn(); } catch (e) {
      if (e instanceof OpsNoLongerApply) toast(t("drawer.errors.opsDropped"));
      else if (storageErrorKey(e)) toast(t(storageErrorKey(e)!));
      else if (e instanceof ApiError && e.status === 403) toast(t("errors.unknown"));
      else toast(t("errors.unknown"));
    }
  }

  async function onPhoto(file: File | undefined) {
    if (!file) return;
    setPhotoBusy(true);
    try { await setPhoto(id, await processPhoto(file)); } catch (e) { toast(t(storageErrorKey(e) ?? "drawer.photoFailed")); } finally { setPhotoBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  }

  /**
   * Drag to reorder. The dragged card follows the finger; the others slide aside so
   * the drop slot is always visible. Transforms are written through the CSSOM (the
   * strict CSP forbids style attributes, not CSSOM writes) and transition in CSS,
   * which prefers-reduced-motion turns off. Move up / Move down is the keyboard path.
   */
  function onHandleDown(e: React.PointerEvent<HTMLButtonElement>, lineId: string) {
    if (!canWrite) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const blocks = [...document.querySelectorAll<HTMLElement>("[data-line-id]")];
    const from = blocks.findIndex((b) => b.dataset["lineId"] === lineId);
    if (from < 0) return;
    const rects = blocks.map((b) => b.getBoundingClientRect());
    const gap = blocks.length > 1 ? Math.max(0, rects[1]!.top - rects[0]!.bottom) : 10;
    dragging.current = { id: lineId, pointerId: e.pointerId, startY: e.clientY, from, target: from, slide: rects[from]!.height + gap, gap, blocks, mids: rects.map((r) => r.top + r.height / 2), heights: rects.map((r) => r.height) };
    setDragId(lineId);
  }
  function onHandleMove(e: React.PointerEvent<HTMLButtonElement>) {
    const d = dragging.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const dy = e.clientY - d.startY;
    const mid = d.mids[d.from]! + dy;
    let target = 0;
    for (let i = 0; i < d.mids.length; i++) if (i !== d.from && d.mids[i]! < mid) target++;
    if (target !== d.target) (navigator as { vibrate?: (ms: number) => void }).vibrate?.(8); // a tick when the slot changes (Android)
    d.target = target;
    d.blocks.forEach((b, i) => {
      if (i === d.from) { b.style.transform = `translate3d(32px, ${dy}px, 0) scale(1.03)`; return; }
      const off = i < d.from ? (i >= target ? d.slide : 0) : (i <= target ? -d.slide : 0);
      // displaced cards keep their column; only the held card sits to the right
      b.style.transform = off ? `translate3d(0, ${off}px, 0)` : "";
    });
  }
  /* PETTY-130 (audit F23): the handle works from the keyboard — ↑ ↓ move one step, Home/End to the ends; a live region says where it landed. */
  function onHandleKey(e: React.KeyboardEvent, lineId: string, name: string) {
    const ids = lines.map((x) => x.id);
    const i = ids.indexOf(lineId);
    if (i < 0) return;
    let to = i;
    if (e.key === "ArrowUp") to = Math.max(0, i - 1);
    else if (e.key === "ArrowDown") to = Math.min(ids.length - 1, i + 1);
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = ids.length - 1;
    else return;
    e.preventDefault();
    if (to === i) return;
    const next = [...ids]; next.splice(i, 1); next.splice(to, 0, lineId);
    void run(() => mutateDocument(id, [{ type: "reorder", ids: next }])).then(() => setMoved(t("drawer.movedTo", { name, pos: to + 1, count: ids.length })));
  }
  function onHandleUp() {
    const d = dragging.current;
    dragging.current = null;
    if (!d) return;
    if (d.target === d.from) {
      for (const b of d.blocks) b.style.transform = "";
      setDragId(null);
      return;
    }
    // Snap the held card into the open slot; every transform stays until the new order paints.
    let snap = 0;
    if (d.target > d.from) for (let i = d.from + 1; i <= d.target; i++) snap += d.heights[i]! + d.gap;
    else for (let i = d.target; i < d.from; i++) snap -= d.heights[i]! + d.gap;
    const held = d.blocks[d.from]!;
    held.style.transition = "transform 0.15s ease";
    held.style.transform = `translate3d(0, ${snap}px, 0)`;
    const ids = doc.lines.map((l) => l.id);
    const [moved] = ids.splice(d.from, 1);
    ids.splice(d.target, 0, moved!);
    pendingDrop.current = { ids, blocks: d.blocks };
    void run(() => mutateDocument(id, [{ type: "reorder", ids }])).then(() => {
      // The write failed or was dropped: the order never changed, so release the freeze here.
      window.setTimeout(() => {
        const p = pendingDrop.current;
        if (p && p.ids.join() === ids.join()) {
          for (const b of p.blocks) { b.style.transition = ""; b.style.transform = ""; }
          pendingDrop.current = null;
          setDragId(null);
        }
      }, 150);
    });
  }

  return (
    <>
      <TopBar title={doc.name} onBack={back} actions={<button type="button" className="icon-btn" aria-label={t("drawer.options")} onClick={() => setSheet("options")}>⋯</button>} />
      <main>
        <OfflineBanner />
        <SyncReport />
        <section className="drawer-head" data-testid="drawer-head">
          {/* PETTY-250: the drawer's picture — its photo or icon in the middle, its lines around it in their kinds' colours */}
          <DrawerArt lines={lines} testId="drawer-art" center={view.photo
            ? <img className="uc-bub-disc uc-bub-photo" src={view.photo} alt={t("drawer.photoAlt", { name: doc.name })} data-testid="drawer-photo" />
            : <span className="uc-bub-disc tile" aria-hidden="true" data-icon={iconOf(doc) ?? DEFAULT_DRAWER_ICON}><PIcon name={iconOf(doc) ?? DEFAULT_DRAWER_ICON} /></span>} />
          {/* The name is the sticky top bar's title; the card shows only who edited it last (PETTY-81). */}
          <div className="rowmain">
            <span className="rowsub">{t("drawer.editedAt", { name: memberName(view, view.docAuthor), when: relativeTime(view.summary.last_write_at, i18n.language, t) })}</span>
          </div>
        </section>
        <ReadOnlyHint view={view} />
        <p className="sr-only" aria-live="polite" data-testid="move-announce">{moved}</p>
        {/* A drawer of things only (no money line) has nothing to total (PETTY-77). */}
        {showTotals && lines.some((l) => l.kind === "money") ? (
          <section className="drawer-totals" data-testid="drawer-totals">
            <div className="thead">
              <div className="tbox" data-testid="total-included">
                <span className="tlabel">{t("drawer.totals.title")}</span>
                {amounts(totIncluded)}
                <span className="tmeta">{excludedCount ? t("drawer.totals.countsToward", { included: lines.length - excludedCount, total: lines.length }) : `${t("home.items", { count: lines.length })} · ${t("home.currencies", { count: totIncluded.byCurrency.length })}`}</span>
              </div>
              <span className="tile" aria-hidden="true"><Coins size={22} strokeWidth={1.8} /></span>
            </div>
            {excludedCount ? (
              <div className="tsplit">
                <div className="tcol" data-testid="total-all"><span className="tlabel2">{t("drawer.totals.all")}</span>{amounts(totAll, true)}</div>
                <div className="tcol" data-testid="total-excluded"><span className="tlabel2">{t("drawer.totals.notInTotal")}</span>{amounts(totExcluded, true)}</div>
              </div>
            ) : null}
          </section>
        ) : null}
        {view.rotation ? <p className="warn-box" role="status" data-testid="rotation-progress">{t("rotation.running", { done: view.rotation.done, total: view.rotation.total })}</p> : null}
        {view.summary.rotation_needed && !view.rotation ? <p className="warn-box" role="status" data-testid="rotation-needed">{t("rotation.needed")}</p> : null}
        {view.keyChanged.length ? <p className="warn-box danger" role="alert" data-testid="key-changed">{t("rotation.keyChanged", { names: view.keyChanged.map((u) => memberName(view, u)).join(", ") })} <Button variant="ghost" onClick={() => nav(`/drawers/${id}/members`)}>{t("members.open")}</Button></p> : null}
        {showVerification ? <section className="verify-bar" data-testid="verify-bar" data-status={st.status}>
          <div className="vtext">{verifyText}</div>
          <div className="vbtns">
            {/* PETTY-123 (audit F16): the bar nags only when a real count went stale; "never" and "fresh" are an offer, not a warning. */}
            {canWrite ? <Button variant={st.status === "stale" ? "primary" : "secondary"} onClick={() => setSheet("confirmState")}>{t("verify.confirm")}</Button> : null}
            {doc.verifications.length ? <Button variant="secondary" onClick={() => setShowHistory((s) => !s)} aria-expanded={showHistory}>{showHistory ? t("verify.hide") : t("verify.history", { count: doc.verifications.length })}</Button> : null}
          </div>
        </section> : null}
        {showVerification && showHistory ? (
          <div className="stack mb12" data-testid="verify-history" role="list" aria-label={t("verify.historyTitle")}>
            {verifications.map((v) => {
              const missing = v.lines.filter((vl) => vl.present === false).map((vl) => lineName(vl.line_id));
              const d = new Date(v.logged_at);
              return (
                <div className={`entry${missing.length ? " flagged" : ""}`} key={v.id} role="listitem" data-testid="verification-row">
                  <div className="left">
                    <span className="op adjust">{t("verify.row.title")}</span>
                    <span className="meta">{d.toLocaleDateString(i18n.language, { month: "short", day: "numeric", year: "numeric" })} · {d.toLocaleTimeString(i18n.language, { hour: "numeric", minute: "2-digit" })} · {t("verify.row.by", { name: memberName(view, v.author_id) })}{v.comment ? ` · ${v.comment}` : ""}</span>
                    {missing.length ? <span className="missing">{t("verify.row.missing", { names: missing.join(", ") })}</span> : null}
                    <span className="meta">{verificationSummary(v)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
        {/* PETTY-122 (audit F15) + PETTY-131 (F24): the photo controls live in ⋯; only the hidden file input stays here, out of the tab order. */}
        {canWrite ? <input ref={fileRef} type="file" accept="image/*" className="sr-only" id="photo-input" tabIndex={-1} aria-hidden="true" onChange={(e) => void onPhoto(e.target.files?.[0])} /> : null}
        {lines.length === 0 ? <p className="empty">{t("drawer.noLines")}</p> : null}
        {showTotals && excludedCount ? (
          <div className="tag-bar status-bar" role="group" aria-label={t("drawer.filter.all")} data-testid="status-bar">
            <TagChip label={t("drawer.filter.all")} count={lines.length} pressed={status === "all"} onClick={() => setStatus("all")} />
            <TagChip label={t("drawer.filter.included")} count={lines.length - excludedCount} pressed={status === "in"} onClick={() => setStatus(status === "in" ? "all" : "in")} />
            <TagChip label={t("drawer.filter.excluded")} count={excludedCount} pressed={status === "out"} onClick={() => setStatus(status === "out" ? "all" : "out")} />
          </div>
        ) : null}
        {/* PETTY-153: with no tags yet, writers still get the bar with just Manage tags */}
        {lineTagList.length || (canWrite && lines.length) ? (
          <div className="tag-bar line-tag-bar" role="group" aria-label={t("drawer.filter.allTags")} data-testid="line-tag-bar">
            <span className="tag-lead">{t("drawer.line.tags")}</span>
            {lineTagList.length ? <TagChip label={t("drawer.filter.allTags")} pressed={tagSel === null} onClick={() => setLineTag(null)} /> : null}
            {lineTagList.map(([k, v]) => <TagChip key={k} label={v.label} pressed={tagSel === k} onClick={() => setLineTag(tagSel === k ? null : k)} />)}
            {canWrite ? <button type="button" className="tag-chip tag-edit" onClick={() => setSheet("lineTags")} data-testid="tag-bar-manage"><Tags size={15} aria-hidden="true" />{t("drawer.tagsManage")}</button> : null}
          </div>
        ) : null}
        <div className="stack enter" data-testid="lines">
          {shown.map((l) => {
            const bal = l.kind === "single" ? 0 : lineBalance(view, l.id);
            const label = quantityLabel(l, bal, i18n.language, t);
            const last = l.kind === "single" ? undefined : view.entries.get(l.id)?.at(-1);
            const sub = l.kind === "single" ? (l.text.split("\n")[0]?.slice(0, 40) || t("drawer.kind.single")) : last ? t("drawer.line.lastEntry", { when: relativeTime(last.received_at, i18n.language, t) }) : t("drawer.line.noEntries");
            return (
              <div className={`line-block${dragId === l.id ? " dragging" : ""}`} key={l.id} data-line-id={l.id} data-testid="line-row">
                {canWrite && !filtered ? <button type="button" className="drag-handle" aria-label={t("drawer.dragHandle", { name: l.name })} onPointerDown={(e) => onHandleDown(e, l.id)} onPointerMove={onHandleMove} onPointerUp={onHandleUp} onPointerCancel={onHandleUp} onKeyDown={(e) => onHandleKey(e, l.id, l.name)}>⠿</button> : null}
                <button type="button" className="row" onClick={() => nav(`/drawers/${id}/lines/${l.id}`)} aria-label={t("drawer.open", { name: l.name })}>
                  <span className={`tile small ${KIND_CLASS[l.kind]}`} aria-hidden="true" data-icon={lineIcon(l)}><PIcon name={lineIcon(l)} size={20} /></span>
                  <span className="rowmain">
                    <span className="rowhead">
                      <span className="rowtitle" data-testid="line-name">{l.name}</span>
                      {label ? <span key={bal} className={`rowbalance val-in${bal < 0 ? " negative" : ""}${lineCounted(l) ? "" : " excluded"}`}>{l.kind === "money" ? <>{formatAmount(bal, l.exponent, i18n.language)} <span className="cur">{normalizeCurrencyCode(l.currency)}</span></> : label}</span> : null}
                    </span>
                    {lineTagsOf(l).length ? <span className="row-tags" data-testid="line-tags">{lineTagsOf(l).map((tg) => <TagChip key={tg} label={tg} />)}</span> : null}
                    {l.kind !== "money" || !showTotals ? <span className="rowsub">{sub}</span>
                      : lineCounted(l) ? <span className="rowsub"><span className="dot ok" aria-hidden="true" /><span className="in-total" data-testid="line-counted">{t("drawer.line.included")}</span> · {sub}</span>
                      : <span className="rowsub"><span className="tag-chip tag-off" data-testid="line-counted">{t("drawer.line.excluded")}</span> · {sub}</span>}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
        {canWrite ? <button type="button" className="addbtn" onClick={() => setSheet("addLine")}>+ {t("drawer.addLine")}</button> : null}
      </main>

      <Sheet open={sheet === "options"} title={t("drawer.options")} onClose={() => setSheet(null)}>
        <div className="menu">
          <SwitchRow label={t("drawer.counted")} hint={t("drawer.countedHint")} checked={counted} onChange={(v) => { void setCountedInTotal(id, v); }} testId="counted-switch" />
          <Button variant="secondary" onClick={() => nav(`/drawers/${id}/members`)}>{t("members.open")}</Button>
          {canWrite ? <Button variant="secondary" onClick={() => setSheet("rename")}>{t("drawer.rename")}</Button> : null}
          {canWrite ? <Button variant="secondary" onClick={() => setSheet("icon")} data-testid="drawer-icon">{t("drawer.icon")}</Button> : null}
          {canWrite ? <Button variant="secondary" onClick={() => setSheet("lineTags")} data-testid="manage-tags">{t("drawer.tagsManage")}</Button> : null}
          {canWrite ? <Button variant="secondary" onClick={() => setSheet("tags")} data-testid="drawer-tags">{tagsOf(doc).length ? `${t("drawer.tags")}: ${placeLabel(tagsOf(doc))}` : t("drawer.tags")}</Button> : null}
          {canWrite ? <Button variant="secondary" busy={photoBusy} onClick={() => { setSheet(null); fileRef.current?.click(); }} data-testid="drawer-photo-add">{photoBusy ? t("drawer.photoProcessing") : view.summary.has_photo ? t("drawer.photoChange") : t("drawer.photoAdd")}</Button> : null}
          {canWrite && view.summary.has_photo ? <Button variant="secondary" onClick={() => { setSheet(null); void run(() => removePhoto(id)); }}>{t("drawer.photoRemove")}</Button> : null}
          {isOwner ? <Button variant="secondary" onClick={() => setSheet("history")} data-testid="drawer-history">{t("drawer.history.title")}</Button> : null}
          {isOwner ? <Button variant="danger-ghost" onClick={() => setSheet("delete")}>{t("drawer.delete")}</Button> : null}
        </div>
      </Sheet>
      <PromptSheet open={sheet === "rename"} title={t("drawer.rename")} label={t("home.drawerName")} initial={doc.name} onClose={() => setSheet(null)}
        validate={(v) => (v.trim() ? null : t("drawer.errors.nameRequired"))} onSave={(v) => run(() => mutateDocument(id, [{ type: "rename_drawer", name: v }]))} />
      <Sheet open={sheet === "tags"} title={t("drawer.tags")} onClose={() => setSheet(null)}>
        <PlacePicker tree={tree} value={tagsOf(doc).length ? tagsOf(doc) : null} emptyLabel={t("places.none")} testId="drawer-place-picker"
          onChange={(p) => { setSheet(null); void run(() => mutateDocument(id, [{ type: "set_tags", tags: p ?? [] }])); }}
          onCreate={async (parent, n) => { const r = addPlace(tree, parent, n); await savePlaceTree(r.tree); return r.path; }} />
      </Sheet>
      <ConfirmSheet open={sheet === "delete"} title={t("drawer.delete")} body={t("drawer.deleteConfirm", { name: doc.name })} confirmLabel={t("drawer.deleteBtn")} onClose={() => setSheet(null)}
        challenge={{ label: t("drawer.deleteType"), expected: doc.name, testId: "delete-drawer-name" }}
        onConfirm={async () => { await deleteDrawer(id); nav("/", { replace: true }); }} />
      <TagManager open={sheet === "lineTags"} drawerId={id} onClose={() => setSheet(null)} />
      <Sheet open={sheet === "icon"} title={t("drawer.icon")} onClose={() => setSheet(null)}>
        <IconPicker value={iconOf(doc)} onPick={(icon) => { setSheet(null); void run(() => mutateDocument(id, [{ type: "set_icon", icon }])); }} />
      </Sheet>
      <AddLineSheet open={sheet === "addLine"} onClose={() => setSheet(null)} view={view} />
      {isOwner ? <DocumentHistorySheet open={sheet === "history"} drawerId={id} onClose={() => setSheet(null)} /> : null}
      <ConfirmStateSheet open={sheet === "confirmState"} onClose={() => setSheet(null)} view={view} />

    </>
  );
}
