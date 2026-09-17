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
