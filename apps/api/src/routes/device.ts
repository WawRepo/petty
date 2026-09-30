import type { FastifyInstance } from "fastify";
import { deviceUserCode, importEcdhPublic, normalizeDeviceCode } from "@petty/crypto";
import { DeviceApproveBody, DeviceCodeRequest, DeviceCodeResponse, DeviceRequestView, DeviceTokenPoll, DeviceTokenResponse } from "@petty/protocol";
import { apiPool } from "../db.js";
import { iso, randomToken, sha256 } from "../lib/bytes.js";
import { ApiError, badRequest, conflict, notFound, unauthorized } from "../lib/errors.js";
import { authEvents } from "../lib/metrics.js";
import { clientIp } from "../lib/client-ip.js";
import { checkRate } from "../lib/password.js";
import { requireUser } from "../lib/session.js";

/** How long a request waits for the person, and how often the tool may ask (RFC 8628 §3.2). */
export const DEVICE_LIFETIME_S = 15 * 60;
export const DEVICE_INTERVAL_S = 5;

const tooMany = () => new ApiError(429, "TooManyAttempts", "try again later");

interface Row {
  id: string;
  user_code: string;
  cli_pub: string;
  client_name: string;
  role: "read" | "write";
  expires_days: number | null;
  ip: string | null;
  created_at: Date;
  expires_at: Date;
}

/**
 * Device login (PETTY-274), the way `gh auth login` works (RFC 8628). A tool with no session asks for a
 * code; the person opens /device in the web app, signed in and unlocked, and allows it; the tool polls
 * until it has its answer. The web app makes an ordinary access token and seals it to the tool's
 * one-time key: this server stores and relays that blob and cannot open it. The code is derived from
 * the tool's key, so the page can tell when the key it was given is not the tool's.
 */
export async function deviceRoutes(app: FastifyInstance) {
  /** The tool asks. No session: this is how a tool without one begins. Limited per address. */
  app.post("/device/code", async (req, reply) => {
    if (!checkRate(`device-code:${clientIp(req)}`, 10, 60 * 60_000)) throw tooMany();
    const body = DeviceCodeRequest.parse(req.body);
    try {
      await importEcdhPublic(body.cli_pub);
    } catch {
      throw badRequest("DeviceKeyInvalid");
    }
    const userCode = await deviceUserCode(body.cli_pub);
    const deviceCode = randomToken(32);
    const { rows } = await apiPool.query<{ id: string }>(
      `insert into device_requests (device_hash, user_code, cli_pub, client_name, role, expires_days, ip, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8))
       on conflict do nothing returning id`,
      [sha256(deviceCode), userCode, body.cli_pub, body.client_name, body.role, body.expires_days, clientIp(req), DEVICE_LIFETIME_S],
    );
    if (!rows[0]) throw conflict("DeviceCodeTaken", "ask again with a new key");
    authEvents.inc({ event: "device_code" });
    reply.code(201);
    return DeviceCodeResponse.parse({ request_id: rows[0].id, device_code: deviceCode, user_code: userCode, expires_in: DEVICE_LIFETIME_S, interval: DEVICE_INTERVAL_S });
  });

  /** The page: what asks, before the person allows it. A session only; a token can never approve a token. */
  app.get<{ Params: { code: string } }>("/device/:code", async (req) => {
    const me = requireUser(req);
    if (req.token) throw unauthorized();
    if (!checkRate(`device-look:${me.id}`, 60, 15 * 60_000)) throw tooMany();
    const code = normalizeDeviceCode(req.params.code);
    if (!code) throw notFound("DeviceCodeUnknown");
    const { rows } = await apiPool.query<Row>(
      `select id, user_code, cli_pub, client_name, role, expires_days, ip, created_at, expires_at
         from device_requests where user_code = $1 and state = 'pending' and expires_at > now()`,
      [code],
    );
    const r = rows[0];
    if (!r) throw notFound("DeviceCodeUnknown");
    return DeviceRequestView.parse({ ...r, created_at: iso(r.created_at), expires_at: iso(r.expires_at) });
  });

  /** The page allows it: the token, sealed to the tool's key. Only a pending, unexpired request takes it. */
  app.post<{ Params: { code: string } }>("/device/:code/approve", async (req, reply) => {
    const me = requireUser(req);
    if (req.token) throw unauthorized();
    const body = DeviceApproveBody.parse(req.body);
    const code = normalizeDeviceCode(req.params.code);
    if (!code) throw notFound("DeviceCodeUnknown");
    const { rowCount } = await apiPool.query(
      `update device_requests set state = 'approved', user_id = $2, sealed_token = $3
        where user_code = $1 and state = 'pending' and expires_at > now()`,
      [code, me.id, JSON.stringify(body.sealed)],
    );
    if (!rowCount) throw notFound("DeviceCodeUnknown");
    authEvents.inc({ event: "device_approved" });
    reply.code(204);
  });

  app.post<{ Params: { code: string } }>("/device/:code/deny", async (req, reply) => {
    const me = requireUser(req);
    if (req.token) throw unauthorized();
    const code = normalizeDeviceCode(req.params.code);
    if (!code) throw notFound("DeviceCodeUnknown");
    const { rowCount } = await apiPool.query(
      "update device_requests set state = 'denied', user_id = $2 where user_code = $1 and state = 'pending' and expires_at > now()",
      [code, me.id],
    );
    if (!rowCount) throw notFound("DeviceCodeUnknown");
    authEvents.inc({ event: "device_denied" });
    reply.code(204);
  });

  /**
   * The tool polls (RFC 8628 §3.4–3.5). "AuthorizationPending" and "SlowDown" mean ask again; every
   * other answer is the last one, and the request is gone once it is given. An unknown code gets the
   * same answer as an expired one.
   */
  app.post("/device/token", async (req, reply) => {
    if (!checkRate(`device-poll:${clientIp(req)}`, 600, 15 * 60_000)) throw tooMany();
    const body = DeviceTokenPoll.parse(req.body);
    const { rows } = await apiPool.query<{ id: string; state: "pending" | "approved" | "denied"; sealed_token: unknown; expired: boolean; early: boolean }>(
      `with prev as (select id, last_poll_at from device_requests where device_hash = $1)
       update device_requests d set last_poll_at = now() from prev where d.id = prev.id
       returning d.id, d.state, d.sealed_token, d.expires_at <= now() as expired,
                 coalesce(prev.last_poll_at > now() - make_interval(secs => $2), false) as early`,
      [sha256(body.device_code), DEVICE_INTERVAL_S - 1],
    );
    const r = rows[0];
    if (!r) throw badRequest("ExpiredToken");
    const done = () => apiPool.query("delete from device_requests where id = $1", [r.id]);
    if (r.expired) {
      await done();
      throw badRequest("ExpiredToken");
    }
    if (r.state === "denied") {
      await done();
      throw badRequest("AccessDenied");
    }
    if (r.state === "pending") throw badRequest(r.early ? "SlowDown" : "AuthorizationPending");
    await done();
    reply.code(200);
    return DeviceTokenResponse.parse({ request_id: r.id, sealed: r.sealed_token });
  });
}
