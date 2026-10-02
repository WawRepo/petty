import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client, userMaterial } from "../../apps/api/src/devtools/fixtures.js";

/**
 * Shared bits of the integration suite: the running compose stack, reached over real HTTP.
 * The API test helpers (Client) drive it unchanged: this adapter stands in for Fastify's inject.
 */
export const ORIGIN = process.env["PETTY_IT_ORIGIN"] ?? "http://127.0.0.1:3400";
export const API = `${ORIGIN}/api`;

export const http = {
  async inject(o: { method: string; url: string; cookies?: Record<string, string>; headers?: Record<string, string>; payload?: string }) {
    // The image runs with secure cookies, named __Host-petty_session; the helper knows the plain name.
    const cookie = Object.entries(o.cookies ?? {}).flatMap(([k, v]) => (k === "petty_session" ? [`__Host-${k}=${v}`, `${k}=${v}`] : [`${k}=${v}`])).join("; ");
    const r = await fetch(API + o.url, { method: o.method, headers: { ...(o.headers ?? {}), ...(cookie ? { cookie } : {}) }, ...(o.payload === undefined ? {} : { body: o.payload }) });
    const body = await r.text();
    const headers: Record<string, string | string[]> = {};
    r.headers.forEach((v, k) => { headers[k] = v; });
    const set = r.headers.getSetCookie();
    if (set.length) headers["set-cookie"] = set;
    return { statusCode: r.status, headers, body, json: () => JSON.parse(body) };
  },
} as unknown as ConstructorParameters<typeof Client>[0];

/** Runs `docker compose <args>` against the test stack and returns stdout. */
export function compose(args: string): string {
  const dc = process.env["PETTY_IT_COMPOSE"];
  if (!dc) throw new Error("run through tests/integration/run.sh (PETTY_IT_COMPOSE is not set)");
  return execSync(`${dc} ${args}`, { cwd: import.meta.dirname, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PETTY_IMAGE: process.env["PETTY_IMAGE"] ?? "unused" } });
}

/** A value from test.env (test-only passwords). */
export function testEnv(key: string): string {
  const line = readFileSync(join(import.meta.dirname, "test.env"), "utf8").split("\n").find((l) => l.startsWith(`${key}=`));
  if (!line) throw new Error(`${key} missing in test.env`);
  return line.slice(key.length + 1);
}

const run = crypto.randomUUID().slice(0, 8);

/** A new person. The first join link comes from the operator script, as for a real first account. */
export async function newUser(name: string, joinToken?: string): Promise<Client> {
  const token = joinToken ?? /\/join\/([A-Za-z0-9_-]+)/.exec(compose("exec -T app pnpm --silent join-link"))![1]!;
  const c = new Client(http, await userMaterial(`${name}-${run}`, { email: `${name}-${run}@petty.test` }));
  const res = await c.signup(token);
  if (res.statusCode !== 201) throw new Error(`signup ${name}: ${res.statusCode} ${res.body}`);
  return c;
}

/** What the seed step leaves for the upgrade check: enough to log in and open one drawer. */
export interface SeedState {
  email: string;
  password: string;
  drawerId: string;
  drawerName: string;
  lineId: string;
  drawerKey: string; // base64 raw AES key, test data only
  balance: number;
  entries: number;
}
const statePath = () => process.env["PETTY_IT_STATE"] ?? join(import.meta.dirname, ".state.json");
export const readState = (): SeedState | null => (existsSync(statePath()) ? (JSON.parse(readFileSync(statePath(), "utf8")) as SeedState) : null);
export const writeState = (s: SeedState): void => writeFileSync(statePath(), JSON.stringify(s));
