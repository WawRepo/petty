import type { Page } from "@playwright/test";
import { createDrawerKey, sealDocument, toB64 } from "@petty/crypto";
import { acceptViaUi, apiClient, dbQuery, editUserDoc, expect, inviteViaUi, loginAndUnlock, makeDrawer, openSettings, readDrawerDoc, readUserDoc, rowNamed, signupWithKeys, test } from "./fixtures.js";

/**
 * PETTY-439, PETTY-422: the server's version number of a sealed document is a plain column that the server
 * writes. The user document and each drawer's document carry a counter inside the encryption, and the app
 * compares that. The attacker here has database access and kept older sealed copies.
 */
const API = `http://127.0.0.1:${process.env["API_PORT"] ?? "3000"}`;
const OLDER_DRAWER = "older version of this drawer";

async function addItem(page: Page, drawerId: string, name: string, currency: string, start: string): Promise<void> {
  await page.goto(`/drawers/${drawerId}`);
  await page.getByRole("button", { name: "Add item" }).click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Currency", { exact: true }).fill(currency);
  await page.getByLabel("Starting balance").fill(start);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByTestId("line-row").filter({ hasText: name })).toContainText(`${start}.00 ${currency}`);
}
async function rename(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "Drawer options" }).click();
  await page.getByRole("button", { name: "Rename" }).click();
  await page.getByRole("dialog").getByRole("textbox").fill(name);
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
}

interface Sealed { readonly version: number; readonly row: { author_id?: string; key_version?: number; schema_version: number; nonce: Buffer; ciphertext: Buffer } }
async function drawerDocNow(drawerId: string): Promise<Sealed> {
  const [d] = (await dbQuery("select version from drawers where id = $1", [drawerId])) as { version: number }[];
  const [row] = (await dbQuery("select author_id, key_version, schema_version, nonce, ciphertext from drawer_documents where drawer_id = $1", [drawerId])) as Sealed["row"][];
  return { version: d!.version, row: row! };
}
/** The attacker puts a kept sealed document in place and numbers it as it likes. */
async function serveDrawerDoc(drawerId: string, kept: Sealed, version: number): Promise<void> {
  await dbQuery("update drawer_documents set author_id = $2, key_version = $3, schema_version = $4, nonce = $5, ciphertext = $6 where drawer_id = $1", [drawerId, kept.row.author_id, kept.row.key_version, kept.row.schema_version, kept.row.nonce, kept.row.ciphertext]);
  await dbQuery("update drawers set version = $2 where id = $1", [drawerId, version]);
}
async function userDocNow(userId: string): Promise<Sealed> {
  const [row] = (await dbQuery("select version, schema_version, nonce, ciphertext from user_docs where user_id = $1", [userId])) as (Sealed["row"] & { version: number })[];
  return { version: row!.version, row: row! };
}
async function serveUserDoc(userId: string, kept: Sealed, version: number): Promise<void> {
  await dbQuery("update user_docs set schema_version = $2, nonce = $3, ciphertext = $4, version = $5 where user_id = $1", [userId, kept.row.schema_version, kept.row.nonce, kept.row.ciphertext, version]);
}

async function twoMembers(browser: import("@playwright/test").Browser) {
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
  return { alice, bob, ctxA, pageA, ctxB, pageB, id };
}

