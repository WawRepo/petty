import type { Page } from "@playwright/test";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { openPatBundle, splitPatToken } from "@petty/crypto";
import { expect, loginAndUnlock, openSettings, signupViaApi, test } from "./fixtures.js";

/**
 * Access tokens (PETTY-164): made in Settings, used by a tool outside the browser. The tool sends
 * only the id half; the secret half opens the bundle here, in this Node process, never on the server.
 */
const API = process.env["API_URL"] ?? `http://127.0.0.1:${process.env["API_PORT"] ?? "3000"}`;
const OWNER_DB = process.env["DATABASE_URL"] ?? "postgres://petty:petty@localhost:5432/petty";
async function sql<T extends pg.QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: OWNER_DB });
  await c.connect();
  try { return (await c.query<T>(text, values)).rows; } finally { await c.end(); }
}

async function addDrawerWithLine(page: Page, name: string): Promise<string> {
  await page.getByRole("button", { name: "Add drawer" }).click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  const id = /\/drawers\/([0-9a-f-]+)/.exec(page.url())![1]!;
  await page.getByRole("button", { name: "Add item" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Cash");
  await page.getByLabel("Currency", { exact: true }).fill("PLN");
  await page.getByLabel("Starting balance").fill("10");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByTestId("line-name").filter({ hasText: "Cash" })).toBeVisible();
  // PETTY-321: the item shows as soon as the document is saved, but its starting balance is a second write
  // (the entry). The sheet closes only after that one, and the row then shows the amount. Leaving earlier
  // (the next page.goto) could cancel the entry under load: the token's +5 then stood alone as "5.00".
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("line-row").filter({ hasText: "Cash" })).toContainText("10");
  return id;
}

