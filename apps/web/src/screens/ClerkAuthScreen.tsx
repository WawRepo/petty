import { SignIn, SignUp } from "@clerk/react";
import { useTranslation } from "react-i18next";
import { TopBar } from "../components/TopBar.js";
import { useNavigate } from "react-router";
import { SignUpLegal } from "../components/LegalLinks.js";

/** Clerk mode (PETTY-88): sign in, sign up (invitation tickets included) and password reset are Clerk's components. */
export function ClerkAuthScreen({ kind }: { kind: "sign-in" | "sign-up" }) {
  const { t } = useTranslation();
  const nav = useNavigate();
  return (
    <>
      <TopBar title={kind === "sign-in" ? t("auth.login.title") : t("auth.join.title")} onBack={() => nav("/")} />
      <main className="clerk-main">
        {/* PETTY-146: the landing page's brand, so signing in feels like the same page */}
        <div className="landing-brand">
          <img src="/icon.svg" alt="" width="48" height="48" className="landing-logo" />
          <h1 className="m0">Petty</h1>
        </div>
        <p className="landing-tag m0">{t("landing.tagline")}</p>
        {kind === "sign-in"
          ? <SignIn routing="path" path="/login" signUpUrl="/join" fallbackRedirectUrl="/" />
          : <SignUp routing="path" path="/join" signInUrl="/login" fallbackRedirectUrl="/" />}
        {/* PETTY-342: signing in with Google or GitHub can make the account here too, so both pages say it */}
        <SignUpLegal />
      </main>
    </>
  );
}
