import { describe, expect, it } from "vitest";
import { API, newUser } from "../lib.js";

/** The stack's mail catcher (compose.test.yml). */
const MAILPIT = "http://127.0.0.1:8425/api/v1";
async function mailTo(email: string, subject: RegExp): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const list = (await (await fetch(`${MAILPIT}/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json()) as { messages: { ID: string; Subject: string }[] };
    const m = list.messages.find((x) => subject.test(x.Subject));
    if (m) return ((await (await fetch(`${MAILPIT}/message/${m.ID}`)).json()) as { Text: string }).Text;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no mail matching ${String(subject)} to ${email}`);
}
async function countTo(email: string, subject: RegExp): Promise<number> {
  const list = (await (await fetch(`${MAILPIT}/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json()) as { messages: { Subject: string }[] };
  return list.messages.filter((x) => subject.test(x.Subject)).length;
}
const post = (path: string, body: unknown) => fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("mail (PETTY-281)", () => {
  it("a password changed through a reset link: the mail says how to take it back and names the contact", async () => {
    const ann = await newUser("mail");
    expect((await post("/auth/forgot", { email: ann.user.email })).status).toBe(204);
    const reset = await mailTo(ann.user.email, /^Reset your Petty login password$/);
    expect(reset).toContain("the link works once, for 1 hour");
    const token = /\/reset#([A-Za-z0-9_-]+)/.exec(reset)?.[1];
    expect(token, "the reset mail carries its link").toBeTruthy();
    expect((await post("/auth/reset", { token, password: "a new login password 2026" })).status).toBe(204);
    const changed = await mailTo(ann.user.email, /^Your Petty login password was changed$/);
    // it used to say "sign in and change it, or write to us": the old password no longer works, and "us" had no address
    expect(changed).toContain("reset it again now with “Forgot your password?” on the sign-in page");
    expect(changed).toContain("Write to ops@petty.test.");
    expect(changed).not.toContain("write to us");
  });

  it("a drawer invitation emails once a day per drawer: inviting again says so and sends nothing; a name with a link is refused (PETTY-407)", async () => {
    const [ann, ben] = [await newUser("inviter"), await newUser("invitee")];
    const { id, res } = await ann.createDrawer("Shed");
    expect(res.statusCode).toBe(201);
    const key = await ann.unwrap((await ann.call("GET", "/bootstrap")).json().wraps.find((w: { drawer_id: string }) => w.drawer_id === id), ann.user.pub.ecdh, true);
    const invite = async () => ann.call("POST", `/drawers/${id}/invitations`, { invitee_id: ben.id, role: "read", wrap: await ann.wrapFor(key, ben.user.pub.ecdh, id, 1) });
    const first = await invite();
    expect(first.statusCode).toBe(201);
    expect(first.json().mailed).toBe(true);
    expect(await mailTo(ben.user.email, /^A drawer was shared with you$/)).toContain("invited you to a drawer in Petty as a reader");
    expect((await ann.call("DELETE", `/invitations/${first.json().id}`)).statusCode).toBe(204);
    const again = await invite();
    expect(again.statusCode).toBe(201);
    expect(again.json().mailed).toBe(false);
    await new Promise((r) => setTimeout(r, 1_000)); // a second mail would have reached the catcher by now
    expect(await countTo(ben.user.email, /^A drawer was shared with you$/)).toBe(1);
    expect((await ann.call("PATCH", "/me", { display_name: "Ann, see https://example.test" })).statusCode).toBe(400);
  });
});
