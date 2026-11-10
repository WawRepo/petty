import type { Page, Route } from "@playwright/test";
import { acceptViaUi, apiClient, dbQuery, expect, inviteViaUi, loginAndUnlock, makeDrawer, rowNamed, shareViaApi, signupWithKeys, test } from "./fixtures.js";

/**
 * PETTY-440, PETTY-441: a new drawer key, each batch of the re-encryption and deleting an item carry a
 * custody proof. A browser may still run the web app from before that. These tests play it by taking
 * the proof out of the requests on their way to the server: the rest of what it sends is the same.
 */
const START = /\/api\/drawers\/[^/]+\/rotation$/;
const BATCH = /\/api\/drawers\/[^/]+\/rotation\/batch$/;
const DELETE_ITEM = /\/api\/drawers\/[^/]+\/lines\/[^/]+\/delete$/;

async function withoutProof(route: Route): Promise<void> {
  const body = route.request().postDataJSON() as Record<string, unknown> | null;
  if (!body || !("proof" in body)) return route.continue();
  const rest = Object.fromEntries(Object.entries(body).filter(([k]) => k !== "proof"));
  return route.continue({ postData: JSON.stringify(rest) });
}
const refused = (page: Page, path: RegExp) => page.waitForResponse((r) => path.test(new URL(r.url()).pathname) && r.request().method() !== "GET" && r.status() === 403);

test("a web app from before sends no proof: its key change and its item delete are refused and nothing is lost; another member's app finishes the key change, and the updated app deletes the item", async ({ browser }) => {
  const alice = await signupWithKeys("alice");
  const bob = await signupWithKeys("bob");
  const carol = await signupWithKeys("carol");
  const ctxA = await browser.newContext(); const pageA = await ctxA.newPage();
  const ctxB = await browser.newContext(); const pageB = await ctxB.newPage();
  await loginAndUnlock(pageA, alice);
  const id = await makeDrawer(pageA, "Shared");
  await inviteViaUi(pageA, id, bob, "write");
  await loginAndUnlock(pageB, bob);
  await acceptViaUi(pageB);
  await pageB.goto("about:blank"); // bob's app is closed for now
  const aliceApi = await apiClient(alice);
  const state = async () => ({
    ...((await dbQuery("select key_version, rotation_needed from drawers where id = $1", [id])) as { key_version: number; rotation_needed: boolean }[])[0]!,
    entries: ((await dbQuery("select key_version, encode(ciphertext, 'hex') as c from entries where drawer_id = $1 order by seq", [id])) as { key_version: number; c: string }[]),
    document: ((await dbQuery("select key_version, encode(ciphertext, 'hex') as c from drawer_documents where drawer_id = $1", [id])) as { key_version: number; c: string }[])[0]!,
  });

  // a third member comes and goes: the drawer now needs a new key
  await shareViaApi(alice, id, carol, "write");
  expect((await aliceApi.call("DELETE", `/drawers/${id}/members/${(await apiClient(carol)).id}`)).status).toBe(204);
  const before = await state();
  expect(before).toMatchObject({ key_version: 1, rotation_needed: true });
  expect(before.entries).toHaveLength(1);

  // 1. alice's browser still runs the app from before: no request of hers carries a proof
  for (const path of [START, BATCH, DELETE_ITEM]) await pageA.route((url) => path.test(url.pathname), withoutProof);
  const startRefused = refused(pageA, START);
  await pageA.goto(`/drawers/${id}`);
  expect((await (await startRefused).json()).code).toBe("CustodyProofRequired");
  // the drawer says a new key is still due, and reads as before
  await expect(pageA.getByTestId("rotation-needed")).toBeVisible();
  await expect(pageA.getByTestId("line-row").first()).toContainText("100.00 EUR");
  // deleting the item: refused with a message, the item and its history stay
  await rowNamed(pageA, "Cash").click();
  await pageA.getByRole("button", { name: "Options for Cash" }).click();
  await pageA.getByRole("button", { name: "Delete item", exact: true }).click();
  const deleteRefused = refused(pageA, DELETE_ITEM);
  await pageA.getByRole("button", { name: "Delete", exact: true }).click();
  expect((await (await deleteRefused).json()).code).toBe("CustodyProofRequired");
  await expect(pageA.locator(".toast")).toHaveText("Something went wrong. Try again.");
  expect(await state()).toEqual(before);

  // 2. a key change that was begun, with batches from the older app: each is refused and the rows stay as they are
  await pageA.unrouteAll({ behavior: "wait" });
  await pageA.route((url) => BATCH.test(url.pathname), withoutProof);
  const batchRefused = refused(pageA, BATCH);
  await pageA.goto(`/drawers/${id}`);
  expect((await (await batchRefused).json()).code).toBe("CustodyProofRequired");
  await expect.poll(async () => (await aliceApi.call("GET", `/drawers/${id}/rotation`)).json).toMatchObject({ key_version: 2, pending_entries: 1, document_pending: true, completed: false });
  const pending = await state();
  expect(pending).toMatchObject({ key_version: 2, rotation_needed: false, entries: before.entries, document: before.document });
  // the drawer works meanwhile: the old row reads under the old key, a new one is written under the new key
  await pageA.goto(`/drawers/${id}`);
  await expect(pageA.getByTestId("line-row").first()).toContainText("100.00 EUR");
  await rowNamed(pageA, "Cash").click();
  await pageA.getByRole("button", { name: "Add", exact: true }).click();
  await pageA.getByRole("group").getByRole("button", { name: "7", exact: true }).click();
  await pageA.getByRole("button", { name: "Review" }).click();
  await pageA.getByRole("button", { name: "Save", exact: true }).click();
  await expect(pageA.getByTestId("line-balance")).toHaveText("107.00");
  expect((await state()).entries.map((e) => e.key_version)).toEqual([1, 2]);

  // 3. bob opens the current app: it finishes what alice's began, with proofs of his own key
  await pageB.goto("/");
  await expect.poll(async () => (await aliceApi.call("GET", `/drawers/${id}/rotation`)).json, { timeout: 20_000 }).toMatchObject({ key_version: 2, pending_entries: 0, document_pending: false, completed: true });
  await rowNamed(pageB, "Shared").click();
  await expect(pageB.getByTestId("line-row").first()).toContainText("107.00 EUR");

  // 4. alice's app has updated: it reads the re-encrypted drawer and deletes the item
  await pageA.unrouteAll({ behavior: "wait" });
  await pageA.goto(`/drawers/${id}`);
  await expect(pageA.getByTestId("line-row").first()).toContainText("107.00 EUR");
  await rowNamed(pageA, "Cash").click();
  await pageA.getByRole("button", { name: "Options for Cash" }).click();
  await pageA.getByRole("button", { name: "Delete item", exact: true }).click();
  const deleted = pageA.waitForResponse((r) => DELETE_ITEM.test(new URL(r.url()).pathname) && r.status() === 200);
  await pageA.getByRole("button", { name: "Delete", exact: true }).click();
  expect((await (await deleted).json()).deleted_entries).toBe(2);
  await expect(pageA.getByRole("heading", { name: "Shared" })).toBeVisible();
  await expect(pageA.getByTestId("line-row")).toHaveCount(0);
  expect((await state()).entries).toEqual([]);
  await ctxA.close(); await ctxB.close();
});
