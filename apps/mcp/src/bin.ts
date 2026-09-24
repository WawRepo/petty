#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";

/**
 * Claude Desktop starts this over stdio (PETTY-166). The token comes from PETTY_TOKEN or from
 * ~/.petty/token; the API address from PETTY_API_URL. Errors go to stderr, never to stdout,
 * which carries the protocol.
 */
function token(): string {
  const fromEnv = process.env["PETTY_TOKEN"];
  if (fromEnv) return fromEnv.trim();
  const file = join(homedir(), ".petty", "token");
  try {
    const text = readFileSync(file, "utf8").trim();
    // PETTY-193 (NR-13): the token opens the drawers; other accounts on this machine must not read it.
    if (process.platform !== "win32" && (statSync(file).mode & 0o077) !== 0) {
      process.stderr.write(`petty-mcp: warning: ${file} can be read by other users; run: chmod 600 ${file}\n`);
    }
    return text;
  } catch {
    throw new Error("no token: set PETTY_TOKEN or put it in ~/.petty/token (Settings → Access tokens)");
  }
}

/**
 * `petty-mcp.mjs --print-config <Petty address>/api` prints the MCP settings block for THIS machine and
 * exits: the absolute path of the running Node (GUI apps often lack the shell's PATH) and of this file,
 * so nobody has to work out and type a path into JSON. The token stays a placeholder.
 */
function printConfig(apiArg: string | undefined): void {
  const apiUrl = (apiArg ?? process.env["PETTY_API_URL"] ?? "").replace(/\/$/, "");
  if (!/^https?:\/\//.test(apiUrl)) {
    process.stderr.write("usage: node petty-mcp.mjs --print-config https://<your petty>/api\n");
    process.exit(2);
  }
  const config = { mcpServers: { petty: { command: process.execPath, args: [fileURLToPath(import.meta.url)], env: { PETTY_TOKEN: "petty_pat_…", PETTY_API_URL: apiUrl } } } };
  process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
}

async function main() {
  if (process.argv[2] === "--print-config") return printConfig(process.argv[3]);
  const server = await buildServer({ token: token(), apiUrl: (process.env["PETTY_API_URL"] ?? "http://localhost:3000").replace(/\/$/, "") });
  await server.connect(new StdioServerTransport());
}

main().catch((e: unknown) => {
  process.stderr.write(`petty-mcp: ${(e as Error).message}\n`);
  process.exit(1);
});
