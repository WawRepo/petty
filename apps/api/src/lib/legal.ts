import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The operator's own legal texts (PETTY-342): a privacy notice and terms of service, one Markdown file
 * per language, in LEGAL_DIR — `privacy.en.md`, `terms.pl.md`. They name who runs this Petty, so they
 * belong to the deployment, never to this repository: the household instance and most self-hosters set
 * nothing and see no change. Read once at start; a LEGAL_DIR that is set but unreadable stops the start,
 * so a public instance never runs without the texts it is meant to show.
 */
export const LEGAL_DOCS = ["privacy", "terms"] as const;
export type LegalDoc = (typeof LEGAL_DOCS)[number];
const FILE = /^(privacy|terms)\.([a-z]{2})\.md$/;
const MAX_BYTES = 200_000;

export type LegalTexts = ReadonlyMap<LegalDoc, ReadonlyMap<string, string>>;

export function loadLegalTexts(dir: string): LegalTexts {
  const out = new Map<LegalDoc, Map<string, string>>();
  if (!dir) return out;
  for (const name of readdirSync(dir).sort()) {
    const m = FILE.exec(name);
    if (!m) continue;
    const text = readFileSync(join(dir, name), "utf8");
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error(`LEGAL_DIR: ${name} is over ${MAX_BYTES} bytes`);
    const doc = m[1] as LegalDoc;
    out.set(doc, (out.get(doc) ?? new Map()).set(m[2]!, text));
  }
  return out;
}

/**
 * PETTY-216: a short fingerprint of one document in all its languages (sha256 over the sorted language codes
 * and texts). A sign-up stores the terms' fingerprint, so the operator can tell which text was accepted;
 * any change to any language gives a new one. Null when the doc is missing.
 */
export function legalVersion(texts: LegalTexts, doc: LegalDoc): string | null {
  const byLang = texts.get(doc);
  if (!byLang?.size) return null;
  const h = createHash("sha256");
  for (const lang of [...byLang.keys()].sort()) h.update(`${lang}\0${byLang.get(lang)}\0`);
  return `sha256:${h.digest("hex").slice(0, 16)}`;
}

/** The texts this process serves, set once by buildApp, so the sign-up routes can record the terms version. */
let served: LegalTexts = new Map();
export function serveLegalTexts(texts: LegalTexts): void { served = texts; }
export const termsVersion = (): string | null => legalVersion(served, "terms");

/** The text in this language, else English, else the first language there is; null when the doc is missing. */
export function legalText(texts: LegalTexts, doc: LegalDoc, lang: string): { lang: string; text: string } | null {
  const byLang = texts.get(doc);
  if (!byLang?.size) return null;
  const pick = byLang.has(lang) ? lang : byLang.has("en") ? "en" : [...byLang.keys()][0]!;
  return { lang: pick, text: byLang.get(pick)! };
}
