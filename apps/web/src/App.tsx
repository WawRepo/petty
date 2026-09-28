import { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router";
import { ToastProvider } from "./components/Toast.js";
import { useAuth } from "./lib/session.js";
import { ClerkGate } from "./ClerkGate.js";
import { isClerk } from "./lib/authConfig.js";
import { HomeScreen } from "./screens/HomeScreen.js";
import { PageSkeleton } from "./components/Skeleton.js";
import { LoginScreen } from "./screens/LoginScreen.js";
import { UnlockScreen } from "./screens/UnlockScreen.js";
import { afterUnlock, rememberAfterUnlock } from "./lib/afterUnlock.js";
/**
 * Code-split: screens off the sign-in → unlock → home path load on demand.
 * A chunk that fails to load is almost always a chunk of a build that is no longer served: the open
 * page belongs to the previous deploy and the new service worker has dropped its files (PETTY-60).
 * One reload fetches the current shell; a timestamp in sessionStorage stops a reload loop when the
 * chunk is missing for another reason — then the error screen below takes over.
 */
const RELOAD_KEY = "petty.chunk-reload";
function screen<M, P extends object = Record<string, never>>(load: () => Promise<M>, pick: (m: M) => React.ComponentType<P>) {
  return lazy<React.ComponentType<P>>(() => load().then((m) => ({ default: pick(m) })).catch((e: unknown) => {
    let last = 0;
    try { last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0); } catch { /* storage blocked: no reload guard, so do not reload */ throw e; }
    if (Date.now() - last < 60_000) throw e;
    try { sessionStorage.setItem(RELOAD_KEY, String(Date.now())); } catch { throw e; }
    location.reload();
    return new Promise<{ default: React.ComponentType<P> }>(() => { /* the page is going away */ });
  }));
}
const JoinScreen = screen(() => import("./screens/JoinScreen.js"), (m) => m.JoinScreen);
const SettingsScreen = screen(() => import("./screens/SettingsScreen.js"), (m) => m.SettingsScreen);
const DrawerScreen = screen(() => import("./screens/DrawerScreen.js"), (m) => m.DrawerScreen);
const LineScreen = screen(() => import("./screens/LineScreen.js"), (m) => m.LineScreen);
const MembersScreen = screen(() => import("./screens/MembersScreen.js"), (m) => m.MembersScreen);
const DeleteAccountScreen = screen(() => import("./screens/DeleteAccountScreen.js"), (m) => m.DeleteAccountScreen);
const PrivacyScreen = screen(() => import("./screens/PrivacyScreen.js"), (m) => m.PrivacyScreen);
const AiScreen = screen(() => import("./screens/AiScreen.js"), (m) => m.AiScreen);
const ResetScreen = screen(() => import("./screens/ResetScreen.js"), (m) => m.ResetScreen);
const AdminScreen = screen(() => import("./screens/AdminScreen.js"), (m) => m.AdminScreen);
const LandingScreen = screen(() => import("./screens/LandingScreen.js"), (m) => m.LandingScreen);
const VaultSetupScreen = screen(() => import("./screens/VaultSetupScreen.js"), (m) => m.VaultSetupScreen);
const ClerkAuthScreen = screen<typeof import("./screens/ClerkAuthScreen.js"), { kind: "sign-in" | "sign-up" }>(() => import("./screens/ClerkAuthScreen.js"), (m) => m.ClerkAuthScreen);
const PlacesScreen = screen(() => import("./screens/PlacesScreen.js"), (m) => m.PlacesScreen);
const NotFoundScreen = screen(() => import("./screens/NotFoundScreen.js"), (m) => m.NotFoundScreen);
const DeviceScreen = screen(() => import("./screens/DeviceScreen.js"), (m) => m.DeviceScreen);

/**
 * Never a blank page (PETTY-60): a render error or a screen that could not load shows what went wrong
 * (the error's class and message — never content, CLAUDE.md rule 2) and a Reload button.
 */
class Crash extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  override componentDidCatch(error: Error, info: ErrorInfo) { console.error("render failed", error.name, error.message, info.componentStack); }
  override render() {
    if (!this.state.error) return this.props.children;
    return <CrashScreen error={this.state.error} />;
  }
}
function CrashScreen({ error }: { error: Error }) {
  const { t } = useTranslation();
  return (
    <main className="stack" data-testid="crash-screen">
      <p className="error" role="alert">{t("app.crashed")}</p>
      <p className="hint m0"><code>{error.name}: {error.message}</code></p>
      <button type="button" className="btn btn-primary" onClick={() => location.reload()}>{t("app.reload")}</button>
    </main>
  );
}

