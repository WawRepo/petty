import { createHash, randomBytes as nodeRandom } from "node:crypto";

export const fromB64 = (s: string): Buffer => Buffer.from(s, "base64");
export const toB64 = (b: Buffer | Uint8Array): string => Buffer.from(b).toString("base64");
export const sha256 = (s: string | Buffer): Buffer => createHash("sha256").update(s).digest();
export const randomToken = (bytes = 32): string => nodeRandom(bytes).toString("base64url");
export const iso = (d: Date | string | null): string | null => (d === null ? null : d instanceof Date ? d.toISOString() : new Date(d).toISOString());
