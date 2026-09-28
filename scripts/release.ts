/**
 * Prepares the release commit (PETTY-254); run by .github/workflows/release.yml, which commits, tags and
 * builds what this leaves in the working tree.
 *
 *   node scripts/release.ts <x.y.z> <yyyy-mm-dd> <notes.md>
 *
 * - Sets "version" in every tracked package.json that has one, and in the Claude Desktop add-on manifest.
 * - Turns CHANGELOG.md's [Unreleased] section into `## [x.y.z] — date` under a new, empty [Unreleased],
 *   and moves the compare links along.
 * - Writes that section to <notes.md>, the GitHub Release's notes.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const [version = "", date = "", notesOut = ""] = process.argv.slice(2);

function fail(msg: string): never {
  process.stderr.write(`release: ${msg}\n`);
  process.exit(1);
}

if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`version "${version}" is not x.y.z`);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`date "${date}" is not yyyy-mm-dd`);
if (!notesOut) fail("usage: node scripts/release.ts <x.y.z> <yyyy-mm-dd> <notes.md>");

// Everything is checked before anything is written. The version is edited as text, so each file keeps
// its layout: the first `"version": "x.y.z"` is the top-level one.
const tracked = execFileSync("git", ["ls-files", "package.json", "*/package.json", "apps/mcp/mcpb/manifest.json"], { encoding: "utf8" }).split("\n").filter(Boolean);
const bumped = new Map<string, string>();
for (const file of tracked) {
  const text = readFileSync(file, "utf8");
  if ((JSON.parse(text) as { version?: unknown }).version === undefined) continue;
  const next = text.replace(/"version": "\d+\.\d+\.\d+"/, `"version": "${version}"`);
  if ((JSON.parse(next) as { version?: unknown }).version !== version) fail(`${file}: could not set the version`);
  bumped.set(file, next);
}
if (!bumped.has("apps/mcp/mcpb/manifest.json")) fail("apps/mcp/mcpb/manifest.json has no version");

// CHANGELOG.md, Keep a Changelog style: the release takes what is under [Unreleased].
const log = readFileSync("CHANGELOG.md", "utf8");
if (log.includes(`\n## [${version}]`)) fail(`CHANGELOG.md already has a [${version}] section`);
const head = log.indexOf("\n## [Unreleased]\n");
if (head < 0) fail("CHANGELOG.md has no '## [Unreleased]' heading");
const bodyStart = head + "\n## [Unreleased]\n".length;
const nextSection = log.indexOf("\n## [", bodyStart);
const bodyEnd = nextSection < 0 ? log.length : nextSection + 1;
// A release with nothing listed is dependency and build upkeep: say so rather than publish empty notes.
const body = log.slice(bodyStart, bodyEnd).trim() || "### Changed\n- Maintenance only: dependency and build updates.";

const link = /^\[Unreleased\]: (\S+)\/compare\/v\d+\.\d+\.\d+\.\.\.HEAD$/m.exec(log);
if (!link) fail("CHANGELOG.md has no '[Unreleased]: …/compare/vX.Y.Z...HEAD' link");
const repo = link[1];
const out =
  log.slice(0, bodyStart) +
  `\n## [${version}] — ${date}\n\n${body}\n\n` +
  log.slice(bodyEnd).replace(link[0], () => `[Unreleased]: ${repo}/compare/v${version}...HEAD\n[${version}]: ${repo}/releases/tag/v${version}`);
for (const [file, text] of bumped) writeFileSync(file, text);
writeFileSync("CHANGELOG.md", out);
writeFileSync(notesOut, `${body}\n`);
process.stdout.write(`release: ${version} — ${bumped.size} versions set, CHANGELOG.md section written\n`);
