/**
 * DCO check for pull requests (PETTY-304). Every commit in <base>..<head> must carry a
 * `Signed-off-by:` line with its author's email: the contributor's statement that they may give the
 * change under the AGPL (CONTRIBUTING.md, "License and sign-off"). It runs in ci.yml, so no outside
 * app needs access to the repository. Merge commits are skipped, as `git commit -s` does not touch them.
 *
 *   node scripts/dco-check.ts <base sha> <head sha>
 */
import { execFileSync } from "node:child_process";

const [base, head] = process.argv.slice(2);
if (!base || !head) {
  process.stderr.write("usage: node scripts/dco-check.ts <base sha> <head sha>\n");
  process.exit(2);
}

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const commits = git("rev-list", "--no-merges", "--reverse", `${base}..${head}`).split("\n").filter(Boolean);

const missing: string[] = [];
for (const sha of commits) {
  const [email = "", subject = "", body = ""] = git("log", "-1", "--format=%ae%x00%s%x00%B", sha).split("\0");
  const signers = [...body.matchAll(/^Signed-off-by:.*<([^>\s]+)>\s*$/gim)].map((m) => m[1]!.toLowerCase());
  if (!signers.includes(email.toLowerCase())) missing.push(`${sha.slice(0, 7)} ${subject}`);
}

if (missing.length) {
  process.stderr.write(
    `DCO: ${missing.length} of ${commits.length} commit(s) have no Signed-off-by line with their author's email:\n` +
      missing.map((m) => `  ${m}\n`).join("") +
      "Add it with `git commit --amend -s` (the last commit) or `git rebase --signoff <base>` (a whole branch),\n" +
      "then push again. Why: CONTRIBUTING.md, \"License and sign-off\".\n",
  );
  process.exit(1);
}
process.stdout.write(`DCO: ${commits.length} commit(s) signed off by their authors\n`);
