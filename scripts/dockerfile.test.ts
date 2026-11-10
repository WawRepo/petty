import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * PETTY-418: what the image's Dockerfile must keep. The build itself runs in CI (tests/integration builds
 * this file and tests the image); these checks read the text, so a later edit cannot quietly go back to
 * a pnpm that nothing checked.
 */
const root = join(import.meta.dirname, "..");
const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
const arg = (name: string): string => new RegExp(`^ARG ${name}=(\\S+)$`, "m").exec(dockerfile)?.[1] ?? "";

describe("Dockerfile", () => {
  it("names the pnpm that package.json names, with a SHA-512 of its file", () => {
    const { packageManager } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { packageManager: string };
    assert.equal(`pnpm@${arg("PNPM_VERSION")}`, packageManager);
    assert.match(arg("PNPM_SHA512"), /^[0-9a-f]{128}$/);
  });

  it("checks the pnpm file against that hash before it becomes the file the stages install", () => {
    const stage = /\nFROM [^\n]+ AS pnpm\n([\s\S]*?)\nFROM /.exec(dockerfile)?.[1];
    assert.ok(stage, "no stage named pnpm");
    const fetched = stage.indexOf('npm pack "pnpm@${PNPM_VERSION}" --pack-destination /');
    const checked = stage.indexOf('echo "${PNPM_SHA512}  /pnpm-${PNPM_VERSION}.tgz" | sha512sum -c -');
    const kept = stage.indexOf('mv "/pnpm-${PNPM_VERSION}.tgz" /pnpm.tgz');
    assert.ok(fetched >= 0 && checked > fetched && kept > checked, "fetch, check, then keep");
    assert.match(stage, /npm pack [^\n]*\\\n && echo [^\n]*sha512sum -c - \\\n && mv /, "one RUN, joined with &&: a failed check stops the build");
  });

  it("installs pnpm from the checked file only, never by name from the registry", () => {
    const installs = dockerfile.split("\n").filter((l) => /\bnpm (install|i|add)\b/.test(l) && !l.trimStart().startsWith("#"));
    assert.equal(installs.length, 3, installs.join("\n"));
    for (const line of installs) {
      assert.match(line, /^RUN --mount=type=bind,from=pnpm,source=\/pnpm\.tgz,target=\/mnt\/pnpm\.tgz npm install -g \/mnt\/pnpm\.tgz( \\)?$/, line);
    }
  });

  it("starts the API as node itself, and the API answers a stop", () => {
    assert.match(dockerfile, /\nWORKDIR \/app\/apps\/api\n(?:#[^\n]*\n)*CMD \["node", "--import", "tsx", "src\/index\.ts"\]\n$/);
    // as the first process it gets no default action for a signal: index.ts must handle the stop
    const index = readFileSync(join(root, "apps/api/src/index.ts"), "utf8");
    assert.match(index, /for \(const signal of \["SIGTERM", "SIGINT"\] as const\)/);
    assert.match(index, /app\.close\(\)[^\n]*process\.exit\(0\)/);
  });
});
