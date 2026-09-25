import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router";
import { useBack } from "../lib/nav.js";
import { decimalSeparator, formatAmount, formatCount, negativeWarning, newEntryAmount, parseAmount, LedgerError, type LedgerEntry, type Line } from "@petty/ledger";
import type { EntryOp } from "@petty/crypto";
import { Button } from "../components/Button.js";
import { ConfirmSheet } from "../components/ConfirmSheet.js";
import { applyKey, Keypad } from "../components/Keypad.js";
import { Sheet } from "../components/Sheet.js";
import { TextField } from "../components/TextField.js";
import { TopBar } from "../components/TopBar.js";
import { ReadOnlyHint } from "../components/ReadOnlyHint.js";
import { LineOptions, type LineOptionsStep } from "../components/LineOptions.js";
import { OfflineBanner } from "../components/OfflineBanner.js";
import { SyncReport } from "../components/SyncReport.js";
import { useToast } from "../components/Toast.js";
import { acknowledgeChain, appendEntry, lineFold, loadAll, loadOlder, memberName, RecountRequired, reverseFor, ReverseRefused, useDrawers, type DrawerView } from "../lib/drawers.js";
import { initial } from "../lib/format.js";
import { storageErrorKey } from "../lib/storage.js";

type Op = Exclude<EntryOp, "reverse">;
type MoneyOrCount = Exclude<Line, { kind: "single" }>;

function fmt(line: MoneyOrCount, n: number, locale: string): string {
  return line.kind === "money" ? formatAmount(n, line.exponent, locale) : formatCount(n, locale);
}
function signed(line: MoneyOrCount, n: number, locale: string): string {
  return `${n < 0 ? "−" : "+"}${fmt(line, Math.abs(n), locale)}`;
}

