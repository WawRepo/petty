import { PASSPHRASE_MIN_LENGTH } from "@petty/crypto";

export type PassphraseProblem = "short" | "same_as_password" | "weak" | null;

/**
 * Strength floor at signup (spec: Security §3). Length first; then refuse the
 * obvious: equal to the login password (SPEC-ISSUES A9), containing the email's
 * local part, one repeated character, or a plain keyboard run. Phase 13 may add
 * zxcvbn on top.
 */
export function checkPassphrase(passphrase: string, loginPassword: string, email: string): PassphraseProblem {
  const p = passphrase.normalize("NFKC");
  if (p.length < PASSPHRASE_MIN_LENGTH) return "short";
  if (p === loginPassword.normalize("NFKC")) return "same_as_password";
  const lower = p.toLowerCase();
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  if (local.length >= 4 && lower.includes(local)) return "weak";
  if (/^(.)\1+$/.test(p)) return "weak";
  if (/^(?:0123456789|1234567890|qwertyuiop|asdfghjkl|abcdefghijklmnop)/i.test(p.replace(/\s/g, ""))) return "weak";
  if (new Set(lower.replace(/\s/g, "")).size < 5) return "weak";
  return null;
}
