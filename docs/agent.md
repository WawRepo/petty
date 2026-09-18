# Petty for an agent (Claude Desktop)

Petty's server only ever holds ciphertext, so an agent cannot ask it for a balance. The
decryption happens in a small program on your own machine: `petty-mcp`. It holds your access
token, opens the keys locally, and offers Petty as tools.

```
Claude Desktop ──stdio──▶ petty-mcp (your machine, holds the token)
                              │ opens the key bundle, decrypts here
                              ▼
                          Petty API (ciphertext only)
```

## 1. Make a token

In Petty: **Settings → Access tokens → New token**. Give it a name, decide whether it may add
entries, pick an expiry, and confirm with your passkey or passphrase. The token is shown once:

```
petty_pat_<id>.<secret>
```

Only the `<id>` half is ever sent to the server. The `<secret>` half opens a key bundle that the
server stores and cannot read. Revoking the token stops future use; it cannot un-read what was
already read.

## 2. Add Petty to Claude Desktop

**The easy way:** right after you make the token, Petty offers "Get the Claude Desktop add-on"
(`petty.mcpb`). Open the file; Claude Desktop installs it and asks for the **Petty address** (shown
next to the token) and the **token**. Claude Desktop runs the add-on with its own Node and keeps the
token as a secret field.

**By hand:** Claude Desktop also starts local MCP servers from its config. Add:

```json
{
  "mcpServers": {
    "petty": {
      "command": "/usr/local/bin/node",
      "args": ["<path to petty>/apps/mcp/node_modules/tsx/dist/cli.mjs", "<path to petty>/apps/mcp/src/bin.ts"],
      "env": {
        "PETTY_TOKEN": "petty_pat_…",
        "PETTY_API_URL": "https://petty.example.com/api"
      }
    }
  }
}
```

Instead of `PETTY_TOKEN`, the program also reads `~/.petty/token` (keep it mode 600).

Use a signed Node, such as the installer from nodejs.org (`/usr/local/bin/node`). On macOS, a
Homebrew Node is only ad-hoc signed, and macOS may silently refuse it access to a server on your
home network (see Troubleshooting). Run `pnpm install` in the repository first, so that `tsx` exists.

## Other AI apps (Cursor, VS Code, Windsurf, Claude Code, …)

Any app that runs local MCP servers can use the same program. Petty serves it as one file:
`https://<your petty>/downloads/petty-mcp.mjs`. Save it somewhere, then add this to the app's MCP
settings (the exact file name and place differ per app):

```json
{
  "mcpServers": {
    "petty": {
      "command": "node",
      "args": ["/path/to/petty-mcp.mjs"],
      "env": {
        "PETTY_TOKEN": "petty_pat_…",
        "PETTY_API_URL": "https://petty.example.com/api"
      }
    }
  }
}
```

For Claude Code the same is one command:

```
claude mcp add petty --env PETTY_TOKEN=petty_pat_… --env PETTY_API_URL=https://petty.example.com/api -- node /path/to/petty-mcp.mjs
```

It needs Node 20 or newer. On macOS with a home-network Petty, see Troubleshooting.

Apps that only accept remote connectors (for example on a phone) cannot run a local program;
see "On a phone" below.

## 3. Ask

- "What is in the kitchen drawer?"
- "Add 10 zloty to kitchen cash, from groceries."
- "I counted 37.50 in the tin; set it."

## Tools

| Tool | Needs | Does |
|---|---|---|
| `list_drawers` | read | every drawer and item the token can open, with balances |
| `find_item` | read | finds one item by words; says so when nothing or several match |
| `history` | read | recent entries of one item |
| `add` | write | adds an amount |
| `withdraw` | write | takes an amount out |
| `adjust` | write | sets an item to what was counted |

A read-only token is offered no writing tools at all.

## Drawers made later

A token has its own key pair. When you make a drawer, or someone shares one with you, your Petty
app wraps that drawer's key for every live token the next time it starts. So the tool sees new
drawers without you making a new token. Open Petty once after adding a drawer.

## What this does and does not protect

- The token and your keys stay on your machine. The Petty server never sees the secret half.
- Whatever you ask about reaches the model, because you asked. End-to-end encryption covers the
  server and the network, not the assistant you chose to talk to.
- Item names, tags and comments are your own text. The tools hand them over as labelled data, and
  writing is always a separate, explicit tool call, so text inside a drawer cannot act as an
  instruction on its own. Read a proposed write before you accept it.
- A token cannot replace your vault, delete your account, share a drawer, export, use admin, or
  make another token. Those are refused by the server.

## Troubleshooting

**"cannot reach …: fetch failed (EHOSTUNREACH)" in Claude Desktop, while the site opens in a
browser.** Your Petty is on a home-network address, and macOS guards those with the "Local
Network" permission. Two things to check:

- Claude must be allowed: System Settings → Privacy & Security → Local Network → Claude on.
- The Node that runs the server must be a signed build. A Homebrew Node (`/opt/homebrew/bin/node`)
  is only ad-hoc signed, and macOS may block it even when Claude is allowed. Point `command` at a
  signed Node, such as `/usr/local/bin/node` from the nodejs.org installer, as in the config above.

Restart Claude Desktop after either change.

**"… (ENOTFOUND)"**: the name does not resolve from this machine; check `PETTY_API_URL`.

**A certificate error**: Node does not read the macOS keychain. If your server uses a private
certificate authority, point `NODE_EXTRA_CA_CERTS` at its certificate in the same `env` block.

**"TokenRevoked"**: the token was revoked or expired; make a new one in Settings.

## On a phone

Claude on a phone cannot start a local program. It only connects to a web address, and the call
comes from Anthropic's servers, so the address must be reachable from the internet. That means
running this program yourself on an always-on machine. It is not part of Petty yet.
