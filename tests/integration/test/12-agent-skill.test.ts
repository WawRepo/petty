import { describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { ORIGIN } from "../lib.js";

/**
 * PETTY-310: the image serves the "petty" Agent Skill beside the add-on, as claude.ai takes a skill:
 * a ZIP whose top level is the skill's folder, with SKILL.md and the licence in it.
 */
describe("the Claude skill the image serves", () => {
  it("/downloads/petty-skill.zip holds petty/SKILL.md and petty/LICENSE", async () => {
    const r = await fetch(`${ORIGIN}/downloads/petty-skill.zip`);
    expect(r.status).toBe(200);
    const files = unzipSync(new Uint8Array(await r.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual(["petty/LICENSE", "petty/SKILL.md"]);
    const skill = new TextDecoder().decode(files["petty/SKILL.md"]);
    expect(skill).toMatch(/^---\nname: petty\ndescription: .{40,1024}\n/);
    expect(skill).toContain("## With the command line instead of MCP tools");
    expect(new TextDecoder().decode(files["petty/LICENSE"])).toContain("GNU AFFERO GENERAL PUBLIC LICENSE");
  });
});