/** Keypad → review → confirm, as in the prototype. */
function EntrySheet({ view, line, op, onClose, onSaved }: { view: DrawerView; line: MoneyOrCount; op: Op; onClose: () => void; onSaved: (entryId: string) => void }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const [amount, setAmount] = useState("0");
  const [comment, setComment] = useState("");
  const [step, setStep] = useState<"keypad" | "confirm">("keypad");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recount, setRecount] = useState(false);
  const locale = i18n.language;
  const unit = line.kind === "money" ? line.currency : line.unit || t("drawer.line.items");
  const noun = t(`line.entry.noun.${line.kind === "money" ? "balance" : "count"}`);
  const current = lineFold(view, line.id).balance;
  const exponent = line.kind === "money" ? line.exponent : 0;

  let magnitude = 0;
  try { magnitude = parseAmount(amount, exponent); } catch { magnitude = -1; }
  const delta = op === "add" ? magnitude : op === "withdraw" ? -magnitude : magnitude - current;
  const next = op === "adjust" ? magnitude : current + delta;
  const warning = op === "withdraw" && magnitude > 0 ? negativeWarning(current, -magnitude) : null;

  function review() {
    if (magnitude < 0) { setError(t("line.entry.invalid")); return; }
    if (magnitude === 0 && op !== "adjust") { setError(t("line.entry.zero")); return; }
    setError(null); setStep("confirm");
  }
  // PETTY-112 (audit F5): the physical keyboard drives the keypad — digits, "." or ",", Backspace, Enter → Review.
  // Keys typed into the comment field stay in the comment; Escape is the sheet's own (focus trap).
  const reviewRef = useRef(review); reviewRef.current = review;
  useEffect(() => {
    if (step !== "keypad" || recount) return;
    const dec = decimalSeparator(locale);
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      const inField = tag === "INPUT" || tag === "TEXTAREA";
      if (e.key === "Enter") { e.preventDefault(); reviewRef.current(); return; }
      if (inField) return;
      const k = e.key === "." || e.key === "," ? dec : e.key === "Backspace" ? "⌫" : e.key;
      if (k !== "⌫" && k !== dec && !/^[0-9]$/.test(k)) return;
      e.preventDefault();
      setAmount((v) => applyKey(v, k, dec, exponent > 0)); setError(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [step, recount, locale, exponent]);
  async function confirm() {
    setBusy(true);
    try {
      let value: number;
      try { value = newEntryAmount(op, magnitude); } catch (e) { setError(e instanceof LedgerError ? t("line.entry.invalid") : t("errors.unknown")); return; }
      const saved = await appendEntry(view.summary.id, line, op, value, { comment, delta_hint: op === "adjust" ? magnitude - current : null });
      toast(t("line.entry.saved"));
      onSaved(saved.entry.id);
    } catch (e) {
      if (e instanceof RecountRequired) setRecount(true);
      else setError(t(storageErrorKey(e) ?? "errors.unknown"));
    } finally { setBusy(false); }
  }

  if (recount) {
    return (
      <Sheet open title={t("line.recount.title")} onClose={onClose}>
        <p role="alert">{t("line.recount.body")}</p>
        <div className="actions"><Button onClick={onClose}>{t("line.recount.ok")}</Button></div>
      </Sheet>
    );
  }
  if (step === "confirm") {
    return (
      <Sheet open title={t("line.entry.confirmTitle")} onClose={onClose}>
        <div className="confirm-summary" data-testid="confirm-summary">
          <div className="cline"><span className="k">{t("line.entry.operation")}</span><span>{t(`line.ops.${op}`)}</span></div>
          <div className="cline"><span className="k">{t("line.entry.current", { noun })}</span><span>{fmt(line, current, locale)} {unit}</span></div>
          <div className="cline"><span className="k">{t("line.entry.change")}</span><span>{signed(line, delta, locale)} {unit}</span></div>
          {comment ? <div className="cline"><span className="k">{t("line.entry.comment")}</span><span>{comment}</span></div> : null}
          <div className="cline total"><span>{t("line.entry.new", { noun })}</span><span className={next < 0 ? "negative-text" : ""}>{fmt(line, next, locale)} {unit}</span></div>
        </div>
        {warning !== null ? <p className="warn-box danger" role="alert" data-testid="negative-warning">{t("line.entry.negativeWarning", { amount: `${fmt(line, warning, locale)} ${unit}` })}</p> : null}
        {error ? <p className="error" role="alert">{error}</p> : null}
        <div className="actions">
          <Button variant="secondary" onClick={() => setStep("keypad")}>{t("app.back")}</Button>
          <Button busy={busy} onClick={() => void confirm()}>{t("line.entry.confirm")}</Button>
        </div>
      </Sheet>
    );
  }
  return (
    <Sheet open title={t(`line.entry.title.${op}`, { noun })} onClose={onClose}>
      <div className="amount-display" aria-live="polite">
        <span className="hint block mb4 fw600">{op === "adjust" ? t("line.entry.real", { noun, unit }) : t("line.entry.amount", { unit })}</span>
        <output data-testid="amount-display" aria-label={t("line.entry.amount", { unit })}>{amount}</output>
      </div>
      <Keypad value={amount} onChange={(v) => { setAmount(v); setError(null); }} allowDecimal={exponent > 0} />
      <span className="sr-only">{decimalSeparator(locale)}</span>
      <TextField label={t("line.entry.comment")} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t("line.entry.commentPlaceholder")} error={error} maxLength={500} />
      <div className="actions">
        <Button variant="secondary" onClick={onClose}>{t("app.cancel")}</Button>
        <Button onClick={review}>{t("line.entry.review")}</Button>
      </div>
    </Sheet>
  );
}

function EntryRow({ view, line, e, reversed, onOpen, fresh = false }: { view: DrawerView; line: MoneyOrCount; e: LedgerEntry; reversed: boolean; onOpen: () => void; fresh?: boolean }) {
  const pending = view.pending.has(e.entry.id);
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const p = e.entry;
  const d = new Date(e.received_at);
  const when = `${d.toLocaleDateString(i18n.language, { month: "short", day: "numeric", year: "numeric" })} · ${d.toLocaleTimeString(i18n.language, { hour: "numeric", minute: "2-digit" })}`;
  const author = memberName(view, p.author_id);
  const amountText = p.op === "adjust" ? `${fmt(line, p.amount, i18n.language)}${p.delta_hint !== null ? ` ${t("line.row.adjustHint", { delta: signed(line, p.delta_hint, i18n.language) })}` : ""}` : signed(line, p.amount, i18n.language);
  return (
    <div className={`entry${reversed ? " reversed" : ""}${pending ? " pending" : ""}${fresh ? " fresh" : ""}`} data-testid="entry-row" data-entry-id={p.id} data-pending={pending || undefined}>
      <button type="button" className="avatar-btn" aria-label={t("line.row.by", { name: author })} onClick={() => toast(author)}><span className="avatar">{initial(author)}</span></button>
      <button type="button" className="left plain-btn" onClick={onOpen} aria-label={t("line.row.options")}>
        <span className={`op ${p.op}`}>{t(`line.ops.${p.op}`)}{reversed ? ` · ${t("line.row.reversed")}` : ""}{p.op === "reverse" ? ` · ${t("line.row.cancels")}` : ""}{pending ? ` · ${t("offline.pendingEntry")}` : ""}</span>
        <span className="meta">{when}{p.comment ? ` · ${p.comment}` : ""}</span>
      </button>
      <div className="right"><div className="delta">{amountText}</div></div>
    </div>
  );
}

