import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { legalVersion, loadLegalTexts } from "../src/lib/legal.js";

/**
 * PETTY-342: the operator's own privacy notice and terms, from LEGAL_DIR. Set before the app is loaded:
 * the config is read once, as in the image.
 */
const dir = mkdtempSync(join(tmpdir(), "petty-legal-"));
writeFileSync(join(dir, "privacy.en.md"), "# Privacy notice\n\nRun by Example Operator.\n");
writeFileSync(join(dir, "privacy.pl.md"), "# Polityka prywatności\n\nProwadzi Example Operator.\n");
writeFileSync(join(dir, "terms.pl.md"), "# Regulamin\n\nTylko po polsku.\n");
writeFileSync(join(dir, "notes.txt"), "not a legal text");
process.env["LEGAL_DIR"] = dir;
const { buildApp } = await import("../src/app.js");
const { apiPool, maintPool } = await import("../src/db.js");
const { config } = await import("../src/config.js");
const { Client, makeJoinLink, userMaterial } = await import("../src/devtools/fixtures.js");
const owner = new pg.Pool({ connectionString: config.ownerDatabaseUrl, max: 1 });

const app = buildApp();
beforeAll(async () => { await app.ready(); });
afterAll(async () => { await app.close(); await apiPool.end(); await maintPool.end(); await owner.end(); });

describe("operator legal texts (PETTY-342)", () => {
  it("/config says which texts this deployment has", async () => {
    expect((await app.inject({ method: "GET", url: "/config" })).json().legal).toEqual({ privacy: true, terms: true });
  });

  it("serves a text in the asked language, else English, else the one there is", async () => {
    const get = async (url: string) => (await app.inject({ method: "GET", url })).json();
    expect(await get("/legal/privacy?lang=pl")).toEqual({ doc: "privacy", lang: "pl", text: "# Polityka prywatności\n\nProwadzi Example Operator.\n" });
    expect(await get("/legal/privacy?lang=de")).toMatchObject({ lang: "en", text: expect.stringContaining("Example Operator") });
    expect(await get("/legal/terms?lang=en")).toMatchObject({ lang: "pl", text: expect.stringContaining("Regulamin") });
    expect(await get("/legal/privacy")).toMatchObject({ lang: "en" });
  });

  it("refuses an unknown document or a malformed language", async () => {
    expect((await app.inject({ method: "GET", url: "/legal/cookies" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/legal/privacy?lang=../../etc" })).statusCode).toBe(400);
  });

  it("PETTY-216: a sign-up records which terms it accepted (a fingerprint of every language) and when", async () => {
    const version = legalVersion(loadLegalTexts(dir), "terms");
    expect(version).toMatch(/^sha256:[0-9a-f]{16}$/);
    const u = new Client(app, await userMaterial("terms-ok", { email: `terms-${crypto.randomUUID().slice(0, 8)}@test.local` }));
    expect((await u.signup(await makeJoinLink())).statusCode).toBe(201);
    const row = (await owner.query<{ terms_version: string | null; terms_accepted_at: Date | null }>("select terms_version, terms_accepted_at from users where id = $1", [u.id])).rows[0]!;
    expect(row.terms_version).toBe(version);
    expect(Date.now() - row.terms_accepted_at!.getTime()).toBeLessThan(60_000);
    // any change to any language is a new version; no terms, no version
    const changed = mkdtempSync(join(tmpdir(), "petty-legal-changed-"));
    writeFileSync(join(changed, "terms.pl.md"), "# Regulamin\n\nTylko po polsku, wersja 2.\n");
    expect(legalVersion(loadLegalTexts(changed), "terms")).not.toBe(version);
    expect(legalVersion(loadLegalTexts(changed), "privacy")).toBeNull();
  });

  it("no LEGAL_DIR means no texts: nothing changes for a household", () => {
    expect(loadLegalTexts("").size).toBe(0);
    const empty = mkdtempSync(join(tmpdir(), "petty-legal-none-"));
    expect(loadLegalTexts(empty).size).toBe(0);
    expect(() => loadLegalTexts(join(empty, "missing"))).toThrow();
  });
});
