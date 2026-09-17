/** Permanent: the export archive fixture must open and validate on every build. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { importEcdsaPublic, openArchive, verifyEntry, type ExportArchiveV1 } from "@petty/crypto";
import { ExportPayload } from "../src/index.js";

const fx = JSON.parse(readFileSync(fileURLToPath(new URL("../corpus/export-v1.json", import.meta.url)), "utf8")) as { password: string; payload: unknown; archive: ExportArchiveV1; ecdsa_pub: string };

describe("export archive v1 fixture", () => {
  it("opens with the recorded password, validates, and its entries verify", async () => {
    const opened = ExportPayload.parse(await openArchive(fx.password, fx.archive));
    expect(opened).toEqual(ExportPayload.parse(fx.payload));
    const key = await importEcdsaPublic(fx.ecdsa_pub);
    for (const e of opened.drawers[0]!.entries) await expect(verifyEntry(e.entry, { author_id: e.entry.author_id, sig_key_id: e.entry.sig_key_id, ecdsaPublic: key })).resolves.toBeUndefined();
    expect(opened.drawers[0]!.entries.map((e) => e.entry.op)).toEqual(["add", "withdraw", "adjust"]);
  }, 30_000);
  it("refuses the wrong password", async () => {
    await expect(openArchive("wrong password 2026", fx.archive)).rejects.toThrow();
  }, 30_000);
});