test("PETTY-439: an older sealed copy of the trusted-keys list under a newer version number gives the warning; a drawer someone else shared stays closed until a new list is started", async ({ browser }) => {
  const s = await twoMembers(browser);
  const bobId = (await apiClient(s.bob)).id;
  await s.pageB.goto(`/drawers/${s.id}`);
  await expect(s.pageB.getByTestId("line-row").first()).toContainText("100.00 EUR");
  // the copy the attacker keeps: alice is confirmed in it, and the drawer's key is accepted
  await expect.poll(async () => (await readUserDoc(s.bob))?.doc.drawer_revs?.[s.id] ?? 0).toBeGreaterThan(0);
  const kept = await userDocNow(bobId);
  const keptRev = (await readUserDoc(s.bob))!.doc.rev!;
  expect((await readUserDoc(s.bob))!.doc.v).toBe(2);
  // bob's list changes after that, and his browser sees the newer one
  await editUserDoc(s.bob, (doc) => { doc.hide_totals = true; });
  await s.pageB.reload();
  await expect(s.pageB.getByTestId("line-row").first()).toContainText("100.00 EUR");
  await expect(s.pageB.getByTestId("pins-rolled-back")).toHaveCount(0);
  const now = await userDocNow(bobId);
  expect((await readUserDoc(s.bob))!.doc.rev).toBe(keptRev + 1);

  // the older copy, numbered as the newest and then as newer still: the warning both times, and the drawer alice shared stays closed
  for (const version of [now.version, now.version + 5]) {
    await serveUserDoc(bobId, kept, version);
    await s.pageB.goto("/");
    await expect(s.pageB.getByTestId("pins-rolled-back")).toContainText("does not number it as older");
    await s.pageB.goto(`/drawers/${s.id}`);
    await expect(s.pageB.getByRole("alert")).toContainText("Petty cannot check that person now");
    // nothing is saved on top of the older copy
    await s.pageB.waitForTimeout(500);
    expect((await userDocNow(bobId)).version).toBe(version);
  }
  // the real one back: no warning
  await serveUserDoc(bobId, now, now.version + 5);
  await s.pageB.goto("/");
  await expect(rowNamed(s.pageB, "Shared")).toBeVisible();
  await expect(s.pageB.getByTestId("pins-rolled-back")).toHaveCount(0);
  // the older copy again; bob reads the warning and starts a new list from it
  await serveUserDoc(bobId, kept, now.version + 6);
  await s.pageB.reload();
  await s.pageB.getByRole("button", { name: "Start a new list of trusted keys" }).click();
  await expect(s.pageB.getByTestId("pins-rolled-back")).toHaveCount(0);
  await s.pageB.reload();
  await expect(rowNamed(s.pageB, "Shared")).toBeVisible();
  await expect(s.pageB.getByTestId("pins-rolled-back")).toHaveCount(0);
  await s.ctxA.close(); await s.ctxB.close();
});

test("PETTY-439: a trusted-keys list from before the counter opens, gets its counter at that load, and an older copy of it is caught from then on", async ({ page }) => {
  const user = await signupWithKeys("carol");
  const userId = (await apiClient(user)).id;
  const pin = { ecdh: "AAAA", ecdsa: "BBBB", sig_key_id: "0".repeat(32), pinned_at: "2026-10-01T00:00:00.000Z", confirmed_at: null };
  // as a Petty from before the counter left it
  await editUserDoc(user, (doc) => { doc.pins["11111111-1111-4111-8111-111111111111"] = pin; doc.hide_places = true; }, { older: true });
  const before = await userDocNow(userId);
  expect((await readUserDoc(user))!.doc).toEqual({ v: 1, pins: { "11111111-1111-4111-8111-111111111111": pin }, hide_places: true });

  await loginAndUnlock(page, user);
  await expect.poll(async () => (await readUserDoc(user))!.doc.rev ?? 0).toBe(1);
  expect(await readUserDoc(user)).toEqual({ version: before.version + 1, doc: { v: 2, rev: 1, pins: { "11111111-1111-4111-8111-111111111111": pin }, hide_places: true } });
  await expect(page.getByTestId("pins-rolled-back")).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Petty" })).toBeVisible();
  await expect(page.getByTestId("pins-rolled-back")).toHaveCount(0);
  expect((await readUserDoc(user))!.version).toBe(before.version + 1); // one write, not one per load

  // the copy from before the counter comes back under a newer number
  await serveUserDoc(userId, before, before.version + 3);
  await page.reload();
  await expect(page.getByTestId("pins-rolled-back")).toContainText("does not number it as older");
  expect((await userDocNow(userId)).version).toBe(before.version + 3);
});

