import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { loadAuthConfig } from "./lib/authConfig.js";
import { boot } from "./lib/session.js";

const ClerkShell = lazy(() => import("./ClerkShell.js").then((m) => ({ default: m.ClerkShell })));

/**
 * Identity via Clerk (PETTY-88, docs/auth-clerk.md): GET /config decides. In local mode this is just
 * the boot; in clerk mode the app runs inside the Clerk shell, which is loaded only then.
 */
export function ClerkGate({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<"loading" | "local" | "clerk">("loading");
  useEffect(() => { void loadAuthConfig().then((c) => setMode(c.auth)); }, []);
  useEffect(() => { if (mode === "local") void boot(); }, [mode]);
  if (mode === "loading") return null;
  if (mode === "local") return <>{children}</>;
  return <Suspense fallback={null}><ClerkShell>{children}</ClerkShell></Suspense>;
}
