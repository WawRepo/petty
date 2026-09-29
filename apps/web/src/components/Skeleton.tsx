import { useTranslation } from "react-i18next";

/**
 * Placeholders the size of the real thing (PETTY-118, audit F11): the home renders a total card,
 * a chip row and three drawer rows in grey before the data arrives, so the page does not jump
 * when it does. `aria-busy` + one hidden sentence for screen readers instead of a shimmer.
 */
export function HomeSkeleton() {
  const { t } = useTranslation();
  const shape = homeShape();
  return (
    <div className="skeleton" aria-busy="true" role="status" data-testid="home-skeleton">
      <span className="sr-only">{t("app.loading")}</span>
      <div className="sk sk-total" style={shape.top ? { height: shape.top } : undefined} />
      {shape.chips === false ? null : <div className="sk-chips"><span className="sk sk-chip" /><span className="sk sk-chip" /><span className="sk sk-chip" /></div>}
      <div className="sk sk-row" /><div className="sk sk-row" /><div className="sk sk-row" />
    </div>
  );
}

/**
 * How tall Home's top card was last time (PETTY-280, M11: the skeleton's 122 px stood for a 456 px card
 * with its picture, so the list jumped). A height and whether chips showed: no content, this browser only.
 */
const SHAPE = "petty.home-shape";
export function homeShape(): { top?: number; chips?: boolean } {
  try { return JSON.parse(localStorage.getItem(SHAPE) ?? "{}") as { top?: number; chips?: boolean }; } catch { return {}; }
}
export function rememberHomeShape(top: number, chips: boolean): void {
  const was = homeShape();
  if (was.top === top && was.chips === chips) return;
  try { localStorage.setItem(SHAPE, JSON.stringify({ top, chips })); } catch { /* storage blocked: the default skeleton */ }
}

/** A drawer's screen before its data: the picture's band, the totals and three rows (M11). */
export function DrawerSkeleton() {
  const { t } = useTranslation();
  return (
    <main className="skeleton" aria-busy="true" role="status" data-testid="drawer-skeleton">
      <span className="sr-only">{t("app.loading")}</span>
      <div className="sk sk-art" /><div className="sk sk-totals" /><div className="sk sk-line" /><div className="sk sk-line" /><div className="sk sk-line" />
    </main>
  );
}

/** An item's screen before its data: its bubble, the balance, the three buttons and the history (M11). */
export function LineSkeleton() {
  const { t } = useTranslation();
  return (
    <main className="skeleton" aria-busy="true" role="status" data-testid="line-skeleton">
      <span className="sr-only">{t("app.loading")}</span>
      <div className="sk sk-bubble" /><div className="sk sk-balance" /><div className="sk sk-buttons" /><div className="sk sk-line" /><div className="sk sk-line" />
    </main>
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
