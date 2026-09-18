import type { Page } from "@playwright/test";
import { openPatBundle, splitPatToken } from "@petty/crypto";
import { expect, loginAndUnlock, openSettings, signupViaApi, test } from "./fixtures.js";

/**
 * Access tokens (PETTY-164): made in Settings, used by a tool outside the browser. The tool sends
 * only the id half; the secret half opens the bundle here, in this Node process, never on the server.
 */
const API = process.env["API_URL"] ?? "http://127.0.0.1:3000";

async function addDrawerWithLine(page: Page, name: string): Promise<string> {
  await page.getByRole("button", { name: "Add drawer" }).click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  const id = /\/drawers\/([0-9a-f-]+)/.exec(page.url())![1]!;
  await page.getByRole("button", { name: "Add line" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Cash");
  await page.getByLabel("Currency", { exact: true }).fill("PLN");
  await page.getByLabel("Starting balance").fill("10");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByTestId("line-name").filter({ hasText: "Cash" })).toBeVisible();
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
  await page.getByTestId("token-passphrase").fill(user.passphrase);
  await page.getByTestId("token-create").click();
  const token = (await page.getByTestId("token-value").innerText()).trim();
  expect(token).toMatch(/^petty_pat_[A-Za-z0-9_-]+\.[A-Za-z0-9+/=]+$/);
  await page.getByTestId("token-done").click();
  await expect(page.getByTestId("token-row")).toHaveCount(1);
  await expect(page.getByTestId("token-row")).toContainText("May add entries");

  // the tool: only the id half travels
  const split = splitPatToken(token);
  const bearer = { authorization: `Bearer petty_pat_${split.tokenId}` };
  const self = await request.get(`${API}/me/token`, { headers: bearer });
  expect(self.status()).toBe(200);
  const body = (await self.json()) as { user_id: string; role: string; bundle: { nonce: string; ciphertext: string } };
  expect(body.role).toBe("write");
  const bundle = await openPatBundle(split.secret, split.tokenId, body.user_id, body.bundle);
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
