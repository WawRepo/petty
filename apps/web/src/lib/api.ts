import type { ApiError as ApiErrorShape } from "@petty/protocol";
import { markOffline, markOnline } from "./net.js";

/** Thrown for any non-2xx response. Carries the server's code and ids, never content. */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly context: Record<string, string | number | null> = {}) {
    super(code);
    this.name = "ApiError";
  }
}
/** Thrown when the request never reached the server. */
export class NetworkError extends Error {
  constructor() { super("NetworkError"); this.name = "NetworkError"; }
}

/**
 * On these paths a 401 means "the password you typed is wrong", not "your session is
 * gone" — they must not sign the user out.
 */
const CREDENTIAL_401 = (path: string): boolean =>
  path.startsWith("/auth/") || path === "/me/vault" || path.startsWith("/me/passkeys") || path === "/me/delete";

let tokenProvider: (() => Promise<string | null>) | null = null;
/** Clerk mode (PETTY-88): every call carries the current session token. */
export function setTokenProvider(p: (() => Promise<string | null>) | null): void { tokenProvider = p; }

let onSessionGone: (() => void) | null = null;
/** session.ts registers this: any other 401 means the server no longer knows this session. */
export function setSessionGoneHandler(h: () => void): void { onSessionGone = h; }

export async function api<T = unknown>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    const token = tokenProvider ? await tokenProvider().catch(() => null) : null;
    res = await fetch(`/api${path}`, {
      method,
      credentials: "same-origin",
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    markOffline();
    throw new NetworkError();
  }
  markOnline();
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    if (res.status === 401 && !CREDENTIAL_401(path) && onSessionGone) onSessionGone();
    const e = (json ?? {}) as Partial<ApiErrorShape>;
    throw new ApiError(res.status, e.code ?? "Http", e.context ?? {});
  }
  return json as T;
}
