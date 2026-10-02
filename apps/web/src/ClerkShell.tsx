import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ClerkProvider, useAuth as useClerkAuth, useClerk } from "@clerk/react";
import { useNavigate } from "react-router";
import { currentLocale, type Locale } from "./i18n/index.js";
import { Clerk } from "@clerk/clerk-js";
import { ui } from "@clerk/ui";
import { authConfig } from "./lib/authConfig.js";
import { setTokenProvider } from "./lib/api.js";
import { boot, setSessionScope, setSignOutHandler, toAnonymous } from "./lib/session.js";
import { useClerkAppearance } from "./lib/clerkAppearance.js";

/**
 * clerk-js is bundled into this chunk at a pinned version (PETTY-185, review NR-5), not fetched from
 * Clerk's servers at run time: the page that holds the vault keys runs only code we built and can
 * review. The CSP therefore no longer lists Clerk's origin under script-src. Since Clerk 6 the sign-in
 * and sign-up screens are a package of their own, @clerk/ui, which Clerk would otherwise load from its
 * CDN; it is bundled too and handed to ClerkProvider as `ui` (PETTY-306).
 */
let clerkInstance: Clerk | null = null;
// Clerk 6's types differ from this repo's exactOptionalPropertyTypes in one internal optional field
// (__internal_protectChallengeLoadTimeoutMs: number | undefined vs number); the instance itself is the
// one ClerkProvider expects.
type ClerkInstanceProp = ComponentProps<typeof ClerkProvider>["Clerk"];
const clerkJs = (publishableKey: string): ClerkInstanceProp => (clerkInstance ??= new Clerk(publishableKey)) as unknown as ClerkInstanceProp;

/**
 * Clerk moves between its steps (the email code, a second factor, the OAuth return) through the app's
 * router. Without these it loaded the whole page for each step: the app booted again and the page stood
 * blank until Clerk drew again, a sign-up's code step among them. Clerk keeps the first functions it
 * gets, so they are module-level and call the router of the shell that is mounted now (a navigate from
 * a render React threw away is ignored, and the page was left empty after the code).
 */
let appNavigate: ((to: string, replace: boolean) => void) | null = null;
const clerkNavigation = (replace: boolean) => (to: string) => {
  const url = new URL(to, location.href);
  if (url.origin !== location.origin || !appNavigate) { if (replace) location.replace(url.href); else location.assign(url.href); return; }
  appNavigate(url.pathname + url.search + url.hash, replace);
};
const routerPush = clerkNavigation(false);
const routerReplace = clerkNavigation(true);

type ClerkLocalization = NonNullable<ComponentProps<typeof ClerkProvider>["localization"]>;
/** PETTY-249: Clerk's own texts (the sign-in and sign-up forms) in the app's language, each loaded on demand. */
const CLERK_LOCALES: Record<Locale, () => Promise<ClerkLocalization>> = {
  en: () => import("@clerk/localizations/en-US").then((m) => m.enUS),
  pl: () => import("@clerk/localizations/pl-PL").then((m) => m.plPL),
  de: () => import("@clerk/localizations/de-DE").then((m) => m.deDE),
  es: () => import("@clerk/localizations/es-ES").then((m) => m.esES),
  fr: () => import("@clerk/localizations/fr-FR").then((m) => m.frFR),
};
function useClerkLocalization(): ClerkLocalization | undefined {
  const { i18n } = useTranslation();
  const [localization, setLocalization] = useState<ClerkLocalization | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void CLERK_LOCALES[currentLocale()]().then((l) => { if (live) setLocalization(l); }).catch(() => undefined);
    return () => { live = false; };
  }, [i18n.language]);
  return localization;
}

/**
 * The Clerk side of the gate (PETTY-88), its own chunk, loaded only in clerk mode. Once Clerk
 * reports a session, every API call carries its token and the app boots; when it reports none,
 * the app is anonymous.
 */
export function ClerkShell({ children }: { children: ReactNode }) {
  const appearance = useClerkAppearance();
  const localization = useClerkLocalization();
  const publishableKey = authConfig().clerk_publishable_key ?? "";
  const navigate = useNavigate();
  useEffect(() => {
    appNavigate = (to, replace) => { void navigate(to, { replace }); };
    return () => { appNavigate = null; };
  }, [navigate]);
  return (
    <ClerkProvider Clerk={clerkJs(publishableKey)} ui={ui} appearance={appearance} {...(localization ? { localization } : {})} telemetry={{ disabled: true }} publishableKey={publishableKey} afterSignOutUrl="/" signInUrl="/login" signUpUrl="/join"
      routerPush={routerPush} routerReplace={routerReplace}>
      <Bridge>{children}</Bridge>
    </ClerkProvider>
  );
}

function Bridge({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, getToken, userId, sessionId } = useClerkAuth();
  const clerk = useClerk();
  useEffect(() => {
    if (!isLoaded) return;
    if (isSignedIn) {
      setTokenProvider(() => getToken());
      setSignOutHandler(() => clerk.signOut());
      setSessionScope(sessionId ?? undefined); // PETTY-140: a cached unlock is valid for this Clerk session only
      void boot({ assumeSignedIn: true });
    } else {
      setTokenProvider(null);
      setSessionScope(undefined);
      void toAnonymous();
    }
    // userId / sessionId: a different person, or a new session of the same person, must boot again
  }, [isLoaded, isSignedIn, userId, sessionId, getToken, clerk]);
  return <>{children}</>;
}
