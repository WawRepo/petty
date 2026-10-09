import { describe, expect, it } from "vitest";
import { API, ORIGIN, compose, newUser, testEnv } from "../lib.js";

/** PETTY-342 on the production image: the operator's texts come from a mounted LEGAL_DIR. */
describe("operator legal texts", () => {
  it("/config names them, and each is served in the asked language or the nearest there is", async () => {
    expect((await (await fetch(`${API}/config`)).json()).legal).toEqual({ privacy: true, terms: true });
    expect(await (await fetch(`${API}/legal/privacy?lang=pl`)).json()).toMatchObject({ doc: "privacy", lang: "en", text: expect.stringContaining("Example Operator") });
    expect(await (await fetch(`${API}/legal/terms?lang=en`)).json()).toMatchObject({ doc: "terms", lang: "pl", text: expect.stringContaining("Regulamin") });
    expect((await fetch(`${API}/legal/cookies`)).status).toBe(400);
  });

  it("PETTY-216: a sign-up records the terms version it accepted", async () => {
    const u = await newUser("terms");
    const sql = `select coalesce(terms_version, 'none') || ' ' || (terms_accepted_at is not null) from users where id = '${u.id}'`;
    const out = compose(`exec -T db psql "postgres://petty_api:${testEnv("API_DB_PASSWORD")}@localhost:5432/petty" -At -c "${sql}"`).trim();
    expect(out).toMatch(/^sha256:[0-9a-f]{16} true$/);
  });

  it("/terms is a page of the web app", async () => {
    const res = await fetch(`${ORIGIN}/terms`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });
});
