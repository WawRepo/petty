/**
 * What a per-address limit counts under (PETTY-458). An IPv6 client is counted by its /64 network: one
 * home or phone connection holds a whole /64 and can use any address in it. IPv4 counts per address, as
 * before, also when it is written as IPv6 (::ffff:a.b.c.d).
 */
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { deviceKeyPair, deviceUserCode } from "@petty/crypto";

// Small limits and open sign-up, so one request per route shows the key and a handful shows a limit.
process.env["LOGIN_LIMIT_PER_IP"] = "3";
process.env["OPEN_SIGNUP"] = "true";
process.env["RATE_LIMIT_PER_MINUTE"] = "1000";

/** Test hook: every key the limiter was asked to count. */
const counted: string[] = [];
vi.mock("../src/lib/password.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/lib/password.js")>();
  return { ...orig, checkRate: async (key: string, max: number, windowMs?: number) => { counted.push(key); return orig.checkRate(key, max, windowMs); } };
});

const { buildApp } = await import("../src/app.js");
const { apiPool, maintPool } = await import("../src/db.js");
const { Client, makeJoinLink, userMaterial } = await import("../src/devtools/fixtures.js");
const { clientIp, clientNet, networkOf } = await import("../src/lib/client-ip.js");

const app = buildApp();
const run = crypto.randomUUID().slice(0, 8);
beforeAll(async () => { await app.ready(); }, 60_000);
afterAll(async () => { await app.close(); await apiPool.end(); await maintPool.end(); });

