import { describe, expect, it } from "vitest";
import type { AgentDrawer, AgentLine } from "@petty/agent";
import { drawersText } from "../src/cli.js";
import { cells, padCells } from "../src/width.js";

/** PETTY-495: `petty drawers` lines amounts up by terminal cells, not by UTF-16 units or code points. */
describe("cells()", () => {
  it("counts a cell per letter, accents included", () => {
    expect(cells("Cash")).toBe(4);
    expect(cells("Café")).toBe(4);
    expect(cells("Café")).toBe(4); // e + combining acute
    expect(cells("Złoty")).toBe(5);
  });

  it("counts 2 for an emoji shown as a picture, however many code points it has", () => {
    expect(cells("💰")).toBe(2);
    expect(cells("👨‍👩‍👧")).toBe(2); // three people joined by ZWJ
    expect(cells("👍🏽")).toBe(2); // with a skin tone
    expect(cells("🇵🇱")).toBe(2); // a flag
    expect(cells("❤️")).toBe(2); // a text heart asked to be a picture
    expect(cells("1️⃣")).toBe(2); // a keycap
    expect(cells("Tin 💰")).toBe(6);
  });

  it("counts 1 for a symbol shown as text", () => {
    expect(cells("©")).toBe(1);
    expect(cells("→")).toBe(1);
    expect(cells("€")).toBe(1);
  });

  it("counts 2 for wide East Asian letters and fullwidth forms", () => {
    expect(cells("猫")).toBe(2);
    expect(cells("ねこ")).toBe(4);
    expect(cells("고양이")).toBe(6);
    expect(cells("ＡＢ")).toBe(4);
  });
});

describe("padCells()", () => {
  it("pads to the width in cells, never cuts", () => {
    expect(padCells("猫", 5)).toBe("猫   ");
    expect(padCells("👨‍👩‍👧", 4)).toBe("👨‍👩‍👧  ");
    expect(padCells("Coins", 3)).toBe("Coins");
  });
});

describe("drawersText()", () => {
  const line = (name: string, amount: string): AgentLine => ({ name, amount, kind: "money", countedInTotal: true, tags: [], unverified: 0 }) as unknown as AgentLine;
  const drawer = (lines: AgentLine[]): AgentDrawer => ({ id: "d", name: "Tin", place: [], role: "owner", lines, unreadable: 0 });

  it("starts every amount in the same terminal column, with a gap after the widest name", () => {
    const text = drawersText([drawer([line("💰💰💰💰💰💰💰💰", "1.00 EUR"), line("👨‍👩‍👧 fund", "2.00 EUR"), line("猫の餌", "3.00 EUR"), line("Cash", "4.00 EUR")])]);
    const rows = text.split("\n").slice(1, 5);
    // before PETTY-495 the eight emoji ran into the amount: "💰💰💰💰💰💰💰💰1.00 EUR"
    expect(rows[0]).toBe("  💰💰💰💰💰💰💰💰  1.00 EUR");
    const column = rows.map((r) => cells(r.slice(0, r.indexOf("."))) - 1);
    expect(new Set(column).size).toBe(1);
  });
});
