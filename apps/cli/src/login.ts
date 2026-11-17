import { checkApiUrl, connect, serverCode, warningText, type AgentClient } from "@petty/agent";
import { deviceKeyPair, deviceUserCode, openDeviceToken, splitPatToken } from "@petty/crypto";
import { DeviceCodeResponse, DeviceTokenResponse } from "@petty/protocol";
import pkg from "../package.json" with { type: "json" };
import { CliError, type Io } from "./io.js";

/**
 * `petty auth login` (PETTY-274): sign in through a page of the web app, the way `gh auth login` does
 * (RFC 8628). This process makes a one-time key pair and a code derived from the key and the address
 * (20 letters since PETTY-451), and registers both. The person opens the page, signed in, and allows it;
 * the page works the code out again, seals an ordinary access token to this key, and only this process can
 * open it. The private key never leaves memory. A Petty that still answers with the earlier 12-letter code
 * is older than this program: the sign-in stops and says so.
 */

/** "petty.example.com", "https://petty.example.com/" or ".../api" → "https://petty.example.com". */
export function originOf(host: string): string {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(host.trim()) ? host.trim() : `https://${host.trim()}`;
  let u: URL;
  try { u = new URL(withScheme); } catch { throw new CliError(2, `not an address: ${host}`); }
  return u.origin;
}

export const apiOf = (origin: string): string => `${origin}/api`;

/** Where this program's releases are published; each release has its own petty.mjs (docs/cli.md, "Install"). */
export const RELEASES = "https://github.com/WawRepo/petty/releases";

/**
 * PETTY-515: where to get the petty that goes with the Petty at `origin`. When that Petty says its version
 * (`/api/config`, "v1.2.3"), the answer is that release's file, with the app's page that shows the commands
 * for it; else only the page. A Petty built from a fork or locally has no such version, and only its page knows.
 */
export async function matchingPetty(io: Io, origin: string): Promise<string> {
  const page = `${origin}/ai`;
  let version: unknown = null;
  try {
    const res = await io.fetch(`${apiOf(origin)}/config`);
    if (res.ok) version = ((await res.json()) as { version?: unknown }).version;
  } catch { /* offline, or not JSON: the page */ }
  return typeof version === "string" && /^v\d+\.\d+\.\d+$/.test(version)
    ? `download the petty of ${version}: ${RELEASES}/download/${version}/petty.mjs (the page ${page} shows how to install it)`
    : `the page ${page} shows how to install it`;
}

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

/** What a refusal is printed as (PETTY-453): the server's code if it is one this program knows, never its own text; without a code, the status. */
const said = (r: { status: number; json: Record<string, unknown> }): string => ((r.json["code"] ?? null) === null ? String(r.status) : serverCode(r.json["code"]));

/** Runs the whole device login and returns the token string. */
export async function deviceLogin(io: Io, ask: LoginAsk): Promise<string> {
  const api = apiOf(ask.origin);
  try { checkApiUrl(api); } catch (e) { throw new CliError(2, (e as Error).message); }
  const key = await deviceKeyPair();
  const userCode = await deviceUserCode(key.publicB64, ask.origin);
  const clientName = `petty on ${io.hostname || "this computer"}`.slice(0, 80);
  let started: { status: number; json: Record<string, unknown> };
  try {
    started = await post(io, `${api}/device/code`, { cli_pub: key.publicB64, user_code: userCode, client_name: clientName, role: ask.role, expires_days: ask.expiresDays });
  } catch {
    throw new CliError(1, `cannot reach ${ask.origin}`);
  }
  // PETTY-451: the two ends must be of one age. A newer Petty says so by name. An older one ignores the code
  // sent and answers with its own, of the earlier 12-letter form, which this program never uses.
  // PETTY-515: both say where the petty that goes with that Petty is downloaded
  if (started.json["code"] === "CommandLineTooOld") throw new CliError(1, `this petty (v${pkg.version}) is older than the Petty at ${ask.origin}: install the petty that goes with it, then sign in again. To get it, ${await matchingPetty(io, ask.origin)}`);
  if (started.status === 201 && /^[A-Z]{4}-[A-Z]{4}-[A-Z]{4}$/.test(String(started.json["user_code"]))) throw new CliError(1, `${ask.origin} runs an older Petty than this command line (v${pkg.version}): its sign-in code has the earlier, shorter form, which this petty does not use. Update that Petty, or install the petty that goes with it (to get it, ${await matchingPetty(io, ask.origin)}), or make a token in Settings → Access tokens and use petty auth login --with-token`);
  if (started.status === 429) throw new CliError(1, "too many sign-ins from this address: wait a while and try again");
  if (started.status !== 201) throw new CliError(1, `${ask.origin} did not start a sign-in (${said(started)}). An older Petty has no browser sign-in: make a token in Settings → Access tokens and use petty auth login --with-token`);
  const code = DeviceCodeResponse.parse(started.json);
  // the code is derived from our key; one that is not was made for another key
  if (code.user_code !== userCode) throw new CliError(1, "the server answered with a code that is not this request's: stopped");

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
    throw new CliError(1, `unexpected answer from ${ask.origin} (${said(r)})`);
  }
  throw new CliError(3, "the code expired before it was allowed: run petty auth login again");
}

/** Opens the token's key bundle once, to check it works and to learn its name and role. */
export async function checkToken(io: Io, origin: string, token: string): Promise<AgentClient> {
  try { splitPatToken(token); } catch { throw new CliError(3, "that is not a Petty access token (petty_pat_…)"); }
  // PETTY-445: what a load could not open or check is said on stderr, whatever the command, once per run
  const said = new Set<string>();
  return connect({
    token, apiUrl: apiOf(origin), fetch: io.fetch,
    onWarnings: (list) => {
      for (const text of list.map((w) => warningText(w))) {
        if (!said.has(text)) io.err(`petty: warning: ${text}\n`);
        said.add(text);
      }
    },
  });
}
