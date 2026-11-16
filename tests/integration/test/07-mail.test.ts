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
/** The text of every mail to `email` with this subject. */
async function textsTo(email: string, subject: RegExp): Promise<string[]> {
  const list = (await (await fetch(`${MAILPIT}/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json()) as { messages: { ID: string; Subject: string }[] };
  return Promise.all(list.messages.filter((x) => subject.test(x.Subject)).map(async (m) => ((await (await fetch(`${MAILPIT}/message/${m.ID}`)).json()) as { Text: string }).Text));
}
/**
 * PETTY-503: "and no second mail" used to wait one fixed second, which proves little when the stack is busy.
 * Instead a later mail to the same address (one that says `marker`) must arrive first: a mail the server
 * had sent before it has had at least as long to reach the catcher.
 */
async function afterLaterMail(email: string, subject: RegExp, marker: string): Promise<string[]> {
  for (let i = 0; i < 50; i++) {
    const texts = await textsTo(email, subject);
    if (texts.some((t) => t.includes(marker))) return texts;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no mail saying ${JSON.stringify(marker)} to ${email}`);
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
    // a later invitation to another drawer (as a writer) is mailed; once it is in, still one mail for the first
    const other = await ann.createDrawer("Attic");
    const otherKey = await ann.unwrap((await ann.call("GET", "/bootstrap")).json().wraps.find((w: { drawer_id: string }) => w.drawer_id === other.id), ann.user.pub.ecdh, true);
    const later = await ann.call("POST", `/drawers/${other.id}/invitations`, { invitee_id: ben.id, role: "write", wrap: await ann.wrapFor(otherKey, ben.user.pub.ecdh, other.id, 1) });
    expect(later.json().mailed).toBe(true);
    const shared = await afterLaterMail(ben.user.email, /^A drawer was shared with you$/, "as a writer");
    expect(shared.filter((t) => t.includes("as a reader"))).toHaveLength(1);
    expect((await ann.call("PATCH", "/me", { display_name: "Ann, see https://example.test" })).statusCode).toBe(400);
  });

  it("a join-link email goes to one address once a day per sender: sending again is refused and mails nothing (PETTY-423)", async () => {
    const cleo = await newUser("joiner");
    const friend = `friend-${crypto.randomUUID().slice(0, 8)}@petty.test`;
    expect((await cleo.call("POST", "/join-links", { email: friend })).statusCode).toBe(201);
    expect(await mailTo(friend, /^You are invited to Petty$/)).toMatch(/\/join#[A-Za-z0-9_-]+/);
    const again = await cleo.call("POST", "/join-links", { email: friend.toUpperCase() });
    expect(again.statusCode).toBe(429);
    expect(again.json().code).toBe("TooManyAttempts");
    // someone else's join link to the same address is mailed; once it is in, still one mail from cleo
    const dana = await newUser("other-joiner");
    expect((await dana.call("POST", "/join-links", { email: friend })).statusCode).toBe(201);
    const invited = await afterLaterMail(friend, /^You are invited to Petty$/, `${dana.user.display_name} invited you`);
    expect(invited.filter((t) => t.startsWith(`${cleo.user.display_name} invited you`))).toHaveLength(1);
    expect((await cleo.call("POST", "/join-links", {})).statusCode).toBe(201); // a link with no address is not held back
  });
});
