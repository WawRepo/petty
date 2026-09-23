import type { AuthConfig } from "@petty/protocol";
import { api, NetworkError } from "./api.js";
import { idb } from "./idb.js";

/**
 * Which identity provider this deployment uses (PETTY-88, docs/auth-clerk.md). Fetched once from
 * GET /config so one image serves both modes; cached so an offline start still knows the mode.
 */
let current: AuthConfig = { auth: "local", clerk_publishable_key: null };
const K = "auth.config";

export async function loadAuthConfig(): Promise<AuthConfig> {
  try {
    current = await api<AuthConfig>("GET", "/config");
    await idb.set(K, current);
  } catch (e) {
    if (e instanceof NetworkError) current = (await idb.get<AuthConfig>(K)) ?? current;
  }
  return current;
}
export const authConfig = (): AuthConfig => current;
/** True when Clerk holds the identity: no login password anywhere in the app. */
export const isClerk = (): boolean => current.auth === "clerk";
/** The operator's address for invite requests (PETTY-160), or null: then no "Get an invite" link is shown. */
export const contactEmail = (): string | null => current.contact_email ?? null;
/** PETTY-215: local mode only — this instance lets anyone create an account without a join link. */
export const openSignup = (): boolean => current.open_signup === true;
/** PETTY-218: the running server's version (baked into the image), or null before /config is loaded. */
export const appVersion = (): string | null => current.version ?? null;
