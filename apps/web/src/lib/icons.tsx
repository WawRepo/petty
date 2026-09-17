import { useTranslation } from "react-i18next";
import {
  Archive, Backpack, Banknote, BedDouble, Bike, BookOpen, Briefcase, Car, Coins, CookingPot, CreditCard, FileText, Gem, Gift, Heart, House,
  KeyRound, Landmark, Laptop, Package, PiggyBank, Plane, Shirt, ShoppingBag, Smartphone, Sofa, Star, Tag, Vault, Wallet, Watch, Wrench, type LucideIcon,
} from "lucide-react";
import type { LineKind } from "@petty/ledger";

/**
 * The icon set (PETTY-64): Lucide (ISC), a fixed list so the slug stored in the encrypted document
 * always maps to a drawing. Colour comes from the tile (accent on a tinted ground), never per icon.
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

/** One icon by slug; an unknown slug (a newer build wrote it) falls back to the default drawer icon. */
export function PIcon({ name, size = 22 }: { name: string; size?: number }) {
  const C = ICONS[name] ?? ICONS[DEFAULT_DRAWER_ICON]!;
  return <C size={size} strokeWidth={1.8} aria-hidden="true" />;
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
