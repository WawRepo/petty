import type { Page } from "@playwright/test";
import pg from "pg";
import {
  exportPublicKeys, fromB64, hashEntry, openEntryUnverified, openPatBundle, sealEntry, signEntry, signingKeyId, splitPatToken, toB64, unwrapDrawerKey,
  type DrawerKeyWrapV1, type EntryPayloadV1, type SignedEntryV1,
} from "@petty/crypto";
import { apiClient, dbQuery, expect, loginAndUnlock, makeDrawer, openSettings, rowNamed, shareViaApi, signupWithKeys, test, type TestUserWithKeys } from "./fixtures.js";

/**
 * What a person sees of the history checks (PETTY-444, PETTY-445, PETTY-448): a history that lost entries is reported
 * whatever numbers its rows carry; entries from the command line and the AI add-on raise no warning, linked or not;
 * a row the server calls a count without being one neither resets the balance nor goes unreported.
 */
const API = `http://127.0.0.1:${process.env["API_PORT"] ?? "3000"}`;
const OWNER_DB = process.env["DATABASE_URL"] ?? "postgres://petty:petty@localhost:5432/petty";

interface Row { id: string; seq: number; author_id: string; key_version: number; schema_version: number; nonce: string; ciphertext: string }

async function openLine(page: Page, drawerId: string): Promise<string> {
  const [line] = (await dbQuery("select distinct line_id from entries where drawer_id = $1", [drawerId])) as { line_id: string }[];
  await page.goto(`/drawers/${drawerId}/lines/${line!.line_id}`);
  await expect(page.getByTestId("line-balance")).toBeVisible();
  return line!.line_id;
}
async function entry(page: Page, op: "Add" | "Withdraw" | "Adjust", digits: string): Promise<void> {
  await page.getByRole("button", { name: op, exact: true }).click();
  for (const d of digits) await page.getByRole("group").getByRole("button", { name: d === "." ? "Decimal point" : d, exact: true }).click();
  await page.getByRole("button", { name: "Review" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("confirm-summary")).toBeHidden({ timeout: 15_000 });
}
const noHistoryWarning = async (page: Page) => {
  await expect(page.getByTestId("warn-chain-broken")).toHaveCount(0);
  await expect(page.getByTestId("warn-chain-truncated")).toHaveCount(0);
  await expect(page.getByTestId("warn-problems")).toHaveCount(0);
};
/** Gives a line's rows other numbers, straight in the database: every seq moves up by `by` (triggers off for this connection only). */
async function renumber(drawerId: string, lineId: string, by: number): Promise<void> {
  const c = new pg.Client({ connectionString: OWNER_DB });
  await c.connect();
  try {
    await c.query("set session_replication_role = replica");
    await c.query("update entries set seq = seq + $3 where drawer_id = $1 and line_id = $2", [drawerId, lineId, by]);
    await c.query("update line_heads set head_seq = head_seq + $3, checkpoint_seq = case when checkpoint_seq > 0 then checkpoint_seq + $3 else 0 end where drawer_id = $1 and line_id = $2", [drawerId, lineId, by]);
  } finally { await c.end(); }
}
/** The drawer key and the rows of one line, oldest first, as this member's own program would hold them. */
async function asMember(user: TestUserWithKeys, drawerId: string, lineId: string) {
  const me = await apiClient(user);
  const boot = (await me.call("GET", "/bootstrap")).json as { wraps: DrawerKeyWrapV1[] };
  const wrap = boot.wraps.find((w) => w.drawer_id === drawerId)!;
  const key = await unwrapDrawerKey(wrap, user.keys.ecdh.privateKey, { drawer_id: drawerId, key_version: wrap.key_version, senderEcdhPublicB64: user.ecdhPub });
  const page = (await me.call("GET", `/drawers/${drawerId}/lines/${lineId}/entries?limit=200`)).json as { entries: Row[] };
  const rows: { row: Row; entry: SignedEntryV1 }[] = [];
  for (const row of [...page.entries].reverse()) {
    rows.push({ row, entry: await openEntryUnverified(key, { record_type: "entry", record_id: row.id, drawer_id: drawerId, line_id: lineId, author_id: row.author_id, key_version: row.key_version, schema_version: row.schema_version }, { nonce: fromB64(row.nonce), ciphertext: fromB64(row.ciphertext) }) });
  }
  return { me, key, rows };
}
/** One signed, sealed entry as the body of POST /drawers/:id/entries. */
async function sealedEntry(key: CryptoKey, signWith: CryptoKey, payload: EntryPayloadV1): Promise<Record<string, unknown>> {
  const signed = await signEntry(payload, signWith);
  const sealed = await sealEntry(key, { record_type: "entry", record_id: payload.id, drawer_id: payload.drawer_id, line_id: payload.line_id, author_id: payload.author_id, key_version: 1, schema_version: 1 }, signed);
  return { id: payload.id, line_id: payload.line_id, reverses_entry_id: null, key_version: 1, schema_version: 1, nonce: toB64(sealed.nonce), ciphertext: toB64(sealed.ciphertext) };
}

test("PETTY-444: a history that lost its newest entry is reported as shorter although its rows were renumbered; a renumbered whole history is reported too", async ({ page }) => {
  const user = await signupWithKeys("ren");
  await loginAndUnlock(page, user);
  const drawerId = await makeDrawer(page, "Safe");
  const lineId = await openLine(page, drawerId);
  await entry(page, "Add", "20");
  await entry(page, "Add", "5");
  await expect(page.getByTestId("line-balance")).toHaveText("125.00");
  // the newest row is gone, and the rows that are left carry other numbers
  await dbQuery("delete from entries where id = (select id from entries where drawer_id = $1 and line_id = $2 order by seq desc limit 1)", [drawerId, lineId]);
  await renumber(drawerId, lineId, 10);
  await page.reload();
  await expect(page.getByTestId("warn-chain-truncated")).toContainText("shorter than the last time you saw it");
  await expect(page.getByTestId("line-balance")).toHaveText("120.00");
  await page.goto("/");
  await expect(page.getByTestId("drawer-attention")).toBeVisible();
  await page.goto(`/drawers/${drawerId}/lines/${lineId}`);
  await page.getByRole("button", { name: "Accept as is" }).click();
  await expect(page.getByTestId("warn-chain-truncated")).toBeHidden();
  await page.reload();
  await noHistoryWarning(page);

  // every row is still there, under other numbers
  await renumber(drawerId, lineId, 10);
  await page.reload();
  await expect(page.getByTestId("warn-chain-broken")).toContainText("The history links do not match");
  await expect(page.getByTestId("line-balance")).toHaveText("120.00");
  await page.getByRole("button", { name: "Accept as is" }).click();
  await expect(page.getByTestId("warn-chain-broken")).toBeHidden();
  await page.reload();
  await noHistoryWarning(page);
});

test("PETTY-444: more entries and then a count by another member start a new window with no warning; an entry lost after that is still reported", async ({ browser }) => {
  const alice = await signupWithKeys("alice");
  const bob = await signupWithKeys("bob");
  const ctxA = await browser.newContext(); const pageA = await ctxA.newPage();
  const ctxB = await browser.newContext(); const pageB = await ctxB.newPage();
  await loginAndUnlock(pageA, alice);
  const drawerId = await makeDrawer(pageA, "Shared");
  const lineId = await openLine(pageA, drawerId);
  await entry(pageA, "Add", "20");
  await expect(pageA.getByTestId("line-balance")).toHaveText("120.00"); // alice's browser remembers this entry as the newest
  await shareViaApi(alice, drawerId, bob, "write");
  await loginAndUnlock(pageB, bob);
  await pageB.goto(`/drawers/${drawerId}/lines/${lineId}`);
  await entry(pageB, "Add", "1");
  await entry(pageB, "Withdraw", "2");
  await entry(pageB, "Adjust", "80");
  await entry(pageB, "Add", "3");
  await expect(pageB.getByTestId("line-balance")).toHaveText("83.00");
  await noHistoryWarning(pageB);
  // alice comes back: her newest entry lies before bob's count, with two entries in between
  await pageA.reload();
  await expect(pageA.getByTestId("line-balance")).toHaveText("83.00");
  await expect(pageA.getByTestId("entry-row")).toHaveCount(2);
  await noHistoryWarning(pageA);
  await pageA.goto("/");
  await expect(rowNamed(pageA, "Shared")).toBeVisible();
  await expect(pageA.getByTestId("drawer-attention")).toHaveCount(0);
  // her browser now remembers bob's newest entry: when that one goes, she is told
  await dbQuery("delete from entries where id = (select id from entries where drawer_id = $1 and line_id = $2 order by seq desc limit 1)", [drawerId, lineId]);
  await pageA.goto(`/drawers/${drawerId}/lines/${lineId}`);
  await expect(pageA.getByTestId("warn-chain-truncated")).toBeVisible();
  await expect(pageA.getByTestId("line-balance")).toHaveText("80.00");
  await ctxA.close(); await ctxB.close();
});

test("PETTY-445: entries from a tool raise no history warning, with a link or (as older tools wrote them) without; the remembered newest entry moves on", async ({ page, request }) => {
  const { connect } = await import("../../../packages/agent/src/index.js");
  const user = await signupWithKeys("tool");
  await loginAndUnlock(page, user);
  await page.getByTestId("passkey-nudge").getByRole("button", { name: "Not now" }).click().catch(() => undefined);
  const drawerId = await makeDrawer(page, "Kitchen");
  const lineId = await openLine(page, drawerId);
  await page.goto("/");
  await openSettings(page);
  await page.getByTestId("token-new").click();
  await page.getByTestId("token-name").fill("Tool");
  await page.getByTestId("token-write").check();
  await page.getByTestId("token-scope-all").check(); // PETTY-452: no token without a choice of drawers
  await page.getByTestId("token-passphrase").fill(user.passphrase);
  await page.getByTestId("token-create").click();
  const token = (await page.getByTestId("token-value").innerText()).trim();
  await page.getByTestId("token-done").click();

  // two entries the way tools wrote them before: signed by the token's own key, with no link to the entry before
  const split = splitPatToken(token);
  const bearer = { authorization: `Bearer petty_pat_${split.tokenId}` };
  const self = (await (await request.get(`${API}/me/token`, { headers: bearer })).json()) as { user_id: string; bundle: { nonce: string; ciphertext: string } };
  const bundle = await openPatBundle(split.secret, split.tokenId, self.user_id, self.bundle);
  const key = await crypto.subtle.importKey("raw", new Uint8Array(fromB64(bundle.drawers.find((d) => d.drawer_id === drawerId)!.key)), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  const signing = await crypto.subtle.importKey("pkcs8", new Uint8Array(fromB64(bundle.ecdsa!)), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  for (const amount of [200, 300]) {
    const body = await sealedEntry(key, signing, { v: 1, id: crypto.randomUUID(), drawer_id: drawerId, line_id: lineId, op: "add", amount, exponent: 2, comment: "", logged_at: new Date().toISOString(), reverses: null, prev_hash: null, delta_hint: null, author_id: self.user_id, sig_key_id: bundle.sig_key_id! });
    expect((await request.post(`${API}/drawers/${drawerId}/entries`, { headers: bearer, data: { ...body, is_checkpoint: false } })).status()).toBe(201);
  }
  await page.goto(`/drawers/${drawerId}/lines/${lineId}`);
  await expect(page.getByTestId("line-balance")).toHaveText("105.00");
  await expect(page.getByTestId("entry-row")).toHaveCount(3);
  await noHistoryWarning(page);
  await page.goto("/");
  await expect(rowNamed(page, "Kitchen")).toBeVisible();
  await expect(page.getByTestId("drawer-attention")).toHaveCount(0);

  // today's tool: its entries link to the newest entry it checked
  const agent = await connect({ token, apiUrl: API });
  await agent.add(drawerId, lineId, "1", "");
  await agent.withdraw(drawerId, lineId, "2", "");
  expect(agent.warnings).toEqual([]);
  await page.goto(`/drawers/${drawerId}/lines/${lineId}`);
  await expect(page.getByTestId("line-balance")).toHaveText("104.00");
  await expect(page.getByTestId("entry-row")).toHaveCount(5);
  await noHistoryWarning(page);
  // the app's own next entry goes on top, still with no warning
  await entry(page, "Add", "6");
  await expect(page.getByTestId("line-balance")).toHaveText("110.00");
  await noHistoryWarning(page);

  // the browser remembered the newest entry all along: when the newest row goes, it says so
  await dbQuery("delete from entries where id = (select id from entries where drawer_id = $1 and line_id = $2 order by seq desc limit 1)", [drawerId, lineId]);
  await page.reload();
  await expect(page.getByTestId("warn-chain-truncated")).toContainText("shorter than the last time you saw it");
});

test("PETTY-448: an entry sent with the count flag does not reset the balance, and the item is reported until a real count", async ({ page }) => {
  const user = await signupWithKeys("flag");
  await loginAndUnlock(page, user);
  const drawerId = await makeDrawer(page, "Tin");
  const lineId = await openLine(page, drawerId);
  await entry(page, "Add", "20");
  await expect(page.getByTestId("line-balance")).toHaveText("120.00");
  // an ordinary +1.00 is stored with the count flag set
  const { me, key, rows } = await asMember(user, drawerId, lineId);
  const pub = await exportPublicKeys(user.keys);
  const body = await sealedEntry(key, user.keys.ecdsa.privateKey, {
    v: 1, id: crypto.randomUUID(), drawer_id: drawerId, line_id: lineId, op: "add", amount: 100, exponent: 2, comment: "", logged_at: new Date().toISOString(),
    reverses: null, prev_hash: await hashEntry(rows.at(-1)!.entry), delta_hint: null, author_id: me.id, sig_key_id: await signingKeyId(pub.ecdsa),
  });
  expect((await me.call("POST", `/drawers/${drawerId}/entries`, { ...body, is_checkpoint: true, expected_head_seq: rows.at(-1)!.row.seq })).status).toBe(201);
  await page.reload();
  await expect(page.getByTestId("line-balance")).toHaveText("121.00");
  await expect(page.getByTestId("entry-row")).toHaveCount(3);
  await expect(page.getByTestId("warn-chain-broken")).toContainText("The history links do not match");
  await page.goto("/");
  await expect(page.getByTestId("drawer-attention")).toBeVisible();
  // a real count starts a new window, and the item is clean again
  await page.goto(`/drawers/${drawerId}/lines/${lineId}`);
  await entry(page, "Adjust", "50");
  await expect(page.getByTestId("line-balance")).toHaveText("50.00");
  await page.reload();
  await expect(page.getByTestId("line-balance")).toHaveText("50.00");
  await noHistoryWarning(page);
});

test("PETTY-448: the same entry served twice is not counted twice: the drawer shows as damaged", async ({ page }) => {
  const user = await signupWithKeys("twice");
  await loginAndUnlock(page, user);
  const drawerId = await makeDrawer(page, "Jar");
  await page.goto("/");
  await expect(page.getByTestId("row-amount")).toContainText("100.00");
  // the server's answer carries the item's only row a second time, under the next number
  await page.route("**/api/bootstrap", async (route) => {
    const res = await route.fetch();
    const boot = (await res.json()) as { entries: { drawer_id: string; seq: number }[] };
    const row = boot.entries.find((e) => e.drawer_id === drawerId)!;
    boot.entries.push({ ...row, seq: row.seq + 1 });
    await route.fulfill({ response: res, json: boot });
  });
  await page.reload();
  await expect(page.locator(".degraded")).toContainText("This drawer's data is damaged");
  await expect(page.getByTestId("row-amount")).toHaveCount(0);
});
