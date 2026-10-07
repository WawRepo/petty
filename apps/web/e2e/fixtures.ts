/**
 * Playwright fixtures. `alice` and `bob` are two separate browser contexts with
 * two different users, signed up through the real API and unlocked through the
 * real UI. Single-context tests cannot catch this app's concurrency bugs.
 */
import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";
import { randomBytes, createHash } from "node:crypto";
import pg from "pg";
import { createRecoveryVault, createVault, exportPublicKeys, generateRecoveryCode, generateUserKeys, signingKeyId } from "@petty/crypto";

export const API = `http://127.0.0.1:${process.env["API_PORT"] ?? "3000"}`;
const OWNER_DB = process.env["DATABASE_URL"] ?? "postgres://petty:petty@localhost:5432/petty";

export interface TestUser { name: string; email: string; password: string; passphrase: string }

export async function makeJoinLink(): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  const c = new pg.Client({ connectionString: OWNER_DB });
  await c.connect();
  try { await c.query("insert into join_links (token_hash, expires_at) values ($1, now() + interval '1 day')", [createHash("sha256").update(token).digest()]); }
  finally { await c.end(); }
  return token;
}

/** Creates the account through the API (keys generated here, in Node), so UI tests can start at login. */
export async function signupViaApi(name: string): Promise<TestUser> {
  const run = randomBytes(4).toString("hex");
  const user: TestUser = { name, email: `${name}-${run}@e2e.local`, password: `password-${name}-${run}`, passphrase: `vault ${name} ${run} passphrase` };
  const keys = await generateUserKeys();
  const pub = await exportPublicKeys(keys);
  const body = {
    join_token: await makeJoinLink(), email: user.email, password: user.password, display_name: name, locale: "en",
    keys: { ecdh_pub: pub.ecdh, ecdsa_pub: pub.ecdsa, sig_key_id: await signingKeyId(pub.ecdsa) },
    vault: await createVault(user.passphrase, keys), recovery_vault: await createRecoveryVault(generateRecoveryCode(), keys),
  };
  const res = await fetch(`${API}/auth/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${await res.text()}`);
  return user;
}

/** The join / setup form (PETTY-102) leads with a passkey where the browser can do PRF; these tests want the passphrase fields. */
export async function choosePassphraseDoor(page: Page): Promise<void> {
  await page.getByTestId(/^door-(passkey|passphrase)$/).first().waitFor();
  const sw = page.getByTestId("door-use-passphrase");
  if (await sw.count()) await sw.click();
  await page.getByTestId("door-passphrase").waitFor();
}

/** The tag picker (PETTY-147) is open: switch the given tags on (existing chips) or add them (new), then Save. */
export async function pickTags(page: Page, tags: readonly string[]): Promise<void> {
  const picker = page.getByTestId("tag-picker");
  for (const tag of tags) {
    const chip = picker.getByRole("button", { name: new RegExp(`^${tag}$`, "i") });
    if (await chip.count()) { if ((await chip.first().getAttribute("aria-pressed")) !== "true") await chip.first().click(); }
    else { await picker.getByLabel("New tag").fill(tag); await picker.getByLabel("New tag").press("Enter"); }
  }
  await picker.getByTestId("tag-save").click();
}

export async function loginAndUnlock(page: Page, user: TestUser): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Login password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("Vault passphrase").fill(user.passphrase);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("heading", { name: "Petty" })).toBeVisible();
}

interface Fixtures { alice: { page: Page; context: BrowserContext; user: TestUser }; bob: { page: Page; context: BrowserContext; user: TestUser } }

export const test = base.extend<Fixtures>({
  alice: async ({ browser }, use) => {
    const user = await signupViaApi("alice");
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginAndUnlock(page, user);
    await use({ page, context, user });
    await context.close();
  },
  bob: async ({ browser }, use) => {
    const user = await signupViaApi("bob");
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginAndUnlock(page, user);
    await use({ page, context, user });
    await context.close();
  },
});
export { expect };

// ---------------------------------------------------------------- Phase 6 helpers
import { createDrawerKey, signCustodyChallenge, unwrapDrawerKey, wrapDrawerKey, type DrawerKeyWrapV1 as _W, type UserKeyPairs } from "@petty/crypto";
void createDrawerKey;

