/**
 * PETTY-443: what a member stores in a shared drawer cannot stop the app for the others. A drawer whose
 * content cannot be shown is listed as damaged, with the reason; Home and the other drawers work, and the
 * damaged drawer's own screen offers the ways out its role allows.
 * Alice owns the drawers and uses the browser. Bob is a second member with the write role: he writes
 * through the API from Node, with the drawer key alice shared with him.
 */
import type { Browser, Page } from "@playwright/test";
import {
  exportPublicKeys, fromB64, hashEntry, openDocument, openEntryUnverified, sealDocument, sealEntry, signEntry, signingKeyId, toB64, unwrapDrawerKey,
  type DrawerKeyWrapV1, type RecordIdentity,
} from "@petty/crypto";
import { apiClient, expect, loginAndUnlock, makeDrawer, rowNamed, shareViaApi, signupWithKeys, test, type TestUserWithKeys } from "./fixtures.js";

interface Row { author_id: string; key_version: number; schema_version: number; nonce: string; ciphertext: string }
interface EntryRow extends Row { id: string; line_id: string; seq: number; schema_version: number }
interface Boot { drawers: { id: string; version: number; key_version: number }[]; documents: Record<string, Row>; wraps: (DrawerKeyWrapV1 & { drawer_id: string })[]; entries: (EntryRow & { drawer_id: string })[] }
interface Doc { lines: { id: string; name: string }[]; verifications: unknown[]; [k: string]: unknown }

/** Bob's side of a shared drawer, in Node: the drawer key, the document as it is now, and two ways to write. */
async function member(bob: TestUserWithKeys, owner: TestUserWithKeys, drawerId: string) {
  const api = await apiClient(bob);
  const load = async () => (await api.call("GET", "/bootstrap")).json as Boot;
  const first = await load();
  const wrap = first.wraps.find((w) => w.drawer_id === drawerId)!;
  const key = await unwrapDrawerKey(wrap, bob.keys.ecdh.privateKey, { drawer_id: drawerId, key_version: wrap.key_version, senderEcdhPublicB64: owner.ecdhPub });
  const docId = (author: string, schemaVersion: number): RecordIdentity => ({ record_type: "document", record_id: drawerId, drawer_id: drawerId, line_id: null, author_id: author, key_version: wrap.key_version, schema_version: schemaVersion });
  const document = async (): Promise<Doc> => {
    const row = (await load()).documents[drawerId]!;
    return (await openDocument(key, docId(row.author_id, row.schema_version), { nonce: fromB64(row.nonce), ciphertext: fromB64(row.ciphertext) })) as Doc;
  };
  /** Replaces the drawer's document, as any writer may: in the stored format, with the counter it read plus one (PETTY-422). */
  const putDocument = async (doc: Doc): Promise<void> => {
    const boot = await load();
    const base = boot.drawers.find((d) => d.id === drawerId)!.version;
    const format = boot.documents[drawerId]!.schema_version;
    const next = format >= 2 ? { ...doc, rev: ((doc["rev"] as number | undefined) ?? 0) + 1 } : doc;
    const sealed = await sealDocument(key, docId(api.id, format), next);
    const r = await api.call("PUT", `/drawers/${drawerId}/document`, { base_version: base, key_version: wrap.key_version, schema_version: format, nonce: toB64(sealed.nonce), ciphertext: toB64(sealed.ciphertext), verification: false });
    if (r.status !== 200) throw new Error(`document refused: ${r.status} ${JSON.stringify(r.json)}`);
  };
  /** Appends one signed entry to a line, linked to the line's newest entry. */
  const addEntry = async (lineId: string, amount: number): Promise<void> => {
    const last = (await load()).entries.filter((e) => e.drawer_id === drawerId && e.line_id === lineId).sort((a, b) => a.seq - b.seq).at(-1);
    const prev = last ? await openEntryUnverified(key, { record_type: "entry", record_id: last.id, drawer_id: drawerId, line_id: lineId, author_id: last.author_id, key_version: last.key_version, schema_version: last.schema_version }, { nonce: fromB64(last.nonce), ciphertext: fromB64(last.ciphertext) }) : null;
    const id = crypto.randomUUID();
    const signed = await signEntry({
      v: 1, id, drawer_id: drawerId, line_id: lineId, op: "add", amount, exponent: 2, comment: "", logged_at: new Date().toISOString(), reverses: null,
      prev_hash: prev ? await hashEntry(prev) : null, delta_hint: null, author_id: api.id, sig_key_id: await signingKeyId((await exportPublicKeys(bob.keys)).ecdsa),
    }, bob.keys.ecdsa.privateKey);
    const sealed = await sealEntry(key, { record_type: "entry", record_id: id, drawer_id: drawerId, line_id: lineId, author_id: api.id, key_version: wrap.key_version, schema_version: 1 }, signed);
    const r = await api.call("POST", `/drawers/${drawerId}/entries`, { id, line_id: lineId, is_checkpoint: false, reverses_entry_id: null, key_version: wrap.key_version, schema_version: 1, nonce: toB64(sealed.nonce), ciphertext: toB64(sealed.ciphertext) });
    if (r.status !== 201 && r.status !== 200) throw new Error(`entry refused: ${r.status} ${JSON.stringify(r.json)}`);
  };
  return { id: api.id, document, putDocument, addEntry };
}

