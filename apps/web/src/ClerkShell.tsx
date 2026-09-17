import { useEffect, type ReactNode } from "react";
import { ClerkProvider, useAuth as useClerkAuth, useClerk } from "@clerk/clerk-react";
import { authConfig } from "./lib/authConfig.js";
import { setTokenProvider } from "./lib/api.js";
import { boot, setSessionScope, setSignOutHandler, toAnonymous } from "./lib/session.js";
import { useClerkAppearance } from "./lib/clerkAppearance.js";

/**
 * The Clerk side of the gate (PETTY-88), its own chunk, loaded only in clerk mode. clerk-js and its
 * UI come from the instance's frontend API origin (the CSP allows that origin in clerk mode). Once
 * Clerk reports a session, every API call carries its token and the app boots; when it reports
 * none, the app is anonymous.
 */
export function ClerkShell({ children }: { children: ReactNode }) {
  const appearance = useClerkAppearance();
  return (
    <ClerkProvider appearance={appearance} telemetry={{ disabled: true }} publishableKey={authConfig().clerk_publishable_key ?? ""} afterSignOutUrl="/" signInUrl="/login" signUpUrl="/join">
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
