import { InvalidPayload } from "./errors.js";
import { readU32be, u32be, type Bytes } from "./encoding.js";

/** `[u32 length][plaintext][zeros]` rounded up to a whole number of buckets (at least one). */
export function pad(plaintext: Uint8Array, bucket: number): Bytes {
  if (!Number.isInteger(bucket) || bucket < 16) throw new InvalidPayload("bucket");
  const raw = 4 + plaintext.length;
  const total = Math.ceil(raw / bucket) * bucket;
  const out = new Uint8Array(total);
  out.set(u32be(plaintext.length), 0);
  out.set(plaintext, 4);
  return out;
}

export function unpad(padded: Uint8Array): Bytes {
  const len = readU32be(padded, 0);
  if (4 + len > padded.length) throw new InvalidPayload("padding length");
  for (let i = 4 + len; i < padded.length; i++) if (padded[i] !== 0) throw new InvalidPayload("padding bytes");
  return new Uint8Array(padded.subarray(4, 4 + len));
}
