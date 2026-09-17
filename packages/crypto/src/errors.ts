/**
 * Every error carries a stable `code`, a fixed message, and a `context` of ids and
 * versions only. No error ever carries plaintext, a key, a passphrase, or a
 * ciphertext. This is CLAUDE.md rule 2 at the type level.
 */
export type ErrorContext = Readonly<Record<string, string | number | null>>;

export class PettyCryptoError extends Error {
  readonly code: string;
  readonly context: ErrorContext;
  constructor(code: string, message: string, context: ErrorContext = {}) {
    super(message);
    this.name = code;
    this.code = code;
    this.context = context;
  }
}

/** The passphrase or recovery code did not open the vault. */
export class WrongPassphrase extends PettyCryptoError {
  constructor(context: ErrorContext = {}) { super("WrongPassphrase", "vault did not open", context); }
}
/** AES-GCM authentication failed: wrong key, altered ciphertext, or moved row (AAD mismatch). */
export class AuthTagMismatch extends PettyCryptoError {
  constructor(context: ErrorContext = {}) { super("AuthTagMismatch", "ciphertext failed authentication", context); }
}
/** The row claims a schema_version this build does not understand. */
export class UnknownSchemaVersion extends PettyCryptoError {
  constructor(context: ErrorContext = {}) { super("UnknownSchemaVersion", "unsupported schema version", context); }
}
/** The row was sealed under a key_version the caller holds no key for. */
export class UnknownKeyVersion extends PettyCryptoError {
  constructor(context: ErrorContext = {}) { super("UnknownKeyVersion", "no key for this key version", context); }
}
/** An entry's signature does not verify under the claimed author key. */
export class SignatureInvalid extends PettyCryptoError {
  constructor(context: ErrorContext = {}) { super("SignatureInvalid", "entry signature invalid", context); }
}
/** A prev_hash does not match the entry it claims to follow. */
export class ChainBroken extends PettyCryptoError {
  constructor(context: ErrorContext = {}) { super("ChainBroken", "entry chain broken", context); }
}
/** A wrapped key did not unwrap: wrong recipient key or altered wrap. */
export class UnwrapFailed extends PettyCryptoError {
  constructor(context: ErrorContext = {}) { super("UnwrapFailed", "wrapped key did not unwrap", context); }
}
/** Structural problem with a payload, identity or parameter. Never quotes the value. */
export class InvalidPayload extends PettyCryptoError {
  constructor(what: string, context: ErrorContext = {}) { super("InvalidPayload", `invalid ${what}`, context); }
}
/** The sender key carried by a wrap is not the key the recipient has pinned for that sender. Possible substitution by the server. */
export class SenderKeyMismatch extends PettyCryptoError {
  constructor(context: ErrorContext = {}) { super("SenderKeyMismatch", "wrap sender key differs from the pinned key", context); }
}
/** A wrap was requested for a key that was unwrapped as non-extractable. */
export class KeyNotExtractable extends PettyCryptoError {
  constructor(context: ErrorContext = {}) { super("KeyNotExtractable", "key is not extractable; unwrap it with extractable=true for this operation", context); }
}
