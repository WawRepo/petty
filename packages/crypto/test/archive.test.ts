import { describe, expect, it } from "vitest";
import { InvalidPayload, WrongPassphrase, openArchive, sealArchive } from "../src/index.js";

describe("export archive", () => {
  it("round-trips under the export password; wrong password fails", async () => {
    const payload = { format: "petty-export", v: 1, drawers: [{ id: "d1", name: "Kitchen" }] };
    const archive = await sealArchive("export password 2026", payload);
    expect(archive.kdf.m).toBe(65536);
    expect(JSON.stringify(archive)).not.toContain("Kitchen");
    expect(await openArchive("export password 2026", archive)).toEqual(payload);
    await expect(openArchive("export password 2027", archive)).rejects.toBeInstanceOf(WrongPassphrase);
    await expect(sealArchive("short", payload)).rejects.toBeInstanceOf(InvalidPayload);
  }, 60_000);
});