/** Alice in the browser with two drawers, each with Cash 100.00 EUR: "Kitchen" is hers alone, "Shared" has bob as a writer. */
async function household(browser: Browser) {
  const alice = await signupWithKeys("alice");
  const bob = await signupWithKeys("bob");
  const context = await browser.newContext();
  const page = await context.newPage();
  await loginAndUnlock(page, alice);
  await makeDrawer(page, "Kitchen");
  await page.goto("/");
  const shared = await makeDrawer(page, "Shared");
  await shareViaApi(alice, shared, bob, "write");
  return { alice, bob, context, page, shared, bobs: await member(bob, alice, shared) };
}

/** Home is drawn, with both drawers listed, and the app did not fall back to its error screen. */
async function homeWorks(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("home")).toHaveAttribute("data-status", "ready");
  await expect(page.getByTestId("drawer-row")).toHaveCount(2);
  await expect(page.getByTestId("crash-screen")).toHaveCount(0);
  // the drawer nobody touched opens as ever
  await rowNamed(page, "Kitchen").click();
  await expect(page.getByTestId("line-row").first()).toContainText("100.00 EUR");
  await page.goto("/");
  await expect(page.getByTestId("home")).toHaveAttribute("data-status", "ready");
}

test("an icon name that is no icon of the set draws the default icon, on Home and in the drawer", async ({ browser }) => {
  const { page, shared, bobs, context } = await household(browser);
  const doc = await bobs.document();
  // a valid slug that names no icon, but is the name of something every object has
  await bobs.putDocument({ ...doc, icon: "constructor", lines: doc.lines.map((l) => ({ ...l, icon: "constructor" })) });

  await homeWorks(page);
  const row = page.getByTestId("drawer-row").filter({ hasText: "Shared" });
  await expect(row.locator('[data-icon="constructor"] svg')).toBeVisible();
  await expect(row.getByTestId("row-amount")).toContainText("100.00");
  await row.click();
  await expect(page.getByRole("heading", { name: "Shared" })).toBeVisible();
  await expect(page.getByTestId("line-row").first()).toContainText("100.00 EUR");
  await rowNamed(page, "Cash").click();
  await expect(page.getByTestId("line-balance")).toHaveText("100.00");
  await expect(page.getByTestId("crash-screen")).toHaveCount(0);
  expect(page.url()).toContain(shared);
  await context.close();
});