export function LineScreen() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const { id = "", lineId = "" } = useParams();
  const back = useBack(`/drawers/${id}`);
  const state = useDrawers();
  const [op, setOp] = useState<Op | null>(null);
  const [picked, setPicked] = useState<LedgerEntry | null>(null);
  const [confirmReverse, setConfirmReverse] = useState(false);
  // After a save the newest entry sits at the top of the history: bring the page there and flash it (PETTY-65).
  // On a phone the sheet and its keyboard leave the page scrolled wherever it was, mid-history.
  const [fresh, setFresh] = useState<string | null>(null);
  useEffect(() => { if (!fresh) return; const h = window.setTimeout(() => setFresh(null), 2500); return () => window.clearTimeout(h); }, [fresh]);
  const showNewest = (entryId: string) => {
    setFresh(entryId);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  };
  useEffect(() => { if (state.status === "idle") void loadAll(); }, [state.status]);
  // The line's options live here, behind ⋯ in the top bar (PETTY-71) — as a drawer's do on its own screen.
  const [opts, setOpts] = useState<LineOptionsStep | null>(null);
  const view = state.drawers.get(id);
  const line = view?.doc?.lines.find((l) => l.id === lineId);
  const f = useMemo(() => (view && line && line.kind !== "single" ? lineFold(view, lineId) : null), [view, line, lineId]);
  if (!view || !line) return <><TopBar title={t("app.name")} onBack={back} /><main><p className="empty">{t("app.loading")}</p></main></>;
  const optionsButton = <button type="button" className="icon-btn" aria-label={t("drawer.lineOptions", { name: line.name })} onClick={() => setOpts("options")} data-testid="line-options">⋯</button>;
  const options = <LineOptions view={view} line={line} open={opts !== null} startAt={opts ?? "options"} onClose={() => setOpts(null)} onDeleted={back} />;
  const canWrite = view.summary.role !== "read";
  if (line.kind === "single") {
    return (
      <>
        <TopBar title={line.name} onBack={back} actions={optionsButton} />
        <main>
          <OfflineBanner />
          <SyncReport />
          <ReadOnlyHint view={view} />
          <section className="card single-text" data-testid="single-text">{line.text ? <p className="m0">{line.text}</p> : <p className="empty m0">{t("line.noText")}</p>}</section>
          {canWrite ? <div className="mt8"><Button variant="secondary" onClick={() => setOpts("text")}>{t("drawer.line.editText")}</Button></div> : null}
        </main>
        {options}
      </>
    );
  }
  if (!f) return <><TopBar title={t("app.name")} onBack={back} /><main><p className="empty">{t("app.loading")}</p></main></>;
  const locale = i18n.language;
  const window_ = view.entries.get(lineId) ?? [];
  const hist = view.history.get(lineId);
  const chain = view.chains.get(lineId);
  const problems = view.entryProblems.filter((p) => p.line_id === lineId);
  const newestFirst = [...window_].reverse();
  const olderNewestFirst = [...(hist?.older ?? [])].reverse();
  const unit = line.kind === "money" ? line.currency : line.unit || t("drawer.line.items");
  const rev = picked ? reverseFor(view, lineId, picked.entry.id) : null;

  async function doReverse() {
    if (!picked || !rev?.ok) return;
    try { const saved = await appendEntry(id, line as MoneyOrCount, "reverse", rev.amount, { reverses: rev.reverses }); toast(t("line.entry.saved")); showNewest(saved.entry.id); }
    catch (e) { toast(e instanceof ReverseRefused ? t(`line.reverse.refused.${e.reason}`) : t("errors.unknown")); }
    finally { setPicked(null); setConfirmReverse(false); }
  }

  return (
    <>
      <TopBar title={line.name} onBack={back} actions={optionsButton} />
      <main>
        <OfflineBanner />
        <SyncReport />
        <div className="balance-hero">
          <div className={`amt${f.negative ? " negative" : ""}`} data-testid="line-balance">{fmt(line, f.balance, locale)}</div>
          <div className="unit">{unit}</div>
        </div>
        <ReadOnlyHint view={view} />
        {f.negative ? <p className="warn-box danger" role="status" data-testid="warn-negative">{t("line.warn.negative")}</p> : null}
        {problems.length ? <p className="warn-box danger" role="alert" data-testid="warn-problems">{t("line.warn.problems", { count: problems.length })}</p> : null}
        {f.skipped.length ? <p className="warn-box" role="status">{t("line.warn.skipped", { count: f.skipped.length })}</p> : null}
        {chain && chain.status !== "ok" ? (
          <div className="warn-box danger" role="alert" data-testid={`warn-chain-${chain.status}`}>
            {t(`line.warn.${chain.status}`)}
            <div className="mt8"><Button variant="secondary" onClick={() => void acknowledgeChain(id, lineId)}>{t("line.warn.acknowledge")}</Button></div>
          </div>
        ) : null}
        {canWrite ? (
          <div className="actions-row">
            <Button className="btn-add" onClick={() => setOp("add")}>{t("line.ops.add")}</Button>
            <Button className="btn-withdraw" onClick={() => setOp("withdraw")}>{t("line.ops.withdraw")}</Button>
            <Button className="btn-adjust" onClick={() => setOp("adjust")}>{t("line.ops.adjust")}</Button>
          </div>
        ) : null}
        <h2 className="section">{t("line.history")}</h2>
        {window_.length === 0 && olderNewestFirst.length === 0 ? <p className="empty">{t("line.noEntries")}</p> : null}
        <div className="stack" data-testid="history">
          {newestFirst.map((e) => <EntryRow key={e.entry.id} view={view} line={line} e={e} reversed={f.reversed.has(e.entry.id)} fresh={e.entry.id === fresh} onOpen={() => setPicked(e)} />)}
          {olderNewestFirst.length ? <h2 className="section">{t("line.olderLoaded")}</h2> : null}
          {olderNewestFirst.map((e) => <EntryRow key={e.entry.id} view={view} line={line} e={e} reversed={false} onOpen={() => setPicked(e)} />)}
        </div>
        {hist?.hasMore === false || window_[0]?.entry.prev_hash === null ? null : <button type="button" className="addbtn" onClick={() => void loadOlder(id, lineId)}>{t("line.loadOlder")}</button>}
      </main>
      {op ? <EntrySheet view={view} line={line} op={op} onClose={() => setOp(null)} onSaved={(entryId) => { setOp(null); showNewest(entryId); }} /> : null}
      <Sheet open={picked !== null && !confirmReverse} title={t("line.row.options")} onClose={() => setPicked(null)}>
        {picked ? <p className="hint">{t(`line.ops.${picked.entry.op}`)} · {signed(line, picked.entry.op === "adjust" ? (picked.entry.delta_hint ?? 0) : picked.entry.amount, locale)} {unit} · {t("line.row.by", { name: memberName(view, picked.entry.author_id) })}</p> : null}
        {rev && !rev.ok ? <p className="hint" data-testid="reverse-refused">{t(`line.reverse.refused.${rev.code}`)}</p> : null}
        <div className="menu">
          {canWrite ? <Button variant="danger" disabled={!rev?.ok} onClick={() => setConfirmReverse(true)}>{t("line.reverse.action")}</Button> : null}
        </div>
      </Sheet>
      <ConfirmSheet open={confirmReverse} title={t("line.reverse.title")} body={t("line.reverse.body")} confirmLabel={t("line.ops.reverse")} onClose={() => { setConfirmReverse(false); setPicked(null); }} onConfirm={doReverse} />
      {options}
    </>
  );
}
