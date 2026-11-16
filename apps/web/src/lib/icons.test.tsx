import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_DRAWER_ICON, ICON_NAMES, PIcon } from "./icons.js";

// The slug comes out of a drawer's sealed document, so any member can store any slug there.
describe("PIcon", () => {
  const draw = (name: string): string => renderToStaticMarkup(<PIcon name={name} />);
  const fallback = draw(DEFAULT_DRAWER_ICON);

  it("draws every icon of the set", () => {
    for (const name of ICON_NAMES) expect(draw(name), name).toMatch(/^<svg /);
    expect(draw("wallet")).not.toBe(fallback);
  });

  it("draws the default icon for a slug that is not in the set, also for the names every object has", () => {
    for (const name of ["no-such-icon", "constructor", "toString", "__proto__", "hasOwnProperty", "valueOf", "isPrototypeOf", ""]) {
      expect(draw(name), name).toBe(fallback);
    }
  });
});
