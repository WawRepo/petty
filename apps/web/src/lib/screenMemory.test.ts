import { afterEach, describe, expect, it, vi } from "vitest";

// PETTY-417 (security review #19): what one screen hands the next stays in memory, and lock forgets it.
function fakeStorage(start: Record<string, string>) {
  const map = new Map(Object.entries(start));
  return { map, store: { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) } };
}
async function fresh(start: Record<string, string> = {}) {
  const { map, store } = fakeStorage(start);
  vi.stubGlobal("localStorage", store);
  vi.resetModules();
  return { map, m: await import("./screenMemory.js") };
}
afterEach(() => { vi.unstubAllGlobals(); });

describe("screen memory (PETTY-417)", () => {
  it("removes the last currency an older version left in localStorage, and never writes one", async () => {
    const { map, m } = await fresh({ "petty.lastCurrency": "CHF", "petty.theme": "dark" });
    expect(map.has("petty.lastCurrency")).toBe(false);
    expect(map.get("petty.theme")).toBe("dark");
    expect(m.lastUsedCurrency()).toBeNull();
    m.rememberCurrency("EUR");
    expect(m.lastUsedCurrency()).toBe("EUR");
    expect([...map.keys()]).toEqual(["petty.theme"]);
  });

  it("hands a tag filter to its own drawer once, and tells the drawer already on screen", async () => {
    const { m } = await fresh();
    const seen: (string | null)[] = [];
    const stop = m.onTagFilter(() => seen.push(m.takeTagFilter("d1")));
    m.filterNextDrawer("d2", "cash");
    expect(seen).toEqual([null]); // for another drawer: left for that one
    expect(m.takeTagFilter("d2")).toBe("cash");
    expect(m.takeTagFilter("d2")).toBeNull(); // once
    m.filterNextDrawer("d1", "spare cash");
    expect(seen).toEqual([null, "spare cash"]);
    stop();
    m.filterNextDrawer("d1", "food");
    expect(seen).toHaveLength(2);
    expect(m.takeTagFilter("d1")).toBe("food");
  });

  it("lock and sign-out forget both", async () => {
    const { m } = await fresh();
    m.rememberCurrency("PLN");
    m.filterNextDrawer("d1", "cash");
    m.forgetScreenMemory();
    expect(m.lastUsedCurrency()).toBeNull();
    expect(m.takeTagFilter("d1")).toBeNull();
  });

  it("works when storage is blocked", async () => {
    vi.stubGlobal("localStorage", { removeItem: () => { throw new Error("blocked"); } });
    vi.resetModules();
    const m = await import("./screenMemory.js");
    expect(() => m.forgetScreenMemory()).not.toThrow();
  });
});
