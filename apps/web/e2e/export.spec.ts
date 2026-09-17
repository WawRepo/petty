import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { openArchive } from "@petty/crypto";
import { apiClient, expect, loginAndUnlock, shareViaApi, signupWithKeys, test } from "./fixtures.js";

async function keypad(page: Page, op: "Add" | "Withdraw" | "Adjust", digits: string, comment = "") {
  await page.getByRole("button", { name: op, exact: true }).click();
  for (const d of digits) await page.getByRole("group").getByRole("button", { name: d === "." ? "Decimal point" : d, exact: true }).click();
  if (comment) await page.getByLabel("Comment (optional)").fill(comment);
  await page.getByRole("button", { name: "Review" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByTestId("confirm-summary")).toBeHidden({ timeout: 15_000 });
}

test("encrypted export → import into another account: same drawers, balances, history labels, photo, verification; plain export is warned and readable", async ({ browser }) => {
  const alice = await signupWithKeys("alice");
  const bob = await signupWithKeys("bob");
  const carol = await signupWithKeys("carol");
  const ctxA = await browser.newContext({ acceptDownloads: true }); const pageA = await ctxA.newPage();
  await loginAndUnlock(pageA, alice);
  // a drawer with history worth keeping
  await pageA.getByRole("button", { name: "Add drawer" }).click();
  await pageA.getByLabel("Name", { exact: true }).fill("Kitchen");
  await pageA.getByRole("button", { name: "Save" }).click();
  await expect(pageA.getByRole("heading", { name: "Kitchen" })).toBeVisible();
  const drawerId = /\/drawers\/([0-9a-f-]+)/.exec(pageA.url())![1]!;
  await pageA.getByRole("button", { name: "Add line" }).click();
  await pageA.getByLabel("Name", { exact: true }).fill("PLN kitchen");
  await pageA.getByLabel("Currency", { exact: true }).fill("PLN");
  await pageA.getByLabel("Starting balance").fill("100");
  await pageA.getByRole("button", { name: "Add", exact: true }).click();
  await pageA.getByRole("button", { name: "Add line" }).click();
  await pageA.getByRole("button", { name: "Single item" }).click();
  await pageA.getByLabel("Name", { exact: true }).fill("Passport");
  await pageA.getByRole("button", { name: "Add", exact: true }).click();
  const jpeg = Buffer.from(await pageA.evaluate(async () => { const c = document.createElement("canvas"); c.width = 200; c.height = 100; c.getContext("2d")!.fillStyle = "#c93"; c.getContext("2d")!.fillRect(0, 0, 200, 100); const b = await new Promise<Blob>((r) => c.toBlob((x) => r(x!), "image/jpeg", 0.8)); return Array.from(new Uint8Array(await b.arrayBuffer())); }));
  await pageA.locator("#photo-input").setInputFiles({ name: "p.jpg", mimeType: "image/jpeg", buffer: jpeg });
  await expect(pageA.getByTestId("drawer-photo")).toBeVisible();
  await pageA.getByRole("button", { name: "Open PLN kitchen" }).click();
  await keypad(pageA, "Withdraw", "30", "pizza");
  await keypad(pageA, "Adjust", "60");
  await keypad(pageA, "Add", "5");
  await pageA.getByTestId("entry-row").first().getByRole("button", { name: "Entry options" }).click();
  await pageA.getByRole("button", { name: "Reverse this entry" }).click();
  await pageA.getByRole("button", { name: "Reverse", exact: true }).click();
  await expect(pageA.getByTestId("line-balance")).toHaveText("60.00");
  await pageA.goto(`/drawers/${drawerId}`);
  await pageA.getByRole("button", { name: "Confirm state" }).click();
  await pageA.getByLabel("Comment (optional)").fill("counted");
  await pageA.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(pageA.getByTestId("verify-bar")).toHaveAttribute("data-status", "verified");
  // carol is a reader: export forbidden server-side, and her settings export skips the drawer
  await shareViaApi(alice, drawerId, carol, "read");
  expect((await (await apiClient(carol)).call("GET", `/drawers/${drawerId}/export`)).status).toBe(403);
  // encrypted export
  await pageA.goto("/settings");
  await pageA.getByRole("button", { name: "Export (encrypted)" }).click();
  await pageA.getByLabel("Export password", { exact: true }).fill("short");
  await pageA.getByLabel("Repeat the export password").fill("short");
  await pageA.getByRole("button", { name: "Download" }).click();
  await expect(pageA.getByRole("alert")).toContainText("At least 12 characters");
  await pageA.getByLabel("Export password", { exact: true }).fill("export password 2026");
  await pageA.getByLabel("Repeat the export password").fill("export password 2026");
  const [download] = await Promise.all([pageA.waitForEvent("download"), pageA.getByRole("button", { name: "Download" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^petty-export-\d{4}-\d{2}-\d{2}\.petty\.json$/);
  const encPath = await download.path();
  const encText = readFileSync(encPath!, "utf8");
  expect(encText).not.toContain("Kitchen");
  expect(encText).not.toContain("pizza");
  const opened = (await openArchive("export password 2026", JSON.parse(encText))) as { drawers: Array<{ document: { name: string }; entries: unknown[]; photo_b64: string | null }> };
  expect(opened.drawers[0]!.document.name).toBe("Kitchen");
  expect(opened.drawers[0]!.entries).toHaveLength(5);
  expect(opened.drawers[0]!.photo_b64).toBeTruthy();
  // plain export: warned, then readable
  await pageA.getByRole("button", { name: "Export as plain text…" }).click();
  await expect(pageA.getByRole("dialog")).toContainText("unencrypted");
  const [plain] = await Promise.all([pageA.waitForEvent("download"), pageA.getByRole("button", { name: "Export unencrypted" }).click()]);
  expect(plain.suggestedFilename()).toContain("PLAINTEXT");
  expect(readFileSync((await plain.path())!, "utf8")).toContain("pizza");
  // import into bob's (empty) account
  const ctxB = await browser.newContext(); const pageB = await ctxB.newPage();
  await loginAndUnlock(pageB, bob);
  await pageB.goto("/settings");
  await pageB.locator("#import-input").setInputFiles({ name: "export.petty.json", mimeType: "application/json", buffer: Buffer.from(encText) });
  await pageB.getByLabel("Password of the file").fill("wrong password 12345");
  await pageB.getByRole("button", { name: "Import", exact: true }).click();
  await expect(pageB.getByRole("alert")).toContainText("did not open the file");
  await pageB.getByLabel("Password of the file").fill("export password 2026");
  await pageB.getByRole("button", { name: "Import", exact: true }).click();
  await expect(pageB.locator(".toast")).toHaveText("1 drawer imported", { timeout: 30_000 });
  await expect(pageB.getByTestId("drawer-row")).toHaveCount(1);
  await expect(pageB.getByTestId("drawer-row").first()).toContainText("Kitchen");
  await expect(pageB.getByTestId("drawer-row").first().getByTestId("row-amount")).toHaveText("60.00 PLN");
  await expect(pageB.getByTestId("drawer-row").first()).toContainText("2 items");
  await pageB.getByRole("button", { name: "Open Kitchen" }).click();
  await expect(pageB.getByTestId("drawer-photo")).toBeVisible();
  // the history came along; the server-side verification status starts fresh on this server (nobody confirmed it here yet)
  await expect(pageB.getByTestId("verify-bar")).toHaveAttribute("data-status", "never");
  await pageB.getByRole("button", { name: "History (1)" }).click();
  await expect(pageB.getByTestId("verification-row").first()).toContainText("[imported: alice]");
  await pageB.getByRole("button", { name: "Open PLN kitchen" }).click();
  await expect(pageB.getByTestId("line-balance")).toHaveText("60.00");
  await expect(pageB.getByTestId("entry-row").first()).toContainText("[imported: alice,");
  await expect(pageB.getByTestId("entry-row").first()).toContainText("Reverse");
  await expect(pageB.getByRole("button", { name: "by bob" }).first()).toBeVisible();
  await pageB.getByRole("button", { name: "Load older" }).click();
  await expect(pageB.getByTestId("entry-row").filter({ hasText: "pizza" })).toContainText("pizza · [imported: alice,");
  await ctxA.close(); await ctxB.close();
});
