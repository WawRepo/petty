# petty — Petty from the command line

`petty` reads and writes your drawers from a terminal, from scripts, and from AI agents that run
commands (Claude Code, Codex). Like the web app, it decrypts on your own computer: the Petty server
still sees only ciphertext.

```
petty (your computer, holds an access token)
   │ opens the key bundle, decrypts here
   ▼
Petty API (ciphertext only)
```

## Install

It is one file, `petty.mjs`, and needs Node 20 or newer. Every Petty serves it at
`https://<your petty>/downloads/petty.mjs`; each GitHub release carries it too, with `SHA256SUMS`.
The page *Use Petty with AI* in the app shows these commands with your Petty's address filled in.

macOS or Linux (`~/.local/bin` must be on your `PATH`):

```sh
mkdir -p ~/.local/bin
curl -fsSL https://petty.example.com/downloads/petty.mjs -o ~/.local/bin/petty
chmod +x ~/.local/bin/petty
```

Windows (PowerShell):

```powershell
New-Item -ItemType Directory -Force "$HOME\.petty" | Out-Null
Invoke-WebRequest https://petty.example.com/downloads/petty.mjs -OutFile "$HOME\.petty\petty.mjs"
# run it as: node "$HOME\.petty\petty.mjs" <command>
# or make `petty` a command: save this as petty.cmd in a folder on your PATH
#   @node "%USERPROFILE%\.petty\petty.mjs" %*
```

## Sign in

```sh
petty auth login --host https://petty.example.com
```

It shows a one-time code and opens a page of your Petty in the browser, the way `gh auth login` does:

```
Your one-time code: WDJB-MJHT-KQPL
Opened https://petty.example.com/device?code=WDJB-MJHT-KQPL
Check that the page shows the same code, then allow it there.
Waiting… (Ctrl-C stops)
```

On the page (signed in and unlocked) check that the code is the same, choose whether it can make
changes and when it ends, and press **Allow**. Letting it make changes asks for your vault passphrase
or passkey, as a token made in Settings does. The terminal then says `Signed in`.

- **No browser on this machine** (a server over SSH): `--no-browser` prints the address. Open it on
  any device where you use Petty, or type the code at `https://<your petty>/device`.
- `--read-only` asks only to read. `--expires 30|90|365|never` sets when it ends (90 days by default).
- The login is an ordinary **access token** named "petty on *computer*". Settings → Access tokens
  lists it; revoking it there stops `petty` at once.
- `petty auth status` checks the token still works. `petty auth logout` ends it on the server and
  forgets it here.
- A token you made by hand: `petty auth login --host … --with-token < token.txt`.
- **Scripts and CI:** set `PETTY_TOKEN` and `PETTY_API_URL` (`https://<your petty>/api`). They win
  over the stored login.

## Commands

| Command | What it does |
|---|---|
| `petty drawers [--place P] [--tag T]` | every drawer with its items and balances |
| `petty find <words>` | the one item these words name |
| `petty history <item> [--limit N]` | an item's latest entries, newest first |
| `petty add <item> <amount> [--note TEXT]` | put an amount in |
| `petty take <item> <amount> [--note TEXT]` | take an amount out |
| `petty adjust <item> <counted> [--note TEXT]` | set what you counted |
| `petty tags` · `petty places` | every tag and its items · the place tree |
| `petty tag <item> <tag>` · `petty untag <item> <tag>` | a tag on or off an item |
| `petty move <drawer> <place>` | move a drawer (`"House › Kitchen"`; `""` for no place) |
| `petty mcp` | the MCP server for AI apps, with this login |
| `petty completion -s <shell>` | the Tab completion script |
| `petty auth login` · `status` · `logout` · `token` | see *Sign in* |

Name an item as `"Drawer › Item"` (Tab completes it), by words (`kitchen cash`), or by the
`drawerId/itemId` that `--json` prints. Amounts are in the item's own units:
`petty add "Kitchen tin › Cash" 10.50`. `petty help <command>` tells more.

For scripts and agents, `--json` prints JSON. Exit codes: **0** done, **1** error, **2** usage,
**3** not signed in, the token ended, or it may only read, **4** nothing or more than one thing matches.

## Tab completion

| Shell | Set it up once |
|---|---|
| bash | `eval "$(petty completion -s bash)"` in `~/.bashrc` |
| zsh | `petty completion -s zsh > "${fpath[1]}/_petty"`, then open a new shell |
| fish | `petty completion -s fish > ~/.config/fish/completions/petty.fish` |
| PowerShell | `petty completion -s powershell \| Out-String \| Invoke-Expression` in `$PROFILE` |

Tab completes commands, flags and their values, and the names of your items, drawers, tags and
places. Names are fetched and decrypted when you press Tab, and never saved on disk; with no network
or no login, Tab simply offers none. `PETTY_COMPLETE_NAMES=0` turns name completion off.

## AI agents

An agent that can run commands can call `petty … --json` directly, with no MCP setup. Tell it to
read `petty help`, and to name items by the `drawerId/itemId` it got from `--json`.

For an app that cannot run commands (Claude Desktop), `petty mcp` runs the same MCP server as
`petty-mcp.mjs` ([agent.md](agent.md)), with the login `petty` already has:

```sh
petty mcp --print-config        # the block for the app's settings; no token in it
claude mcp add petty -- petty mcp   # Claude Code, if you prefer its tools to the commands
```

## What is kept, and where

- `~/.petty/hosts.json`, readable by you only (600, in a 700 folder): the token for each Petty you
  signed in to. Nothing read from Petty is written anywhere.
- The token opens the drawers it may read: treat it like a password. `petty auth token` prints it.
- **Your shell's history keeps what you type**, in plain text: a drawer's name, an amount, a note.
  Petty cannot prevent that. `--note -` reads the note from stdin instead, and a command that starts
  with a space is left out of the history in bash (`HISTCONTROL=ignorespace`) and zsh
  (`setopt HIST_IGNORE_SPACE`).

## How the browser sign-in keeps the token from the server

The server cannot make you a token: it has no keys. The page makes it, the way Settings → Access
tokens does, and hands it to `petty` sealed:

1. `petty auth login` makes a one-time key pair and sends the public half. The code you see is
   derived from that key, and `petty` checks the server's answer against it.
2. The page gets the request from the server and works the code out again from the key it was
   given. If the server, or anyone who changed its database, swapped in a key of its own, the codes
   differ and the page refuses to go on.
3. On **Allow**, the page makes the token and seals it to `petty`'s key (ECDH P-256 → HKDF →
   AES-256-GCM, bound to the request, the code and the site). The server keeps only that sealed blob
   until `petty` picks it up, once, and then deletes the request. A request nobody allows ends after
   15 minutes.

More: [threat-model.md](threat-model.md), *Device login*.
