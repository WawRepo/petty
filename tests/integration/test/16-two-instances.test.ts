import { describe, expect, it } from "vitest";
import { patSecret, sealPatBundle, toB64 } from "@petty/crypto";
import { API, newUser } from "../lib.js";

/**
 * PETTY-334: the public instance runs two machines behind one address, so the two requests of a
 * custody-guarded action — the challenge, then the request carrying its signed proof — can reach
 * different ones. The challenge lived in one process's memory and every such action (a token, a
 * passphrase change, a delete) failed with 403 about half the time. Now it is in the database: here the
 * second instance of the same image, on the same database, takes a proof the first one asked for, once.
 * The sign-in limits count there too: wrong passwords sent to both instances add up to one lockout.
 */
const SECOND = "http://127.0.0.1:3402/api";

async function onSecond(path: string, cookie: string, body: unknown) {
  const res = await fetch(SECOND + path, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `__Host-petty_session=${cookie}; petty_session=${cookie}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { code?: string } };
}

describe("two instances, one database (PETTY-334)", () => {
  it("a custody challenge from one instance is accepted by the other, and only once", async () => {
    const ann = await newUser("twin");
    const token = async (proof: unknown) => {
      const id = toB64(crypto.getRandomValues(new Uint8Array(24))).replace(/[+/=]/g, "_");
      return { token_id: id, name: "across instances", role: "read", scope: null, expires_at: null, bundle: await sealPatBundle(patSecret(), id, { v: 1, user_id: ann.id, drawers: [] }), proof };
    };
    const proof = await ann.proof(); // asked of the first instance
    const made = await onSecond("/me/tokens", ann.cookie!, await token(proof));
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    // used up for both: the same proof again is refused by the second and by the first
    expect((await onSecond("/me/tokens", ann.cookie!, await token(proof))).json.code).toBe("CustodyProofRequired");
    expect((await ann.call("POST", "/me/tokens", await token(proof))).json().code).toBe("CustodyProofRequired");
  });

  it("wrong passwords sent to both instances add up to one lockout", async () => {
    const bea = await newUser("twinlock");
    const login = (base: string, password: string) =>
      fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: bea.user.email, password }) }).then((r) => r.status);
    const bases = [API, SECOND];
    const codes = [];
    for (let i = 0; i < 10; i++) codes.push(await login(bases[i % 2]!, "not the password")); // LOGIN_LIMIT_PER_EMAIL: 10
    expect(codes.every((c) => c === 401), codes.join(",")).toBe(true);
    // the eleventh, on either instance — even with the right password — waits out the window
    expect(await login(bases[0]!, bea.user.password)).toBe(429);
    expect(await login(bases[1]!, bea.user.password)).toBe(429);
  });
});
