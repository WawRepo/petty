/**
 * Renders the PWA icon set from public/app-icon.svg (Phase 17, PETTY-51: the
 * full-bleed variant; icon.svg with the spark lines is the landing/logo mark). iOS ignores SVG
 * manifest icons and needs a 180 px PNG; Android/Chrome want 192 + 512 PNG and
 * a maskable variant with safe-zone padding. Run: pnpm icons
 */
import sharp from "sharp";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../public/", import.meta.url));
const svg = readFileSync(dir + "app-icon.svg");
const BG = "#2f6f4f";

async function plain(size: number, name: string) {
  await sharp(svg).resize(size, size).png().toFile(dir + name);
}
/** Maskable: the artwork sits inside the central 80% (Android safe zone), on the brand colour. */
async function maskable(size: number, name: string) {
  const inner = Math.round(size * 0.66);
  const art = await sharp(svg).resize(inner, inner).png().toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: BG } })
    .composite([{ input: art, gravity: "centre" }]).png().toFile(dir + name);
}
await plain(192, "icon-192.png");
await plain(512, "icon-512.png");
await maskable(512, "icon-maskable-512.png");
await maskable(180, "apple-touch-icon.png");
process.stdout.write("icons written\n");
