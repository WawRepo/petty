import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { isClerk } from "../lib/authConfig.js";
import { useNavigate } from "react-router";
import { useBack } from "../lib/nav.js";
import { DeletePreview, type DeletePreview as Preview } from "@petty/protocol";
import { Button } from "../components/Button.js";
import { TextField } from "../components/TextField.js";
import { TopBar } from "../components/TopBar.js";
import { useToast } from "../components/Toast.js";
import { api, ApiError } from "../lib/api.js";
import { custodyProof } from "../lib/custody.js";
import { useDrawers, loadIfIdle } from "../lib/drawers.js";
import { getAuth, signOut } from "../lib/session.js";

type Choice = { action: "transfer"; to_user_id: string } | { action: "delete" };

/** Spec "Account deletion": one screen, one explicit choice per shared drawer, honest text about what stays. */
export function DeleteAccountScreen() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const back = useBack("/settings");
  const toast = useToast();
  const state = useDrawers();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice | undefined>>({});
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (state.status === "idle") loadIfIdle(); }, [state.status]);
  useEffect(() => { api<unknown>("GET", "/me/delete").then((r) => setPreview(DeletePreview.parse(r))).catch(() => setError(t("errors.unknown"))); }, [t]);
  const name = (id: string) => state.drawers.get(id)?.doc?.name ?? "…";
  const undecided = preview ? preview.shared.filter((s) => !choices[s.drawer_id]) : [];

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!preview) return;
    if (undecided.length) { setError(t("delete.decide")); return; }
    setBusy(true); setError(null);
    try {
      const decisions = preview.shared.map((s) => { const c = choices[s.drawer_id]!; return c.action === "transfer" ? { drawer_id: s.drawer_id, action: "transfer", to_user_id: c.to_user_id } : { drawer_id: s.drawer_id, action: "delete" }; });
      const a = getAuth();
      if (a.status !== "unlocked") throw new Error("locked");
      await api("POST", "/me/delete", { ...(isClerk() ? {} : { password }), proof: await custodyProof(a.keys.ecdsaPrivate), decisions });
      await signOut();
      toast(t("delete.done"));
      nav("/login", { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setError(t("delete.wrongPassword"));
      else if (err instanceof ApiError && err.code === "DecisionsRequired") setError(t("delete.decide"));
      else setError(t("errors.unknown"));
    } finally { setBusy(false); }
  }

  return (
    <>
      <TopBar title={t("delete.title")} onBack={back} />
      <main className="stack">
        <p className="warn-box danger" role="alert">{t("delete.intro")}</p>
        <section className="card">
          <p className="hint mb8">{t("delete.erased")}</p>
          <p className="hint m0">{t("delete.kept")}</p>
        </section>
        {preview === null ? <p className="empty">{t("app.loading")}</p> : (
          <form onSubmit={submit} noValidate className="stack">
            <section className="card">
              <h2 className="h-card">{t("delete.sharedTitle")}</h2>
              {preview.shared.length === 0 ? <p className="hint m0">{t("delete.none")}</p> : null}
              {preview.shared.map((s) => {
                const c = choices[s.drawer_id];
                return (
                  <fieldset key={s.drawer_id} className="fieldset-box decision" data-testid="shared-decision">
                    <legend className="legend fw700">{name(s.drawer_id)}</legend>
                    {/* PETTY-126 (audit F19): the two choices are cards in the house style; the native inputs stay for the keyboard and screen readers. */}
                    <label className="choice-row">
                      <input type="radio" name={`d-${s.drawer_id}`} checked={c?.action === "transfer"} onChange={() => setChoices({ ...choices, [s.drawer_id]: { action: "transfer", to_user_id: s.members[0]!.user_id } })} />
                      <span className="choice-body">
                        <span className="choice-title">{t("delete.giveTo")}</span>
                        <span className="field m0">
                          <select aria-label={`${t("delete.giveTo")} ${name(s.drawer_id)}`} disabled={c?.action !== "transfer"} value={c?.action === "transfer" ? c.to_user_id : ""} onChange={(e) => setChoices({ ...choices, [s.drawer_id]: { action: "transfer", to_user_id: e.target.value } })}>
                            {c?.action !== "transfer" ? <option value="">{t("delete.nobody")}</option> : null}
                            {s.members.map((m) => <option key={m.user_id} value={m.user_id}>{m.display_name}</option>)}
                          </select>
                        </span>
                      </span>
                    </label>
                    <label className="choice-row danger">
                      <input type="radio" name={`d-${s.drawer_id}`} checked={c?.action === "delete"} onChange={() => setChoices({ ...choices, [s.drawer_id]: { action: "delete" } })} />
                      <span className="choice-body"><span className="choice-title">{t("delete.deleteForAll")}</span></span>
                    </label>
                  </fieldset>
                );
              })}
            </section>
            <section className="card" data-testid="delete-summary">
              <h2 className="h-card">{t("delete.summaryTitle")}</h2>
              <ul className="list m0 hint">
                {preview.shared.map((s) => {
                  const c = choices[s.drawer_id];
                  const who = c?.action === "transfer" ? s.members.find((m) => m.user_id === c.to_user_id)?.display_name ?? "?" : "";
                  return <li key={s.drawer_id}>{c?.action === "transfer" ? t("delete.summaryGive", { drawer: name(s.drawer_id), name: who }) : c?.action === "delete" ? t("delete.summaryDelete", { drawer: name(s.drawer_id) }) : t("delete.summaryUndecided", { drawer: name(s.drawer_id) })}</li>;
                })}
                {/* PETTY-280 (S24): which drawers, not only how many */}
                {preview.sole.length ? <li>{t("delete.sole", { count: preview.sole.length })}<ul className="list mt4 mb0" data-testid="delete-sole">{preview.sole.map((id) => <li key={id}>{name(id)}</li>)}</ul></li> : null}
                {preview.memberships.length ? <li>{t("delete.memberships", { count: preview.memberships.length })}</li> : null}
              </ul>
            </section>
            <section className="card">
              {isClerk() ? null : <TextField label={t("delete.password")} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} error={error} />}
              <div className="actions">
                <Button variant="secondary" onClick={back}>{t("app.cancel")}</Button>
                <Button variant="danger" type="submit" busy={busy} disabled={!isClerk() && !password}>{busy ? t("delete.working") : t("delete.confirm")}</Button>
              </div>
            </section>
          </form>
        )}
      </main>
    </>
  );
}
