import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { MapPin } from "lucide-react";
import { PIcon } from "../lib/icons.js";

/**
 * PETTY-269: above a drawer's picture, the way back to Home at the level of its place — All › Flat ›
 * Kitchen. A pill opens Home at that level, where the drawer shrinks back into its bubble. Real buttons:
 * no other control on the screen goes there. Each is named by its visible text; the trail's label says
 * what they are. A long name ends in "…".
 */
export function PlaceTrail({ path, onPick }: { path: readonly string[]; onPick: (depth: number) => void }) {
  const { t } = useTranslation();
  return (
    <nav className="place-trail" aria-label={t("drawer.trail")} data-testid="place-trail">
      <button type="button" className="trail-pill" onClick={() => onPick(0)}>
        <PIcon name="home" size={14} /><span>{t("home.tags.all")}</span>
      </button>
      {path.map((name, i) => (
        <Fragment key={`${i}:${name}`}>
          <span className="trail-sep" aria-hidden="true">›</span>
          <button type="button" className="trail-pill" onClick={() => onPick(i + 1)}>
            <MapPin size={14} strokeWidth={1.8} aria-hidden="true" /><span>{name}</span>
          </button>
        </Fragment>
      ))}
    </nav>
  );
}
