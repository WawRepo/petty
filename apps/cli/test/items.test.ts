import { describe, expect, it } from "vitest";
import { TokenError, type AgentClient, type AgentDrawer } from "@petty/agent";
import { CliError } from "../src/io.js";
import { resolveDrawer, resolveItem } from "../src/items.js";

/**
 * How a command names an item or a drawer (PETTY-274, PETTY-515), against a stand-in of the client: only the
 * lookups matter here. The real client and API are in cli.test.ts and tests/integration 06-cli.
 */
const DRAWER = "6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c4a";
const LINE = "0b7e1d2c-3a4f-4e5b-8c6d-7f8091a2b3c4";
const OLD = "old id/7"; // an item id from before ids were UUIDs; it may hold a slash or a space
const drawer = { id: DRAWER, name: "Kitchen tin", place: [], lines: [{ id: LINE, name: "Cash", tags: [] }, { id: OLD, name: "Key", tags: [] }] } as unknown as AgentDrawer;
const client = (scope: string[] | null = null): AgentClient => ({
  identity: { scope },
  drawers: async () => [drawer],
  find: async (q: string) => { throw new TokenError("NotFound", `nothing matches ${JSON.stringify(q)}`); },
  findDrawer: async (t: string) => { if (t === DRAWER || t === "Kitchen tin") return drawer; throw new TokenError("NotFound", `no drawer matches ${JSON.stringify(t)}`); },
}) as unknown as AgentClient;

const name = async (target: string) => (await resolveItem(client(), target)).line.name;

describe("naming an item (PETTY-515)", () => {
  it("by the ids --json prints, the drawer's id in either case", async () => {
    expect(await name(`${DRAWER}/${LINE}`)).toBe("Cash");
    expect(await name(`${DRAWER.toUpperCase()}/${LINE.toUpperCase()}`)).toBe("Cash");
  });

  it("by an older item id that is not a UUID, as it is or quoted the way the AI add-on shows it", async () => {
    expect(await name(`${DRAWER}/${OLD}`)).toBe("Key");
    expect(await name(`${DRAWER}/${JSON.stringify(OLD)}`)).toBe("Key");
  });

  it("by the item's page in the app, copied from the browser, with its id %-escaped", async () => {
    expect(await name(`https://petty.example/drawers/${DRAWER}/lines/${LINE}`)).toBe("Cash");
    expect(await name(`https://petty.example/drawers/${DRAWER}/lines/${encodeURIComponent(OLD)}/`)).toBe("Key");
    expect(await name(`http://localhost:5173/drawers/${DRAWER.toUpperCase()}/lines/${LINE}?x=1#top`)).toBe("Cash");
  });

  it("an unknown id is not found (exit 4), and says so for a token made for chosen drawers", async () => {
    await expect(resolveItem(client(), `${DRAWER}/nope`)).rejects.toMatchObject({ code: "NotFound" });
    await expect(resolveItem(client(), `https://petty.example/drawers/${LINE}/lines/${LINE}`)).rejects.toMatchObject({ code: "NotFound" });
    await expect(resolveItem(client([DRAWER]), `${LINE}/${LINE}`)).rejects.toThrow("(this token opens only the 1 drawer chosen for it)");
  });

  it("a drawer's page or another page of Petty is a usage mistake (exit 2)", async () => {
    await expect(resolveItem(client(), `https://petty.example/drawers/${DRAWER}`)).rejects.toThrow(CliError);
    await expect(resolveItem(client(), `https://petty.example/drawers/${DRAWER}`)).rejects.toThrow("is a drawer's page");
    for (const page of ["https://petty.example/settings", "https://petty.example/drawers/kitchen/lines/x", `https://petty.example/drawers/${DRAWER}/lines/%E0%A4%A`]) {
      await expect(resolveItem(client(), page), page).rejects.toMatchObject({ exitCode: 2 });
    }
  });

  it("anything else still goes to the name and the words: a slash after a word that is not an id is part of the words", async () => {
    await expect(resolveItem(client(), "kitchen/cash")).rejects.toThrow('nothing matches "kitchen/cash"');
  });
});

describe("naming a drawer (PETTY-515)", () => {
  it("by its page, its id in either case, or its name", async () => {
    for (const t of [`https://petty.example/drawers/${DRAWER}`, DRAWER.toUpperCase(), "Kitchen tin"]) expect((await resolveDrawer(client(), t)).id, t).toBe(DRAWER);
  });

  it("an item's page names an item, not a drawer to move (exit 2)", async () => {
    await expect(resolveDrawer(client(), `https://petty.example/drawers/${DRAWER}/lines/${LINE}`)).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining("is an item's page") });
  });
});
