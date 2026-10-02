import { describe, expect, it } from "vitest";
import { ORIGIN } from "../lib.js";

/**
 * PETTY-292 (review S4): what the image serves carries its licences. The web notices list the workspace
 * packages' dependencies (hash-wasm) and the service worker's Workbox runtime; an LGPL package, when
 * there is one, comes with its source address and the LGPL and GPL texts (Clerk 5 brought one,
 * rpc-websockets; Clerk 6 does not, PETTY-306). Each downloadable single file names its licence, the
 * source of its version, and ends with the notices of what it bundles.
 */
describe("licences in what the image serves", () => {
  it("the web app's third-party notices are complete", async () => {
    const r = await fetch(`${ORIGIN}/THIRD_PARTY_NOTICES.md`);
    expect(r.status).toBe(200);
    const md = await r.text();
    for (const pkg of ["hash-wasm", "workbox-core", "workbox-precaching"]) expect(md).toMatch(new RegExp(`^## ${pkg} `, "m"));
    const lgpl = [...md.matchAll(/^## (\S+) \S+ — (\S*LGPL\S*)$/gm)].map((m) => m[1]!);
    for (const pkg of lgpl) expect(md).toMatch(new RegExp(`^## ${pkg.replace(/[/.]/g, "\\$&")} [^\n]*\n\nSource: https://`, "m"));
    expect(md.includes("GNU LESSER GENERAL PUBLIC LICENSE")).toBe(lgpl.length > 0);
    expect(/^ +GNU GENERAL PUBLIC LICENSE$/m.test(md)).toBe(lgpl.length > 0);
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
