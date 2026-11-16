import { describe, expect, it } from "vitest";
import { Client, userMaterial } from "../../../apps/api/src/devtools/fixtures.js";
import { compose, http, newUser, testEnv } from "../lib.js";

/** PETTY-341 (GDPR, storage limitation), on the production image and its migrations. */
describe("personal data is not kept longer than needed", () => {
  const sql = (q: string) => compose(`exec -T db psql "postgres://petty_api:${testEnv("API_DB_PASSWORD")}@localhost:5432/petty" -v ON_ERROR_STOP=1 -At -c "${q}"`).trim();

  it("a join link forgets the invitee's email once used, and the request role may clear dead reset tokens", async () => {
    const ann = await newUser("ret-ann");
    const email = `ret-friend-${crypto.randomUUID().slice(0, 8)}@petty.test`;
    const link = await ann.call("POST", "/join-links", { email });
    expect(link.statusCode).toBe(201);
    expect(sql(`select count(*) from join_links where email = '${email}'`)).toBe("1");
    const friend = new Client(http, await userMaterial("ret-friend", { email }));
    expect((await friend.signup(link.json().token)).statusCode).toBe(201);
    expect(sql(`select coalesce(email, 'none') from join_links where used_by = '${friend.id}'`)).toBe("none");
    // maintenance runs as the request role: migration 015 gave it DELETE on password_resets
    expect(sql("delete from password_resets where expires_at < now() - interval '100 years'")).toBe("DELETE 0");
  });

  // PETTY-488: and old drawer history, which before went only with the drawer's next write
  it("the maintenance run at start also clears dead tokens' data and old drawer history, as the request role, without an error (PETTY-410)", () => {
    const lines = compose("logs --no-color --no-log-prefix app").split("\n").filter((l) => l.includes('"msg":"maintenance'));
    expect(lines.filter((l) => l.includes('"msg":"maintenance failed"'))).toEqual([]);
    const runs = lines.map((l) => JSON.parse(l.slice(l.indexOf("{"))) as { msg: string; tokens?: unknown; document_history?: unknown }).filter((l) => l.msg === "maintenance");
    expect(runs.length).toBeGreaterThan(0);
    for (const r of runs) {
      expect(typeof r.tokens).toBe("number");
      expect(typeof r.document_history).toBe("number");
    }
  });
});
