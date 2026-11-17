import { describe, expect, it } from "vitest";
import { Client, userMaterial } from "../../../apps/api/src/devtools/fixtures.js";
import { API, compose, http, newUser, testEnv } from "../lib.js";

/**
 * PETTY-359: the image with EMAIL_KEY seals every stored email address, the ones written before the key
 * too, and still signs people in, finds them by address and mails them. An instance without the key
 * refuses to start; EMAIL_KEY_OLD alone writes every address back in plain. Both app instances are
 * started again for this, so it runs after every other file but 21-stop, and puts them back as they were.
 */
const MAILPIT = "http://127.0.0.1:8425/api/v1";
const KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"); // this run only
const NONE = { EMAIL_KEY: "", EMAIL_KEY_OLD: "" };
const sql = (q: string) => compose(`exec -T db psql "postgres://petty_api:${testEnv("API_DB_PASSWORD")}@localhost:5432/petty" -v ON_ERROR_STOP=1 -At -c "${q}"`).trim();
/** How often an address of this suite (they all end in @petty.test) is in a full dump of the database. */
const inDump = () => Number(compose(`exec -T db sh -c 'pg_dump "postgres://petty:${testEnv("OWNER_DB_PASSWORD")}@localhost:5432/petty" | grep -c -i "@petty.test" || true'`).trim());
const post = (path: string, body: unknown) => fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}
const sealed = () => sql("select (select count(*) from users where email_sealed is not null) + (select count(*) from join_links where email_sealed is not null)");
/** The way back: only the old key, and the housekeeping run at start writes every address in plain again. */
async function plainAgain() {
  compose("up -d --wait --no-deps app app2", { EMAIL_KEY: "", EMAIL_KEY_OLD: KEY });
  await until("every address plain", () => sealed() === "0");
}
async function mailTo(email: string, subject: RegExp): Promise<string> {
  let text: string | undefined;
  await until(`a mail to ${email}`, async () => {
    const list = (await (await fetch(`${MAILPIT}/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json()) as { messages: { ID: string; Subject: string }[] };
    const m = list.messages.find((x) => subject.test(x.Subject));
    if (m) text = ((await (await fetch(`${MAILPIT}/message/${m.ID}`)).json()) as { Text: string }).Text;
    return text !== undefined;
  }, 10_000);
  return text!;
}
const login = (c: Client, email = c.user.email) => c.call("POST", "/auth/login", { email, password: c.user.password });

describe("email addresses sealed at rest (PETTY-359)", () => {
  it("with EMAIL_KEY the database holds no address, and sign-in, lookup, mail and join links still work; without it the app does not start; EMAIL_KEY_OLD alone undoes it", async () => {
    // written before the key, in plain
    const [ann, ben] = [await newUser("seal-ann"), await newUser("seal-ben")];
    const friend = `seal-friend-${crypto.randomUUID().slice(0, 8)}@petty.test`;
    const link = await ann.call("POST", "/join-links", { email: friend });
    expect(link.statusCode).toBe(201);
    expect(sql(`select count(*) from users where id = '${ann.id}' and email is not null`)).toBe("1");
    expect(inDump()).toBeGreaterThan(0);

    try {
      compose("up -d --wait --no-deps app app2", { EMAIL_KEY: KEY, EMAIL_KEY_OLD: "" });
      // the housekeeping run at start seals what was there
      await until("every address sealed", () => sql("select (select count(*) from users where email is not null) + (select count(*) from join_links where email is not null)") === "0");
      expect(inDump(), "an address in the database").toBe(0);
      expect(sql("select count(*) from users where email_sealed is null or email_index is null")).toBe("0");

      // sign-in in any case, lookup, a second account for the same address refused
      expect((await login(ann, ann.user.email.toUpperCase())).statusCode).toBe(200);
      expect((await login(ben)).statusCode).toBe(200);
      const found = await ben.call("POST", "/users/lookup", { email: ann.user.email.toUpperCase() });
      expect(found.statusCode).toBe(200);
      expect(found.json().id).toBe(ann.id);
      expect((await ann.call("GET", "/me")).json().email).toBe(ann.user.email);
      const twin = new Client(http, await userMaterial("seal-twin", { email: ann.user.email.toUpperCase() }));
      expect((await twin.call("POST", "/auth/signup", twin.user.signupBody)).json().code).toBe("EmailTaken");

      // mail goes to the opened address: a reset, and a drawer invitation
      expect((await post("/auth/forgot", { email: ben.user.email })).status).toBe(204);
      expect(await mailTo(ben.user.email, /^Reset your Petty login password$/)).toContain("/reset#");
      const { id: drawer } = await ann.createDrawer("Sealed shed");
      const key = await ann.unwrap((await ann.call("GET", "/bootstrap")).json().wraps.find((w: { drawer_id: string }) => w.drawer_id === drawer), ann.user.pub.ecdh, true);
      const inv = await ann.call("POST", `/drawers/${drawer}/invitations`, { invitee_id: ben.id, role: "read", wrap: await ann.wrapFor(key, ben.user.pub.ecdh, drawer, 1) });
      expect(inv.json().mailed).toBe(true);
      await mailTo(ben.user.email, /^A drawer was shared with you$/);

      // the join link from before the key: its address was sealed, it still shows and still binds
      const token = link.json().token as string;
      expect((await post("/join-links/lookup", { token }).then((r) => r.json())).email).toBe(friend);
      const other = new Client(http, await userMaterial("seal-other", { email: `seal-other-${crypto.randomUUID().slice(0, 8)}@petty.test` }));
      expect((await other.signup(token)).json().code).toBe("JoinLinkEmailMismatch");
      const joined = new Client(http, await userMaterial("seal-friend", { email: friend }));
      expect((await joined.signup(token)).statusCode).toBe(201);
      expect(sql(`select count(*) from users where id = '${joined.id}' and email is null`)).toBe("1"); // sealed at once
      expect(inDump(), "an address in the database").toBe(0);

      // an instance without the key refuses to start, and says why
      compose("up -d --no-deps app2", NONE);
      await until("the refusal in the log", () => compose("logs --no-color --no-log-prefix app2").includes('"msg":"email key check failed"'));
      const log = compose("logs --no-color --no-log-prefix app2");
      expect(log).toContain("Set EMAIL_KEY, or EMAIL_KEY_OLD");
      expect(log).not.toContain("@petty.test");
      expect(log).not.toContain(KEY);
      expect(await fetch("http://127.0.0.1:3402/api/health/live").then((r) => r.status, () => 0)).not.toBe(200);

      await plainAgain();
      expect(sql(`select email from users where id = '${ann.id}'`)).toBe(ann.user.email);
      expect(inDump()).toBeGreaterThan(0);
    } finally {
      if (sealed() !== "0") await plainAgain(); // a failed step must not leave the next file a stack that cannot start
      compose("up -d --wait --no-deps app app2", NONE); // as the other files found them
    }
    expect((await login(ann)).statusCode).toBe(200);
    expect((await fetch("http://127.0.0.1:3402/api/health/live")).status).toBe(200);
  }, 300_000);
});
