import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";

/** PETTY-304: scripts/dco-check.ts against a throw-away repository. */
const script = join(import.meta.dirname, "dco-check.ts");
const repo = mkdtempSync(join(tmpdir(), "petty-dco-"));
after(() => rmSync(repo, { recursive: true, force: true }));

const ann = ["-c", "user.name=Ann", "-c", "user.email=ann@example.com"];
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
let n = 0;
function commit(message: string, as: string[] = ann): string {
  writeFileSync(join(repo, `f${++n}`), String(n));
  git("add", ".");
  git(...as, "commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
}
const check = (base: string, head: string, prAuthor?: string) => spawnSync(process.execPath, [script, base, head, ...(prAuthor === undefined ? [] : [prAuthor])], { cwd: repo, encoding: "utf8" });

git("init", "-q", "-b", "main");
const root = commit("root");

describe("dco-check", () => {
  it("passes when every commit is signed off by its author", () => {
    const head = commit("one\n\nSigned-off-by: Ann <ann@example.com>");
    const r = check(root, head);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /1 commit\(s\) signed off/);
  });

  it("fails on a commit with no sign-off, and names it", () => {
    const base = git("rev-parse", "HEAD");
    const head = commit("forgot it");
    const r = check(base, head);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /forgot it/);
    assert.match(r.stderr, /git commit --amend -s/);
  });

  it("fails when the sign-off names someone else", () => {
    const base = git("rev-parse", "HEAD");
    const head = commit("signed by another\n\nSigned-off-by: Bob <bob@example.com>");
    assert.equal(check(base, head).status, 1);
  });

  it("skips commits by GitHub's bots, which sign with another address, but not a look-alike", () => {
    const base = git("rev-parse", "HEAD");
    const bot = ["-c", "user.name=dependabot[bot]", "-c", "user.email=49699333+dependabot[bot]@users.noreply.github.com"];
    const head = commit("Bump x from 1 to 2\n\nSigned-off-by: dependabot[bot] <support@github.com>", bot);
    const r = check(base, head);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /1 by GitHub's bots skipped/);
    assert.equal(check(base, head, "dependabot[bot]").status, 0);
    // a person's pull request with a commit that only claims to be a bot's
    assert.equal(check(base, head, "eve").status, 1);
    const fake = commit("not a bot", ["-c", "user.name=Eve", "-c", "user.email=eve[bot]@example.com"]);
    assert.equal(check(head, fake).status, 1);
  });

  it("matches the email without regard to case, and skips merge commits", () => {
    const base = git("rev-parse", "HEAD");
    git("checkout", "-q", "-b", "side");
    commit("on a side branch\n\nSigned-off-by: Ann <ANN@Example.com>");
    git("checkout", "-q", "main");
    commit("on main\n\nSigned-off-by: Ann <ann@example.com>");
    git(...ann, "merge", "-q", "--no-ff", "-m", "merge without a sign-off", "side");
    const r = check(base, git("rev-parse", "HEAD"));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /2 commit\(s\)/);
  });
});
