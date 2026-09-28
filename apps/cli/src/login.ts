import { checkApiUrl, connect, type AgentClient } from "@petty/agent";
import { deviceKeyPair, deviceUserCode, openDeviceToken, splitPatToken } from "@petty/crypto";
import { DeviceCodeResponse, DeviceTokenResponse } from "@petty/protocol";
import { CliError, type Io } from "./io.js";

/**
 * `petty auth login` (PETTY-274): sign in through a page of the web app, the way `gh auth login` does
 * (RFC 8628). This process makes a one-time key pair and asks the server for a code. The code is derived
 * from the key, so it is checked here too. The person opens the page, signed in, and allows it; the page
 * seals an ordinary access token to this key, and only this process can open it. The private key never
 * leaves memory.
 */

/** "petty.example.com", "https://petty.example.com/" or ".../api" → "https://petty.example.com". */
export function originOf(host: string): string {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(host.trim()) ? host.trim() : `https://${host.trim()}`;
  let u: URL;
  try { u = new URL(withScheme); } catch { throw new CliError(2, `not an address: ${host}`); }
  return u.origin;
}

export const apiOf = (origin: string): string => `${origin}/api`;

export interface LoginAsk {
  readonly origin: string;
  readonly role: "read" | "write";
  /** null = until revoked */
  readonly expiresDays: 30 | 90 | 365 | null;
  readonly browser: boolean;
}

async function post(io: Io, url: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await io.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { /* not JSON: an older Petty or a proxy page */ }
  return { status: res.status, json };
}

/** Runs the whole device login and returns the token string. */
export async function deviceLogin(io: Io, ask: LoginAsk): Promise<string> {
  const api = apiOf(ask.origin);
  try { checkApiUrl(api); } catch (e) { throw new CliError(2, (e as Error).message); }
  const key = await deviceKeyPair();
  const clientName = `petty on ${io.hostname || "this computer"}`.slice(0, 80);
  let started: { status: number; json: Record<string, unknown> };
  try {
    started = await post(io, `${api}/device/code`, { cli_pub: key.publicB64, client_name: clientName, role: ask.role, expires_days: ask.expiresDays });
  } catch {
    throw new CliError(1, `cannot reach ${ask.origin}`);
  }
  if (started.status === 429) throw new CliError(1, "too many sign-ins from this address: wait a while and try again");
  if (started.status !== 201) throw new CliError(1, `${ask.origin} did not start a sign-in (${String(started.json["code"] ?? started.status)}). An older Petty has no browser sign-in: make a token in Settings → Access tokens and use petty auth login --with-token`);
  const code = DeviceCodeResponse.parse(started.json);
  // the code is derived from our key; one that is not was made for another key
  if (code.user_code !== (await deviceUserCode(key.publicB64))) throw new CliError(1, "the server answered with a code that is not this request's: stopped");

  const page = `${ask.origin}/device?code=${code.user_code}`;
  io.err(`\nYour one-time code: ${code.user_code}\n`);
  if (ask.browser && io.openUrl(page)) io.err(`Opened ${page}\nCheck that the page shows the same code, then allow it there.\n`);
  else io.err(`Open this page in a browser where you use Petty, check the code, and allow it:\n  ${page}\n`);
  io.err("Waiting… (Ctrl-C stops)\n");

  let interval = code.interval * 1000;
  const until = io.now() + code.expires_in * 1000;
  while (io.now() < until) {
    await io.sleep(interval);
    let r: { status: number; json: Record<string, unknown> };
    try {
      r = await post(io, `${api}/device/token`, { device_code: code.device_code });
    } catch {
      continue; // off the network for a moment: keep waiting until the code expires
    }
    if (r.status === 200) {
      const got = DeviceTokenResponse.parse(r.json);
      try {
        return await openDeviceToken(key.privateKey, got.sealed, { requestId: code.request_id, userCode: code.user_code, origin: ask.origin });
      } catch {
        throw new CliError(1, "the answer did not open with this sign-in's key: stopped (was the page on another address?)");
      }
    }
    const answer = r.json["code"];
    if (answer === "AuthorizationPending") continue;
    if (answer === "SlowDown" || r.status === 429) { interval += 5000; continue; }
    if (answer === "AccessDenied") throw new CliError(3, "denied on the page: not signed in");
    if (answer === "ExpiredToken") break;
    throw new CliError(1, `unexpected answer from ${ask.origin} (${String(answer ?? r.status)})`);
  }
  throw new CliError(3, "the code expired before it was allowed: run petty auth login again");
}

/** Opens the token's key bundle once, to check it works and to learn its name and role. */
export async function checkToken(io: Io, origin: string, token: string): Promise<AgentClient> {
  try { splitPatToken(token); } catch { throw new CliError(3, "that is not a Petty access token (petty_pat_…)"); }
  return connect({ token, apiUrl: apiOf(origin), fetch: io.fetch });
}
