#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

async function main() {
  const server = await buildServer({ token: token(), apiUrl: (process.env["PETTY_API_URL"] ?? "http://localhost:3000").replace(/\/$/, "") });
  await server.connect(new StdioServerTransport());
}

main().catch((e: unknown) => {
  process.stderr.write(`petty-mcp: ${(e as Error).message}\n`);
  process.exit(1);
});