test("PETTY-422: an older sealed document of a drawer under a newer version number is refused, at the next save and at the next start", async ({ browser }) => {
  const s = await twoMembers(browser);
  const before = await drawerDocNow(s.id); // Cash only
  await addItem(s.pageA, s.id, "Coins", "PLN", "7");
  await s.pageB.goto(`/drawers/${s.id}`);
  await expect(rowNamed(s.pageB, "Coins")).toBeVisible();
  await expect(s.pageB.getByRole("alert")).toHaveCount(0);
  // the document has its counter inside, and bob's user document remembers the one he opened
  const opened = await readDrawerDoc(s.alice, s.id);
  expect(opened).toMatchObject({ schemaVersion: 2, doc: { rev: 3, name: "Shared" } });
  await expect.poll(async () => (await readUserDoc(s.bob))?.doc.drawer_revs?.[s.id]).toBe(3);
  const now = await drawerDocNow(s.id);

  // the document from before Coins comes back under a newer number. Bob still has the drawer on screen:
  // his save is refused for its number, the app reads the drawer again, and does not build on the older copy.
  await serveDrawerDoc(s.id, before, now.version + 1);
  await rename(s.pageB, "Renamed");
  await expect(s.pageB.getByRole("alert")).toContainText(OLDER_DRAWER);
  // nor is it opened at the next start, under that number or under the real one
  await s.pageB.reload();
  await expect(s.pageB.getByRole("alert")).toContainText(OLDER_DRAWER);
  await serveDrawerDoc(s.id, before, now.version);
  await s.pageB.reload();
  await expect(s.pageB.getByRole("alert")).toContainText(OLDER_DRAWER);
  await s.pageB.goto("/");
  await expect(rowNamed(s.pageB, "Shared")).toHaveCount(0); // listed with the reason, not as an open drawer
  await expect(s.pageB.getByText(OLDER_DRAWER)).toBeVisible();
  // nothing was written on top of it
  expect(await drawerDocNow(s.id)).toMatchObject({ version: now.version, row: { nonce: before.row.nonce } });
  // the real document back: it opens, with no warning
  await serveDrawerDoc(s.id, now, now.version);
  await s.pageB.goto(`/drawers/${s.id}`);
  await expect(rowNamed(s.pageB, "Coins")).toBeVisible();
  await expect(s.pageB.getByRole("alert")).toHaveCount(0);
  await s.ctxA.close(); await s.ctxB.close();
});

