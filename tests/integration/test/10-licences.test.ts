import { describe, expect, it } from "vitest";
import { ORIGIN } from "../lib.js";

/**
 * PETTY-292 (review S4): what the image serves carries its licences. The web notices list the workspace
 * packages' dependencies (hash-wasm), the service worker's Workbox runtime, and the LGPL library in
 * Clerk's chunk with the LGPL and GPL texts it requires; each downloadable single file names its licence,
 * the source of its version, and ends with the notices of what it bundles.
 */
describe("licences in what the image serves", () => {
  it("the web app's third-party notices are complete", async () => {
    const r = await fetch(`${ORIGIN}/THIRD_PARTY_NOTICES.md`);
    expect(r.status).toBe(200);
    const md = await r.text();
    for (const pkg of ["hash-wasm", "workbox-core", "workbox-precaching", "rpc-websockets"]) expect(md).toMatch(new RegExp(`^## ${pkg} `, "m"));
    expect(md).toMatch(/^Source: https:\/\/github\.com\/elpheria\/rpc-websockets$/m);
    expect(md).toContain("GNU LESSER GENERAL PUBLIC LICENSE");
    expect(md).toMatch(/^ +GNU GENERAL PUBLIC LICENSE$/m);
  });

  for (const file of ["petty.mjs", "petty-mcp.mjs"]) {
    it(`/downloads/${file} names its licence and source, and ends with its notices`, async () => {
      const r = await fetch(`${ORIGIN}/downloads/${file}`);
      expect(r.status).toBe(200);
      const js = await r.text();
      const head = js.slice(0, 600);
      expect(head.startsWith("#!/usr/bin/env node\n/*!")).toBe(true);
      expect(head).toContain("AGPL-3.0-only");
      expect(head).toMatch(/Source code of this version: https:\/\/github\.com\/WawRepo\/petty\/tree\/v\d+\.\d+\.\d+/);
      expect(js.lastIndexOf("/*! Third-party notices")).toBeGreaterThan(js.length / 2);
      expect(js.trimEnd().endsWith("*/")).toBe(true);
    });
  }
});
