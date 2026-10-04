/**
 * The MCP Registry entry for a release (PETTY-311). The official registry
 * (registry.modelcontextprotocol.io) holds metadata only: this entry points at the release's Claude
 * Desktop add-on on GitHub and gives its SHA-256, which MCP apps check before they install it. The
 * registry itself asks for: a name under the namespace the GitHub login proves (io.github.WawRepo/,
 * matched case for case), a title and a description of at most 100 characters, and an `.mcpb` address on
 * github.com that contains "mcp". The add-on runs on the user's computer (stdio) and decrypts there.
 *
 *   node scripts/mcp-server-json.ts <vX.Y.Z tag> <petty.mcpb> > server.json
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const NAME = "io.github.WawRepo/petty";
const REPO = "https://github.com/WawRepo/petty";
const DESCRIPTION = "End-to-end encrypted cash ledger: balances, history, add or take cash. Decrypts on your computer.";

const [tag = "", file = ""] = process.argv.slice(2);
const fail = (msg: string): never => {
  process.stderr.write(`mcp-server-json: ${msg}\n`);
  process.exit(1);
};
if (!/^v\d+\.\d+\.\d+$/.test(tag) || !file) fail("usage: node scripts/mcp-server-json.ts <vX.Y.Z tag> <petty.mcpb>");
if (DESCRIPTION.length > 100) fail(`the description has ${DESCRIPTION.length} characters; the registry takes 100`);
const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");

const entry = {
  $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  name: NAME,
  title: "Petty",
  description: DESCRIPTION,
  version: tag.slice(1),
  repository: { url: REPO, source: "github", subfolder: "apps/mcp" },
  websiteUrl: `${REPO}/blob/main/docs/agent.md`,
  packages: [
    {
      registryType: "mcpb",
      identifier: `${REPO}/releases/download/${tag}/petty.mcpb`,
      fileSha256: sha256,
      transport: { type: "stdio" },
    },
  ],
};
process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`);
