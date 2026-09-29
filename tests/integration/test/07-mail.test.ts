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
});
