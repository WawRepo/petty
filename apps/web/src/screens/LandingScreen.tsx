import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { Button } from "../components/Button.js";
import { UseCases } from "../components/UseCases.js";
import { AiShowcase } from "../components/AiShowcase.js";
import { TourFilm } from "../components/TourFilm.js";
import { currentLocale, LOCALE_NAMES, LOCALES, setLocale } from "../i18n/index.js";
import { LanguagePicker } from "../components/LanguagePicker.js";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { appVersion, contactEmail, isClerk, openSignup } from "../lib/authConfig.js";
import { sourceUrlFor } from "../lib/links.js";
import { useTheme } from "../lib/theme.js";


/**
 * What an anonymous visitor sees at "/". Marketing only: no API calls, no state.
 * Screenshots are real app captures (e2e/marketing.spec.ts) per locale and theme.
 */
export function LandingScreen() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const loc = currentLocale();
  const shotLoc = loc; // captures exist for every language (e2e/marketing.spec.ts, PETTY-249)
  // PETTY-108 (audit F1): a visitor needs a way in. With Clerk, sign-up is self-serve; in local mode Petty is invite-only.
  const open = isClerk() || openSignup(); // PETTY-215: local open-signup also gets the self-serve CTA
  const contact = contactEmail();
  const cta = (
    <div className="actions landing-cta">
      {open
        ? <><Button onClick={() => nav("/join")} data-testid="landing-create">{t("landing.create")}</Button><Button variant="secondary" onClick={() => nav("/login")}>{t("auth.login.submit")}</Button></>
        : <><Button onClick={() => nav("/login")} data-testid="landing-signin">{t("auth.login.submit")}</Button>{contact ? <a className="btn btn-secondary" href={`mailto:${contact}?subject=Petty%20invite`} data-testid="landing-invite">{t("landing.getInvite")}</a> : null}</>}
    </div>
  );
  const [big, setBig] = useState<number | null>(null);
  const shots = (["home", "drawer", "items", "places", "entry"] as const).map((n) => ({
    light: `/landing/${n}-${shotLoc}-light.webp`,
    dark: `/landing/${n}-${shotLoc}-dark.webp`,
    alt: t(`landing.shots.${n}`),
  }));
  const features = ["private", "shared", "places", "currencies", "verify", "passkey"] as const; // PETTY-135 (audit F28): one grid of six, the pillars folded in
  const faqs = ["see", "ai", "places", "lost", "undo", "cost", "phone"] as const;
  return (
    <main className="landing">
      {/* PETTY-249: the language switch at the top, where a visitor looks first */}
      <div className="landing-lang"><LanguagePicker compact testId="landing-language" /></div>
      <section className="landing-hero">
        <div className="landing-brand">
          <img src="/icon.svg" alt="" width="64" height="64" className="landing-logo" />
          <h1 className="m0">Petty</h1>
        </div>
        <p className="landing-tag">{t("landing.tagline")}</p>
        <p className="hint m0">{t("landing.sub")}</p>
        {cta}
        {/* PETTY-293 (review S8): "write to us" only when this Petty names an address to write to */}
        <p className="hint m0" data-testid="landing-access">{t(open ? "landing.betaOpen" : contact ? "landing.betaInvite" : "landing.betaInviteNoContact")}</p>
        {/* PETTY-329: the tour film, a button here and the film over the whole page */}
        <TourFilm />
        <p className="m0 landing-jumps">
          <Button variant="ghost" onClick={() => document.getElementById("crypto")?.scrollIntoView({ behavior: "smooth" })}>{t("landing.how")}</Button>
          <Button variant="ghost" onClick={() => document.getElementById("ai")?.scrollIntoView({ behavior: "smooth" })} data-testid="landing-ai-jump">{t("landing.aiJump")}</Button>
        </p>
      </section>

      {/* PETTY-248: the one pattern (place › drawer › items) as a live demo, one example turning into the next. */}
      <UseCases />

      {/* PETTY-316: working with AI apps (it was only a footer link before); after the use cases since PETTY-319 */}
      <AiShowcase />

      {/* Five real captures (PETTY-77/79; audit F2 in PETTY-109): whole frames in a row from 1000 px up, a swipe strip on phones;
          a tap or Enter opens the frame at full size in an overlay — no reflow, no reserved empty height. */}
      <section className="shots" role="region" aria-label={t("landing.shotsTitle")}>
        {shots.map((s, i) => (
          <button type="button" key={s.light} className="shot-btn" onClick={() => setBig(i)} aria-label={t("landing.shotOpen", { name: s.alt })}>
            <Shot shot={s} className="shot" lazy />
          </button>
        ))}
      </section>
      {big !== null ? <ShotOverlay shot={shots[big]!} index={big} count={shots.length} onClose={() => setBig(null)} onStep={(d) => setBig((big + d + shots.length) % shots.length)} /> : null}

      <section className="landing-again" aria-label={t("landing.again")}>
        <p className="m0 fw700">{t(open ? "landing.again" : "landing.againInvite")}</p>
        {cta}
      </section>

      <section className="landing-features">
        <h2 className="landing-h2">{t("landing.featuresTitle")}</h2>
        <div className="feature-grid">
          {features.map((f) => (
            <div className="card" key={f}>
              <p className="m0 fw700">{t(`landing.features.${f}.title`)}</p>
              <p className="hint m0 mt4">{t(`landing.features.${f}.body`)}</p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="landing-h2">{t("landing.stepsTitle")}</h2>
        <ol className="list">
          {(["one", "two", "three"] as const).map((k) => <li className="mb6" key={k}>{t(`landing.steps.${k}`)}</li>)}
        </ol>
      </section>

      <section id="crypto">
        <h2 className="landing-h2">{t("landing.cryptoTitle")}</h2>
        <div className="card">
          <ul className="list m0">
            {(["device", "server", "safety", "recovery", "chain"] as const).map((k) => <li className="mb6" key={k}>{t(`landing.crypto.${k}`)}</li>)}
          </ul>
          <p className="mb0 mt8"><Button variant="ghost" onClick={() => nav("/privacy")}>{t("privacy.link")}</Button></p>
        </div>
      </section>

      <section>
        <h2 className="landing-h2">{t("landing.faqTitle")}</h2>
        {faqs.map((k) => (
          <details className="faq" key={k}>
            <summary>{t(`landing.faq.${k}.q`)}</summary>
            <p className="hint">{t(`landing.faq.${k}.a`)}</p>
          </details>
        ))}
      </section>

      <section className="landing-again" aria-label={t("landing.again")}>
        <p className="m0 fw700">{t(open ? "landing.again" : "landing.againInvite")}</p>
        {cta}
      </section>

      <footer className="landing-footer">
        <div className="actions m0 landing-langs" role="group" aria-label={t("settings.language")}>
          {LOCALES.map((l) => <Button key={l} variant="ghost" onClick={() => { void setLocale(l); }} aria-pressed={loc === l} lang={l}>{LOCALE_NAMES[l]}</Button>)}
        </div>
        <Button variant="ghost" onClick={() => nav("/login")}>{t("auth.login.title")}</Button>
        <Button variant="ghost" onClick={() => nav("/privacy")}>{t("privacy.link")}</Button>
        <Button variant="ghost" onClick={() => nav("/ai")} data-testid="landing-ai">{t("ai.link")}</Button>
        <a className="btn btn-ghost" href={sourceUrlFor(appVersion())} target="_blank" rel="noopener noreferrer" data-testid="landing-source">{t("app.sourceCode")}</a>
        <a className="btn btn-ghost" href="/THIRD_PARTY_NOTICES.md" target="_blank" rel="noopener noreferrer" data-testid="landing-notices">{t("app.thirdPartyNotices")}</a>
        <p className="hint m0">{t("landing.made")}{contact ? <> · <a className="landing-mail" href={`mailto:${contact}`}>{contact}</a></> : null}</p>
        {/* PETTY-280 (F26): the slogan on its own line, the version kept with it, no lone "·" at a line's end */}
        <p className="hint m0">{t("landing.footer")}</p>
        <p className="hint m0">{t("landing.slogan")}{appVersion() ? <span className="nobr"> · {appVersion()}</span> : null}</p>
      </footer>
    </main>
  );
}

/** One capture at full size: Escape or the backdrop closes, ← → step through the five. Focus lands on Close and returns to the page after. */
/** A capture in the palette on screen (PETTY-259): the device's, or the theme chosen in Settings. */
function Shot({ shot, className, lazy = false }: { shot: { light: string; dark: string; alt: string }; className: string; lazy?: boolean }) {
  const { theme, resolved } = useTheme();
  return (
    <picture>
      {theme === "system" ? <source media="(prefers-color-scheme: dark)" srcSet={shot.dark} /> : null}
      <img src={theme !== "system" && resolved === "dark" ? shot.dark : shot.light} alt={shot.alt} className={className} loading={lazy ? "lazy" : undefined} width="320" height="591" />
    </picture>
  );
}

function ShotOverlay({ shot, index, count, onClose, onStep }: { shot: { light: string; dark: string; alt: string }; index: number; count: number; onClose: () => void; onStep: (d: -1 | 1) => void }) {
  const { t } = useTranslation();
  const closeRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // The latest callbacks, without running the effect again: each step renders new ones, and the effect
  // used to hand focus back to the opener and then to Close on every step (PETTY-279).
  const cb = useRef({ onClose, onStep });
  useEffect(() => { cb.current = { onClose, onStep }; });
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    // PETTY-279: a dialog keeps Tab inside it, and the page behind it does not scroll
    document.documentElement.classList.add("no-scroll");
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cb.current.onClose();
      else if (e.key === "ArrowRight") cb.current.onStep(1);
      else if (e.key === "ArrowLeft") cb.current.onStep(-1);
      else if (e.key === "Tab") {
        const items = [...(bodyRef.current?.querySelectorAll<HTMLElement>("button") ?? [])];
        const i = items.indexOf(document.activeElement as HTMLElement);
        e.preventDefault();
        items[(i + (e.shiftKey ? -1 : 1) + items.length) % items.length]?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); document.documentElement.classList.remove("no-scroll"); opener?.focus(); };
  }, []);
  // Portal (PETTY-142): a direct child of main.landing would pick up the page's 480 px column rule.
  return createPortal(
    <div className="shot-overlay" role="dialog" aria-modal="true" aria-label={shot.alt} onClick={onClose} data-testid="shot-overlay">
      <div className="shot-overlay-body" ref={bodyRef} onClick={(e) => e.stopPropagation()}>
        <Shot shot={shot} className="shot-big" />
        <p className="shot-caption">{shot.alt} · {index + 1}/{count}</p>
        <div className="shot-controls">
          <Button variant="secondary" onClick={() => onStep(-1)} aria-label={t("landing.shotPrev")}>‹</Button>
          <button ref={closeRef} type="button" className="btn btn-secondary" onClick={onClose}>{t("app.close")}</button>
          <Button variant="secondary" onClick={() => onStep(1)} aria-label={t("landing.shotNext")}>›</Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
