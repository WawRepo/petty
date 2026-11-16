import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * The release workflow cannot be run as a test: a run publishes a release. These checks read the file
 * and hold the rules that keep a release safe (PETTY-406, PETTY-418, PETTY-456):
 * - a job that runs dependency code holds no write token and cannot sign;
 * - the job that signs the attestations can write neither to the repository nor to the registry;
 * - the image is pushed by digest, and gets its version tag only once the release commit and its git
 *   tag are on main, so a run that fails leaves no version tag for the next run to replace.
 */
const dir = join(import.meta.dirname, "../.github/workflows");
const text = readFileSync(join(dir, "release.yml"), "utf8");

/** Each job's lines, by name: a job starts at a line with two spaces, a name and a colon. */
const jobs = new Map<string, string>();
{
  const lines = text.slice(text.indexOf("\njobs:\n") + "\njobs:\n".length).split("\n");
  let name = "";
  for (const line of lines) {
    const start = /^ {2}([a-z][a-z0-9_-]*):\s*$/.exec(line);
    if (start) { name = start[1]!; jobs.set(name, ""); continue; }
    if (name) jobs.set(name, `${jobs.get(name)}${line}\n`);
  }
}
const job = (name: string): string => { const body = jobs.get(name); assert.ok(body, `release.yml has no job "${name}"`); return body; };
/** A job's permissions, from the block under its `permissions:` line (comments dropped). */
function permissions(name: string): Record<string, string> {
  const block = /^ {4}permissions:\n((?: {6}\S.*\n)+)/m.exec(job(name));
  assert.ok(block, `job "${name}" names no permissions`);
  return Object.fromEntries(block[1]!.trim().split("\n").map((l) => { const [k, v] = l.replace(/#.*$/, "").trim().split(/:\s*/); return [k!, v!]; }));
}
const needs = (name: string): string[] => /^ {4}needs: \[?([^\]\n]+)\]?$/m.exec(job(name))?.[1]?.split(",").map((s) => s.trim()) ?? [];
const runsDependencyCode = (body: string): boolean => /\bpnpm (install|--filter|run|exec)\b/.test(body);
const at = (body: string, what: string): number => { const i = body.indexOf(what); assert.ok(i >= 0, `not found: ${what}`); return i; };

describe("release.yml", () => {
  it("has the jobs these checks know", () => {
    assert.deepEqual([...jobs.keys()], ["prepare", "pack", "image", "attest", "publish", "registry"]);
  });

  it("gives a job that runs dependency code a read-only token", () => {
    const names = [...jobs.keys()].filter((n) => runsDependencyCode(job(n)));
    assert.deepEqual(names, ["pack"]);
    for (const n of names) assert.deepEqual(permissions(n), { contents: "read" });
  });

  it("lets the job that builds the image write to the registry only", () => {
    assert.match(job("image"), /uses: docker\/build-push-action@/);
    assert.deepEqual(permissions("image"), { contents: "read", packages: "write" });
  });

  it("signs in a job of its own that runs no dependency code and can write nowhere else", () => {
    const body = job("attest");
    assert.deepEqual(permissions("attest"), { contents: "read", "id-token": "write", attestations: "write" });
    assert.equal(runsDependencyCode(body), false);
    assert.doesNotMatch(body, /^\s+run:/m, "the attest job runs no script of its own");
    assert.doesNotMatch(body, /actions\/checkout@|docker\//);
    for (const n of jobs.keys()) if (n !== "attest") assert.equal(permissions(n)["attestations"], undefined, `${n} must not write attestations`);
    // the only other job with id-token is the registry login, which calls mcp-registry.yml
    assert.deepEqual([...jobs.keys()].filter((n) => permissions(n)["id-token"]), ["attest", "registry"]);
  });

  it("attests the four files that SHA256SUMS lists, and the image by the digest that was built", () => {
    const body = job("attest");
    const files = /sha256sum ([^>]+)> SHA256SUMS/.exec(job("publish"))?.[1]?.trim().split(/\s+/) ?? [];
    assert.deepEqual(files, ["petty.mcpb", "petty-mcp.mjs", "petty-skill.zip", "petty.mjs"]);
    for (const f of files) assert.ok(body.includes(`\${{ runner.temp }}/downloads/${f}\n`), `the attest job does not name ${f}`);
    assert.match(body, /subject-name: ghcr\.io\/wawrepo\/petty\n\s+subject-digest: \$\{\{ needs\.image\.outputs\.digest \}\}/);
    assert.deepEqual(needs("attest"), ["pack", "image"]);
  });

  it("publishes only after the attestations are signed", () => {
    assert.deepEqual(needs("publish"), ["prepare", "pack", "image", "attest"]);
    assert.deepEqual(needs("registry"), ["prepare", "publish"]);
  });

  it("pushes the image by digest, with no tag", () => {
    const body = job("image");
    assert.match(body, /outputs: type=image,name=ghcr\.io\/wawrepo\/petty,push-by-digest=true,name-canonical=true,push=true\n/);
    assert.doesNotMatch(body, /^\s+tags:/m);
    assert.doesNotMatch(body, /^\s+push:/m);
    assert.match(body, /IMAGE: ghcr\.io\/wawrepo\/petty@\$\{\{ steps\.build\.outputs\.digest \}\}/);
    assert.doesNotMatch(body, /imagetools create/);
  });

  it("tags the image only after the release commit and its tag are on main, then publishes, then moves latest", () => {
    const body = job("publish");
    const login = at(body, "uses: docker/login-action@");
    const push = at(body, 'git push --atomic origin HEAD:refs/heads/main "refs/tags/v$VERSION"');
    const tag = at(body, 'docker buildx imagetools create --tag "ghcr.io/wawrepo/petty:v$VERSION" "ghcr.io/wawrepo/petty@$DIGEST"');
    const release = at(body, 'gh release create "v$VERSION"');
    const latest = at(body, 'docker buildx imagetools create --tag ghcr.io/wawrepo/petty:latest "ghcr.io/wawrepo/petty@$DIGEST"');
    assert.ok(login < push, "the registry login comes before the push to main");
    assert.ok(push < tag && tag < release && release < latest, "push to main, version tag, GitHub Release, latest");
    assert.equal(body.split("imagetools create").length - 1, 2);
    assert.equal(runsDependencyCode(body), false);
    assert.deepEqual(permissions("publish"), { contents: "write", packages: "write" });
    for (const n of jobs.keys()) if (n !== "publish") assert.doesNotMatch(job(n), /imagetools create|git push/, `${n} must not tag or push`);
  });
});

describe("every workflow", () => {
  it("pins each action by commit, with its version in a comment", () => {
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".yml"))) {
      for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
        const uses = /^\s*(?:- )?uses:\s*(\S+)(.*)$/.exec(line);
        if (!uses || uses[1]!.startsWith("./")) continue;
        assert.match(`${uses[1]}${uses[2]}`, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+/, `${file}: ${line.trim()}`);
      }
    }
  });
});
