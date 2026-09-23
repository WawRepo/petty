import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { Button } from "../components/Button.js";
import { setLocale } from "../i18n/index.js";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { appVersion, contactEmail, isClerk, openSignup } from "../lib/authConfig.js";
import { SOURCE_URL } from "../lib/links.js";


/**
 * What an anonymous visitor sees at "/". Marketing only: no API calls, no state.
 * Screenshots are real app captures (e2e/marketing.spec.ts) per locale and theme.
 */
export function LandingScreen() {
  const { t, i18n } = useTranslation();
  const nav = useNavigate();
  const loc = i18n.language === "pl" ? "pl" : "en";
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
    light: `/landing/${n}-${loc}-light.webp`,
    dark: `/landing/${n}-${loc}-dark.webp`,
    alt: t(`landing.shots.${n}`),
  }));
  const features = ["private", "shared", "places", "currencies", "verify", "passkey"] as const; // PETTY-135 (audit F28): one grid of six, the pillars folded in
  const faqs = ["see", "places", "lost", "undo", "cost", "phone"] as const;
  return (
    <main className="landing">
      <section className="landing-hero">
        <div className="landing-brand">
          <img src="/icon.svg" alt="" width="64" height="64" className="landing-logo" />
          <h1 className="m0">Petty</h1>
        </div>
        <p className="landing-tag">{t("landing.tagline")}</p>
        <p className="hint m0">{t("landing.sub")}</p>
        {cta}
        <p className="hint m0">{t(open ? "landing.betaOpen" : "landing.betaInvite")}</p>
        <p className="m0"><Button variant="ghost" onClick={() => document.getElementById("crypto")?.scrollIntoView({ behavior: "smooth" })}>{t("landing.how")}</Button></p>
      </section>

      {/* Five real captures (PETTY-77/79; audit F2 in PETTY-109): whole frames in a row from 1000 px up, a swipe strip on phones;
          a tap or Enter opens the frame at full size in an overlay — no reflow, no reserved empty height. */}
      <section className="shots" role="region" aria-label={t("landing.shotsTitle")}>
        {shots.map((s, i) => (
          <button type="button" key={s.light} className="shot-btn" onClick={() => setBig(i)} aria-label={t("landing.shotOpen", { name: s.alt })}>
            <picture>
              <source media="(prefers-color-scheme: dark)" srcSet={s.dark} />
              <img src={s.light} alt={s.alt} className="shot" loading="lazy" width="320" height="591" />
            </picture>
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
        <div className="actions m0">
          <Button variant="ghost" onClick={() => setLocale("en")} aria-pressed={loc === "en"}>English</Button>
          <Button variant="ghost" onClick={() => setLocale("pl")} aria-pressed={loc === "pl"}>Polski</Button>
        </div>
        <Button variant="ghost" onClick={() => nav("/login")}>{t("auth.login.title")}</Button>
        <Button variant="ghost" onClick={() => nav("/privacy")}>{t("privacy.link")}</Button>
        <Button variant="ghost" onClick={() => nav("/ai")} data-testid="landing-ai">{t("ai.link")}</Button>
        <a className="btn btn-ghost" href={SOURCE_URL} target="_blank" rel="noopener noreferrer" data-testid="landing-source">{t("app.sourceCode")}</a>
        <p className="hint m0">{t("landing.made")}{contact ? <> · <a className="landing-mail" href={`mailto:${contact}`}>{contact}</a></> : null}</p>
        <p className="hint m0">{t("landing.footer")} · {t("landing.slogan")}{appVersion() ? <> · {appVersion()}</> : null}</p>
      </footer>
    </main>
  );
}

/** One capture at full size: Escape or the backdrop closes, ← → step through the five. Focus lands on Close and returns to the page after. */
function ShotOverlay({ shot, index, count, onClose, onStep }: { shot: { light: string; dark: string; alt: string }; index: number; count: number; onClose: () => void; onStep: (d: -1 | 1) => void }) {
  const { t } = useTranslation();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); else if (e.key === "ArrowRight") onStep(1); else if (e.key === "ArrowLeft") onStep(-1); };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); opener?.focus(); };
  }, [onClose, onStep]);
  // Portal (PETTY-142): a direct child of main.landing would pick up the page's 480 px column rule.
  return createPortal(
    <div className="shot-overlay" role="dialog" aria-modal="true" aria-label={shot.alt} onClick={onClose} data-testid="shot-overlay">
      <div className="shot-overlay-body" onClick={(e) => e.stopPropagation()}>
        <picture>
          <source media="(prefers-color-scheme: dark)" srcSet={shot.dark} />
          <img src={shot.light} alt={shot.alt} className="shot-big" width="320" height="591" />
        </picture>
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
