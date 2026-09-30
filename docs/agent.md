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

**Agents that can run commands** (Claude Code, Codex, scripts) can use the command line instead:
[cli.md](cli.md). It signs in through your browser, so there is no token to copy, and `petty mcp`
runs this same server with that login.

## 1. Make a token

In Petty: **Settings → Access tokens → New token**. Give it a name, switch on **Can make changes**
if it should add entries and change names, items, tags and places (a new token only reads), pick an
expiry, and confirm with your passkey or passphrase. The token is shown once:

```
petty_pat_<id>.<secret>
```

Only the `<id>` half is ever sent to the server. The `<secret>` half opens a key bundle that the
server stores and cannot read. Revoking the token stops future use; it cannot un-read what was
already read.

## 2. Add Petty to Claude Desktop

**The easy way** — no terminal, nothing else to install:

1. Install **Claude Desktop** from [claude.ai/download](https://claude.ai/download) and sign in.
2. Make a token (step 1). The token screen then offers **Get the Claude Desktop add-on**; the same
   button is on the in-app page **Use Petty with AI**. It downloads `petty.mcpb`. The file is the same
   for everyone and holds no secret, so any Petty (`https://<your petty>/downloads/petty.mcpb`) or the
   GitHub release page can give it to you.
3. **Double-click `petty.mcpb`** (or drag it onto the Claude Desktop window) and click **Install**.
4. Claude Desktop asks for the **Petty address** (shown next to the token, ending in `/api`) and the
   **token**. Paste both and save. Claude Desktop keeps the token as a secret and runs the add-on with
   its own built-in Node. Change either later in **Settings → Extensions → Petty**.
5. Start a new chat and ask *"What is in my drawers?"*. On a Mac with a Petty on your home network,
   allow network access if asked and restart Claude Desktop (see Troubleshooting).

**By hand** (Claude Desktop without the add-on, or any other app): see the next section. The
settings block it produces goes into Claude Desktop's `claude_desktop_config.json` the same way.

## Other AI apps (Cursor, VS Code, Windsurf, Claude Code, …)

Any app that runs local MCP servers can use the same program. Petty serves it as one file,
`https://<your petty>/downloads/petty-mcp.mjs`. It needs Node 20 or newer. Put it in a `.petty`
folder in your home folder — the same place the program looks for a token file — and let it print
its own settings block, so you never type a path by hand.

The in-app page **Use Petty with AI** shows these commands with your Petty's address filled in.

**macOS or Linux** (Terminal):

```
mkdir -p ~/.petty && curl -fsSL https://petty.example.com/downloads/petty-mcp.mjs -o ~/.petty/petty-mcp.mjs
node ~/.petty/petty-mcp.mjs --print-config https://petty.example.com/api
```

**Windows** (PowerShell):

```
New-Item -ItemType Directory -Force "$HOME\.petty" | Out-Null; Invoke-WebRequest https://petty.example.com/downloads/petty-mcp.mjs -OutFile "$HOME\.petty\petty-mcp.mjs"
node "$HOME\.petty\petty-mcp.mjs" --print-config https://petty.example.com/api
```

The second command prints the block for this machine — the full path of your Node and of the file
(apps started from the dock or Start menu often cannot find a bare `node`):

```json
{
  "mcpServers": {
    "petty": {
      "command": "/usr/local/bin/node",
      "args": ["/Users/you/.petty/petty-mcp.mjs"],
      "env": {
        "PETTY_TOKEN": "petty_pat_…",
        "PETTY_API_URL": "https://petty.example.com/api"
      }
    }
  }
}
```

Paste it into the app's MCP settings (the file name and place differ per app) and put your token
in place of `petty_pat_…`. Instead of `PETTY_TOKEN`, the program also reads `~/.petty/token` (keep it
mode 600): then the block needs no secret at all.

For Claude Code, skip the block — one command:

```
claude mcp add petty --env PETTY_TOKEN=petty_pat_… --env PETTY_API_URL=https://petty.example.com/api -- node ~/.petty/petty-mcp.mjs
```

On macOS with a Petty on your home network, use a signed Node (see Troubleshooting). To update, run
the download command again.

Apps that only accept remote connectors (for example on a phone) cannot run a local program;
see "On a phone" below.

## 3. Ask

- "What is in the kitchen drawer?"
- "Add 10 zloty to kitchen cash, from groceries."
- "I counted 37.50 in the tin; set it."
- "How much is in the kitchen?" · "What is tagged travel?" · "Move the tin to Kitchen › shelf."

## Tools

| Tool | Needs | Does |
|---|---|---|
| `list_drawers` | read | every drawer and item the token can open, with balances |
| `find_item` | read | finds one item by words; says so when nothing or several match |
| `history` | read | recent entries of one item |
| `add` | write | adds an amount |
| `withdraw` | write | takes an amount out |
| `adjust` | write | sets an item to what was counted |
| `list_tags` | read | every tag with the items that carry it |
| `list_places` | read | the place tree with the drawers in each place |
| `tag_item`, `untag_item` | write | puts a tag on an item, or takes it off |
| `rename_tag`, `remove_tag` | write | renames or removes a tag on every item; a rename onto an existing tag merges them |
| `move_drawer` | write | puts a drawer in a place, such as "Kitchen › shelf" |

`list_drawers` can be filtered by `tag` or `place`. The tools see the tags and places that
drawers carry. Your own saved tag list and the order of your place tree stay in the app.

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