/* The identity mode is known only once the gate has read /config, so these pick the screen at their own render, not at App's. */
function LoginRoute() { return isClerk() ? <ClerkAuthScreen kind="sign-in" /> : <LoginScreen />; }
function JoinRoute() { return isClerk() ? <ClerkAuthScreen kind="sign-up" /> : <JoinScreen />; }
function ResetRoute() { return isClerk() ? <Navigate to="/login" replace /> : <ResetScreen />; }

/** "/" shows the app when signed in and the landing page to visitors. */
function RootRoute() {
  const auth = useAuth();
  if (auth.status === "loading") return <PageSkeleton />;
  if (auth.status === "anonymous") return <LandingScreen />;
  if (auth.status === "novault") return <Navigate to="/setup" replace />;
  if (auth.status === "locked") return <Navigate to="/unlock" replace />;
  return <HomeScreen />;
}

/** Route guard: anonymous → /login, locked → /unlock, unlocked → the page. */
function Guard({ need, children }: { need: "anonymous" | "locked" | "unlocked" | "novault" | "setup"; children: React.ReactElement }) {
  const auth = useAuth();
  const loc = useLocation();
  if (auth.status === "loading") return <PageSkeleton />;
  if (need === "novault") return auth.status === "novault" ? children : <Navigate to="/" replace />;
  // PETTY-199: vault setup signs in (locked), unlocks, and only THEN shows the recovery code. The
  // screen itself leaves once the code is confirmed, or at once when it is not in the middle of that.
  if (need === "setup") return auth.status === "anonymous" ? <Navigate to="/login" replace /> : children;
  if (auth.status === "novault") return <Navigate to="/setup" replace />;
  if (need === "unlocked" && (auth.status === "anonymous" || auth.status === "locked")) {
    // PETTY-274: the device login page is opened from a terminal; after signing in, come back to it
    rememberAfterUnlock(loc.pathname + loc.search);
    return auth.status === "anonymous" ? <Navigate to="/login" replace state={{ from: loc.pathname }} /> : <Navigate to="/unlock" replace />;
  }
  if (need === "locked") {
    if (auth.status === "anonymous") return <Navigate to="/login" replace />;
    if (auth.status === "unlocked") return <Navigate to={afterUnlock() ?? "/"} replace />;
  }
  if (need === "anonymous" && auth.status !== "anonymous") return <Navigate to={auth.status === "locked" ? "/unlock" : afterUnlock() ?? "/"} replace />;
  return children;
}

function Loading() { return <PageSkeleton />; }

export function App() {
  return (
    <ToastProvider>
      <BrowserRouter>
        <div className="app">
          <Crash>
          <ClerkGate>
          <Suspense fallback={<Loading />}>
          <Routes>
            <Route path="/privacy" element={<PrivacyScreen />} />
            <Route path="/ai" element={<AiScreen />} />
            <Route path="/login/*" element={<Guard need="anonymous"><LoginRoute /></Guard>} />
            {/* Tokens travel in the URL fragment (/join#<token>), which never reaches the server (SR-9); the path form stays for links already sent. */}
            <Route path="/join/*" element={<JoinRoute />} />
            <Route path="/join/:token" element={<JoinRoute />} />
            <Route path="/reset" element={<ResetRoute />} />
            <Route path="/reset/:token" element={<ResetRoute />} />
            <Route path="/setup" element={<Guard need="setup"><VaultSetupScreen /></Guard>} />
            <Route path="/admin" element={<Guard need="unlocked"><AdminScreen /></Guard>} />
            <Route path="/device" element={<Guard need="unlocked"><DeviceScreen /></Guard>} />
            <Route path="/unlock" element={<Guard need="locked"><UnlockScreen /></Guard>} />
            <Route path="/" element={<RootRoute />} />
            <Route path="/drawers/:id" element={<Guard need="unlocked"><DrawerScreen /></Guard>} />
            <Route path="/drawers/:id/lines/:lineId" element={<Guard need="unlocked"><LineScreen /></Guard>} />
            <Route path="/drawers/:id/members" element={<Guard need="unlocked"><MembersScreen /></Guard>} />
            <Route path="/settings" element={<Guard need="unlocked"><SettingsScreen /></Guard>} />
            <Route path="/places" element={<Guard need="unlocked"><PlacesScreen /></Guard>} />
            <Route path="/settings/delete" element={<Guard need="unlocked"><DeleteAccountScreen /></Guard>} />
            <Route path="*" element={<NotFoundScreen />} />
          </Routes>
          </Suspense>
          </ClerkGate>
          </Crash>
        </div>
      </BrowserRouter>
    </ToastProvider>
  );
}
