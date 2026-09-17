import type { FastifyInstance } from "fastify";
import { AccessToken, AccessTokenCreate, AccessTokenSelf } from "@petty/protocol";
import { apiPool } from "../db.js";
import { iso, sha256 } from "../lib/bytes.js";
import { badRequest, notFound, unauthorized } from "../lib/errors.js";
import { requireUser } from "../lib/session.js";
import { PAT_PREFIX } from "../lib/tokens.js";

interface Row {
  id: string;
  name: string;
  role: "read" | "write";
  scope: string[] | null;
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date | null;
}
const row = (r: Row) =>
  AccessToken.parse({
    id: r.id,
    name: r.name,
    role: r.role,
    scope: r.scope,
    created_at: iso(r.created_at),
    last_used_at: iso(r.last_used_at),
    expires_at: iso(r.expires_at),
  });

/**
 * Access tokens for the owner's own tools (PETTY-164). The client makes the whole token and
 * seals the key bundle; we store the hash of the id half and the sealed bundle, and can open
 * neither. Managing tokens needs a session: a token can never make or read another token.
 */
export async function tokenRoutes(app: FastifyInstance) {
  app.get("/me/tokens", async (req) => {
    const me = requireUser(req);
    if (req.token) throw unauthorized();
    const { rows } = await apiPool.query<Row>(
      "select id, name, role, scope, created_at, last_used_at, expires_at from access_tokens where user_id = $1 and revoked_at is null order by created_at desc",
      [me.id],
    );
    return { tokens: rows.map(row) };
  });

  app.post("/me/tokens", async (req, reply) => {
    const me = requireUser(req);
    if (req.token) throw unauthorized();
    const body = AccessTokenCreate.parse(req.body);
    if (body.scope && body.scope.length === 0) throw badRequest("EmptyScope");
    if (body.expires_at && new Date(body.expires_at).getTime() <= Date.now()) throw badRequest("ExpiresInThePast");
    if (body.scope) {
      // Every drawer in the scope must be one this user is a member of, so a token can never widen access.
      const { rows } = await apiPool.query<{ n: string }>(
        `select count(*)::text as n from drawers d
          where d.id = any($2::uuid[])
            and (d.owner_id = $1 or exists (select 1 from drawer_members m where m.drawer_id = d.id and m.user_id = $1))`,
        [me.id, body.scope],
      );
      if (Number(rows[0]?.n ?? 0) !== body.scope.length) throw badRequest("ScopeNotAMember");
    }
    const { rows } = await apiPool.query<Row>(
      `insert into access_tokens (user_id, name, token_hash, role, scope, bundle_nonce, bundle_ciphertext, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning id, name, role, scope, created_at, last_used_at, expires_at`,
      [me.id, body.name, sha256(PAT_PREFIX + body.token_id), body.role, body.scope, body.bundle.nonce, body.bundle.ciphertext, body.expires_at],
    );
    reply.code(201);
    return row(rows[0]!);
  });

  app.delete<{ Params: { id: string } }>("/me/tokens/:id", async (req, reply) => {
    const me = requireUser(req);
    if (req.token) throw unauthorized();
    const { rowCount } = await apiPool.query("update access_tokens set revoked_at = now() where id = $1 and user_id = $2 and revoked_at is null", [
      req.params.id,
      me.id,
    ]);
    if (!rowCount) throw notFound("TokenNotFound");
    reply.code(204);
  });

  /** What a tool asks for with its own token: who it belongs to and its sealed bundle. */
  app.get("/me/token", async (req) => {
    const t = req.token;
    if (!t) throw unauthorized();
    const { rows } = await apiPool.query<{ user_id: string; name: string; role: "read" | "write"; scope: string[] | null; bundle_nonce: string; bundle_ciphertext: string }>(
      "select user_id, name, role, scope, bundle_nonce, bundle_ciphertext from access_tokens where id = $1",
      [t.id],
    );
    const r = rows[0];
    if (!r) throw notFound("TokenNotFound");
    return AccessTokenSelf.parse({
      user_id: r.user_id,
      name: r.name,
      role: r.role,
      scope: r.scope,
      bundle: { nonce: r.bundle_nonce, ciphertext: r.bundle_ciphertext },
    });
  });
}
