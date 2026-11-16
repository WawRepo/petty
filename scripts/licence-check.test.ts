import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { allowed } from "./licence-check.ts";

/** PETTY-384: scripts/licence-check.ts, on SPDX expressions and on pnpm's licence list. */
const script = join(import.meta.dirname, "licence-check.ts");
const dir = mkdtempSync(join(tmpdir(), "petty-licences-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** Runs the check over a list shaped as `pnpm licenses list --json -r` prints it. */
function check(list: Record<string, { name: string; versions: string[]; license: string }[]>) {
  const file = join(dir, `list-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(list));
  return spawnSync(process.execPath, [script, "--from", file], { encoding: "utf8" });
}
const pkg = (name: string, license: string) => ({ name, versions: ["1.0.0"], license });

describe("allowed()", () => {
  it("passes the licences Petty's tree uses today", () => {
    for (const l of ["MIT", "MIT-0", "ISC", "0BSD", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "BlueOak-1.0.0", "Unlicense", "CC0-1.0", "CC-BY-4.0", "Python-2.0", "MPL-2.0", "LGPL-3.0-or-later"]) {
      assert.equal(allowed(l), true, l);
    }
  });

  it("refuses licences that cannot ship with AGPL-3.0, and strings that are no licence", () => {
    for (const l of ["SSPL-1.0", "BUSL-1.1", "GPL-2.0-only", "GPL-2.0", "CC-BY-NC-4.0", "Elastic-2.0", "UNLICENSED", "UNKNOWN", "SEE LICENSE IN LICENSE.md", "", "Commercial"]) {
      assert.equal(allowed(l), false, l);
    }
  });

  it("reads OR, AND, WITH and brackets as SPDX does", () => {
    assert.equal(allowed("(MIT OR CC0-1.0)"), true);
    assert.equal(allowed("(MIT OR SSPL-1.0)"), true);
    assert.equal(allowed("(MIT AND SSPL-1.0)"), false);
    assert.equal(allowed("MIT AND (Apache-2.0 OR SSPL-1.0)"), true);
    assert.equal(allowed("(SSPL-1.0 OR BUSL-1.1) AND MIT"), false);
    assert.equal(allowed("Apache-2.0 WITH LLVM-exception"), true);
    assert.equal(allowed("GPL-3.0+"), true);
    assert.equal(allowed("(MIT"), false);
    assert.equal(allowed("MIT OR"), false);
    assert.equal(allowed("MIT MIT"), false);
  });
});

describe("licence-check", () => {
  it("passes a list where every licence is allowed", () => {
    const r = check({ MIT: [pkg("a", "MIT")], "(MIT OR CC0-1.0)": [pkg("type-fest", "(MIT OR CC0-1.0)")] });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /2 packages, every licence allowed/);
  });

  it("fails on a package with a licence that is not allowed, and names it", () => {
    const r = check({ MIT: [pkg("a", "MIT")], "SSPL-1.0": [pkg("mongo-thing", "SSPL-1.0")], UNLICENSED: [pkg("private-thing", "UNLICENSED")] });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /2 package\(s\)/);
    assert.match(r.stderr, /mongo-thing@1\.0\.0: SSPL-1\.0/);
    assert.match(r.stderr, /private-thing@1\.0\.0: UNLICENSED/);
    assert.doesNotMatch(r.stderr, /\ba@/);
  });

  it("fails on an empty list, which is what pnpm prints before an install or without -r", () => {
    const r = check({});
    assert.equal(r.status, 1);
    assert.match(r.stderr, /listed no packages/);
  });
});
