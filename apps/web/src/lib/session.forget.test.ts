import { describe, expect, it, vi } from "vitest";

// PETTY-461: what a module keeps from the unlocked session is dropped on lock. Only session.ts is real here.
vi.mock("./passkey.js", () => ({ evaluatePrf: vi.fn() }));
vi.mock("./api.js", () => ({ api: vi.fn(), ApiError: class extends Error {}, NetworkError: class extends Error {}, setBeforeRequest: vi.fn(), setSessionGoneHandler: vi.fn() }));
vi.mock("./idb.js", () => ({ idb: { get: vi.fn(async () => undefined), set: vi.fn(async () => undefined), del: vi.fn(async () => undefined), keys: vi.fn(async () => []) } }));
vi.mock("./net.js", () => ({ onBackOnline: vi.fn() }));
vi.mock("./drawers.js", () => ({ resetDrawers: vi.fn() }));
vi.mock("./pins.js", () => ({ forgetSelfKey: vi.fn() }));

describe("onForget (PETTY-461)", () => {
  it("runs every registered forgetter on lock, also when one of them throws, and stops when asked", async () => {
    const { lockNow, onForget } = await import("./session.js");
    const seen: string[] = [];
    onForget(() => { seen.push("a"); throw new Error("boom"); });
    const stop = onForget(() => seen.push("b"));
    await lockNow();
    expect(seen).toEqual(["a", "b"]);
    stop();
    await lockNow();
    expect(seen).toEqual(["a", "b", "a"]);
  });
});
