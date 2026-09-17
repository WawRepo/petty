import { InvalidPayload } from "./errors.js";

/** Bytes backed by a plain ArrayBuffer — the only kind WebCrypto accepts. */
export type Bytes = Uint8Array<ArrayBuffer>;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function utf8(s: string): Bytes {
  return encoder.encode(s) as Bytes;
}
export function fromUtf8(b: Uint8Array): string {
  try { return decoder.decode(b); } catch { throw new InvalidPayload("utf8"); }
}
export function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
export function copy(b: Uint8Array): Bytes {
  return new Uint8Array(b);
}
export function randomBytes(n: number): Bytes {
  const b = new Uint8Array(n);
  // getRandomValues refuses more than 65536 bytes per call.
  for (let o = 0; o < n; o += 65536) crypto.getRandomValues(b.subarray(o, Math.min(n, o + 65536)));
  return b;
}
export function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
export function fromHex(s: string): Bytes {
  if (s.length % 2 !== 0 || /[^0-9a-fA-F]/.test(s)) throw new InvalidPayload("hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}
export function toB64(b: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < b.length; i += chunk) s += String.fromCharCode(...b.subarray(i, i + chunk));
  return btoa(s);
}
export function fromB64(s: string): Bytes {
  let bin: string;
  try { bin = atob(s); } catch { throw new InvalidPayload("base64"); }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function u32be(n: number): Bytes {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new InvalidPayload("u32");
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
}
export function readU32be(b: Uint8Array, offset = 0): number {
  if (b.length < offset + 4) throw new InvalidPayload("u32 read");
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(offset);
}
/** Unambiguous concatenation: each field is prefixed by its 4-byte big-endian length. */
export function lengthPrefixed(fields: Uint8Array[]): Bytes {
  return concat(...fields.flatMap((f) => [u32be(f.length), f]));
}
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/**
 * Deterministic JSON: object keys sorted (UTF-16 order, recursively), `undefined`
 * members dropped, non-finite numbers rejected. Used for everything that is
 * signed or hashed, so two clients produce byte-identical bytes.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}
function sortValue(v: unknown): unknown {
  if (v === null) return null;
  if (Array.isArray(v)) return v.map(sortValue);
  switch (typeof v) {
    case "object": {
      const src = v as Record<string, unknown>;
      const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const k of Object.keys(src).sort()) {
        if (k === "__proto__") throw new InvalidPayload("json key");
        const x = src[k];
        if (x !== undefined) out[k] = sortValue(x);
      }
      return out;
    }
    case "number":
      if (!Number.isFinite(v)) throw new InvalidPayload("number");
      return v;
    case "string":
    case "boolean":
      return v;
    default:
      throw new InvalidPayload("json value");
  }
}
/** Overwrite secret bytes once WebCrypto has imported them. Best effort: JS cannot guarantee no copies exist. */
export function zero(b: Uint8Array): void {
  b.fill(0);
}
export async function sha256(data: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", copy(data)));
}
