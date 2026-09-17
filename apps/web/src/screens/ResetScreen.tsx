import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { Button } from "../components/Button.js";
import { TextField } from "../components/TextField.js";
import { TopBar } from "../components/TopBar.js";
import { useToast } from "../components/Toast.js";
import { api, ApiError, NetworkError } from "../lib/api.js";

/** New login password from a mailed link. The vault passphrase is not involved and the screen says so. */
export function ResetScreen() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const toast = useToast();
  const { token: pathToken } = useParams();
  const [token] = useState(() => pathToken ?? location.hash.replace(/^#/, ""));
  const [p1, setP1] = useState(""); const [p2, setP2] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (p1.length < 8) errs["p1"] = t("auth.join.errors.passwordShort");
    if (p1 !== p2) errs["p2"] = t("auth.reset.mismatch");
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      await api("POST", "/auth/reset", { token, password: p1 });
      toast(t("auth.reset.done"));
      nav("/login", { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === "ResetInvalid") setErrors({ form: t("auth.reset.invalid") });
      else if (err instanceof NetworkError) setErrors({ form: t("errors.network") });
      else setErrors({ form: t("errors.unknown") });
    } finally { setBusy(false); }
  }

  return (
    <>
      <TopBar title={t("auth.reset.newTitle")} />
      <main>
        <p className="hint">{t("auth.reset.newHint")}</p>
        <form onSubmit={submit} noValidate>
          <TextField label={t("auth.reset.newPassword")} type="password" autoComplete="new-password" value={p1} onChange={(e) => setP1(e.target.value)} hint={t("auth.join.passwordHint")} error={errors["p1"]} autoFocus />
          <TextField label={t("auth.reset.repeat")} type="password" autoComplete="new-password" value={p2} onChange={(e) => setP2(e.target.value)} error={errors["p2"]} />
          {errors["form"] ? <p className="error" role="alert">{errors["form"]}</p> : null}
          <Button type="submit" busy={busy}>{t("auth.reset.submit")}</Button>
        </form>
        <p><Button variant="ghost" onClick={() => nav("/login")}>{t("auth.reset.toLogin")}</Button></p>
      </main>
    </>
  );
}
