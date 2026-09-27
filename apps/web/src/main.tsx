import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { i18nReady } from "./i18n/index.js";
import "./styles/tokens.css";
import "./styles/base.css";
import { App } from "./App.js";

/**
 * Trusted Types (CSP `require-trusted-types-for 'script'`): DOM sinks that take
 * strings throw unless a policy vets them. React never hits them. The one
 * legitimate use is the service-worker registration (vite-plugin-pwa's
 * registerSW.js runs on `load`, after this module): only our own /sw.js passes.
 */
const tt = (window as unknown as { trustedTypes?: { createPolicy: (name: string, rules: { createScriptURL?: (s: string) => string; createHTML?: (s: string) => string; createScript?: (s: string) => string }) => unknown } }).trustedTypes;
if (tt) {
  try {
    tt.createPolicy("default", {
      createScriptURL: (url) => {
        const u = new URL(url, location.origin);
        if (u.origin === location.origin && u.pathname === "/sw.js") return u.href;
        throw new TypeError("blocked script URL");
      },
    });
  } catch { /* policy already exists */ }
}
/**
 * PETTY-144: after a deploy the new service worker takes control of this page (clientsClaim). The page
 * still runs the old code, so reload once onto the new shell — but never under an open sheet (an entry
 * being typed), and never on the very first install, when there was no worker before.
 */
if ("serviceWorker" in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloading) return;
    reloading = true;
    const go = () => { if (document.querySelector('[role="dialog"]')) { window.setTimeout(go, 1000); return; } location.reload(); };
    go();
  });
  // A long-open tab checks for a new version when it comes back to the foreground.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void navigator.serviceWorker.getRegistration().then((r) => r?.update()).catch(() => undefined);
  });
}
document.documentElement.lang = document.documentElement.lang || "en";
// PETTY-249: the first frame is already in the reader's language (its dictionary loads on demand).
void i18nReady.then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
