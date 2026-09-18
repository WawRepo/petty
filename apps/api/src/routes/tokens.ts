import type { FastifyInstance } from "fastify";
import { verifyDelegation } from "@petty/crypto";
import { AccessToken, AccessTokenCreate, AccessTokenKeysBody, AccessTokenSelf, TokenBootstrap, UserDelegations, type DrawerSummary } from "@petty/protocol";
import type { DrawerRow } from "../lib/perm.js";
import { drawerSummary, entryRow, sealedRow, userKeys } from "../lib/rows.js";
import { apiPool } from "../db.js";
import { iso, sha256 } from "../lib/bytes.js";
import { badRequest, notFound, unauthorized } from "../lib/errors.js";
import { requireUser } from "../lib/session.js";
import { consumeCustodyProof } from "../lib/custody.js";
import { PAT_PREFIX } from "../lib/tokens.js";

interface Row {
  id: string;
  name: string;
  role: "read" | "write";
  scope: string[] | null;
  ecdh_pub: string | null;
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
    ecdh_pub: r.ecdh_pub,
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
      "select id, name, role, scope, ecdh_pub, created_at, last_used_at, expires_at from access_tokens where user_id = $1 and revoked_at is null order by created_at desc",
      [me.id],
    );
    return { tokens: rows.map(row) };
  });

  app.post("/me/tokens", async (req, reply) => {
    const me = requireUser(req);
    if (req.token) throw unauthorized();
    const body = AccessTokenCreate.parse(req.body);
    // Defence in depth (NR-1): a stolen session alone cannot make a token; it takes the signing key.
    await consumeCustodyProof(req, me.id, body.proof);
    if (body.scope && body.scope.length === 0) throw badRequest("EmptyScope");
    if (body.expires_at && new Date(body.expires_at).getTime() <= Date.now()) throw badRequest("ExpiresInThePast");
    // PETTY-184 (NR-4): a writing token signs with its own key, vouched for by the account key.
    if (body.role === "write" && !body.signing) throw badRequest("SigningKeyRequired");
    if (body.role === "read" && body.signing) throw badRequest("ReadTokenCannotSign");
    if (body.signing) {
      const d = body.signing.delegation;
      const acct = (await apiPool.query<{ sig_key_id: string; ecdsa_pub: string }>("select sig_key_id, ecdsa_pub from user_keys where user_id = $1 and retired_at is null", [me.id])).rows[0];
      const sameExpiry = (d.expires_at === null) === (body.expires_at === null) && (d.expires_at === null || Date.parse(d.expires_at) === Date.parse(body.expires_at!));
      if (!acct || d.token_ecdsa_pub !== body.signing.ecdsa_pub || !sameExpiry) throw badRequest("DelegationMismatch");
      try {
        await verifyDelegation(d, { user_id: me.id, sig_key_id: acct.sig_key_id, ecdsa_pub: acct.ecdsa_pub });
      } catch {
        throw badRequest("DelegationInvalid");
      }
    }
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
      `insert into access_tokens (user_id, name, token_hash, role, scope, bundle_nonce, bundle_ciphertext, expires_at, ecdh_pub, ecdsa_pub, sig_key_id, delegation)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       returning id, name, role, scope, ecdh_pub, created_at, last_used_at, expires_at`,
      [
        me.id, body.name, sha256(PAT_PREFIX + body.token_id), body.role, body.scope, body.bundle.nonce, body.bundle.ciphertext, body.expires_at, body.ecdh_pub ?? null,
        body.signing?.ecdsa_pub ?? null, body.signing?.delegation.token_sig_key_id ?? null, body.signing ? JSON.stringify(body.signing.delegation) : null,
      ],
    );
    reply.code(201);
    return row(rows[0]!);
  });

  /**
   * Every signing delegation a user made, revoked ones included (PETTY-184). A reader needs them to
   * verify entries a token signed; each is checked on the reader's side against the account key, so
   * this route cannot vouch for anything by itself. Session only.
   */
  app.get<{ Params: { id: string } }>("/users/:id/delegations", async (req) => {
    requireUser(req);
    if (req.token) throw unauthorized();
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw notFound("UserNotFound");
    const { rows } = await apiPool.query<{ delegation: unknown; revoked_at: Date | null }>(
      "select delegation, revoked_at from access_tokens where user_id = $1 and delegation is not null order by created_at",
      [req.params.id],
    );
    return UserDelegations.parse({ delegations: rows.map((r) => ({ delegation: r.delegation, revoked_at: iso(r.revoked_at) })) });
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

  /**
   * The wraps a token already holds (PETTY-169). The web app asks for this to see which drawers
   * still need one, then posts the missing ones. Session only: a token cannot widen itself.
   */
  app.get<{ Params: { id: string } }>("/me/tokens/:id/keys", async (req) => {
    const me = requireUser(req);
    if (req.token) throw unauthorized();
    const { rows } = await apiPool.query<{ drawer_id: string; key_version: number }>(
      `select k.drawer_id, k.key_version from access_token_keys k join access_tokens t on t.id = k.token_id
        where k.token_id = $1 and t.user_id = $2`,
      [req.params.id, me.id],
    );
    return { keys: rows };
  });

  app.post<{ Params: { id: string } }>("/me/tokens/:id/keys", async (req, reply) => {
    const me = requireUser(req);
    if (req.token) throw unauthorized();
    const body = AccessTokenKeysBody.parse(req.body);
    const { rows } = await apiPool.query<{ id: string; scope: string[] | null }>(
      "select id, scope from access_tokens where id = $1 and user_id = $2 and revoked_at is null",
      [req.params.id, me.id],
    );
    const token = rows[0];
    if (!token) throw notFound("TokenNotFound");
    for (const k of body.keys) {
      if (token.scope && !token.scope.includes(k.drawer_id)) throw badRequest("OutOfScope");
      // The drawer must be one this user can already open, so a wrap can never widen access.
      const ok = await apiPool.query(
        `select 1 from drawers d where d.id = $1
          and (d.owner_id = $2 or exists (select 1 from drawer_members m where m.drawer_id = d.id and m.user_id = $2))`,
        [k.drawer_id, me.id],
      );
      if (!ok.rowCount) throw badRequest("NotAMember");
      await apiPool.query(
        `insert into access_token_keys (token_id, drawer_id, key_version, wrap) values ($1, $2, $3, $4)
         on conflict (token_id, drawer_id, key_version) do nothing`,
        [token.id, k.drawer_id, k.key_version, k.wrap],
      );
    }
    reply.code(204);
  });

  /** The tool's own wraps, for the token it presents. */
  app.get("/me/token/keys", async (req) => {
    const t = req.token;
    if (!t) throw unauthorized();
    const { rows } = await apiPool.query<{ drawer_id: string; key_version: number; wrap: unknown }>(
      "select drawer_id, key_version, wrap from access_token_keys where token_id = $1",
      [t.id],
    );
    return { keys: rows.filter((r) => !t.scope || t.scope.includes(r.drawer_id)) };
  });

  /**
   * The token's own start-up load (PETTY-182, review NR-2): only the drawers in its scope, their
   * documents and entries since the last Adjust, and the signing key id. Unlike /bootstrap, no vault,
   * passkeys, user wraps, members, invitations or transfers.
   */
  app.get("/me/token/bootstrap", async (req) => {
    const t = req.token;
    if (!t) throw unauthorized();
    const { rows: ds } = await apiPool.query<DrawerRow & { role: DrawerSummary["role"]; has_photo: boolean }>(
      `select d.*, case when d.owner_id = $1 then 'owner' else m.role end as role, (p.drawer_id is not null) as has_photo
         from drawers d
         left join drawer_members m on m.drawer_id = d.id and m.user_id = $1
         left join drawer_photos p on p.drawer_id = d.id
        where (d.owner_id = $1 or m.user_id is not null) and ($2::uuid[] is null or d.id = any($2::uuid[]))
        order by d.created_at`,
      [t.userId, t.scope],
    );
    const ids = ds.map((d) => d.id);
    const [docs, entries, keys, authorKeys, authorDelegations] = await Promise.all([
      apiPool.query("select * from drawer_documents where drawer_id = any($1)", [ids]),
      apiPool.query(
        `select e.* from entries e join line_heads h on h.drawer_id = e.drawer_id and h.line_id = e.line_id
          where e.drawer_id = any($1) and e.seq >= greatest(h.checkpoint_seq, 1)
          order by e.drawer_id, e.line_id, e.seq`,
        [ids],
      ),
      apiPool.query<{ sig_key_id: string }>("select sig_key_id from user_keys where user_id = $1 and retired_at is null", [t.userId]),
      // PETTY-191 (NR-11): every key and delegation of anyone who wrote in these drawers, so the tool can check signatures
      apiPool.query(
        "select k.* from user_keys k where k.user_id in (select distinct author_id from entries where drawer_id = any($1)) order by k.created_at",
        [ids],
      ),
      apiPool.query<{ user_id: string; delegation: unknown; revoked_at: Date | null }>(
        `select user_id, delegation, revoked_at from access_tokens
          where delegation is not null and user_id in (select distinct author_id from entries where drawer_id = any($1)) order by created_at`,
        [ids],
      ),
    ]);
    const authors: Record<string, { keys: ReturnType<typeof userKeys>[]; delegations: { delegation: unknown; revoked_at: string | null }[] }> = {};
    const author = (id: string) => (authors[id] ??= { keys: [], delegations: [] });
    for (const r of authorKeys.rows) { const k = userKeys(r); if (k) author(r.user_id).keys.push(k); }
    for (const r of authorDelegations.rows) author(r.user_id).delegations.push({ delegation: r.delegation, revoked_at: iso(r.revoked_at) });
    const documents: Record<string, ReturnType<typeof sealedRow>> = {};
    for (const r of docs.rows) documents[r.drawer_id] = sealedRow(r);
    return TokenBootstrap.parse({
      user_id: t.userId,
      sig_key_id: keys.rows[0]?.sig_key_id ?? "",
      drawers: ds.map((d) => drawerSummary(d, d.role, d.has_photo)),
      documents,
      entries: entries.rows.map(entryRow),
      authors,
    });
  });

  /** What a tool asks for with its own token: who it belongs to and its sealed bundle. */
  app.get("/me/token", async (req) => {
    const t = req.token;
    if (!t) throw unauthorized();
    const { rows } = await apiPool.query<{ user_id: string; name: string; role: "read" | "write"; scope: string[] | null; bundle_nonce: string; bundle_ciphertext: string; owner_ecdh_pub: string }>(
      `select t.user_id, t.name, t.role, t.scope, t.bundle_nonce, t.bundle_ciphertext, k.ecdh_pub as owner_ecdh_pub
         from access_tokens t join user_keys k on k.user_id = t.user_id and k.retired_at is null
        where t.id = $1`,
      [t.id],
    );
    const r = rows[0];
    if (!r) throw notFound("TokenNotFound");
    return AccessTokenSelf.parse({
      user_id: r.user_id,
      name: r.name,
      role: r.role,
      scope: r.scope,
      owner_ecdh_pub: r.owner_ecdh_pub,
      bundle: { nonce: r.bundle_nonce, ciphertext: r.bundle_ciphertext },
    });
  });
}
