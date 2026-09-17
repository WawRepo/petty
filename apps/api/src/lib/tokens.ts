import type { FastifyRequest } from "fastify";
import { apiPool } from "../db.js";
import { sha256 } from "./bytes.js";
import { forbidden } from "./errors.js";

/**
 * Access tokens (PETTY-164). A tool of the owner's own presents `Authorization: Bearer
 * petty_pat_<id>`. Only that id reaches us, and only its hash is stored. The secret half of the
 * token never comes here: it opens the key bundle on the tool's machine.
 *
 * A token is deliberately weaker than a session. It can read the drawers in its scope and, with
 * the write role, append entries. It can never touch the vault, the account, sharing, admin or
 * export, and it can never make another token. The allow-list below is the whole permission set,
 * so a new route is denied to tokens until someone adds it here on purpose.
 */
export interface TokenAuth {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly role: "read" | "write";
  /** null = every drawer the owner is a member of */
  readonly scope: readonly string[] | null;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Set when this request was authenticated by an access token instead of a session. */
    token: TokenAuth | null;
  }
}

export const PAT_PREFIX = "petty_pat_";

interface Row {
  id: string;
  user_id: string;
  name: string;
  role: "read" | "write";
  scope: string[] | null;
  email: string;
  display_name: string;
  locale: string;
  is_admin: boolean;
  stale: boolean;
}

/** Look up a bearer credential. Returns null for unknown, revoked, expired, blocked or deleted. */
export async function authenticateToken(bearer: string): Promise<{ token: TokenAuth; user: { id: string; email: string; display_name: string; locale: string; is_admin: boolean } } | null> {
  const id = bearer.slice(PAT_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(id)) return null;
  const { rows } = await apiPool.query<Row>(
    `select t.id, t.user_id, t.name, t.role, t.scope, u.email, u.display_name, u.locale, u.is_admin,
            (t.last_used_at is null or t.last_used_at < now() - interval '5 minutes') as stale
       from access_tokens t join users u on u.id = t.user_id
      where t.token_hash = $1 and t.revoked_at is null and (t.expires_at is null or t.expires_at > now())
        and u.deleted_at is null and u.blocked_at is null`,
    [sha256(bearer)],
  );
  const r = rows[0];
  if (!r) return null;
  // At most one write per token per 5 minutes, like sessions.
  if (r.stale) apiPool.query("update access_tokens set last_used_at = now() where id = $1", [r.id]).catch(() => undefined);
  return {
    token: { id: r.id, userId: r.user_id, name: r.name, role: r.role, scope: r.scope },
    user: { id: r.user_id, email: r.email, display_name: r.display_name, locale: r.locale, is_admin: false },
  };
}

/** Route templates a token may call, by method. `write` routes also need the write role. */
const READ_ROUTES = new Set([
  "GET /me/token",
  "GET /bootstrap",
  "GET /drawers/:id",
  "GET /drawers/:id/photo",
  "GET /drawers/:id/lines/:lineId/entries",
]);
const WRITE_ROUTES = new Set(["POST /drawers/:id/entries"]);

/**
 * Called for every token request before the handler. Denies anything outside the allow-list, an
 * append from a read-only token, and any drawer outside the token's scope.
 */
export function assertTokenMay(req: FastifyRequest, token: TokenAuth): void {
  const url = (req.routeOptions.url ?? "").replace(/^\/api/, "");
  const key = `${req.method} ${url}`;
  const write = WRITE_ROUTES.has(key);
  if (!write && !READ_ROUTES.has(key)) throw forbidden("TokenNotAllowed");
  if (write && token.role !== "write") throw forbidden("TokenReadOnly");
  const params = req.params as { id?: string } | undefined;
  if (params?.id && token.scope && !token.scope.includes(params.id)) throw forbidden("TokenOutOfScope");
}