test("PETTY-422: a drawer refused for an older counter is no dead end: its owner puts back a version from the drawer's own screen, and every member opens it again", async ({ browser }) => {
  const s = await twoMembers(browser);
  await addItem(s.pageA, s.id, "Coins", "PLN", "7");
  const withCoins = await drawerDocNow(s.id); // the copy that comes back later
  await rename(s.pageA, "Renamed");
  await expect(s.pageA.getByRole("heading", { name: "Renamed" })).toBeVisible();
  await s.pageA.reload();
  await expect(s.pageA.getByRole("heading", { name: "Renamed" })).toBeVisible();
  await s.pageB.goto(`/drawers/${s.id}`);
  await expect(s.pageB.getByRole("heading", { name: "Renamed" })).toBeVisible();
  for (const who of [s.alice, s.bob]) await expect.poll(async () => (await readUserDoc(who))?.doc.drawer_revs?.[s.id]).toBe(4);

  // the copy from before the rename, under a newer number: both apps refuse it
  await serveDrawerDoc(s.id, withCoins, (await drawerDocNow(s.id)).version + 1);
  await s.pageB.reload();
  await expect(s.pageB.getByRole("alert")).toContainText(OLDER_DRAWER);
  await s.pageA.reload();
  await expect(s.pageA.getByTestId("drawer-damaged")).toContainText(OLDER_DRAWER);
  // the owner's way out: Earlier versions, on the drawer's own screen
  await s.pageA.getByTestId("drawer-history").click();
  await s.pageA.getByTestId("history-row").filter({ hasText: "Shared" }).filter({ hasText: "2 items" }).getByRole("button", { name: /^Restore the version from/ }).click();
  await expect(s.pageA.getByText("Earlier version restored.")).toBeVisible();
  // a counter above every one either app remembers
  await expect.poll(async () => (await readDrawerDoc(s.alice, s.id)).doc.rev).toBe(5);
  expect((await readDrawerDoc(s.alice, s.id)).doc).toMatchObject({ name: "Shared" });
  for (const page of [s.pageA, s.pageB]) {
    await page.goto(`/drawers/${s.id}`);
    await expect(rowNamed(page, "Coins")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Shared" })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
  }
  await s.ctxA.close(); await s.ctxB.close();
});

test("PETTY-422: two members who save at the same time, and a tool that edits the drawer: the counter goes up by one each time, and nobody is warned", async ({ browser }) => {
  const { connect } = await import("../../../packages/agent/src/index.js");
  const s = await twoMembers(browser);
  expect((await readDrawerDoc(s.alice, s.id)).doc.rev).toBe(2); // made, then Cash added
  // both have the drawer on screen
  await s.pageA.goto(`/drawers/${s.id}`);
  await s.pageB.goto(`/drawers/${s.id}`);
  await expect(rowNamed(s.pageB, "Cash")).toBeVisible();
  // alice adds an item; bob, who has not seen that, renames the drawer: his save is refused once, reads again, and goes on top
  await addItem(s.pageA, s.id, "Coins", "PLN", "7");
  await rename(s.pageB, "Renamed");
  await expect(s.pageB.getByRole("heading", { name: "Renamed" })).toBeVisible();
  await expect(rowNamed(s.pageB, "Coins")).toBeVisible();
  expect(await readDrawerDoc(s.alice, s.id)).toMatchObject({ schemaVersion: 2, doc: { rev: 4, name: "Renamed" } });
  await s.pageA.reload();
  await expect(s.pageA.getByRole("heading", { name: "Renamed" })).toBeVisible();
  await expect(s.pageA.getByRole("alert")).toHaveCount(0);

  // a tool with a write token of alice's moves the drawer to a place and tags an item
  await s.pageA.goto("/");
  await openSettings(s.pageA);
  await s.pageA.getByTestId("token-new").click();
  await s.pageA.getByTestId("token-name").fill("Writer");
  await s.pageA.getByTestId("token-write").check();
  await s.pageA.getByTestId("token-scope-all").check();
  await s.pageA.getByTestId("token-passphrase").fill(s.alice.passphrase);
  await s.pageA.getByTestId("token-create").click();
  const token = (await s.pageA.getByTestId("token-value").innerText()).trim();
  await s.pageA.getByTestId("token-done").click();
  const tool = await connect({ token, apiUrl: API });
  await tool.moveDrawer(s.id, ["Shed"]);
  const cash = (await tool.drawers()).find((d) => d.id === s.id)!.lines.find((l) => l.name === "Cash")!;
  await tool.tagItem(s.id, cash.id, "notes");
  expect(await readDrawerDoc(s.alice, s.id)).toMatchObject({ schemaVersion: 2, doc: { rev: 6, name: "Renamed", tags: ["Shed"] } });
  for (const page of [s.pageA, s.pageB]) {
    await page.goto(`/drawers/${s.id}`);
    await expect(rowNamed(page, "Coins")).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.goto("/");
    await expect(page.getByTestId("drawer-attention")).toHaveCount(0);
  }
  await expect.poll(async () => (await readUserDoc(s.bob))?.doc.drawer_revs?.[s.id]).toBe(6);

  // deleting an item writes the document too: the next counter, and nobody is warned
  await s.pageA.goto(`/drawers/${s.id}`);
  await rowNamed(s.pageA, "Coins").click();
  await s.pageA.getByRole("button", { name: "Options for Coins" }).click();
  await s.pageA.getByRole("button", { name: "Delete item", exact: true }).click();
  await s.pageA.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(rowNamed(s.pageA, "Coins")).toBeHidden();
  // the screen goes back before the save is through: wait for the stored document
  await expect.poll(async () => (await readDrawerDoc(s.alice, s.id)).doc.lines.map((l) => l.name)).toEqual(["Cash"]);
  expect(await readDrawerDoc(s.alice, s.id)).toMatchObject({ schemaVersion: 2, doc: { rev: 7, name: "Renamed" } });
  await s.pageB.goto(`/drawers/${s.id}`);
  await expect(rowNamed(s.pageB, "Cash")).toBeVisible();
  await expect(rowNamed(s.pageB, "Coins")).toBeHidden();
  await expect(s.pageB.getByRole("alert")).toHaveCount(0);
  await expect.poll(async () => (await readUserDoc(s.bob))?.doc.drawer_revs?.[s.id]).toBe(7);
  await s.ctxA.close(); await s.ctxB.close();
});

test("PETTY-422: a version put back from Earlier versions and a key replaced after a member leaves: the counter never goes down, and nobody is warned", async ({ browser }) => {
  const s = await twoMembers(browser);
  await s.pageA.goto(`/drawers/${s.id}`);
  await rename(s.pageA, "Oops");
  await expect(s.pageA.getByRole("heading", { name: "Oops" })).toBeVisible();
  await s.pageB.goto(`/drawers/${s.id}`);
  await expect(s.pageB.getByRole("heading", { name: "Oops" })).toBeVisible();
  await expect.poll(async () => (await readUserDoc(s.bob))?.doc.drawer_revs?.[s.id]).toBe(3);

  // alice puts back the version from before the rename: her app opens the kept copy and saves it with the next counter
  await s.pageA.getByRole("button", { name: "Drawer options" }).click();
  await s.pageA.getByTestId("drawer-history").click();
  await s.pageA.getByTestId("history-row").filter({ hasText: "Shared" }).filter({ hasText: "1 item" }).getByRole("button", { name: /^Restore the version from/ }).click();
  await expect(s.pageA.getByText("Earlier version restored.")).toBeVisible();
  await expect(s.pageA.getByRole("heading", { name: "Shared" })).toBeVisible();
  const restored = await readDrawerDoc(s.alice, s.id);
  expect(restored).toMatchObject({ version: 4, keyVersion: 1, schemaVersion: 2, doc: { rev: 4, name: "Shared" } });
  await s.pageB.reload();
  await expect(s.pageB.getByRole("heading", { name: "Shared" })).toBeVisible();
  await expect(s.pageB.getByRole("alert")).toHaveCount(0);
  // the version that was replaced is in the list in turn
  await s.pageA.getByRole("button", { name: "Drawer options" }).click();
  await s.pageA.getByTestId("drawer-history").click();
  await expect(s.pageA.getByTestId("history-row").filter({ hasText: "Oops" })).toBeVisible();

  // bob leaves; alice's app replaces the drawer key and re-seals the document as it is
  expect((await (await apiClient(s.bob)).call("POST", `/drawers/${s.id}/leave`)).status).toBe(204);
  await s.pageA.goto(`/drawers/${s.id}`);
  const aliceApi = await apiClient(s.alice);
  await expect.poll(async () => (await aliceApi.call("GET", `/drawers/${s.id}/rotation`)).json, { timeout: 20_000 }).toMatchObject({ completed: true, key_version: 2 });
  expect(await readDrawerDoc(s.alice, s.id)).toMatchObject({ version: 4, keyVersion: 2, schemaVersion: 2, doc: { rev: 4, name: "Shared" } });
  await s.pageA.reload();
  await expect(s.pageA.getByTestId("line-row").first()).toContainText("100.00 EUR");
  await expect(s.pageA.getByRole("alert")).toHaveCount(0);
  // a kept version that is sealed with the key from before still opens in the list, and can be put back
  await s.pageA.getByRole("button", { name: "Drawer options" }).click();
  await s.pageA.getByTestId("drawer-history").click();
  await s.pageA.getByTestId("history-row").filter({ hasText: "Oops" }).getByRole("button", { name: /^Restore the version from/ }).click();
  await expect(s.pageA.getByText("Earlier version restored.")).toBeVisible();
  await expect(s.pageA.getByRole("heading", { name: "Oops" })).toBeVisible();
  expect(await readDrawerDoc(s.alice, s.id)).toMatchObject({ version: 5, keyVersion: 2, schemaVersion: 2, doc: { rev: 5, name: "Oops" } });
  await s.pageA.reload();
  await expect(s.pageA.getByRole("heading", { name: "Oops" })).toBeVisible();
  await expect(s.pageA.getByRole("alert")).toHaveCount(0);
  await s.ctxA.close(); await s.ctxB.close();
});

test("PETTY-422: a drawer from before the counter opens as before, gets its counter the next time the web app saves it, and an older copy is refused from then on", async ({ page }) => {
  const user = await signupWithKeys("dora");
  const api = await apiClient(user);
  // as a Petty from before the counter left the account: a user document without a counter, and a drawer whose document has none (format 1)
  await editUserDoc(user, () => undefined, { older: true });
  const id = crypto.randomUUID();
  const { key, selfWrap } = await createDrawerKey({ ecdhPrivate: user.keys.ecdh.privateKey, ecdhPublicB64: user.ecdhPub }, id, 1);
  const plain = { v: 1, name: "Old tin", has_photo: false, lines: [{ id: crypto.randomUUID(), kind: "single", name: "Passport", text: "blue box" }], verifications: [] };
  const sealed = await sealDocument(key, { record_type: "document", record_id: id, drawer_id: id, line_id: null, author_id: api.id, key_version: 1, schema_version: 1 }, plain);
  expect((await api.call("POST", "/drawers", { id, document: { key_version: 1, schema_version: 1, nonce: toB64(sealed.nonce), ciphertext: toB64(sealed.ciphertext) }, self_wrap: selfWrap })).status).toBe(201);
  const before = await drawerDocNow(id);

  await loginAndUnlock(page, user);
  await rowNamed(page, "Old tin").click();
  await expect(rowNamed(page, "Passport")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByTestId("pins-rolled-back")).toHaveCount(0);
  // opening changes nothing: the document keeps its format until someone saves it
  await page.reload();
  await expect(rowNamed(page, "Passport")).toBeVisible();
  expect(await readDrawerDoc(user, id)).toEqual({ version: 1, keyVersion: 1, schemaVersion: 1, doc: plain });
  expect((await readUserDoc(user))!.doc.drawer_revs?.[id]).toBeUndefined();

  // the first save: format 2, the counter at 1, the content kept
  await rename(page, "Tin");
  // exact: "Old tin" holds "Tin" too, and would match before the save is through
  await expect(page.getByRole("heading", { name: "Tin", exact: true })).toBeVisible();
  expect(await readDrawerDoc(user, id)).toEqual({ version: 2, keyVersion: 1, schemaVersion: 2, doc: { ...plain, name: "Tin", rev: 1 } });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Tin", exact: true })).toBeVisible();
  await expect.poll(async () => (await readUserDoc(user))?.doc.drawer_revs?.[id]).toBe(1);

  // the copy from before the counter comes back under a newer number
  await serveDrawerDoc(id, before, 3);
  await page.reload();
  await expect(page.getByRole("alert")).toContainText(OLDER_DRAWER);
});

test("PETTY-422: a drawer document in a format this Petty does not know says so, and is not written over", async ({ page }) => {
  const user = await signupWithKeys("erin");
  await loginAndUnlock(page, user);
  const id = await makeDrawer(page, "Tin");
  const now = await drawerDocNow(id);
  // a row that names a later format, as a newer Petty would store it
  await dbQuery("update drawer_documents set schema_version = 3 where drawer_id = $1", [id]);
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("saved by a newer version of Petty");
  await page.goto("/");
  await expect(page.getByText("saved by a newer version of Petty")).toBeVisible();
  expect(await drawerDocNow(id)).toMatchObject({ version: now.version, row: { nonce: now.row.nonce } });
  await dbQuery("update drawer_documents set schema_version = 2 where drawer_id = $1", [id]);
  await page.goto(`/drawers/${id}`);
  await expect(page.getByTestId("line-row").first()).toContainText("100.00 EUR");
});
