import { useEffect, useState } from "react";

/**
 * Clerk's components in Petty's look (PETTY-146): the colours come from the live design tokens
 * (tokens.css), read at runtime so light and dark both match, and re-read when the scheme flips.
 * Clerk's own footer ("Secured by Clerk", "Development mode") is left alone.
 */
interface Tokens { dark: boolean; accent: string; accentText: string; text: string; muted: string; card: string; bg: string; border: string; danger: string; font: string }
function read(): Tokens {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  const bg = v("--bg");
  return { dark: bg.toLowerCase() === "#151412", accent: v("--accent"), accentText: v("--accent-text"), text: v("--text"), muted: v("--muted"), card: v("--card"), bg: v("--bg"), border: v("--border"), danger: v("--danger"), font: cs.fontFamily };
}

function build(c: Tokens) {
  return {
    variables: {
      colorPrimary: c.accent, colorTextOnPrimaryBackground: c.accentText, colorText: c.text, colorTextSecondary: c.muted,
      colorBackground: c.card, colorInputBackground: c.card, colorInputText: c.text, colorDanger: c.danger, colorNeutral: c.text,
      fontFamily: c.font, fontFamilyButtons: c.font, fontSize: "15px", borderRadius: "12px", spacingUnit: "1rem",
    },
    elements: {
      rootBox: { width: "100%", display: "flex", justifyContent: "center" },
      cardBox: { width: "100%", maxWidth: "440px", boxShadow: "none", border: `1px solid ${c.border}`, borderRadius: "16px" },
      card: { boxShadow: "none", backgroundColor: c.card },
      headerTitle: { fontSize: "20px", fontWeight: 700, letterSpacing: "-0.01em" },
      headerSubtitle: { color: c.muted },
      formButtonPrimary: { minHeight: "48px", borderRadius: "14px", fontSize: "16px", fontWeight: 700, textTransform: "none", boxShadow: "none" },
      socialButtonsBlockButton: { minHeight: "44px", borderRadius: "12px", borderColor: c.border },
      socialButtonsIconButton: { minHeight: "44px", borderRadius: "12px", borderColor: c.border },
      // GitHub's mark is black; on the dark card it needs to be light.
      socialButtonsProviderIcon__github: c.dark ? { filter: "invert(1)" } : {},
      formFieldInput: { minHeight: "44px", borderRadius: "12px", borderColor: c.border },
      footer: { background: c.bg },
      footerActionLink: { color: c.accent, fontWeight: 600 },
    },
    // "auto": Clerk shows icon buttons when the provider names would not fit.
    options: { socialButtonsPlacement: "top" as const, socialButtonsVariant: "auto" as const },
  };
}

export function useClerkAppearance() {
  const [tokens, setTokens] = useState(read);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const again = () => setTokens(read());
    mq.addEventListener("change", again);
    const obs = new MutationObserver(again);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => { mq.removeEventListener("change", again); obs.disconnect(); };
  }, []);
  return build(tokens);
}
