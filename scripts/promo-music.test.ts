import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";

/** PETTY-324: the promo films' music is made here, so its length, format and level are ours to check. */
const script = join(import.meta.dirname, "promo-music.ts");
const dir = mkdtempSync(join(tmpdir(), "petty-music-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const make = (secs: string, out: string) => spawnSync(process.execPath, [script, secs, join(dir, out)], { encoding: "utf8" });

describe("promo-music", () => {
  it("writes a 48 kHz 16-bit stereo WAV exactly as long as asked, loud but not clipped, quiet at both ends", () => {
    assert.equal(make("2.5", "a.wav").status, 0);
    const b = readFileSync(join(dir, "a.wav"));
    assert.equal(b.toString("ascii", 0, 4), "RIFF");
    assert.equal(b.toString("ascii", 8, 12), "WAVE");
    assert.deepEqual([b.readUInt16LE(20), b.readUInt16LE(22), b.readUInt32LE(24), b.readUInt16LE(34)], [1, 2, 48_000, 16]);
    assert.equal(b.readUInt32LE(40), 2.5 * 48_000 * 4);
    let peak = 0;
    for (let i = 44; i < b.length; i += 2) peak = Math.max(peak, Math.abs(b.readInt16LE(i)) / 32767);
    assert.ok(peak > 0.5 && peak <= 0.9, `peak ${peak}`);
    assert.ok(Math.abs(b.readInt16LE(44)) < 50 && Math.abs(b.readInt16LE(b.length - 4)) < 50, "fades in and out");
  });

  it("makes the same piece every run", () => {
    assert.equal(make("1.5", "b.wav").status, 0);
    assert.equal(make("1.5", "c.wav").status, 0);
    assert.ok(readFileSync(join(dir, "b.wav")).equals(readFileSync(join(dir, "c.wav"))));
  });

  it("refuses a missing or empty length", () => {
    assert.equal(make("0", "d.wav").status, 2);
  });
});
