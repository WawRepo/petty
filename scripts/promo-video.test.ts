import { describe, it } from "node:test";
import assert from "node:assert/strict";

/** PETTY-324: the owner asked for a film of about 20 seconds and one of 40 to 50; PETTY-325 for a longer tour. */
const { FILMS, length } = (await import("./promo-video.ts")) as typeof import("./promo-video.ts");

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
});
