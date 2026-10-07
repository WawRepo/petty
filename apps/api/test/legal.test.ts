import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadLegalTexts } from "../src/lib/legal.js";

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

const app = buildApp();
beforeAll(async () => { await app.ready(); });
afterAll(async () => { await app.close(); await apiPool.end(); await maintPool.end(); });

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

  it("no LEGAL_DIR means no texts: nothing changes for a household", () => {
    expect(loadLegalTexts("").size).toBe(0);
    const empty = mkdtempSync(join(tmpdir(), "petty-legal-none-"));
    expect(loadLegalTexts(empty).size).toBe(0);
    expect(() => loadLegalTexts(join(empty, "missing"))).toThrow();
  });
});