test("a document that does not pass the check makes its drawer a damaged one; the owner puts back an earlier version", async ({ browser }) => {
  const { page, shared, bobs, context } = await household(browser);
  const doc = await bobs.document();
  const cash = doc.lines[0]!.id;
  // a verification whose stored balance is not a number
  await bobs.putDocument({ ...doc, verifications: [{ id: crypto.randomUUID(), author_id: bobs.id, logged_at: new Date().toISOString(), comment: "", lines: [{ line_id: cash, kind: "money", balance: "10000", present: null, head_seq: 1 }] }] });

  await homeWorks(page);
  const row = page.getByTestId("drawer-row").filter({ hasText: "This drawer's data is damaged" });
  await expect(row).toHaveCount(1);
  // the total says that a drawer is missing from it, and still counts the other one
  await expect(page.getByTestId("home-totals")).toContainText("100.00");
  await expect(page.getByTestId("totals-incomplete")).toBeVisible();

  await row.click();
  await expect(page).toHaveURL(new RegExp(`/drawers/${shared}$`));
  const damaged = page.getByTestId("drawer-damaged");
  await expect(damaged.getByRole("alert")).toHaveText("This drawer's data is damaged. Its owner can put back an earlier version.");
  // the owner's ways out: an earlier version, or deleting; leaving is for the others
  await expect(damaged.getByRole("button", { name: "Delete drawer" })).toBeVisible();
  await expect(damaged.getByRole("button", { name: "Leave drawer" })).toHaveCount(0);
  await damaged.getByRole("button", { name: "Earlier versions" }).click();
  const version = page.getByTestId("history-row").filter({ hasText: "Shared" }).first();
  await expect(version).toContainText("1 item");
  await version.getByRole("button", { name: /^Restore the version from/ }).click();
  await expect(page.getByText("Earlier version restored.")).toBeVisible();
  // the drawer is back, with its item and its balance
  await expect(page.getByRole("heading", { name: "Shared" })).toBeVisible();
  await expect(page.getByTestId("line-row").first()).toContainText("100.00 EUR");
  await expect(page.getByTestId("drawer-damaged")).toHaveCount(0);
  await context.close();
});