export interface TestUserWithKeys extends TestUser { keys: UserKeyPairs; ecdhPub: string; recoveryCode: string }

/** Like signupViaApi but keeps the keypairs, so the test can wrap drawer keys in Node. */
export async function signupWithKeys(name: string): Promise<TestUserWithKeys> {
  const run = randomBytes(4).toString("hex");
  const user: TestUser = { name, email: `${name}-${run}@e2e.local`, password: `password-${name}-${run}`, passphrase: `vault ${name} ${run} passphrase` };
  const keys = await generateUserKeys();
  const pub = await exportPublicKeys(keys);
  const recoveryCode = generateRecoveryCode();
  const body = {
    join_token: await makeJoinLink(), email: user.email, password: user.password, display_name: name, locale: "en",
    keys: { ecdh_pub: pub.ecdh, ecdsa_pub: pub.ecdsa, sig_key_id: await signingKeyId(pub.ecdsa) },
    vault: await createVault(user.passphrase, keys), recovery_vault: await createRecoveryVault(recoveryCode, keys),
  };
  const res = await fetch(`${API}/auth/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${await res.text()}`);
  return { ...user, keys, ecdhPub: pub.ecdh, recoveryCode };
}

/** A minimal API client from Node with its own session cookie. */
export async function apiClient(user: TestUser) {
  const login = await fetch(`${API}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: user.email, password: user.password }) });
  if (login.status !== 200) throw new Error(`login failed: ${login.status}`);
  const cookie = /petty_session=([^;]*)/.exec(login.headers.get("set-cookie") ?? "")?.[1];
  const me = (await login.json()) as { id: string };
  const call = async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { cookie: `petty_session=${cookie ?? ""}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    const r = await fetch(`${API}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await r.text();
    return { status: r.status, json: text ? JSON.parse(text) : undefined };
  };
  /** Custody proof (SR-2) for PUT /me/vault and POST /me/delete: a fresh challenge signed with the user's ECDSA key. */
  const proof = async (keys: UserKeyPairs) => {
    const c = (await call("POST", "/me/custody-challenge")).json as { challenge: string };
    return { challenge: c.challenge, signature: await signCustodyChallenge(keys.ecdsa.privateKey, c.challenge) };
  };
  return { id: me.id, call, proof };
}

/** Owner (with Node keys) shares a drawer with another user (with Node keys) through the API, and the invitee accepts. */
export async function shareViaApi(owner: TestUserWithKeys, drawerId: string, invitee: TestUserWithKeys, role: "write" | "read"): Promise<void> {
  const o = await apiClient(owner);
  const boot = (await o.call("GET", "/bootstrap")).json as { wraps: _W[] };
  const wrap = boot.wraps.find((w) => w.drawer_id === drawerId)!;
  const key = await unwrapDrawerKey(wrap, owner.keys.ecdh.privateKey, { drawer_id: drawerId, key_version: wrap.key_version, senderEcdhPublicB64: owner.ecdhPub }, { extractable: true });
  const forInvitee = await wrapDrawerKey(key, { ecdhPrivate: owner.keys.ecdh.privateKey, ecdhPublicB64: owner.ecdhPub }, invitee.ecdhPub, drawerId, wrap.key_version);
  const inv = await o.call("POST", `/drawers/${drawerId}/invitations`, { invitee_id: (await apiClient(invitee)).id, role, wrap: forInvitee });
  if (inv.status !== 201) throw new Error(`invite failed: ${inv.status} ${JSON.stringify(inv.json)}`);
  const i = await apiClient(invitee);
  const acc = await i.call("POST", `/invitations/${(inv.json as { id: string }).id}/accept`);
  if (acc.status !== 204) throw new Error(`accept failed: ${acc.status}`);
}

/** Flips one byte of a drawer document's ciphertext straight in Postgres (simulating tampering / corruption). */
export async function corruptDocument(drawerId: string): Promise<void> {
  const c = new pg.Client({ connectionString: OWNER_DB });
  await c.connect();
  try { await c.query("update drawer_documents set ciphertext = overlay(ciphertext placing decode('ff', 'hex') from 10 for 1) where drawer_id = $1", [drawerId]); }
  finally { await c.end(); }
}

/** A tiny baseline JPEG with an APP1 Exif segment carrying a GPS IFD. Enough for a real decoder and for our "no Exif left" check. */
export function jpegWithGpsExif(plainJpeg: Buffer): Buffer {
  if (plainJpeg[0] !== 0xff || plainJpeg[1] !== 0xd8) throw new Error("not a JPEG");
  const soi = Buffer.from([0xff, 0xd8]);
  // TIFF header (little endian) + IFD0 with one GPS pointer + GPS IFD with GPSVersionID
  const tiff = Buffer.alloc(8 + 2 + 12 + 4 + 2 + 12 + 4);
  tiff.write("II", 0, "ascii"); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);                      // IFD0: 1 entry
  tiff.writeUInt16LE(0x8825, 10); tiff.writeUInt16LE(4, 12); tiff.writeUInt32LE(1, 14); tiff.writeUInt32LE(26, 18); // GPSInfo IFD pointer → offset 26
  tiff.writeUInt32LE(0, 22);                     // next IFD
  tiff.writeUInt16LE(1, 26);                     // GPS IFD: 1 entry
  tiff.writeUInt16LE(0x0000, 28); tiff.writeUInt16LE(1, 30); tiff.writeUInt32LE(4, 32); tiff.writeUInt32LE(0x00000302, 36); // GPSVersionID 2.3.0.0
  tiff.writeUInt32LE(0, 40);
  const exifBody = Buffer.concat([Buffer.from("Exif\0\0", "ascii"), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from([(exifBody.length + 2) >> 8, (exifBody.length + 2) & 0xff]), exifBody]);
  const hasExifAlready = plainJpeg.indexOf(Buffer.from("Exif\0\0", "ascii")) >= 0;
  if (hasExifAlready) throw new Error("input already has Exif");
  return Buffer.concat([soi, app1, plainJpeg.subarray(2)]);
}

// ---------------------------------------------------------------- Phase 7 helpers (raw database tampering)
export async function dbQuery(sql: string, params: unknown[] = []): Promise<unknown[]> {
  const c = new pg.Client({ connectionString: OWNER_DB });
  await c.connect();
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}
/** An attacker with database access deletes the newest entry of a line. */
export async function deleteNewestEntry(drawerId: string, lineId: string): Promise<void> {
  await dbQuery("delete from entries where id = (select id from entries where drawer_id = $1 and line_id = $2 order by seq desc limit 1)", [drawerId, lineId]);
}
/** An attacker swaps the ciphertexts of two entries (trigger disabled, as a raw DB writer could). */
export async function swapCiphertexts(drawerId: string, lineId: string): Promise<void> {
  const rows = (await dbQuery("select id from entries where drawer_id = $1 and line_id = $2 order by seq limit 2", [drawerId, lineId])) as { id: string }[];
  if (rows.length < 2) throw new Error("need two entries");
  // Triggers off for THIS connection only (a superuser can), so parallel test workers do not interfere.
  const c = new pg.Client({ connectionString: OWNER_DB });
  await c.connect();
  try {
    await c.query("set session_replication_role = replica");
    await c.query(`update entries e set nonce = v.nonce, ciphertext = v.ciphertext
                     from (select id, nonce, ciphertext from entries where id in ($1, $2)) v
                    where (e.id = $1 and v.id = $2) or (e.id = $2 and v.id = $1)`, [rows[0]!.id, rows[1]!.id]);
  } finally { await c.end(); }
}

/** Settings live behind the account button (PETTY-82). */
export async function openSettings(page: Page): Promise<void> {
  await page.getByTestId("account-menu").click();
  await page.getByRole("dialog").getByRole("button", { name: "Settings" }).click();
}

/** Drawers made through the app's own store (dev build, signed in and unlocked), each with its place. */
export async function makeDrawers(page: Page, list: [string, string[]][]): Promise<void> {
  const made = await page.evaluate(async (list) => {
    const url = performance.getEntriesByType("resource").map((e) => e.name).filter((n) => /\/src\/lib\/drawers\.ts(\?|$)/.test(n)).at(-1);
    if (!url) return 0;
    const m = (await import(url)) as { createDrawer: (name: string, tags: readonly string[]) => Promise<string> };
    for (const [name, place] of list) await m.createDrawer(name, place);
    return list.length;
  }, list);
  expect(made, "the drawers must be made in the app's own store").toBe(list.length);
}
