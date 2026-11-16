/**
 * PETTY-495: how many terminal cells a text takes, so that `petty drawers` lines its amounts up after an
 * item name with an emoji or with Chinese, Japanese or Korean letters. `String.padEnd` counts UTF-16
 * units: "💰" is 2 of them and 2 cells, but "👨‍👩‍👧" is 8 units in 2 cells, and "猫" is 1 unit in 2 cells.
 *
 * One character as people see it (a grapheme: a letter with its accents, a whole emoji with its joiners,
 * a flag) takes 2 cells when it is an emoji shown as a picture, or a wide East Asian letter or sign;
 * otherwise 1. Terminals differ in rare cases; this is the rule most of them follow. Text reaching this
 * point has no control or invisible characters left (`clean` in cli.ts turns them into "?").
 */
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// an emoji shown as a picture: one that is a picture by default, one asked to be (U+FE0F), a flag, a keycap
const PICTURE = /\p{Emoji_Presentation}|️|\p{Regional_Indicator}|⃣/u;
// East Asian Wide and Fullwidth: the CJK scripts, their symbols and punctuation, the fullwidth forms
const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}⺀-〾豈-﫿︰-﹏＀-｠￠-￦]/u;

/** The number of terminal cells `text` takes. */
export function cells(text: string): number {
  let n = 0;
  for (const { segment } of segmenter.segment(text)) n += PICTURE.test(segment) || WIDE.test(segment) ? 2 : 1;
  return n;
}

/** `text` with spaces after it up to `width` cells (no spaces when it is already that wide or wider). */
export function padCells(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - cells(text)));
}