test("access tokens (PETTY-164): a token made in Settings opens its bundle outside the browser, reads its drawer, and stops when revoked", async ({ page, request }) => {
  const user = await signupViaApi("pat");
  await loginAndUnlock(page, user);
  await page.getByTestId("passkey-nudge").getByRole("button", { name: "Not now" }).click().catch(() => undefined);
  const drawerId = await addDrawerWithLine(page, "Kitchen");

  await page.goto("/");
  await openSettings(page);
  await page.getByTestId("token-new").click();
  await page.getByTestId("token-name").fill("Desktop assistant");
  // PETTY-281: a new token only reads until you switch changes on
  await expect(page.getByTestId("token-write")).not.toBeChecked();
  await page.getByTestId("token-write").check();
  // PETTY-452: "all drawers" is a choice the person makes; this token is to reach drawers made later too
  await expect(page.getByTestId("token-scope-all")).not.toBeChecked();
  await page.getByTestId("token-scope-all").check();
  await page.getByTestId("token-passphrase").fill(user.passphrase);
  await page.getByTestId("token-create").click();
  const token = (await page.getByTestId("token-value").innerText()).trim();
  expect(token).toMatch(/^petty_pat_[A-Za-z0-9_-]+\.[A-Za-z0-9+/=]+$/);
  // PETTY-172: the add-on and the address to paste sit next to the token
  await expect(page.getByTestId("token-address")).toHaveValue(/\/api$/);
  await expect(page.getByTestId("token-addon")).toHaveAttribute("href", "/downloads/petty.mcpb");
  await page.getByTestId("token-done").click();
  await expect(page.getByTestId("token-row")).toHaveCount(1);
  await expect(page.getByTestId("token-row")).toContainText("Can make changes · all drawers");

  // the tool: only the id half travels
  const split = splitPatToken(token);
  const bearer = { authorization: `Bearer petty_pat_${split.tokenId}` };
  const self = await request.get(`${API}/me/token`, { headers: bearer });
  expect(self.status()).toBe(200);
  const body = (await self.json()) as { user_id: string; role: string; bundle: { nonce: string; ciphertext: string }; owner_ecdh_pub: string };
  expect(body.role).toBe("write");
  const bundle = await openPatBundle(split.secret, split.tokenId, body.user_id, body.bundle);
  // PETTY-397: the owner's key is sealed in, so later wraps are opened against it, not against the server's copy
  expect(bundle.owner_ecdh).toBe(body.owner_ecdh_pub);
  expect(bundle.drawers.map((d) => d.drawer_id)).toContain(drawerId);
  expect(bundle.ecdsa).toBeTruthy(); // a writing token carries the signing key
  // the drawer's document opens with the key from the bundle, so the tool can really read
  const drawer = await request.get(`${API}/drawers/${drawerId}`, { headers: bearer });
  expect(drawer.status()).toBe(200);
  const key = bundle.drawers.find((d) => d.drawer_id === drawerId)!;
  expect(key.key_version).toBe(1);

  // the vault and the account stay out of reach
  expect((await request.get(`${API}/me`, { headers: bearer })).status()).toBe(403);
  expect((await request.get(`${API}/me/tokens`, { headers: bearer })).status()).toBe(403);

  // PETTY-169: a drawer made after the token reaches it, because the app wraps its key for the token
  await page.goto("/");
  const laterId = await addDrawerWithLine(page, "Attic");
  await page.goto("/");
  await page.reload(); // the wrap sync runs once per session
  await expect.poll(async () => {
    const keys = await request.get(`${API}/me/token/keys`, { headers: bearer });
    return ((await keys.json()) as { keys: { drawer_id: string }[] }).keys.map((k) => k.drawer_id);
  }, { timeout: 15_000 }).toContain(laterId);

  // revoke: the same call stops working
  await openSettings(page);
  await page.getByRole("button", { name: "Revoke token Desktop assistant" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByTestId("token-row")).toHaveCount(0);
  expect((await request.get(`${API}/drawers/${drawerId}`, { headers: bearer })).status()).toBe(401);
});


test("NR-1 (PETTY-181): a token the owner did not make, or one whose key was swapped, never receives drawer keys", async ({ page }) => {
  const user = await signupViaApi("patnr1");
  await loginAndUnlock(page, user);
  await page.getByTestId("passkey-nudge").getByRole("button", { name: "Not now" }).click().catch(() => undefined);
  await addDrawerWithLine(page, "Kitchen");

  // the owner makes one real token
  await page.goto("/");
  await openSettings(page);
  await page.getByTestId("token-new").click();
  await page.getByTestId("token-name").fill("Real one");
  await page.getByTestId("token-write").check();
  await page.getByTestId("token-scope-all").check();
  await page.getByTestId("token-passphrase").fill(user.passphrase);
  await page.getByTestId("token-create").click();
  await expect(page.getByTestId("token-value")).toBeVisible();
  await page.getByTestId("token-done").click();
  const userId = (await sql<{ id: string }>("select id from users where email = $1", [user.email]))[0]!.id;
  const [real] = await sql<{ id: string }>("select id from access_tokens where user_id = $1", [userId]);

  // an attacker who can write to the database: plant a token with their own key, and swap the real token's key
  const attacker = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const attackerPub = Buffer.from(await crypto.subtle.exportKey("spki", attacker.publicKey)).toString("base64");
  const [planted] = await sql<{ id: string }>(
    `insert into access_tokens (user_id, name, token_hash, role, scope, bundle_nonce, bundle_ciphertext, ecdh_pub)
     values ($1, 'planted', $2, 'read', null, 'AAAA', 'AAAA', $3) returning id`,
    [userId, randomBytes(32), attackerPub],
  );
  await sql("update access_tokens set ecdh_pub = $2 where id = $1", [real!.id, attackerPub]);

  // a new drawer appears, and the owner opens the app again (the wrap sync runs)
  await page.goto("/");
  const later = await addDrawerWithLine(page, "Attic");
  await page.goto("/");
  await page.reload();
  await expect(page.getByTestId("drawer-row").filter({ hasText: "Attic" })).toBeVisible();
  await page.waitForTimeout(1500); // give the background sync time to (wrongly) post

  const plantedWraps = await sql("select 1 from access_token_keys where token_id = $1", [planted!.id]);
  expect(plantedWraps).toHaveLength(0);
  const swappedWraps = await sql("select 1 from access_token_keys where token_id = $1 and drawer_id = $2", [real!.id, later]);
  expect(swappedWraps).toHaveLength(0);
});

test("NR-4 (PETTY-184): an entry a token signs with its own key shows clean in the app, before and after revoke", async ({ page }) => {
  const { connect } = await import("../../../packages/agent/src/index.js");
  const user = await signupViaApi("patnr4");
  await loginAndUnlock(page, user);
  await page.getByTestId("passkey-nudge").getByRole("button", { name: "Not now" }).click().catch(() => undefined);
  const drawerId = await addDrawerWithLine(page, "Kitchen");

  await page.goto("/");
  await openSettings(page);
  await page.getByTestId("token-new").click();
  await page.getByTestId("token-name").fill("Writer");
  await page.getByTestId("token-write").check();
  await page.getByTestId("token-scope-all").check();
  await page.getByTestId("token-passphrase").fill(user.passphrase);
  await page.getByTestId("token-create").click();
  const token = (await page.getByTestId("token-value").innerText()).trim();
  await page.getByTestId("token-done").click();

  // the token holds its own key, not the account key: its bundle names a key id the account does not have
  const userId = (await sql<{ id: string }>("select id from users where email = $1", [user.email]))[0]!.id;
  const [acct] = await sql<{ sig_key_id: string }>("select sig_key_id from user_keys where user_id = $1", [userId]);
  const [tok] = await sql<{ sig_key_id: string | null }>("select sig_key_id from access_tokens where user_id = $1", [userId]);
  expect(tok!.sig_key_id).toMatch(/^[0-9a-f]{32}$/);
  expect(tok!.sig_key_id).not.toBe(acct!.sig_key_id);

  const agent = await connect({ token, apiUrl: API });
  const [d] = (await agent.drawers()).filter((x) => x.id === drawerId);
  await agent.add(drawerId, d!.lines[0]!.id, "5", "");

  const check = async () => {
    await page.goto(`/drawers/${drawerId}`);
    await page.getByTestId("line-name").filter({ hasText: "Cash" }).click();
    await expect(page.getByTestId("line-balance")).toContainText("15");
    await expect(page.getByTestId("entry-row")).toHaveCount(2);
    await expect(page.getByTestId("warn-problems")).toHaveCount(0);
  };
  await check();

  // revoking stops the token, but what it wrote before stays trusted
  await page.goto("/");
  await openSettings(page);
  await page.getByRole("button", { name: "Revoke token Writer" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByTestId("token-row")).toHaveCount(0);
  await page.reload();
  await check();
});

test("PETTY-452: a token is made for the drawers the person picks, after the vault passphrase, a reading one too", async ({ page, request }) => {
  const { connect } = await import("../../../packages/agent/src/index.js");
  const user = await signupViaApi("patscope");
  await loginAndUnlock(page, user);
  await page.getByTestId("passkey-nudge").getByRole("button", { name: "Not now" }).click().catch(() => undefined);
  const kitchenId = await addDrawerWithLine(page, "Kitchen");
  await page.goto("/");
  const atticId = await addDrawerWithLine(page, "Attic");
  const userId = (await sql<{ id: string }>("select id from users where email = $1", [user.email]))[0]!.id;
  const tokens = () => sql<{ id: string; role: string; scope: string[] | null; expires_at: Date | null }>("select id, role, scope, expires_at from access_tokens where user_id = $1", [userId]);

  await page.goto("/");
  await openSettings(page);
  await page.getByTestId("token-new").click();
  const sheet = page.getByRole("dialog");
  await page.getByTestId("token-name").fill("Kitchen reader");
  // a token that only reads (the default) is confirmed by the vault as well
  await expect(page.getByTestId("token-write")).not.toBeChecked();
  await expect(page.getByTestId("token-passphrase")).toBeVisible();
  await expect(page.getByTestId("token-confirm-hint")).toContainText("asks for your vault passphrase or passkey again");
  // nothing is chosen for the person: no drawers yet, and no token without a choice
  await expect(page.getByTestId("token-scope-all")).not.toBeChecked();
  await expect(page.getByTestId("token-scope-some")).not.toBeChecked();
  await page.getByTestId("token-passphrase").fill(user.passphrase);
  await page.getByTestId("token-create").click();
  await expect(sheet.getByRole("alert")).toHaveText("Choose which drawers this token can use.");
  await page.getByTestId("token-scope-some").check();
  await page.getByTestId("token-create").click();
  await expect(sheet.getByRole("alert")).toHaveText("Choose which drawers this token can use."); // "only these", and none ticked
  const pick = sheet.getByRole("group", { name: "Drawers for this token" });
  await expect(pick.getByRole("checkbox")).toHaveCount(2);
  await pick.getByRole("checkbox", { name: "Kitchen" }).check();
  // the passphrase is really checked: none, or a wrong one, makes no token while the vault is open
  await page.getByTestId("token-passphrase").fill("");
  await page.getByTestId("token-create").click();
  await expect(sheet.getByRole("alert")).toHaveText("Enter your vault passphrase.");
  await page.getByTestId("token-passphrase").fill("not the passphrase at all");
  await page.getByTestId("token-create").click();
  await expect(sheet.getByRole("alert")).toHaveText("That passphrase did not open the vault.");
  expect(await tokens()).toHaveLength(0);
  await page.getByTestId("token-passphrase").fill(user.passphrase);
  await page.getByTestId("token-create").click();
  const token = (await page.getByTestId("token-value").innerText()).trim();
  await page.getByTestId("token-done").click();
  await expect(page.getByTestId("token-row")).toContainText("Read only · 1 drawer");

  // what the server keeps: the one drawer, and an end date 90 days on, which nobody had to ask for
  const [row] = await tokens();
  expect(row).toMatchObject({ role: "read", scope: [kitchenId] });
  expect(Math.round((row!.expires_at!.getTime() - Date.now()) / 86_400_000)).toBe(90);

  // the tool: only the chosen drawer's key is in the bundle, and the server refuses the other drawer
  const split = splitPatToken(token);
  const bearer = { authorization: `Bearer petty_pat_${split.tokenId}` };
  const self = (await (await request.get(`${API}/me/token`, { headers: bearer })).json()) as { user_id: string; scope: string[] | null; bundle: { nonce: string; ciphertext: string } };
  expect(self.scope).toEqual([kitchenId]);
  const bundle = await openPatBundle(split.secret, split.tokenId, self.user_id, self.bundle);
  expect(bundle.drawers.map((d) => d.drawer_id)).toEqual([kitchenId]);
  expect((await request.get(`${API}/drawers/${kitchenId}`, { headers: bearer })).status()).toBe(200);
  const other = await request.get(`${API}/drawers/${atticId}`, { headers: bearer });
  expect(other.status()).toBe(403);
  expect(((await other.json()) as { code: string }).code).toBe("TokenOutOfScope");
  const agent = await connect({ token, apiUrl: API });
  expect((await agent.drawers()).map((d) => d.name)).toEqual(["Kitchen"]);
  await expect(agent.history(atticId, crypto.randomUUID())).rejects.toMatchObject({ code: "OutOfScope" });

  // a drawer made later stays out of it: the app wraps new drawer keys only for the drawers a token was made for
  await page.goto("/");
  const laterId = await addDrawerWithLine(page, "Cellar");
  await page.goto("/");
  await page.reload(); // the wrap sync runs once per session
  await expect(page.getByTestId("drawer-row").filter({ hasText: "Cellar" })).toBeVisible();
  await page.waitForTimeout(1500); // give the background sync time to (wrongly) post
  const keys = ((await (await request.get(`${API}/me/token/keys`, { headers: bearer })).json()) as { keys: { drawer_id: string }[] }).keys.map((k) => k.drawer_id);
  expect(keys).not.toContain(laterId);
  expect(keys).not.toContain(atticId);
  expect((await request.get(`${API}/drawers/${laterId}`, { headers: bearer })).status()).toBe(403);

  // "no end date" stays a choice the person can make
  await openSettings(page);
  await page.getByTestId("token-new").click();
  await page.getByTestId("token-name").fill("No end");
  await page.getByTestId("token-scope-all").check();
  await expect(page.getByTestId("token-expiry")).toHaveValue("90");
  await page.getByTestId("token-expiry").selectOption("0");
  await page.getByTestId("token-passphrase").fill(user.passphrase);
  await page.getByTestId("token-create").click();
  await expect(page.getByTestId("token-value")).toBeVisible();
  await page.getByTestId("token-done").click();
  const all = await tokens();
  expect(all).toHaveLength(2);
  expect(all.find((t) => t.id !== row!.id)).toMatchObject({ scope: null, expires_at: null });
});
