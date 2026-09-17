import { useTranslation } from "react-i18next";

/**
 * Placeholders the size of the real thing (PETTY-118, audit F11): the home renders a total card,
 * a chip row and three drawer rows in grey before the data arrives, so the page does not jump
 * when it does. `aria-busy` + one hidden sentence for screen readers instead of a shimmer.
 */
export function HomeSkeleton() {
  const { t } = useTranslation();
  return (
    <div className="skeleton" aria-busy="true" role="status" data-testid="home-skeleton">
      <span className="sr-only">{t("app.loading")}</span>
      <div className="sk sk-total" />
      <div className="sk-chips"><span className="sk sk-chip" /><span className="sk sk-chip" /><span className="sk sk-chip" /></div>
      <div className="sk sk-row" /><div className="sk sk-row" /><div className="sk sk-row" />
    </div>
  );
}

/** The shell's own placeholder while the session boots: a bar and two cards. */
export function PageSkeleton() {
  const { t } = useTranslation();
  return (
    <main className="skeleton" aria-busy="true" role="status">
      <span className="sr-only">{t("app.loading")}</span>
      <div className="sk sk-total" /><div className="sk sk-row" /><div className="sk sk-row" />
    </main>
  );
}
