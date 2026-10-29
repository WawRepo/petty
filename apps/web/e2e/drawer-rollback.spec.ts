import type { Page } from "@playwright/test";
import { acceptViaUi, dbQuery, expect, inviteViaUi, loginAndUnlock, makeDrawer, rowNamed, signupWithKeys, test } from "./fixtures.js";

/**
 * The security review of v1.5.26 (PETTY-395, finding 5, PETTY-403): a server or database must not be able to make a
 * whole line, or a whole later state of a drawer, vanish with no warning. The attacker here has database access.
 */

async function addItem(page: Page, drawerId: string, name: string, currency: string, start: string): Promise<void> {
  await page.goto(`/drawers/${drawerId}`);
  await page.getByRole("button", { name: "Add item" }).click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Currency", { exact: true }).fill(currency);
  await page.getByLabel("Starting balance").fill(start);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByTestId("line-row").filter({ hasText: name })).toContainText(`${start}.00 ${currency}`);
}

interface DocumentState { readonly version: number; readonly row: { author_id: string; key_version: number; schema_version: number; nonce: Buffer; ciphertext: Buffer } }
async function documentNow(drawerId: string): Promise<DocumentState> {
  const [d] = (await dbQuery("select version from drawers where id = $1", [drawerId])) as { version: number }[];
  const [row] = (await dbQuery("select author_id, key_version, schema_version, nonce, ciphertext from drawer_documents where drawer_id = $1", [drawerId])) as DocumentState["row"][];
  return { version: d!.version, row: row! };
}
/** An attacker with database access puts a drawer back to an earlier state, its version number with it, as a restore from an old backup would. */
async function putBack(drawerId: string, s: DocumentState): Promise<void> {
  await dbQuery("update drawer_documents set author_id = $2, key_version = $3, schema_version = $4, nonce = $5, ciphertext = $6 where drawer_id = $1", [drawerId, s.row.author_id, s.row.key_version, s.row.schema_version, s.row.nonce, s.row.ciphertext]);
  await dbQuery("update drawers set version = $2 where id = $1", [drawerId, s.version]);
}

test("PETTY-403: a line whose whole log the server drops reads as shorter, not as an empty line", async ({ page }) => {
  const user = await signupWithKeys("hal");
  await loginAndUnlock(page, user);
  const id = await makeDrawer(page, "Tin");
  const [line] = (await dbQuery("select distinct line_id from entries where drawer_id = $1", [id])) as { line_id: string }[];
  await page.goto(`/drawers/${id}/lines/${line!.line_id}`);
  await expect(page.getByTestId("line-balance")).toHaveText("100.00");
  // the attacker deletes every entry of the line
  await dbQuery("delete from entries where drawer_id = $1 and line_id = $2", [id, line!.line_id]);
  await page.reload();
  await expect(page.getByTestId("warn-chain-truncated")).toContainText("shorter than the last time you saw it");
  await page.goto("/");
  await expect(page.getByTestId("drawer-attention")).toBeVisible();
  // the user looks at it and accepts the line as it is now
  await page.goto(`/drawers/${id}/lines/${line!.line_id}`);
  await page.getByRole("button", { name: "Accept as is" }).click();
  await expect(page.getByTestId("warn-chain-truncated")).toBeHidden();
  await page.reload();
  await expect(page.getByTestId("line-balance")).toHaveText("0.00");
  await expect(page.getByTestId("warn-chain-truncated")).toBeHidden();
});

test("PETTY-403: an older state of a drawer is refused; an item another member deleted, or a version the owner put back, is not reported", async ({ browser }) => {
  const alice = await signupWithKeys("alice");
  const bob = await signupWithKeys("bob");
  const ctxA = await browser.newContext(); const pageA = await ctxA.newPage();
  const ctxB = await browser.newContext(); const pageB = await ctxB.newPage();
  await loginAndUnlock(pageA, alice);
  const id = await makeDrawer(pageA, "Shared");
  await inviteViaUi(pageA, id, bob, "write");
  await loginAndUnlock(pageB, bob);
  await acceptViaUi(pageB);
  await expect(rowNamed(pageB, "Shared")).toBeVisible();
  const before = await documentNow(id);
  // alice adds an item; bob opens the drawer and sees it: no warning for a newer version
  await addItem(pageA, id, "Coins", "PLN", "7");
  await pageB.goto(`/drawers/${id}`);
  await expect(rowNamed(pageB, "Coins")).toBeVisible();
  await expect(pageB.getByRole("alert")).toHaveCount(0);
  const now = await documentNow(id);

  // the attacker puts the drawer back to the state before Coins; bob's next save is not built on it
  await putBack(id, before);
  await pageB.getByRole("button", { name: "Drawer options" }).click();
  await pageB.getByRole("button", { name: "Rename" }).click();
  await pageB.getByRole("dialog").getByRole("textbox").fill("Renamed");
  await pageB.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(pageB.getByRole("alert")).toContainText("older version of this drawer");
  // nor opened at the next start
  await pageB.reload();
  await expect(pageB.getByRole("alert")).toContainText("older version of this drawer");
  expect((await documentNow(id)).version).toBe(before.version);
  await putBack(id, now);
  await pageB.reload();
  await expect(rowNamed(pageB, "Coins")).toBeVisible();

  // alice deletes Coins: bob's device saw its log, and reports nothing
  await pageA.goto(`/drawers/${id}`);
  await rowNamed(pageA, "Coins").click();
  await pageA.getByRole("button", { name: "Options for Coins" }).click();
  await pageA.getByRole("button", { name: "Delete item", exact: true }).click();
  await pageA.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(rowNamed(pageA, "Coins")).toBeHidden();
  await pageB.reload();
  await expect(rowNamed(pageB, "Cash")).toBeVisible();
  await expect(rowNamed(pageB, "Coins")).toBeHidden();
  await pageB.goto("/");
  await expect(rowNamed(pageB, "Shared")).toBeVisible();
  await expect(pageB.getByTestId("drawer-attention")).toHaveCount(0);

  // alice puts back the version that still had Coins (its log stays deleted): bob sees it back, empty, with no warning
  await pageA.goto(`/drawers/${id}`);
  await pageA.getByRole("button", { name: "Drawer options" }).click();
  await pageA.getByTestId("drawer-history").click();
  await pageA.getByTestId("history-row").filter({ hasText: "2 items" }).getByRole("button", { name: /^Restore the version from/ }).click();
  await expect(pageA.getByText("Earlier version restored.")).toBeVisible();
  await pageB.goto(`/drawers/${id}`);
  await expect(pageB.getByTestId("line-row").filter({ hasText: "Coins" })).toContainText("0.00 PLN");
  await pageB.goto("/");
  await expect(rowNamed(pageB, "Shared")).toBeVisible();
  await expect(pageB.getByTestId("drawer-attention")).toHaveCount(0);
  await ctxA.close();
  await ctxB.close();
});
