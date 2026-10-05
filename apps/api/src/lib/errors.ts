/** Errors the API returns. Code + ids only, never content (CLAUDE.md rule 2). */
export type Ctx = Record<string, string | number | null>;

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly context: Ctx = {}) {
    super(message);
    this.name = "ApiError";
  }
}
export const badRequest = (code: string, message = code, context: Ctx = {}) => new ApiError(400, code, message, context);
export const unauthorized = () => new ApiError(401, "Unauthorized", "sign in required");
export const forbidden = (code = "Forbidden", context: Ctx = {}) => new ApiError(403, code, "not allowed", context);
export const notFound = (code = "NotFound", context: Ctx = {}) => new ApiError(404, code, "not found", context);
export const conflict = (code: string, message: string, context: Ctx = {}) => new ApiError(409, code, message, context);
/** PETTY-243: a record over its size limit, or a write that would pass the storage quota. */
export const tooLarge = (code: string, message: string, context: Ctx = {}) => new ApiError(413, code, message, context);

/**
 * PETTY-266: refusals that normal use never triggers: a custody proof signed with another key, keys or a
 * wrap that do not match the account or the drawer, a delegation or device key that does not check, a
 * token asked to do what it may not. Each is counted by code (petty_security_refusals_total) so an alert
 * can see someone probing. Left out on purpose: CustodyProofRequired (also a proof that expired while the
 * person paused) and WrapsIncomplete (also a member who joined during a key rotation).
 */
export const SECURITY_REFUSALS: ReadonlySet<string> = new Set([
  "CustodyProofInvalid", "KeysMismatch", "WrapMismatch", "DelegationInvalid", "DelegationMismatch",
  "DeviceKeyInvalid", "TokenCannotVerify", "SigningKeyRequired", "ReadTokenCannotSign",
]);
