import type { CSSProperties, Ref } from "react";
import {
  Armchair, BadgeCheck, Banknote, BedDouble, CalendarCheck, CarFront, ChartLine, Coins, CookingPot, Drill, Eye, FolderOpen, Gem, Hammer, Handshake,
  House, IdCard, KeyRound, Landmark, Mail, MapPinned, Package, PiggyBank, Plane, Ruler, ScrollText, ShieldCheck, Tent, Ticket, UserCheck, Users,
  Vault, Wallet, Warehouse, Wrench, type LucideIcon,
} from "lucide-react";
import { Roll } from "./Roll.js";

/**
 * The picture beside each landing example (PETTY-248): the example's drawer in the middle, and around
 * it where it is and what is in it. The colours are the demo's: money green, things blue, notes amber;
 * places and people are plain. The last picture puts every example around the home, on one ring.
 *
 * One set of bubbles draws every picture. Going from one example to the next they travel round the
 * middle to their new places (base.css animates their angle and distance, so each line from the
 * middle stays attached) and their icons pop into the new ones; bubbles a picture does not need fold
 * into the middle. Decorative: the demo and the caption carry the meaning, so assistive tech skips it.
 */
type ArtKind = "money" | "things" | "notes" | "plain" | "case";
interface Sat { readonly n: string; readonly icon: LucideIcon; readonly kind: ArtKind; readonly label?: string }
export interface Scene {
  readonly n: string;
  readonly center: LucideIcon;
  readonly sats: readonly Sat[];
  /** where the first bubble sits, in degrees (−90 is the top); the rest follow clockwise, evenly */
  readonly rot: number;
  /** the orbit, in % of the picture's width and height */
  readonly rx: number;
  readonly ry: number;
  /** every second bubble sits this much closer to the middle, so a picture is not a perfect ring */
  readonly wobble?: number;
  readonly finale?: boolean;
}

const sat = (n: string, icon: LucideIcon, kind: ArtKind): Sat => ({ n, icon, kind });

export const SCENES: Readonly<Record<string, Scene>> = {
  workshop: { n: "hammer", center: Hammer, rot: -90, rx: 34, ry: 35, wobble: 0.1, sats: [
    sat("warehouse", Warehouse, "plain"), sat("package", Package, "things"), sat("ruler", Ruler, "things"), sat("drill", Drill, "notes"), sat("wrench", Wrench, "notes"),
  ] },
  trip: { n: "plane", center: Plane, rot: -54, rx: 36, ry: 34, wobble: 0.06, sats: [
    sat("pin", MapPinned, "plain"), sat("wallet", Wallet, "money"), sat("users", Users, "plain"), sat("coins", Coins, "money"), sat("ticket", Ticket, "things"),
  ] },
  accounts: { n: "landmark", center: Landmark, rot: -45, rx: 31, ry: 36, sats: [
    sat("folder", FolderOpen, "plain"), sat("piggy", PiggyBank, "money"), sat("chart", ChartLine, "money"), sat("calendar", CalendarCheck, "plain"),
  ] },
  cash: { n: "banknote", center: Banknote, rot: -18, rx: 35, ry: 35, wobble: 0.1, sats: [
    sat("pot", CookingPot, "plain"), sat("coins", Coins, "money"), sat("mail", Mail, "money"), sat("bed", BedDouble, "plain"), sat("check", BadgeCheck, "plain"),
  ] },
  lent: { n: "handshake", center: Handshake, rot: -90, rx: 35, ry: 35, wobble: 0.12, sats: [
    sat("car", CarFront, "plain"), sat("drill", Drill, "notes"), sat("armchair", Armchair, "things"), sat("tent", Tent, "notes"), sat("user", UserCheck, "plain"),
  ] },
  family: { n: "vault", center: Vault, rot: -90, rx: 35, ry: 36, wobble: 0.14, sats: [
    sat("bed", BedDouble, "plain"), sat("id", IdCard, "things"), sat("scroll", ScrollText, "things"), sat("gem", Gem, "notes"), sat("key", KeyRound, "notes"), sat("eye", Eye, "plain"),
  ] },
};

/** An example's symbol — the middle of its picture — and the home for the last step. */
export const caseIcon = (key: string): LucideIcon => SCENES[key]?.center ?? House;

/** The last picture: the home in the middle and every example's own symbol on one ring around it. */
export function finaleScene(label: (key: string) => string): Scene {
  const around = ["workshop", "trip", "accounts", "cash", "lent", "family"] as const;
  return {
    n: "house", center: House, rot: -60, rx: 38, ry: 32, finale: true,
    sats: around.map((key) => ({ n: `case-${key}`, icon: SCENES[key]!.center, kind: "case" as const, label: label(key) })),
  };
}

const SATS = 6; // the most any picture has

/**
 * Where bubble `i` of `n` sits: an angle and a distance from the middle, as CSS properties that
 * base.css animates (so a bubble travels round the middle and its spoke stays attached). A bubble that
 * is not `on` folds into the middle. Also drives the app's own pictures (DrawerArt, PETTY-250).
 */
export function orbit(o: { readonly rot: number; readonly rx: number; readonly ry: number; readonly wobble?: number }, n: number, i: number, on = true): CSSProperties {
  const r = on && i < n ? 1 - (o.wobble ?? 0) * (i % 2) : 0;
  return { "--uc-a": `${o.rot + (360 / Math.max(n, 1)) * i}deg`, "--uc-rx": o.rx * r, "--uc-ry": o.ry * r, "--i": i } as CSSProperties;
}

export function UseCaseArt({ scene, sceneKey, seen, ref }: { scene: Scene; sceneKey: string; seen: boolean; ref?: Ref<HTMLDivElement> }) {
  const n = scene.sats.length;
  const Center = scene.center;
  const at = (i: number): CSSProperties => orbit(scene, n, i, seen);
  return (
    <div ref={ref} className={`uc-art${scene.finale ? " finale" : ""}${seen ? "" : " unseen"}`} aria-hidden="true" data-testid="use-case-art" data-scene={sceneKey}>
      <span className="uc-halo" />
      <span className="uc-orbit" style={{ "--uc-rx": scene.rx, "--uc-ry": scene.ry } as CSSProperties} />
      {Array.from({ length: SATS }, (_, i) => <span key={i} className={`uc-spoke${i < n ? "" : " off"}`} style={at(i)} />)}
      {Array.from({ length: SATS }, (_, i) => {
        const s = scene.sats[i];
        const Icon = s?.icon;
        return (
          <span key={i} className={`uc-bub sat k-${s?.kind ?? "plain"}${s ? "" : " off"}`} style={at(i)}>
            <span className="uc-bub-float">
              <span className="uc-bub-disc">
                <Roll k={s?.n ?? "none"} delay={i * 45} className="uc-swap">{Icon ? <Icon className="uc-bub-icon" strokeWidth={2} /> : null}</Roll>
              </span>
              <Roll k={s?.label ?? ""} delay={scene.finale ? 700 + i * 60 : 0} className="uc-bub-label">{s?.label ?? null}</Roll>
            </span>
          </span>
        );
      })}
      <span className="uc-bub center">
        <span className="uc-bub-float">
          <span className="uc-bub-disc">
            <Roll k={scene.n} className="uc-swap"><Center className="uc-bub-icon" strokeWidth={1.8} /></Roll>
            <span className="uc-bub-badge"><ShieldCheck strokeWidth={2.2} /></span>
          </span>
        </span>
      </span>
    </div>
  );
}
