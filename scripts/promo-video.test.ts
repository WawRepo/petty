import { describe, it } from "node:test";
import assert from "node:assert/strict";

/** PETTY-324: the owner asked for a film of about 20 seconds and one of 40 to 50; PETTY-325 for a longer tour. */
const { FILMS, SHORTS, length } = (await import("./promo-video.ts")) as typeof import("./promo-video.ts");

describe("promo-video", () => {
  it("cuts a short film of about 20 s and a long one of 40 to 50 s", () => {
    const by = Object.fromEntries(FILMS.map((f) => [f.name, length(f)]));
    assert.ok(by["petty-short"]! >= 18 && by["petty-short"]! <= 22, `short is ${by["petty-short"]} s`);
    assert.ok(by["petty-long"]! >= 40 && by["petty-long"]! <= 50, `long is ${by["petty-long"]} s`);
    // PETTY-325: the feature tour, a chapter a feature, under two minutes
    assert.ok(by["petty-tour"]! >= 80 && by["petty-tour"]! <= 120, `tour is ${by["petty-tour"]} s`);
  });

  it("gives every scene a middle: longer than the cross-fades at both its ends", () => {
    for (const f of FILMS) for (const s of f.scenes) assert.ok(s.dur > 2 * f.fade + 1, `${f.name} ${s.clip}: ${s.dur} s`);
  });

  // PETTY-467: YouTube Shorts are 15 to 45 s here, and the app is already moving in the first second
  it("cuts each Short to 15–45 s from one take, starting just before its first tap", () => {
    assert.ok(SHORTS.length >= 2 && SHORTS.length <= 3, `${SHORTS.length} Shorts`);
    for (const f of SHORTS) {
      assert.ok(FILMS.includes(f), `${f.name} is cut with the others`);
      assert.ok(length(f) >= 15 && length(f) <= 45, `${f.name} is ${length(f)} s`);
      assert.equal(f.layers, "layers-short", `${f.name} uses the Shorts' frame`);
      assert.equal(new Set(f.scenes.map((s) => s.clip)).size, 1, `${f.name} is one take`);
      const first = f.scenes[0]!.from;
      assert.ok(typeof first !== "number" && first[0] === "b1" && first[1] > -0.5 && first[1] <= 0, `${f.name} starts at its first beat`);
      assert.equal(f.scenes.at(-1)!.layers.at(-1)!.png, "cap-s-end", `${f.name} ends on the name and the address`);
    }
  });
});
