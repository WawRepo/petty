import type { FastifyRequest } from "fastify";
import { verifyCustodyProof } from "@petty/crypto";
import type { CustodyProof } from "@petty/protocol";
import { apiPool } from "../db.js";
import { randomBytes } from "node:crypto";
import { toB64 } from "./bytes.js";
import { forbidden } from "./errors.js";

/**
 * Custody challenges (security review SR-2). One outstanding challenge per user,
 * five minutes, single use, in memory: the API runs as one process and a lost
 * challenge only costs the client one extra round trip.
 */
const CHALLENGE_MS = 5 * 60_000;
const outstanding = new Map<string, { challenge: string; expiresAt: number }>();

export function issueChallenge(userId: string): { challenge: string; expires_at: string } {
  const challenge = toB64(randomBytes(32));
  const expiresAt = Date.now() + CHALLENGE_MS;
  outstanding.set(userId, { challenge, expiresAt });
  return { challenge, expires_at: new Date(expiresAt).toISOString() };
}

/**
 * Verifies and consumes the proof against the user's CURRENT signing key.
 * 403 CustodyProofRequired when there is no live challenge or it does not match;
 * 403 CustodyProofInvalid when the signature is wrong.
 */
export async function consumeCustodyProof(req: FastifyRequest, userId: string, proof: CustodyProof): Promise<void> {
  const c = outstanding.get(userId);
  outstanding.delete(userId);
  if (!c || c.expiresAt < Date.now() || c.challenge !== proof.challenge) throw forbidden("CustodyProofRequired");
  const k = (await apiPool.query<{ ecdsa_pub: string }>("select ecdsa_pub from user_keys where user_id = $1 and retired_at is null", [userId])).rows[0];
  if (!k || !(await verifyCustodyProof(k.ecdsa_pub, proof.challenge, proof.signature))) {
    req.log.warn({ user: userId }, "custody proof rejected");
    throw forbidden("CustodyProofInvalid");
  }
}
