/**
 * WebAuthn passkeys with the PRF extension (Phase 14; passkey first since PETTY-102).
 * The passkey is not a login factor and no server verifies its assertions: the only
 * thing we take from it is the 32-byte PRF output, which the authenticator computes
 * from a per-passkey salt after Face ID / Touch ID / PIN. That output derives the key
 * that opens the passkey vault. It exists in memory for milliseconds and is zeroed
 * afterwards. Several passkeys per account: one per device, each with its own salt
 * and its own wrapped copy of the same keys.
 */
import { fromB64, randomBytes, toB64, utf8 } from "@petty/crypto";

export type PasskeyErrorCode = "unsupported" | "no_prf" | "cancelled" | "failed" | "exists";
export class PasskeyError extends Error {
  constructor(readonly code: PasskeyErrorCode) { super(code); this.name = "PasskeyError"; }
}

interface PrfOutputs { enabled?: boolean; results?: { first?: ArrayBuffer } }
const prfOf = (c: PublicKeyCredential): PrfOutputs | undefined => (c.getClientExtensionResults() as { prf?: PrfOutputs }).prf;
const buf = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
const rpId = (): string => location.hostname;
const b64url = (b64: string): string => b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function passkeyAvailable(): boolean {
  return typeof window !== "undefined" && "PublicKeyCredential" in window && !!navigator.credentials;
}

/** True when the browser says PRF works or does not say; false when it says no (Firefox at the time of writing). */
export async function passkeyPrfSupported(): Promise<boolean> {
  if (!passkeyAvailable()) return false;
  const PKC = PublicKeyCredential as unknown as { getClientCapabilities?: () => Promise<Record<string, boolean | undefined>> };
  try {
    if (PKC.getClientCapabilities) {
      const caps = await PKC.getClientCapabilities();
      if (caps["prf"] === false) return false;
    }
  } catch { /* unknown → let the user try */ }
  return true;
}

/** What the unlock prompt needs to know about a stored passkey. */
export interface PasskeyRef { readonly credential_id: string; readonly prf_salt: string; readonly transports?: readonly string[] | undefined }
export interface RegisteredPasskey { readonly credential_id: string; readonly prf_salt: string; readonly prf: Uint8Array; readonly transports: string[] }

/**
 * Creates a discoverable passkey for this origin, then evaluates PRF once to get the wrapping
 * secret. Two prompts on most devices. `userHandle` is the account's stable signing-key id, so
 * every Petty passkey for one account shares one user entry in the authenticator; `exclude`
 * (the credential ids already stored) stops the same authenticator from making a duplicate.
 */
export async function registerPasskey(userHandle: string, email: string, displayName: string, exclude: readonly string[] = []): Promise<RegisteredPasskey> {
  if (!passkeyAvailable()) throw new PasskeyError("unsupported");
  const salt = randomBytes(32);
  let cred: Credential | null;
  try {
    cred = await navigator.credentials.create({
      publicKey: {
        challenge: buf(randomBytes(32)), // nobody verifies it; the PRF output is the secret, not the signature
        rp: { id: rpId(), name: "Petty" },
        user: { id: buf(utf8(userHandle)), name: `${email} · vault`, displayName },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        excludeCredentials: exclude.map((id) => ({ type: "public-key" as const, id: buf(fromB64(id)) })),
        extensions: { prf: {} },
      },
    });
  } catch (e) { throw wrapError(e); }
  if (!(cred instanceof PublicKeyCredential)) throw new PasskeyError("failed");
  if (prfOf(cred)?.enabled === false) throw new PasskeyError("no_prf");
  const credential_id = toB64(new Uint8Array(cred.rawId));
  const prf_salt = toB64(salt);
  const resp = cred.response as AuthenticatorAttestationResponse & { getTransports?: () => string[] };
  let transports: string[] = [];
  try { transports = resp.getTransports?.() ?? []; } catch { /* older browsers */ }
  const { prf } = await evaluatePrf([{ credential_id, prf_salt, transports }]);
  return { credential_id, prf_salt, prf, transports };
}

/**
 * Asks the authenticator for PRF(salt) under ANY of the given passkeys: the browser lists
 * them all (with the transports it knows, so a passkey on the phone shows the QR path), the
 * user picks one, and the salt of that one is evaluated. Returns which credential answered.
 * Caller zeroes the result.
 */
export async function evaluatePrf(passkeys: readonly PasskeyRef[]): Promise<{ credential_id: string; prf: Uint8Array }> {
  if (!passkeyAvailable()) throw new PasskeyError("unsupported");
  if (!passkeys.length) throw new PasskeyError("failed");
  const evalByCredential: Record<string, { first: ArrayBuffer }> = {};
  for (const p of passkeys) evalByCredential[b64url(p.credential_id)] = { first: buf(fromB64(p.prf_salt)) };
  let cred: Credential | null;
  try {
    cred = await navigator.credentials.get({
      publicKey: {
        challenge: buf(randomBytes(32)),
        rpId: rpId(),
        userVerification: "required",
        allowCredentials: passkeys.map((p) => ({ type: "public-key" as const, id: buf(fromB64(p.credential_id)), ...(p.transports?.length ? { transports: [...p.transports] as AuthenticatorTransport[] } : {}) })),
        extensions: { prf: { evalByCredential } } as AuthenticationExtensionsClientInputs,
      },
    });
  } catch (e) { throw wrapError(e); }
  if (!(cred instanceof PublicKeyCredential)) throw new PasskeyError("failed");
  const first = prfOf(cred)?.results?.first;
  if (!first) throw new PasskeyError("no_prf");
  return { credential_id: toB64(new Uint8Array(cred.rawId)), prf: new Uint8Array(first) };
}

function wrapError(e: unknown): PasskeyError {
  if (e instanceof PasskeyError) return e;
  const name = (e as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "AbortError") return new PasskeyError("cancelled");
  if (name === "InvalidStateError") return new PasskeyError("exists");
  if (name === "NotSupportedError") return new PasskeyError("unsupported");
  return new PasskeyError("failed");
}

/**
 * Which passkeys this device knows about (created here, or offered here and declined).
 * Credential ids only — public, and useless without the authenticator. This decides the
 * one-time "add a passkey for this device?" offer after an unlock through another device.
 */
const KNOWN = "petty.passkeys.known";
export function knownPasskeyIds(): string[] {
  try { const v = JSON.parse(localStorage.getItem(KNOWN) ?? "[]"); return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; } catch { return []; }
}
export function rememberPasskey(credentialId: string): void {
  try { localStorage.setItem(KNOWN, JSON.stringify([...new Set([...knownPasskeyIds(), credentialId])].slice(-20))); } catch { /* ignore */ }
}
/** True when at least one of the account's passkeys was created on, or already offered on, this device. */
export function hasKnownPasskey(passkeys: readonly PasskeyRef[]): boolean {
  const known = new Set(knownPasskeyIds());
  return passkeys.some((p) => known.has(p.credential_id));
}

/** A label to prefill for a new passkey: the device family, a brand word that needs no translation. */
export function deviceLabel(): string | null {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && typeof navigator !== "undefined" && navigator.maxTouchPoints > 1)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  if (/Linux/.test(ua)) return "Linux";
  return null;
}
