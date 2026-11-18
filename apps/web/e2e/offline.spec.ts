import { randomBytes, randomUUID } from "node:crypto";
import type { BrowserContext, Page } from "@playwright/test";
import { exportPublicKeys, fromB64, generateUserKeys, hashEntry, openEntryUnverified, sealEntry, signDelegation, signEntry, signingKeyId, toB64, unwrapDrawerKey, type DrawerKeyWrapV1, type EntryPayloadV1 } from "@petty/crypto";
import { apiClient, dbQuery, expect, loginAndUnlock, shareViaApi, signupWithKeys, test, openSettings, rowNamed, type TestUserWithKeys } from "./fixtures.js";

async function makeLine(page: Page, drawer: string): Promise<{ drawerId: string; lineId: string }> {
  await page.getByRole("button", { name: "Add drawer" }).click();
  await page.getByLabel("Name", { exact: true }).fill(drawer);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: drawer })).toBeVisible();
  const drawerId = /\/drawers\/([0-9a-f-]+)/.exec(page.url())![1]!;
  await page.getByRole("button", { name: "Add item" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Cash");
  await page.getByLabel("Currency", { exact: true }).fill("EUR");
  await page.getByLabel("Starting balance").fill("100");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByTestId("line-row").first()).toContainText("100.00 EUR");
  await rowNamed(page, "Cash").click();
  await expect(page.getByTestId("line-balance")).toHaveText("100.00");
  const lineId = /\/lines\/([0-9a-f-]+)/.exec(page.url())![1]!;
  return { drawerId, lineId };
}
async function add(page: Page, digits: string, op: "Add" | "Adjust" = "Add") {
  await page.getByRole("button", { name: op, exact: true }).click();
  for (const d of digits) await page.getByRole("group").getByRole("button", { name: d, exact: true }).click();
  await page.getByRole("button", { name: "Review" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("confirm-summary")).toBeHidden({ timeout: 15_000 });
}
async function pair(browser: import("@playwright/test").Browser) {
  const alice = await signupWithKeys("alice");
  const bob = await signupWithKeys("bob");
  const ctxA = await browser.newContext(); const pageA = watched(await ctxA.newPage());
  const ctxB = await browser.newContext(); const pageB = watched(await ctxB.newPage());
  await loginAndUnlock(pageA, alice);
  const { drawerId, lineId } = await makeLine(pageA, "Shared");
  await shareViaApi(alice, drawerId, bob, "write");
  await loginAndUnlock(pageB, bob);
  await pageB.goto(`/drawers/${drawerId}/lines/${lineId}`);
  await expect(pageB.getByTestId("line-balance")).toHaveText("100.00");
  return { alice, bob, ctxA, pageA, ctxB, pageB, drawerId, lineId };
}
/**
 * PETTY-376: React's "two children with the same key" warning means one row was shown twice (or dropped) for a
 * moment. Every page of this file reports it, with React's component stack, and the test fails.
 */
const keyWarnings: string[] = [];
function watched(page: Page): Page {
  page.on("console", (m) => { if (m.type() === "error" && m.text().includes("two children with the same key")) keyWarnings.push(m.text()); });
  return page;
}
test.afterEach(() => {
  const found = keyWarnings.splice(0);
  expect(found, found.join("\n\n")).toEqual([]);
});

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
  const ctx = await browser.newContext(); const page = watched(await ctx.newPage());
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
  const ctx: BrowserContext = await browser.newContext(); const page = watched(await ctx.newPage());
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
  await rowNamed(page, "Basement").click();
  await rowNamed(page, "Cash").click();
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

/**
 * A tool's entry, as the command line or the AI add-on makes one (PETTY-184): the user's account key signs a delegation
 * for the token's own key, and the token's key signs an "add" of `amount` (minor units) on the line's newest entry.
 */
async function toolAdds(user: TestUserWithKeys, drawerId: string, amount: number): Promise<{ entryId: string }> {
  const api = await apiClient(user);
  const boot = (await api.call("GET", "/bootstrap")).json as { wraps: DrawerKeyWrapV1[]; entries: Array<{ id: string; drawer_id: string; line_id: string; author_id: string; key_version: number; nonce: string; ciphertext: string }> };
  const wrap = boot.wraps.filter((w) => w.drawer_id === drawerId).at(-1)!;
  const key = await unwrapDrawerKey(wrap, user.keys.ecdh.privateKey, { drawer_id: drawerId, key_version: wrap.key_version, senderEcdhPublicB64: user.ecdhPub });
  const last = boot.entries.filter((e) => e.drawer_id === drawerId).at(-1)!;
  const head = await openEntryUnverified(key, { record_type: "entry", record_id: last.id, drawer_id: drawerId, line_id: last.line_id, author_id: last.author_id, key_version: last.key_version, schema_version: 1 }, { nonce: fromB64(last.nonce), ciphertext: fromB64(last.ciphertext) });
  const tool = await generateUserKeys();
  const toolPub = (await exportPublicKeys(tool)).ecdsa;
  const accountPub = (await exportPublicKeys(user.keys)).ecdsa;
  const delegation = await signDelegation(user.keys.ecdsa.privateKey, { user_id: api.id, account_sig_key_id: await signingKeyId(accountPub), token_ecdsa_pub: toolPub, created_at: new Date().toISOString(), expires_at: null });
  await dbQuery("insert into access_tokens (user_id, name, token_hash, role, bundle_nonce, bundle_ciphertext, ecdsa_pub, sig_key_id, delegation) values ($1, 'tool', $2, 'write', 'AAAA', 'AAAA', $3, $4, $5)",
    [api.id, randomBytes(32), toolPub, delegation.token_sig_key_id, JSON.stringify(delegation)]);
  const payload: EntryPayloadV1 = {
    v: 1, id: randomUUID(), drawer_id: drawerId, line_id: last.line_id, op: "add", amount, exponent: 2, comment: "", logged_at: new Date().toISOString(),
    reverses: null, prev_hash: await hashEntry(head), delta_hint: null, author_id: api.id, sig_key_id: delegation.token_sig_key_id,
  };
  const sealed = await sealEntry(key, { record_type: "entry", record_id: payload.id, drawer_id: drawerId, line_id: last.line_id, author_id: api.id, key_version: wrap.key_version, schema_version: 1 }, await signEntry(payload, tool.ecdsa.privateKey));
  const r = await api.call("POST", `/drawers/${drawerId}/entries`, { id: payload.id, line_id: last.line_id, is_checkpoint: false, reverses_entry_id: null, key_version: wrap.key_version, schema_version: 1, nonce: toB64(sealed.nonce), ciphertext: toB64(sealed.ciphertext) });
  expect(r.status).toBe(201);
  return { entryId: payload.id };
}

test("PETTY-523: a tool's entry checks also after a reload with no network, and a revocation the app saw stays, online and offline", async ({ browser }) => {
  const alice = await signupWithKeys("alice");
  const ctx = await browser.newContext(); const page = watched(await ctx.newPage());
  await loginAndUnlock(page, alice);
  const { drawerId, lineId } = await makeLine(page, "Toolbox");
  const { entryId } = await toolAdds(alice, drawerId, 500);
  const line = `/drawers/${drawerId}/lines/${lineId}`;
  const counted = async (balance: string, rows: number, problems: string | null) => {
    await expect(page.getByTestId("line-balance")).toHaveText(balance);
    await expect(page.getByTestId("entry-row")).toHaveCount(rows);
    if (problems === null) await expect(page.getByTestId("warn-problems")).toHaveCount(0);
    else await expect(page.getByTestId("warn-problems")).toContainText(problems);
  };
  await page.goto(line);
  await counted("105.00", 2, null);
  // no network: the reload starts from the copy kept on this device, the delegation included
  await page.route("**/api/**", (r) => r.abort("internetdisconnected"));
  await page.reload(); // still unlocked within 24 h: no prompt
  await expect(page.getByTestId("offline-banner")).toContainText("Showing what was loaded last time");
  await counted("105.00", 2, null);
  // the token is revoked before the server took the entry: online, the entry is out of the balance
  await page.unroute("**/api/**");
  await dbQuery("update access_tokens set revoked_at = (select received_at - interval '1 second' from entries where id = $1) where user_id = (select author_id from entries where id = $1)", [entryId]);
  await page.reload();
  await counted("100.00", 1, "1 entry could not be read or verified");
  // the server then forgets the revocation: the app does not
  await dbQuery("update access_tokens set revoked_at = null where user_id = (select author_id from entries where id = $1)", [entryId]);
  await page.reload();
  await counted("100.00", 1, "1 entry could not be read or verified");
  // and neither does the copy kept for a start with no network
  await page.route("**/api/**", (r) => r.abort("internetdisconnected"));
  await page.reload();
  await expect(page.getByTestId("offline-banner")).toContainText("Showing what was loaded last time");
  await counted("100.00", 1, "1 entry could not be read or verified");
  await ctx.close();
});
