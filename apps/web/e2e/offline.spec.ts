import type { BrowserContext, Page } from "@playwright/test";
import { dbQuery, expect, loginAndUnlock, shareViaApi, signupWithKeys, test, openSettings } from "./fixtures.js";

async function makeLine(page: Page, drawer: string): Promise<{ drawerId: string; lineId: string }> {
  await page.getByRole("button", { name: "Add drawer" }).click();
  await page.getByLabel("Name", { exact: true }).fill(drawer);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: drawer })).toBeVisible();
  const drawerId = /\/drawers\/([0-9a-f-]+)/.exec(page.url())![1]!;
  await page.getByRole("button", { name: "Add line" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Cash");
  await page.getByLabel("Currency", { exact: true }).fill("EUR");
  await page.getByLabel("Starting balance").fill("100");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByTestId("line-row").first()).toContainText("100.00 EUR");
  await page.getByRole("button", { name: "Open Cash" }).click();
  await expect(page.getByTestId("line-balance")).toHaveText("100.00");
  const lineId = /\/lines\/([0-9a-f-]+)/.exec(page.url())![1]!;
  return { drawerId, lineId };
}
async function add(page: Page, digits: string, op: "Add" | "Adjust" = "Add") {
  await page.getByRole("button", { name: op, exact: true }).click();
  for (const d of digits) await page.getByRole("group").getByRole("button", { name: d, exact: true }).click();
  await page.getByRole("button", { name: "Review" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByTestId("confirm-summary")).toBeHidden({ timeout: 15_000 });
}
async function pair(browser: import("@playwright/test").Browser) {
  const alice = await signupWithKeys("alice");
  const bob = await signupWithKeys("bob");
  const ctxA = await browser.newContext(); const pageA = await ctxA.newPage();
  const ctxB = await browser.newContext(); const pageB = await ctxB.newPage();
  await loginAndUnlock(pageA, alice);
  const { drawerId, lineId } = await makeLine(pageA, "Shared");
  await shareViaApi(alice, drawerId, bob, "write");
  await loginAndUnlock(pageB, bob);
  await pageB.goto(`/drawers/${drawerId}/lines/${lineId}`);
  await expect(pageB.getByTestId("line-balance")).toHaveText("100.00");
  return { alice, bob, ctxA, pageA, ctxB, pageB, drawerId, lineId };
}
const entryCount = async (drawerId: string, lineId: string) => (await dbQuery("select count(*)::int as n from entries where drawer_id = $1 and line_id = $2", [drawerId, lineId]) as { n: number }[])[0]!.n;

test("offline entries queue as pending; on reconnect they interleave with another user's entry and the report says what changed", async ({ browser }) => {
  const { ctxA, pageA, pageB, ctxB, drawerId, lineId } = await pair(browser);
  await ctxA.setOffline(true);
  await add(pageA, "10");
  await add(pageA, "20");
  await expect(pageA.getByTestId("line-balance")).toHaveText("130.00");
  await expect(pageA.getByTestId("entry-row").filter({ hasText: "pending" })).toHaveCount(2);
  await expect(pageA.getByTestId("pending-count")).toContainText("2 changes waiting to send");
  expect(await entryCount(drawerId, lineId)).toBe(1);
  // bob adds online meanwhile
  await add(pageB, "30");
  await expect(pageB.getByTestId("line-balance")).toHaveText("130.00");
  // alice reconnects: the browser fires `online`, the outbox drains, everything reloads
  await ctxA.setOffline(false);
  await expect.poll(() => entryCount(drawerId, lineId), { timeout: 20_000 }).toBe(4);
  await expect(pageA.getByTestId("line-balance")).toHaveText("160.00");
  await expect(pageA.getByTestId("entry-row")).toHaveCount(4);
  await expect(pageA.getByTestId("entry-row").filter({ hasText: "pending" })).toHaveCount(0);
  await expect(pageA.getByTestId("sync-report")).toContainText("+30.00 EUR by bob on Cash");
  await expect(pageA.getByTestId("offline-banner")).toHaveCount(0);
  await pageA.getByRole("button", { name: "OK" }).click();
  await expect(pageA.getByTestId("sync-report")).toHaveCount(0);
  await pageB.reload();
  await expect(pageB.getByTestId("line-balance")).toHaveText("160.00");
  await ctxA.close(); await ctxB.close();
});

test("an offline Adjust made against a line that changed meanwhile is refused on reconnect and reported; nothing is written", async ({ browser }) => {
  const { ctxA, pageA, pageB, ctxB, drawerId, lineId } = await pair(browser);
  await ctxA.setOffline(true);
  await add(pageA, "500", "Adjust");
  await expect(pageA.getByTestId("line-balance")).toHaveText("500.00");
  await add(pageB, "1");
  await ctxA.setOffline(false);
  await expect(pageA.getByTestId("sync-report")).toContainText("Your count on Cash was not saved", { timeout: 20_000 });
  expect((await dbQuery("select count(*)::int as n from entries where drawer_id = $1 and is_checkpoint", [drawerId]) as { n: number }[])[0]!.n).toBe(0);
  await expect(pageA.getByTestId("line-balance")).toHaveText("101.00");
  void lineId;
  await ctxA.close(); await ctxB.close();
});

test("a page reloaded in the middle of sending drains the outbox exactly once", async ({ browser }) => {
  const alice = await signupWithKeys("alice");
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  await loginAndUnlock(page, alice);
  const { drawerId, lineId } = await makeLine(page, "Solo");
  await ctx.setOffline(true);
  await add(page, "1"); await add(page, "2"); await add(page, "3");
  await expect(pageCount(page)).toContainText("3 changes");
  // reconnect and immediately reload: whatever was in flight is re-sent by the fresh page, idempotently
  await ctx.setOffline(false);
  await page.reload();
  await expect.poll(() => entryCount(drawerId, lineId), { timeout: 20_000 }).toBe(4);
  await page.waitForTimeout(1500);
  expect(await entryCount(drawerId, lineId)).toBe(4);
  await expect(page.getByTestId("pending-count")).toHaveCount(0);
  const outbox = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((res, rej) => { const r = indexedDB.open("petty", 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const keys = await new Promise<IDBValidKey[]>((res) => { const r = db.transaction("kv").objectStore("kv").getAllKeys(); r.onsuccess = () => res(r.result); });
    const k = keys.find((x) => String(x).startsWith("outbox."));
    if (!k) return [];
    return new Promise<unknown[]>((res) => { const r = db.transaction("kv").objectStore("kv").get(k); r.onsuccess = () => res((r.result as unknown[]) ?? []); });
  });
  expect(outbox).toEqual([]);
  await ctx.close();
});
function pageCount(page: Page) { return page.getByTestId("pending-count"); }

test("offline reload: unlock works with no network, drawers come from the ciphertext cache, and an old outbox is flagged", async ({ browser }) => {
  const alice = await signupWithKeys("alice");
  const ctx: BrowserContext = await browser.newContext(); const page = await ctx.newPage();
  await loginAndUnlock(page, alice);
  await makeLine(page, "Basement");
  await page.goto("/");
  await expect(page.getByTestId("drawer-row")).toHaveCount(1);
  // block only the API (the dev server keeps serving the app; the service worker is tested separately against the production build)
  let apiCalls = 0;
  await page.route("**/api/**", (r) => { apiCalls += 1; void r.abort("internetdisconnected"); });
  await openSettings(page);
  await page.getByRole("button", { name: "Lock now" }).click();
  await expect(page.getByRole("heading", { name: "Unlock your vault" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Unlock your vault" })).toBeVisible();
  await page.getByLabel("Vault passphrase").fill(alice.passphrase);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByTestId("drawer-row")).toHaveCount(1);
  await expect(page.getByTestId("drawer-row").first()).toContainText("Basement");
  await expect(page.getByTestId("drawer-row").first()).toContainText("100.00 EUR");
  await expect(page.getByTestId("offline-banner")).toContainText("Showing what was loaded last time");
  expect(apiCalls).toBeGreaterThan(0);
  // an entry logged now goes to the outbox; backdate it two days → the "waited more than a day" warning
  await page.getByRole("button", { name: "Open Basement" }).click();
  await page.getByRole("button", { name: "Open Cash" }).click();
  await add(page, "9");
  await expect(page.getByTestId("line-balance")).toHaveText("109.00");
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((res, rej) => { const r = indexedDB.open("petty", 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const store = db.transaction("kv", "readwrite").objectStore("kv");
    const keys = await new Promise<IDBValidKey[]>((res) => { const r = store.getAllKeys(); r.onsuccess = () => res(r.result); });
    const k = keys.find((x) => String(x).startsWith("outbox."))!;
    const items = await new Promise<Array<{ created_at: string }>>((res) => { const r = store.get(k); r.onsuccess = () => res(r.result); });
    for (const it of items) it.created_at = new Date(Date.now() - 2 * 86_400_000).toISOString();
    await new Promise((res) => { const r = store.put(items, k); r.onsuccess = () => res(null); });
  });
  await page.reload(); // still unlocked within 24 h: no prompt
  await expect(page.getByTestId("outbox-old")).toContainText("waited more than a day");
  await ctx.close();
});
