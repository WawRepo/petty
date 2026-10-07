import type { FastifyRequest } from "fastify";
import { verifyCustodyProof } from "@petty/crypto";
import type { CustodyProof } from "@petty/protocol";
import { apiPool } from "../db.js";
import { randomBytes } from "node:crypto";
import { toB64 } from "./bytes.js";
import { forbidden } from "./errors.js";

/**
 * Custody challenges (security review SR-2). One outstanding challenge per user, five minutes, single
 * use. In the database since PETTY-334, not in this process's memory: with more than one instance (the
 * public one runs two machines) the challenge and the request that uses it may reach different ones.
 */
const CHALLENGE_MS = 5 * 60_000;

export async function issueChallenge(userId: string): Promise<{ challenge: string; expires_at: string }> {
  const challenge = toB64(randomBytes(32));
  const expiresAt = new Date(Date.now() + CHALLENGE_MS);
  await apiPool.query(
    `insert into custody_challenges (user_id, challenge, expires_at) values ($1, $2, $3)
     on conflict (user_id) do update set challenge = excluded.challenge, expires_at = excluded.expires_at`,
    [userId, challenge, expiresAt],
  );
  return { challenge, expires_at: expiresAt.toISOString() };
}

/**
 * Verifies and consumes the proof against the user's CURRENT signing key.
 * 403 CustodyProofRequired when there is no live challenge or it does not match;
 * 403 CustodyProofInvalid when the signature is wrong.
 */
export async function consumeCustodyProof(req: FastifyRequest, userId: string, proof: CustodyProof): Promise<void> {
  // single use whatever the outcome: one statement reads and deletes, so two instances cannot both accept it
  const c = (await apiPool.query<{ challenge: string; expires_at: Date }>(
    "delete from custody_challenges where user_id = $1 returning challenge, expires_at", [userId],
  )).rows[0];
  if (!c || c.expires_at.getTime() < Date.now() || c.challenge !== proof.challenge) throw forbidden("CustodyProofRequired");
  const k = (await apiPool.query<{ ecdsa_pub: string }>("select ecdsa_pub from user_keys where user_id = $1 and retired_at is null", [userId])).rows[0];
  if (!k || !(await verifyCustodyProof(k.ecdsa_pub, proof.challenge, proof.signature))) {
    req.log.warn({ user: userId }, "custody proof rejected");
    throw forbidden("CustodyProofInvalid");
  }
}
