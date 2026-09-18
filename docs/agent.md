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

## 2. Tell Claude Desktop about it

Claude Desktop starts local MCP servers from its config. Add:

```json
{
  "mcpServers": {
    "petty": {
      "command": "npx",
      "args": ["-y", "tsx", "<path to petty>/apps/mcp/src/bin.ts"],
      "env": {
        "PETTY_TOKEN": "petty_pat_…",
        "PETTY_API_URL": "https://petty.example.com/api"
      }
    }
  }
}
```

Instead of `PETTY_TOKEN`, the program also reads `~/.petty/token` (keep it mode 600).

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
browser.** Your Petty is on a home-network address, and macOS only lets an app reach those with
the "Local Network" permission. Open System Settings → Privacy & Security → Local Network, turn
Claude on, and restart Claude Desktop. The program Claude starts inherits that permission.

**"… (ENOTFOUND)"**: the name does not resolve from this machine; check `PETTY_API_URL`.

**A certificate error**: Node does not read the macOS keychain. If your server uses a private
certificate authority, point `NODE_EXTRA_CA_CERTS` at its certificate in the same `env` block.

**"TokenRevoked"**: the token was revoked or expired; make a new one in Settings.

## On a phone

Claude on a phone cannot start a local program. It only connects to a web address, and the call
comes from Anthropic's servers, so the address must be reachable from the internet. That means
running this program yourself on an always-on machine. It is not part of Petty yet.
