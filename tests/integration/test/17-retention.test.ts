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

  // PETTY-349: a deleted account's row and public keys went never; now once no record someone else keeps needs them
  it("a deleted account that nothing needs goes; one whose entry another person keeps stays, and still verifies", async () => {
    const [own, gone, wrote] = [await newUser("ret-own"), await newUser("ret-gone"), await newUser("ret-wrote")];
    const { id: drawer, res } = await own.createDrawer("Pantry");
    expect(res.statusCode).toBe(201);
    const key = await own.unwrap((await own.call("GET", "/bootstrap")).json().wraps.find((w: { drawer_id: string }) => w.drawer_id === drawer), own.user.pub.ecdh, true);
    const inv = await own.call("POST", `/drawers/${drawer}/invitations`, { invitee_id: wrote.id, role: "write", wrap: await own.wrapFor(key, wrote.user.pub.ecdh, drawer, 1) });
    expect(inv.statusCode).toBe(201);
    expect((await wrote.call("POST", `/invitations/${inv.json().id}/accept`)).statusCode).toBe(204);
    expect((await wrote.postEntry(drawer, key, crypto.randomUUID(), "add", 250)).res.statusCode).toBe(201);
    for (const c of [gone, wrote]) expect((await c.call("POST", "/me/delete", { password: c.user.password, proof: await c.proof(), decisions: [] })).statusCode).toBe(204);
    expect((await own.call("GET", `/users/${gone.id}/keys`)).statusCode).toBe(200); // a tombstone, until the next run

    // what each maintenance run calls, as the request role, on the production image's migrations
    expect(Number(sql("select purge_tombstones()"))).toBeGreaterThanOrEqual(1);
    expect((await own.call("GET", `/users/${gone.id}/keys`)).statusCode).toBe(404);
    expect(sql(`select count(*) from users where id = '${gone.id}'`)).toBe("0");
    const kept = await own.call("GET", `/users/${wrote.id}/keys`);
    expect(kept.statusCode).toBe(200);
    expect(kept.json()).toMatchObject({ display_name: "Deleted user", deleted: true });
    expect(kept.json().keys.map((k: { ecdsa_pub: string }) => k.ecdsa_pub)).toEqual([wrote.user.pub.ecdsa]); // so the entry still verifies
  });

  // PETTY-488: and old drawer history, which before went only with the drawer's next write
  it("the maintenance run at start also clears dead tokens' data, old drawer history and unneeded deleted accounts, as the request role, without an error (PETTY-410)", () => {
    const lines = compose("logs --no-color --no-log-prefix app").split("\n").filter((l) => l.includes('"msg":"maintenance'));
    expect(lines.filter((l) => l.includes('"msg":"maintenance failed"'))).toEqual([]);
    const runs = lines.map((l) => JSON.parse(l.slice(l.indexOf("{"))) as { msg: string; tokens?: unknown; document_history?: unknown; tombstones?: unknown }).filter((l) => l.msg === "maintenance");
    expect(runs.length).toBeGreaterThan(0);
    for (const r of runs) {
      expect(typeof r.tokens).toBe("number");
      expect(typeof r.document_history).toBe("number");
      expect(typeof r.tombstones).toBe("number");
    }
  });
});
