import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { Button } from "../components/Button.js";
import { TopBar } from "../components/TopBar.js";
import { useAuth } from "../lib/session.js";

/** A wrong or stale URL (PETTY-110, audit F3): say so, and offer the one way out that fits the visitor. */
export function NotFoundScreen() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const auth = useAuth();
  const signedIn = auth.status === "unlocked" || auth.status === "locked";
  return (
    <>
      <TopBar title={t("app.name")} brand />
      <main>
        <h2 className="landing-h2" data-testid="not-found">{t("notFound.title")}</h2>
        <p className="hint">{t("notFound.body")}</p>
        <div className="actions">
          <Button onClick={() => nav("/", { replace: true })}>{t(signedIn ? "notFound.drawers" : "notFound.home")}</Button>
          <Button variant="secondary" onClick={() => history.length > 1 ? nav(-1) : nav("/", { replace: true })}>{t("app.back")}</Button>
        </div>
      </main>
    </>
  );
}