// The counts live in the database and outlive this process: a fresh network per test.
const hex = () => (1 + Math.floor(Math.random() * 0xfffe)).toString(16);
const freshNet6 = () => `2001:db8:${hex()}:${hex()}`;
const freshV4 = () => `198.51.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
const json = { "content-type": "application/json" };
// a sign-in request as the command line sends it: its key, and the code that goes with the key and the address (PETTY-451)
const deviceAsk = async () => {
  const key = await deviceKeyPair();
  return JSON.stringify({ cli_pub: key.publicB64, user_code: await deviceUserCode(key.publicB64, "https://petty.test"), client_name: "petty on net-test", role: "read", expires_days: 30 });
};

describe("networkOf: the key of an address", () => {
  it("an IPv4 address counts as it is", () => {
    for (const a of ["203.0.113.7", "10.0.0.1", "127.0.0.1"]) expect(networkOf(a)).toBe(a);
  });

  it("an IPv6 address counts as its /64, however it is written", () => {
    for (const a of ["2001:db8:1:2:3:4:5:6", "2001:db8:1:2::1", "2001:db8:1:2::", "2001:DB8:0001:0002:ffff:ffff:ffff:ffff", "2001:db8:1:2:0:0:0:9", "2001:db8:1:2::9%en0"]) expect(networkOf(a), a).toBe("2001:db8:1:2::/64");
    expect(networkOf("2001:db8::7")).toBe("2001:db8:0:0::/64");
    expect(networkOf("2001:db8:0:1::7")).toBe("2001:db8:0:1::/64");
    expect(networkOf("2001:db8:1:3::1")).not.toBe(networkOf("2001:db8:1:2::1"));
    expect(networkOf("::1")).toBe("0:0:0:0::/64");
    expect(networkOf("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(networkOf("64:ff9b::203.0.113.7")).toBe("64:ff9b:0:0::/64");
  });

  it("an IPv4 address written as IPv6 counts as that IPv4 address, not as one shared /64", () => {
    for (const a of ["::ffff:203.0.113.7", "::FFFF:203.0.113.7", "::ffff:cb00:7107", "0:0:0:0:0:ffff:cb00:7107", "0000:0000:0000:0000:0000:ffff:203.0.113.7"]) expect(networkOf(a), a).toBe("203.0.113.7");
    expect(networkOf("::ffff:203.0.113.8")).toBe("203.0.113.8");
  });

  it("what is not an address stays as it is", () => {
    for (const a of ["", "unknown", "not-an-address", "2001:db8::1::2", "1.2.3", "[2001:db8::1]"]) expect(networkOf(a), a).toBe(a);
  });

  it("clientNet reads the same address as clientIp; the device-login record keeps the whole address", async () => {
    const probe = Fastify({ trustProxy: false });
    probe.get("/ip", async (req) => ({ ip: clientIp(req, "x-client"), net: clientNet(req, "x-client") }));
    const seen = async (remoteAddress: string, header?: string) => (await probe.inject({ method: "GET", url: "/ip", remoteAddress, headers: header ? { "x-client": header } : {} })).json();
    expect(await seen("172.19.0.2", "2001:db8:1:2::9")).toEqual({ ip: "2001:db8:1:2::9", net: "2001:db8:1:2::/64" });
    expect(await seen("172.19.0.2", "203.0.113.7, 10.0.0.1")).toEqual({ ip: "203.0.113.7", net: "203.0.113.7" });
    expect(await seen("::ffff:172.19.0.2")).toEqual({ ip: "::ffff:172.19.0.2", net: "172.19.0.2" });
    expect(await seen("2001:db8:a:b:c:d:e:f")).toEqual({ ip: "2001:db8:a:b:c:d:e:f", net: "2001:db8:a:b::/64" });
    await probe.close();
  });
});

describe("every per-address limit counts an IPv6 client by its /64 (PETTY-458)", () => {
  it("sign-in, password reset, sign-up, device codes, device polls, the email lookup and the general limit", async () => {
    const net = freshNet6();
    const from = (n: number) => `${net}:${hex()}:${hex()}:${hex()}:${n}`;
    const U = new Client(app, await userMaterial("net-u", { email: `net-u-${run}@test.local` }));
    expect((await U.signup(await makeJoinLink())).statusCode).toBe(201);
    counted.length = 0;
    const fresh = await userMaterial("net-open", { email: `net-open-${run}@test.local` });
    const sent = [
      await app.inject({ method: "POST", url: "/auth/login", remoteAddress: from(1), headers: json, payload: JSON.stringify({ email: `nobody-${run}@test.local`, password: "wrong-password" }) }),
      await app.inject({ method: "POST", url: "/auth/forgot", remoteAddress: from(2), headers: json, payload: JSON.stringify({ email: `nobody-${run}@test.local` }) }),
      await app.inject({ method: "POST", url: "/auth/signup", remoteAddress: from(3), headers: json, payload: JSON.stringify(fresh.signupBody) }),
      await app.inject({ method: "POST", url: "/device/code", remoteAddress: from(4), headers: json, payload: await deviceAsk() }),
      await app.inject({ method: "POST", url: "/device/token", remoteAddress: from(5), headers: json, payload: JSON.stringify({ device_code: "x".repeat(43) }) }),
      await app.inject({ method: "POST", url: "/users/lookup", remoteAddress: from(6), cookies: { petty_session: U.cookie! }, headers: json, payload: JSON.stringify({ email: U.user.email }) }),
    ];
    expect(sent.map((r) => r.statusCode)).toEqual([401, 204, 201, 201, 400, 200]);
    const perAddress = counted.filter((k) => !k.startsWith("lookup:") && !k.startsWith("forgot:nobody") && !k.startsWith("joinlinks:"));
    expect([...new Set(perAddress)].sort()).toEqual(["api", "device-code", "device-poll", "forgot", "login", "lookup-ip", "signup"].map((name) => `${name}:${net}::/64`).sort());
    expect(counted.join("\n")).not.toMatch(new RegExp(`${net}:[0-9a-f]`)); // no key holds a whole address
  }, 60_000);

  it("a limit holds across the addresses of one /64, and another /64 has its own", async () => {
    const net = freshNet6();
    const ask = async (remoteAddress: string) => (await app.inject({ method: "POST", url: "/device/code", remoteAddress, headers: json, payload: await deviceAsk() })).statusCode;
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push(await ask(`${net}:${hex()}:${hex()}:${hex()}:${hex()}`)); // 10 device codes an hour
    expect(codes).toEqual([...Array<number>(10).fill(201), 429]);
    expect(await ask(`${freshNet6()}::1`)).toBe(201);
  }, 60_000);

  it("the sign-in limit too: a new address of the same /64 does not start a new count", async () => {
    const net = freshNet6();
    const login = async (remoteAddress: string) => (await app.inject({ method: "POST", url: "/auth/login", remoteAddress, headers: json, payload: JSON.stringify({ email: `nobody-${crypto.randomUUID()}@test.local`, password: "wrong-password" }) })).statusCode;
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push(await login(`${net}::${i + 1}`)); // LOGIN_LIMIT_PER_IP is 3 here
    expect(codes).toEqual([401, 401, 401, 429]);
    expect(await login(`${freshNet6()}::1`)).toBe(401);
  }, 60_000);

  it("IPv4 stays per address, and its IPv6 spelling shares the count with the plain one", async () => {
    const a = freshV4();
    const [p, q, r, s] = a.split(".").map(Number) as [number, number, number, number];
    const neighbour = `${p}.${q}.${r}.${s === 250 ? 1 : s + 1}`;
    const login = async (remoteAddress: string) => (await app.inject({ method: "POST", url: "/auth/login", remoteAddress, headers: json, payload: JSON.stringify({ email: `nobody-${crypto.randomUUID()}@test.local`, password: "wrong-password" }) })).statusCode;
    expect([await login(a), await login(`::ffff:${a}`), await login(`::ffff:${((p << 8) | q).toString(16)}:${((r << 8) | s).toString(16)}`), await login(a)]).toEqual([401, 401, 401, 429]);
    expect(await login(`::ffff:${a}`)).toBe(429);
    // the next IPv4 address is another client, in either spelling
    expect(await login(`::ffff:${neighbour}`)).toBe(401);
    expect(await login(neighbour)).toBe(401);
  }, 60_000);
});
