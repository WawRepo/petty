import { useEffect, useState } from "react";
import type { LegalText } from "@petty/protocol";
import { api } from "./api.js";
import { authConfig } from "./authConfig.js";

/**
 * The operator's own privacy notice and terms (PETTY-342). A deployment that set LEGAL_DIR says so in
 * /config; one that did not (a household, most self-hosters) has neither, and nothing links to them.
 */
export type LegalDoc = LegalText["doc"];
export const hasLegal = (doc: LegalDoc): boolean => authConfig().legal?.[doc] === true;

export function useLegalText(doc: LegalDoc, lang: string): { text: string | null; failed: boolean } {
  const [state, setState] = useState<{ key: string; text: string | null; failed: boolean }>({ key: "", text: null, failed: false });
  const key = `${doc}:${lang}`;
  useEffect(() => {
    if (!hasLegal(doc)) return;
    let live = true;
    api<LegalText>("GET", `/legal/${doc}?lang=${encodeURIComponent(lang)}`)
      .then((r) => { if (live) setState({ key, text: r.text, failed: false }); })
      .catch(() => { if (live) setState({ key, text: null, failed: true }); });
    return () => { live = false; };
  }, [doc, lang, key]);
  return state.key === key ? state : { text: null, failed: false };
}
