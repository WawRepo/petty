/**
 * Re-wrapping the SAME keypairs under another door: a passphrase (recovery "I forgot it",
 * a plain passphrase change, or a first backup passphrase for a passkey-only account) or
 * a new passkey. The keys are extractable only between unwrap and re-wrap, inside these
 * functions, and never touch storage.
 */
import { createPasskeyVault, createRecoveryVault, createVault, generateRecoveryCode, keyPairsOf, signCustodyChallenge, unlockPasskeyVault, unlockVault, zero, type UnlockedKeys, type VaultBlobV1 } from "@petty/crypto";
import { CustodyChallenge, PasskeyEntry, type CustodyProof, type Me } from "@petty/protocol";
import { api } from "./api.js";
import { evaluatePrf, registerPasskey, rememberPasskey } from "./passkey.js";

/**
 * Proof of key possession for destructive custody calls (security review SR-2):
 * fetch a challenge, sign it with the unlocked ECDSA key. The server refuses
 * PUT /me/vault, /me/passkeys and POST /me/delete without it, so a reset login
 * password alone cannot destroy anyone's keys.
 */
export async function custodyProof(ecdsaPrivate: CryptoKey): Promise<CustodyProof> {
  const c = CustodyChallenge.parse(await api<unknown>("POST", "/me/custody-challenge"));
  return { challenge: c.challenge, signature: await signCustodyChallenge(ecdsaPrivate, c.challenge) };
}

const pw = (loginPassword?: string) => (loginPassword ? { password: loginPassword } : {});

/** Opens the passphrase copy EXTRACTABLE (proves the passphrase before any biometric prompt). Throws WrongPassphrase. */
export async function openWithPassphrase(me: Me, passphrase: string): Promise<UnlockedKeys> {
  if (!me.vault) throw new Error("no passphrase vault");
  return unlockVault(me.vault, passphrase, { extractable: true });
}

/** Opens any of the account's passkey copies EXTRACTABLE: the authenticator prompt is the confirmation. */
export async function openWithPasskey(me: Me): Promise<UnlockedKeys> {
  const { credential_id, prf } = await evaluatePrf(me.passkeys);
  try {
    const pk = me.passkeys.find((p) => p.credential_id === credential_id);
    if (!pk) throw new Error("unknown passkey");
    return await unlockPasskeyVault(pk.vault, prf, { extractable: true });
  } finally { zero(prf); }
}

/** Opens the recovery-code copy EXTRACTABLE. Throws WrongPassphrase for a bad code. */
export async function openWithRecoveryCode(recoveryCode: string): Promise<UnlockedKeys> {
  const { recovery_vault } = await api<{ recovery_vault: VaultBlobV1 }>("GET", "/me/recovery-vault");
  return unlockVault(recovery_vault, recoveryCode, { extractable: true });
}

/** (Re)wrap the keys under a passphrase and store that copy: change, recovery, or a first backup passphrase. */
export async function setPassphrase(unlocked: UnlockedKeys, newPassphrase: string, loginPassword?: string): Promise<VaultBlobV1> {
  const vault = await createVault(newPassphrase, await keyPairsOf(unlocked));
  await api("PUT", "/me/vault", { ...pw(loginPassword), proof: await custodyProof(unlocked.ecdsaPrivate), vault });
  return vault;
}

/**
 * A new recovery code (PETTY-200). Step one only makes it: nothing is stored until the person has
 * typed the code back, so an abandoned attempt leaves the old code working.
 */
export async function makeRecoveryCode(unlocked: UnlockedKeys): Promise<{ code: string; vault: VaultBlobV1 }> {
  const code = generateRecoveryCode();
  return { code, vault: await createRecoveryVault(code, await keyPairsOf(unlocked)) };
}

/** Step two: store the new recovery copy; from now on only the new code opens it. */
export async function storeRecoveryCode(unlocked: UnlockedKeys, vault: VaultBlobV1, loginPassword?: string): Promise<void> {
  await api("PUT", "/me/recovery-vault", { ...pw(loginPassword), proof: await custodyProof(unlocked.ecdsaPrivate), recovery_vault: vault });
}

/** Recovery: open the recovery-code copy, wrap under the new passphrase, store. */
export async function recoverWithCode(recoveryCode: string, newPassphrase: string, loginPassword?: string): Promise<VaultBlobV1> {
  return setPassphrase(await openWithRecoveryCode(recoveryCode), newPassphrase, loginPassword);
}

/** Passphrase change: open with the current passphrase, wrap under the new one, store. */
export async function changePassphrase(me: Me, currentPassphrase: string, newPassphrase: string, loginPassword?: string): Promise<VaultBlobV1> {
  return setPassphrase(await openWithPassphrase(me, currentPassphrase), newPassphrase, loginPassword);
}

/**
 * Passkey for this device (PETTY-102): create a passkey, wrap the same keys under its PRF
 * output, store the copy with a label. The caller already proved custody by opening the
 * keys extractable through any door (passphrase, another passkey, the recovery code).
 */
export async function addPasskey(me: Me, unlocked: UnlockedKeys, label: string, loginPassword?: string): Promise<PasskeyEntry> {
  const reg = await registerPasskey(me.keys.sig_key_id, me.email, me.display_name, me.passkeys.map((p) => p.credential_id));
  let vault: VaultBlobV1;
  try { vault = await createPasskeyVault(reg.prf, await keyPairsOf(unlocked)); } finally { zero(reg.prf); }
  const passkey = { credential_id: reg.credential_id, prf_salt: reg.prf_salt, vault, label: label.trim().slice(0, 60), transports: reg.transports };
  const entry = PasskeyEntry.parse(await api<unknown>("POST", "/me/passkeys", { ...pw(loginPassword), proof: await custodyProof(unlocked.ecdsaPrivate), passkey }));
  rememberPasskey(entry.credential_id);
  return entry;
}

/** Removes one passkey's copy of the keys. The keys were never exposed, so nothing needs rotating. */
export async function removePasskey(id: string, ecdsaPrivate: CryptoKey, loginPassword?: string): Promise<void> {
  await api("DELETE", `/me/passkeys/${encodeURIComponent(id)}`, { ...pw(loginPassword), proof: await custodyProof(ecdsaPrivate) });
}
