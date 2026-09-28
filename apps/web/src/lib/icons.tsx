import { useTranslation } from "react-i18next";
import {
  Archive, Backpack, Banknote, BedDouble, Bike, BookOpen, Briefcase, Car, Coins, CookingPot, CreditCard, FileText, Gem, Gift, Heart, House,
  KeyRound, Landmark, Laptop, Package, PiggyBank, Plane, Shirt, ShoppingBag, Smartphone, Sofa, Star, Tag, Vault, Wallet, Watch, Wrench, type LucideIcon,
} from "lucide-react";
import type { LineKind } from "@petty/ledger";

/**
 * The icon set (PETTY-64): Lucide (ISC), a fixed list so the slug stored in the encrypted document
 * always maps to a drawing. Colour comes from the tile, never per icon: a drawer's is the accent, a
 * line's is its kind (PETTY-250, as on the landing page) — money green, counted things blue, single
 * notes amber (KIND_CLASS; tokens --k-money, --k-things, --k-notes).
 */
export const ICONS: Record<string, LucideIcon> = {
  home: House, bed: BedDouble, kitchen: CookingPot, sofa: Sofa, car: Car, bike: Bike, briefcase: Briefcase, backpack: Backpack,
  wallet: Wallet, "piggy-bank": PiggyBank, banknote: Banknote, coins: Coins, card: CreditCard, bank: Landmark, vault: Vault, gem: Gem, watch: Watch,
  laptop: Laptop, phone: Smartphone, key: KeyRound, gift: Gift, bag: ShoppingBag, archive: Archive, box: Package, plane: Plane,
  heart: Heart, star: Star, wrench: Wrench, book: BookOpen, shirt: Shirt, tag: Tag, note: FileText,
};
export const ICON_NAMES = Object.keys(ICONS);
export const DEFAULT_DRAWER_ICON = "archive";
export const DEFAULT_LINE_ICON: Record<LineKind, string> = { money: "banknote", countable: "box", single: "note" };
export const KIND_CLASS: Record<LineKind, string> = { money: "k-money", countable: "k-things", single: "k-notes" };
/** A line's icon slug: its own, else its kind's. */
export const lineIcon = (l: { readonly kind: LineKind; readonly icon?: string | undefined }): string => l.icon ?? DEFAULT_LINE_ICON[l.kind];

/** One icon by slug; an unknown slug (a newer build wrote it) falls back to the default drawer icon. */
export function PIcon({ name, size = 22 }: { name: string; size?: number }) {
  const C = ICONS[name] ?? ICONS[DEFAULT_DRAWER_ICON]!;
  return <C size={size} strokeWidth={1.8} aria-hidden="true" />;
}

/**
 * A drawer's colour (PETTY-252): one of eight, muted like the brand green, stored as a slug in the
 * drawer's document. "green" is the default and is stored as no colour. The class sets the local
 * `--accent`, so the drawer's tile, its bubble on Home and the middle and glow of its picture follow.
 * Lines keep their kind's colour (KIND_CLASS): there the colour is a meaning, not a choice.
 */
export const DRAWER_COLORS = ["green", "teal", "blue", "violet", "rose", "clay", "olive", "slate"] as const;
export type DrawerColor = (typeof DRAWER_COLORS)[number];
const isDrawerColor = (c: string | null | undefined): c is DrawerColor => !!c && (DRAWER_COLORS as readonly string[]).includes(c);
/** The class for a drawer's colour; none for the default or a slug a newer build wrote. */
export const colorClass = (c: string | null | undefined): string => (isDrawerColor(c) && c !== "green" ? `c-${c}` : "");

/** A row of colour swatches; the current one is pressed. "green" picks the default (null). */
export function ColorPicker({ value, onPick, testId = "color-picker" }: { value: string | null; onPick: (color: string | null) => void; testId?: string }) {
  const { t } = useTranslation();
  const current = isDrawerColor(value) ? value : "green";
  return (
    <div className="color-row" role="group" aria-label={t("colors.pick")} data-testid={testId}>
      {DRAWER_COLORS.map((c) => (
        <button type="button" key={c} className={`color-swatch ${colorClass(c)}`} aria-pressed={current === c} aria-label={t(`colors.${c}`)} data-color={c} onClick={() => onPick(c === "green" ? null : c)} />
      ))}
    </div>
  );
}

/** A grid of icon buttons; the current one is pressed. Every button has a real name (CLAUDE.md rule 10). */
export function IconPicker({ value, onPick, testId = "icon-picker" }: { value: string | null; onPick: (icon: string | null) => void; testId?: string }) {
  const { t } = useTranslation();
  return (
    <div className="icon-grid" role="group" aria-label={t("icons.pick")} data-testid={testId}>
      <button type="button" className="icon-cell none" aria-pressed={value === null} aria-label={t("icons.none")} onClick={() => onPick(null)}>–</button>
      {ICON_NAMES.map((n) => <button type="button" key={n} className="icon-cell" aria-pressed={value === n} aria-label={t(`icons.${n}`)} data-icon={n} onClick={() => onPick(n)}><PIcon name={n} /></button>)}
    </div>
  );
}