test("entries that add up past the exact integers make their drawer a damaged one, with the reason; each role gets its own ways out", async ({ browser }) => {
  const { page, shared, bobs, bob, context } = await household(browser);
  const cash = (await bobs.document()).lines[0]!.id;
  await bobs.addEntry(cash, Number.MAX_SAFE_INTEGER);
  await bobs.addEntry(cash, Number.MAX_SAFE_INTEGER);

  await homeWorks(page);
  // listed by its name, with the reason and without any amount
  const row = page.getByTestId("drawer-row").filter({ hasText: "Shared" });
  await expect(row).toContainText("The amounts in this drawer add up to a number too large to show");
  await expect(row.getByTestId("row-amount")).toHaveCount(0);
  await expect(page.getByTestId("home-totals")).toContainText("100.00");
  await expect(page.getByTestId("totals-incomplete")).toBeVisible();

  // the owner: the reason, Earlier versions, Delete
  await row.click();
  const damaged = page.getByTestId("drawer-damaged");
  await expect(damaged.getByRole("alert")).toContainText("too large to show");
  await expect(page.getByRole("heading", { name: "Shared" })).toBeVisible();
  await expect(damaged.getByRole("button", { name: "Leave drawer" })).toHaveCount(0);
  await damaged.getByRole("button", { name: "Earlier versions" }).click();
  await expect(page.getByTestId("history-row").first()).toBeVisible();
  await page.keyboard.press("Escape");
  // an item's own address leads to the same view, not to an endless wait
  await page.goto(`/drawers/${shared}/lines/${cash}`);
  await expect(page.getByTestId("drawer-damaged")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/drawers/${shared}$`));

  // bob, a member: the same reason; he may leave, and nothing else
  const bobContext = await browser.newContext();
  const bobPage = await bobContext.newPage();
  await loginAndUnlock(bobPage, bob);
  await bobPage.getByTestId("drawer-row").filter({ hasText: "Shared" }).click();
  const bobDamaged = bobPage.getByTestId("drawer-damaged");
  await expect(bobDamaged.getByRole("alert")).toContainText("too large to show");
  await expect(bobDamaged.getByRole("button", { name: "Earlier versions" })).toHaveCount(0);
  await expect(bobDamaged.getByRole("button", { name: "Delete drawer" })).toHaveCount(0);
  await bobDamaged.getByRole("button", { name: "Leave drawer" }).click();
  await bobPage.getByRole("dialog").getByRole("button", { name: "Leave drawer" }).click();
  await expect(bobPage.getByTestId("home")).toHaveAttribute("data-status", "ready");
  await expect(bobPage.getByTestId("drawer-row")).toHaveCount(0);
  await bobContext.close();

  // the owner deletes it: typed, as any drawer
  await page.reload();
  await page.getByTestId("drawer-damaged").getByRole("button", { name: "Delete drawer" }).click();
  await page.getByTestId("delete-drawer-name").fill("Shared");
  await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByTestId("home")).toHaveAttribute("data-status", "ready");
  await expect(page.getByTestId("drawer-row")).toHaveCount(1);
  await expect(rowNamed(page, "Kitchen")).toBeVisible();
  await context.close();
});

test("a drawer that fails to draw is fenced in: its row and its screen say so, Home and the other drawers stay", async ({ browser }) => {
  const { page, shared, bobs, context } = await household(browser);
  const doc = await bobs.document();
  // one verification, so the drawer's row and screen read the time of the last check
  await bobs.putDocument({ ...doc, verifications: [{ id: crypto.randomUUID(), author_id: bobs.id, logged_at: new Date().toISOString(), comment: "", lines: [] }] });
  // The server's answer names a time for that check that is no time. Nothing checks for it when the drawer
  // opens, so drawing the drawer fails: the case the fences are for.
  await page.route("**/api/bootstrap", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { drawers: { id: string; last_verified_at: string | null }[] };
    for (const d of body.drawers) if (d.id === shared) d.last_verified_at = "not a time";
    await route.fulfill({ response: res, json: body });
  });

  await homeWorks(page);
  const row = page.getByTestId("drawer-row").filter({ hasText: "Shared" });
  await expect(row).toContainText("This drawer's data is damaged");
  await row.click();
  // the drawer's own screen: the damaged view inside the app's frame, with the owner's ways out
  const damaged = page.getByTestId("drawer-damaged");
  await expect(damaged.getByRole("alert")).toHaveText("This drawer's data is damaged. Its owner can put back an earlier version.");
  await expect(page.getByRole("heading", { name: "Shared" })).toBeVisible();
  await expect(page.getByTestId("account-menu")).toBeVisible();
  await expect(page.getByTestId("crash-screen")).toHaveCount(0);
  await expect(damaged.getByRole("button", { name: "Delete drawer" })).toBeVisible();
  await damaged.getByRole("button", { name: "Earlier versions" }).click();
  await expect(page.getByTestId("history-row").first()).toBeVisible();
  await context.close();
});

test("an amount that would take a balance past the exact integers is refused at the keypad; a count starts the sum over", async ({ browser }) => {
  const { page, shared, bobs, context } = await household(browser);
  const cash = (await bobs.document()).lines[0]!.id;
  // with the 100.00 that is there, the balance is now the largest number that is still exact
  await bobs.addEntry(cash, Number.MAX_SAFE_INTEGER - 10_000);
  await page.goto(`/drawers/${shared}/lines/${cash}`);
  await expect(page.getByTestId("line-balance")).toHaveText("90,071,992,547,409.91");

  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("group").getByRole("button", { name: "1", exact: true }).click();
  await page.getByRole("button", { name: "Review" }).click();
  await expect(page.getByTestId("amount-error")).toHaveText("Enter a valid amount.");
  await expect(page.getByTestId("confirm-summary")).toHaveCount(0);
  await expect(page.getByTestId("crash-screen")).toHaveCount(0);
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();

  // counting the cash again is the way back to a sane balance
  await page.getByRole("button", { name: "Adjust", exact: true }).click();
  for (const d of "50") await page.getByRole("group").getByRole("button", { name: d, exact: true }).click();
  await page.getByRole("button", { name: "Review" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("line-balance")).toHaveText("50.00");
  await context.close();
});
