#!/usr/bin/env node
import { readFileSync } from "node:fs";
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
  try {
    return readFileSync(join(homedir(), ".petty", "token"), "utf8").trim();
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
