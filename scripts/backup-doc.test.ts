import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * PETTY-455: the backup script in docs/deploy.md ("Backups") is what a self-hoster copies, so this runs
 * the text itself: a dump that fails must end the script with an error, leave nothing under the day's
 * name, and keep an earlier good dump of the same day. `docker` (which runs pg_dump) and `age` are
 * stand-ins on the PATH that succeed or fail on request.
 */
const doc = readFileSync(join(import.meta.dirname, "../docs/deploy.md"), "utf8");
const backups = doc.slice(doc.indexOf("\n## Backups\n"), doc.indexOf("\n## Upgrading\n"));
const script = /```sh\n(#!\/usr\/bin\/env bash\n[\s\S]*?)```/.exec(backups)?.[1];

const root = mkdtempSync(join(tmpdir(), "petty-backup-doc-"));
after(() => rmSync(root, { recursive: true, force: true }));
const bin = join(root, "bin");
mkdirSync(bin);
// `docker compose … exec -T db pg_dump -U petty -Fc petty`: some bytes, then the status asked for
writeFileSync(join(bin, "docker"), `#!/bin/sh
case "$*" in *"exec -T db pg_dump -U petty -Fc petty") ;; *) echo "unexpected: docker $*" >&2; exit 64 ;; esac
printf 'dump:%s' "$DUMP_BYTES"
exit "\${DUMP_STATUS:-0}"
`);
// `age -r <recipient>`: passes its input on, marked, then the status asked for
writeFileSync(join(bin, "age"), `#!/bin/sh
[ "$1" = -r ] && [ "$2" = age1testrecipient ] || { echo "unexpected: age $*" >&2; exit 64; }
printf 'sealed:'; cat
exit "\${AGE_STATUS:-0}"
`);
for (const f of ["docker", "age"]) chmodSync(join(bin, f), 0o755);

/** Runs the script in a folder of its own; `before` is a dump already there under today's name. */
function run(env: Record<string, string | undefined>, before?: string) {
  const dir = mkdtempSync(join(root, "run-"));
  writeFileSync(join(dir, "backup.sh"), script!);
  // the script names the file by the shell's local date, so ask the same shell for it
  const today = `petty-${spawnSync("bash", ["-c", "date +%F"], { encoding: "utf8" }).stdout.trim()}.dump.age`;
  if (before !== undefined) writeFileSync(join(dir, today), before);
  const all: Record<string, string | undefined> = { PATH: `${bin}:${process.env["PATH"] ?? ""}`, AGE_RECIPIENT: "age1testrecipient", DUMP_BYTES: "all of it", ...env };
  const res = spawnSync("bash", ["backup.sh"], { cwd: dir, encoding: "utf8", env: Object.fromEntries(Object.entries(all).filter(([, v]) => v !== undefined)) as Record<string, string> });
  const files = readdirSync(dir).filter((f) => f !== "backup.sh");
  return { status: res.status, stderr: res.stderr, files, dump: existsSync(join(dir, today)) ? readFileSync(join(dir, today), "utf8") : null };
}

describe("the backup script in docs/deploy.md", () => {
  it("is there to copy", () => {
    assert.ok(script, "docs/deploy.md, Backups: no ```sh block that starts with #!/usr/bin/env bash");
  });
  it("writes the day's dump when pg_dump and age succeed, and leaves no partial file", () => {
    const r = run({});
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.dump, "sealed:dump:all of it");
    assert.equal(r.files.length, 1, r.files.join(" "));
  });
  it("fails and writes nothing when pg_dump fails part way", () => {
    const r = run({ DUMP_STATUS: "1", DUMP_BYTES: "half" });
    assert.notEqual(r.status, 0);
    assert.deepEqual(r.files, []);
  });
  it("keeps an earlier good dump of the same day when pg_dump fails", () => {
    const r = run({ DUMP_STATUS: "1", DUMP_BYTES: "half" }, "sealed:dump:the morning's good dump");
    assert.notEqual(r.status, 0);
    assert.equal(r.dump, "sealed:dump:the morning's good dump");
    assert.equal(r.files.length, 1, r.files.join(" "));
  });
  it("fails and writes nothing when age fails", () => {
    const r = run({ AGE_STATUS: "1" });
    assert.notEqual(r.status, 0);
    assert.deepEqual(r.files, []);
  });
  it("fails and writes nothing when no recipient is set", () => {
    const r = run({ AGE_RECIPIENT: undefined });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /AGE_RECIPIENT/);
    assert.deepEqual(r.files, []);
  });
});
