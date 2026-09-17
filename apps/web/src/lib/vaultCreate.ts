/**
 * Creating a vault (join screen in local mode, setup screen in Clerk mode) — PETTY-102:
 * keys are generated here, wrapped under the first door (a passkey on this device, or a
 * passphrase) and under the recovery code, and the server stores what it cannot open.
 * The keys exist extractable only inside `createVaultMaterial` and the session that
 * follows unlocks a non-extractable copy from them.
 */
import { createPasskeyVault, createRecoveryVault, createVault, exportPublicKeys, generateRecoveryCode, generateUserKeys, signingKeyId, zero, type PublicKeys, type UserKeyPairs, type VaultBlobV1 } from "@petty/crypto";
import type { PasskeyVault } from "@petty/protocol";
import { registerPasskey } from "./passkey.js";

export type FirstDoor =
  | { kind: "passphrase"; passphrase: string }
  | { kind: "passkey"; email: string; displayName: string; label: string };

export interface VaultMaterial {
  readonly keys: UserKeyPairs;
  readonly pub: PublicKeys;
  readonly recoveryCode: string;
  /** The body fields shared by POST /auth/signup and POST /auth/provision. */
  readonly body: { keys: { ecdh_pub: string; ecdsa_pub: string; sig_key_id: string }; vault?: VaultBlobV1; passkey?: PasskeyVault; recovery_vault: VaultBlobV1 };
}

export async function createVaultMaterial(door: FirstDoor): Promise<VaultMaterial> {
  const keys = await generateUserKeys();
  const pub = await exportPublicKeys(keys);
  const sig_key_id = await signingKeyId(pub.ecdsa);
  const recoveryCode = generateRecoveryCode();
  const recovery_vault = await createRecoveryVault(recoveryCode, keys);
  const base = { keys: { ecdh_pub: pub.ecdh, ecdsa_pub: pub.ecdsa, sig_key_id }, recovery_vault };
  if (door.kind === "passphrase") {
    return { keys, pub, recoveryCode, body: { ...base, vault: await createVault(door.passphrase, keys) } };
  }
  const reg = await registerPasskey(sig_key_id, door.email, door.displayName, []);
  let vault: VaultBlobV1;
  try { vault = await createPasskeyVault(reg.prf, keys); } finally { zero(reg.prf); }
  const passkey: PasskeyVault = { credential_id: reg.credential_id, prf_salt: reg.prf_salt, vault, label: door.label.trim().slice(0, 60), transports: reg.transports };
  return { keys, pub, recoveryCode, body: { ...base, passkey } };
}
