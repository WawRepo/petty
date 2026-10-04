import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.js";
import { COMMANDS } from "../../cli/src/commands.js";
import { readSkill } from "../scripts/skill.js";

/**
 * PETTY-310: the "petty" Agent Skill follows the specification, and it cannot drift from what it
 * teaches: every tool the server offers is in its table and nothing else is, every command it names
 * is a real `petty` command, and every error code it explains is one the agent can raise.
 */
const dir = join(import.meta.dirname, "../skills/petty");
const skill = readSkill(dir);
const root = mkdtempSync(join(tmpdir(), "petty-skill-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The rows of the Markdown table that follows a heading, as arrays of cells. */
function table(heading: string): string[][] {
  const at = skill.body.indexOf(`## ${heading}\n`);
  expect(at, heading).toBeGreaterThan(-1);
  const section = skill.body.slice(at + heading.length + 4).split(/\n## /)[0]!;
  const rows = section.split("\n").filter((l) => l.startsWith("|")).map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
  return rows.slice(2); // header and the --- line
}
const ticked = (cell: string) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);

/** All the tools, as a host sees them before the token's role is known (the write tools included). */
async function serverTools(): Promise<string[]> {
  const server = await buildServer({ token: "petty_pat_x.y", apiUrl: "https://petty.test", connect: async () => { throw new Error("offline"); } });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new McpClient({ name: "test-host", version: "1.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return (await client.listTools()).tools.map((t) => t.name);
}

describe("the petty skill", () => {
  it("has the frontmatter the Agent Skills specification asks for", () => {
    expect(skill.name).toBe("petty");
    expect(skill.description.length).toBeLessThanOrEqual(1024);
    expect(skill.description).toMatch(/Use it when/);
    expect(skill.fields["license"]).toMatch(/^AGPL-3\.0-only/);
    expect(skill.metadata["docs"]).toBe("https://github.com/WawRepo/petty/blob/main/docs/agent.md");
    expect(skill.body.split("\n").length).toBeLessThan(500);
  });

  it("lists exactly the tools the MCP server offers", async () => {
    const listed = table("With the command line instead of MCP tools").map((r) => ticked(r[0]!)[0]);
    expect([...listed].sort()).toEqual((await serverTools()).sort());
  });

  it("names only real petty commands, with flags they take", () => {
    for (const row of table("With the command line instead of MCP tools")) {
      for (const cmd of ticked(row[1]!)) {
        const words = cmd.split(" ");
        const spec = COMMANDS.find((c) => c.name === words[1]);
        expect(spec, cmd).toBeDefined();
        for (const flag of cmd.matchAll(/--([a-z-]+)/g)) expect(spec!.flags.map((f) => f.name), cmd).toContain(flag[1]);
      }
    }
  });

  it("explains only error codes the agent can raise", () => {
    const src = readFileSync(join(import.meta.dirname, "../../../packages/agent/src/index.ts"), "utf8");
    const union = /constructor\(readonly code: ([^,]+),/.exec(src)?.[1] ?? "";
    const codes = [...union.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]);
    expect(codes.length).toBeGreaterThan(5);
    for (const row of table("Errors")) for (const code of ticked(row[0]!)) expect(codes, code).toContain(code);
  });
});

describe("readSkill", () => {
  const write = (name: string, front: string): string => {
    const d = join(root, name.replace(/\W/g, "_"), name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "SKILL.md"), `---\n${front}\n---\n\n# body\n`);
    return d;
  };
  it("refuses what the specification does not allow", () => {
    expect(() => readSkill(write("ok", "name: ok\ndescription: Does a thing. Use it when asked."))).not.toThrow();
    expect(() => readSkill(write("other", "name: petty\ndescription: d"))).toThrow(/folder name/);
    expect(() => readSkill(write("Upper", "name: Upper\ndescription: d"))).toThrow(/lowercase/);
    expect(() => readSkill(write("dash", "name: dash\ndescription: d\nversion: 1"))).toThrow(/not in the Agent Skills specification/);
    expect(() => readSkill(write("long", `name: long\ndescription: ${"x".repeat(1025)}`))).toThrow(/1-1024/);
    expect(() => readSkill(write("quoted", "name: quoted\ndescription: \"d\""))).toThrow(/plain value/);
    expect(() => readSkill(write("colon", "name: colon\ndescription: a: b"))).toThrow(/plain value/);
    expect(() => readSkill(write("nometa", "name: nometa\ndescription: d\nmetadata: x"))).toThrow(/metadata/);
  });
});

describe("pack.ts --skill", () => {
  const pack = (tz: string, out: string) => {
    execFileSync(process.execPath, ["--import", "tsx", join(import.meta.dirname, "../scripts/pack.ts"), "--skill", dir, out, join(import.meta.dirname, "../../../LICENSE")], { env: { ...process.env, TZ: tz } });
    return readFileSync(out);
  };
  it("zips the skill folder as the top level, with the licence, the same bytes everywhere", () => {
    const a = pack("UTC", join(root, "a.zip"));
    const b = pack("Pacific/Auckland", join(root, "b.zip"));
    expect(createHash("sha256").update(a).digest("hex")).toBe(createHash("sha256").update(b).digest("hex"));
    const files = unzipSync(new Uint8Array(a));
    expect(Object.keys(files).sort()).toEqual(["petty/LICENSE", "petty/SKILL.md"]);
    expect(new TextDecoder().decode(files["petty/SKILL.md"])).toBe(readFileSync(join(dir, "SKILL.md"), "utf8"));
  });
  it("refuses a skill whose SKILL.md breaks the specification", () => {
    const bad = join(root, "bad", "bad");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "SKILL.md"), "---\nname: other\ndescription: d\n---\n");
    expect(() => execFileSync(process.execPath, ["--import", "tsx", join(import.meta.dirname, "../scripts/pack.ts"), "--skill", bad, join(root, "bad.zip"), join(import.meta.dirname, "../../../LICENSE")], { stdio: "pipe" })).toThrow(/folder name/);
  });
});
