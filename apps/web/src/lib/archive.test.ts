import { beforeEach, describe, expect, it, vi } from "vitest";
import { LedgerError, newDocument, type DrawerDocument, type Line } from "@petty/ledger";
import type { ExportDrawer, ExportPayload } from "@petty/protocol";

/**
 * PETTY-519: the import refuses an archive whose amounts could add up past the largest exact number, and
 * checks every drawer before it writes the first. The server and the drawers are stand-ins: a refused
 * archive must reach neither.
 */
const writes: string[] = [];
vi.mock("./api.js", () => ({ api: vi.fn(async (method: string, path: string) => { writes.push(`${method} ${path}`); return {}; }) }));
vi.mock("./drawers.js", () => ({
  appendEntry: vi.fn(async () => { writes.push("entry"); return { entry: { id: "x" } }; }),
  getDrawers: () => ({ status: "ready", order: [], drawers: new Map() }),
  loadAll: vi.fn(async () => undefined),
  setPhoto: vi.fn(async () => { writes.push("photo"); }),
}));
vi.mock("./pins.js", () => ({ startUserDoc: vi.fn(async () => { writes.push("user doc"); }) }));
vi.mock("./session.js", () => ({ getAuth: () => ({ status: "unlocked", me: { id: "00000000-0000-4000-8000-0000000000f0" }, keys: {} }) }));

const { ImportSumTooLarge, importPayload, importSumsAreExact } = await import("./archive.js");

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const money = (id: string, currency = "EUR", exponent = 2): Line => ({ id, kind: "money", name: `${currency} ${id}`, currency, exponent });
const things = (id: string): Line => ({ id, kind: "countable", name: "Balls", unit: "" });
const doc = (...lines: Line[]): DrawerDocument => ({ ...newDocument("Kitchen"), lines });
let seq = 0;
const entry = (line: string, op: "add" | "withdraw" | "adjust" | "reverse", amount: number): ExportDrawer["entries"][number] => ({
  seq: ++seq, received_at: "2026-11-18T12:00:00.000Z",
  entry: {
    v: 1, id: uuid(1000 + seq), drawer_id: uuid(900), line_id: line, op, amount, exponent: 2, comment: "", logged_at: "2026-11-18T12:00:00.000Z",
    reverses: null, prev_hash: null, delta_hint: null, author_id: uuid(901), sig_key_id: "k", sig: "s",
  },
});
const half = 2 ** 52; // two of them make 2^53, one past the largest exact integer
const [A, B] = [uuid(1), uuid(2)];

describe("importSumsAreExact (PETTY-519)", () => {
  it("takes an ordinary archive, and the largest amounts that stay exact", () => {
    expect(importSumsAreExact(doc(money(A)), [entry(A, "adjust", 10000), entry(A, "add", 250), entry(A, "withdraw", -1200)])).toBe(true);
    expect(importSumsAreExact(doc(money(A)), [entry(A, "add", Number.MAX_SAFE_INTEGER)])).toBe(true);
    expect(importSumsAreExact(doc(money(A)), [])).toBe(true);
  });

  it("refuses an item whose sum leaves the exact integers", () => {
    expect(importSumsAreExact(doc(money(A)), [entry(A, "add", half), entry(A, "add", half)])).toBe(false);
    expect(importSumsAreExact(doc(things(A)), [entry(A, "add", half), entry(A, "withdraw", -half)])).toBe(false);
  });

  it("starts again at each count, as the drawer's balance does", () => {
    expect(importSumsAreExact(doc(money(A)), [entry(A, "add", half), entry(A, "adjust", 5), entry(A, "add", half)])).toBe(true);
  });

  it("counts an undo as an amount of its own: the import may leave it out", () => {
    // in the archive's order the balance never passes 2^52; without the undo it would reach 2^53
    expect(importSumsAreExact(doc(money(A)), [entry(A, "add", half), entry(A, "reverse", -half), entry(A, "add", half)])).toBe(false);
  });

  it("refuses items of one currency whose sum leaves the exact integers, as the app does when it opens a drawer", () => {
    expect(importSumsAreExact(doc(money(A), money(B)), [entry(A, "add", half), entry(B, "add", half)])).toBe(false);
    // another currency, or counted things, are not added up together
    expect(importSumsAreExact(doc(money(A), money(B, "PLN")), [entry(A, "add", half), entry(B, "add", half)])).toBe(true);
    expect(importSumsAreExact(doc(things(A), things(B)), [entry(A, "add", half), entry(B, "add", half)])).toBe(true);
  });

  it("leaves out what the import does not write: a single item, and an item not in the document", () => {
    expect(importSumsAreExact(doc(money(A)), [entry(B, "add", half), entry(B, "add", half)])).toBe(true);
    expect(importSumsAreExact(doc({ id: A, kind: "single", name: "Passport", text: "" }), [entry(A, "add", half), entry(A, "add", half)])).toBe(true);
  });

  it("refuses an amount that is not a safe integer", () => {
    expect(importSumsAreExact(doc(money(A)), [entry(A, "add", 2 ** 53)])).toBe(false);
  });
});

describe("importPayload (PETTY-519)", () => {
  beforeEach(() => { writes.length = 0; });
  const drawer = (document: unknown, entries: ExportDrawer["entries"]): ExportDrawer => ({ id: uuid(900), document, photo_b64: null, members: [], entries });
  const payload = (...drawers: ExportDrawer[]): ExportPayload => ({ format: "petty-export", v: 1, exported_at: "2026-11-18T12:00:00.000Z", exported_by: { id: uuid(901), display_name: "Ann" }, drawers });
  const good = drawer(doc(money(A)), [entry(A, "add", 100)]);

  it("writes nothing when one drawer's sums would not be exact, even after a good one", async () => {
    await expect(importPayload(payload(good, drawer(doc(money(A)), [entry(A, "add", half), entry(A, "add", half)])), () => undefined)).rejects.toBeInstanceOf(ImportSumTooLarge);
    expect(writes).toEqual([]);
  });

  it("writes nothing when one drawer's document is refused, even after a good one", async () => {
    await expect(importPayload(payload(good, drawer({ ...doc(), name: "n".repeat(121) }, [])), () => undefined)).rejects.toBeInstanceOf(LedgerError);
    expect(writes).toEqual([]);
  });
});
