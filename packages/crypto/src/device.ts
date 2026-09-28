import { AuthTagMismatch, InvalidPayload, UnknownSchemaVersion } from "./errors.js";
import { concat, fromB64, fromUtf8, lengthPrefixed, randomBytes, sha256, toB64, utf8, zero, type Bytes } from "./encoding.js";
import { hkdfAesKey } from "./kdf.js";
import { importEcdhPublic } from "./keys.js";

const subtle = crypto.subtle;

/**
 * Device login (PETTY-274): `petty auth login` signs the command-line tool in through a page of the
 * web app, the way `gh auth login` does (RFC 8628, the device authorization grant). Petty's server
 * cannot make the tool a token, because it holds no keys. The web app makes an ordinary access token
 * and hands it to the tool sealed to a one-time key only the tool has; the server relays the sealed
 * blob and can open nothing.
 *
 * The code the person sees is derived from the tool's public key. The page works it out again from
 * the key the server passed on and refuses a mismatch, so a server (or a database) that swapped in a
 * key of its own would need one with the same code: about 2^52 tries, inside the request's 15 minutes.
 */
/** RFC 8628 §6.1: no vowels (no words), no look-alikes. */
export const DEVICE_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
export const DEVICE_CODE_CHARS = 12;
const CODE_DOMAIN = "petty/device-code/v1";
const SEAL_DOMAIN = "petty/device-token/v1";

const grouped = (s: string) => `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;

/** `WDJB-MJHT-KQPL`: 12 of 20 consonants (about 52 bits) from SHA-256 of the key, in three groups of four. */
export async function deviceUserCode(cliPubSpkiB64: string): Promise<string> {
  const h = await sha256(concat(utf8(CODE_DOMAIN), fromB64(cliPubSpkiB64)));
  let n = 0n;
  for (const b of h.subarray(0, 16)) n = (n << 8n) | BigInt(b);
  let s = "";
  for (let i = 0; i < DEVICE_CODE_CHARS; i++) {
    s += DEVICE_CODE_ALPHABET[Number(n % 20n)];
    n /= 20n;
  }
  return grouped(s);
}

/** A code as a person typed it: case, spaces and dashes do not matter. Null when it cannot be a code. */
export function normalizeDeviceCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, "");
  if (s.length !== DEVICE_CODE_CHARS || [...s].some((c) => !DEVICE_CODE_ALPHABET.includes(c))) return null;
  return grouped(s);
}

/** What one sealed token is bound to: the request, its code and the site that made it. */
export interface DeviceSealContext {
  readonly requestId: string;
  readonly userCode: string;
  /** The web app's origin, for example https://petty.example.com */
  readonly origin: string;
}

export interface SealedDeviceTokenV1 {
  readonly v: 1;
  /** base64 SPKI of the page's one-time ECDH key */
  readonly eph_pub: string;
  readonly salt: string;
  readonly nonce: string;
  readonly ciphertext: string;
}

function context(ctx: DeviceSealContext): Bytes {
  if (!ctx.requestId || !ctx.userCode || !ctx.origin) throw new InvalidPayload("device.context");
  return lengthPrefixed([utf8(SEAL_DOMAIN), utf8(ctx.requestId), utf8(ctx.userCode), utf8(ctx.origin)]);
}

async function sealKey(mine: CryptoKey, theirs: CryptoKey, salt: Uint8Array, ctx: DeviceSealContext): Promise<CryptoKey> {
  const shared = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: theirs }, mine, 256));
  try {
    return await hkdfAesKey(shared, salt, context(ctx), "AES-GCM", ["encrypt", "decrypt"]);
  } finally {
    zero(shared);
  }
}

/** The tool's one-time key pair for one login. The private half cannot be exported and dies with the process. */
export async function deviceKeyPair(): Promise<{ privateKey: CryptoKey; publicB64: string }> {
  const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  return { privateKey: pair.privateKey, publicB64: toB64(new Uint8Array(await subtle.exportKey("spki", pair.publicKey))) };
}

/** The page: seals the token string to the tool's key (ECDH with a one-time key of its own → HKDF → AES-256-GCM). */
export async function sealDeviceToken(cliPubSpkiB64: string, token: string, ctx: DeviceSealContext): Promise<SealedDeviceTokenV1> {
  const cli = await importEcdhPublic(cliPubSpkiB64);
  const eph = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const salt = randomBytes(32);
  const key = await sealKey(eph.privateKey, cli, salt, ctx);
  const nonce = randomBytes(12);
  const ciphertext = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: context(ctx) }, key, utf8(token)));
  return { v: 1, eph_pub: toB64(new Uint8Array(await subtle.exportKey("spki", eph.publicKey))), salt: toB64(salt), nonce: toB64(nonce), ciphertext: toB64(ciphertext) };
}

/** The tool: opens the sealed token. Another key, request, code or site fails the tag, and says nothing more. */
export async function openDeviceToken(cliPrivate: CryptoKey, sealed: SealedDeviceTokenV1, ctx: DeviceSealContext): Promise<string> {
  if (sealed.v !== 1) throw new UnknownSchemaVersion({ v: String((sealed as { v: unknown }).v) });
  const eph = await importEcdhPublic(sealed.eph_pub);
  const key = await sealKey(cliPrivate, eph, fromB64(sealed.salt), ctx);
  let plain: ArrayBuffer;
  try {
    plain = await subtle.decrypt({ name: "AES-GCM", iv: fromB64(sealed.nonce), additionalData: context(ctx) }, key, fromB64(sealed.ciphertext));
  } catch {
    throw new AuthTagMismatch({ record_type: "device_token" });
  }
  return fromUtf8(new Uint8Array(plain));
}
