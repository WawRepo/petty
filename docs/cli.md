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

It is one file, `petty.mjs`, and needs Node 20 or newer. Take it from the GitHub release of the version
your Petty runs: Settings → About and the landing page's footer show it (`v1.2.3` below). The page
*Use Petty with AI* in the app shows these commands with your Petty's version and address filled in.

macOS or Linux (`~/.local/bin` must be on your `PATH`):

```sh
mkdir -p ~/.local/bin
curl -fsSL https://github.com/WawRepo/petty/releases/download/v1.2.3/petty.mjs -o ~/.local/bin/petty
chmod +x ~/.local/bin/petty
```

Windows (PowerShell):

```powershell
New-Item -ItemType Directory -Force "$HOME\.petty" | Out-Null
Invoke-WebRequest https://github.com/WawRepo/petty/releases/download/v1.2.3/petty.mjs -OutFile "$HOME\.petty\petty.mjs"
# run it as: node "$HOME\.petty\petty.mjs" <command>
# or make `petty` a command: save this as petty.cmd in a folder on your PATH
#   @node "%USERPROFILE%\.petty\petty.mjs" %*
```

### Check what you download

`petty` (and `petty-mcp.mjs` and the add-on `petty.mcpb`, see [agent.md](agent.md)) runs on your
computer and holds an access token. Check the file after you download it and before you first run it.

**With GitHub's command line**, [`gh`](https://cli.github.com), signed in (`gh auth login`):

```sh
gh attestation verify ~/.local/bin/petty --repo WawRepo/petty \
  --signer-workflow WawRepo/petty/.github/workflows/release.yml --source-ref refs/heads/main
```

Each release signs a statement of what it built (a build attestation, through Sigstore), and GitHub
keeps it with the repository. The command passes only if this repository's release workflow, run from
`main`, built exactly the bytes of your file. The file's name does not matter. For a file that anyone
changed afterwards, wherever it was changed, the command finds no attestation and fails. It fails the
same way for a release made before attestations were added: for such a release, use the checksum.

**Without `gh`**, compare checksums:

```sh
curl -fsSL https://github.com/WawRepo/petty/releases/download/v1.2.3/SHA256SUMS | grep ' petty.mjs$'
shasum -a 256 ~/.local/bin/petty        # Linux also: sha256sum; PowerShell: Get-FileHash <file>
```

The two long numbers must be the same. This shows that your file is the one on the release page, and
nothing more: someone who could change the release's files could change `SHA256SUMS` with them.

**What these checks do not cover:**

- Nobody runs them for you, and `petty` neither checks nor updates itself. To update, download and
  check again.
- They say who built a file, not that its code is good.
- An older release passes too. Take the version your Petty shows.
- The page *Use Petty with AI* is part of the web app, so the server you use controls what it shows
  ([threat-model.md](threat-model.md), "A malicious frontend build"). Read the addresses in its
  commands: they should begin with `https://github.com/WawRepo/petty/`. This file, read on GitHub, is
  the copy that does not depend on that server.

**The copy your Petty serves.** Every Petty also serves these files itself, at
`https://<your petty>/downloads/petty.mjs` (and `petty-mcp.mjs`, `petty.mcpb`, `petty-skill.zip`).
Nothing checks that copy, and whoever controls the server controls it. It is built again inside the
image, so it may differ from the release's file byte for byte, and then neither check above passes.
Use it only when you trust that server the way you trust your own computer, for example your own
Petty on a network with no way out to GitHub.

**A Petty that runs its own build or a fork.** Its version is then no release of this repository, or
its source is somewhere else, and no release holds its files. *Use Petty with AI* says so and offers
that Petty's own copies. You then trust its operator, who must offer you the source of what runs
([deploy.md](deploy.md), "Running a changed version"). An operator who makes releases with a copy of
this repository's workflow gets attestations in their own repository: check with `--repo` and
`--signer-workflow` set to theirs.

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
claude mcp add -s user petty -- ~/.local/bin/petty mcp   # Claude Code, if you prefer its tools to the commands
```

Give Claude Code the full path, and sign in first (`petty auth login --host …`). If Claude Code's
`/mcp` says "Failed to reconnect to petty: ENOENT", it could not find the program: `~/.local/bin` is
often not on the PATH it starts programs with. `-s user` adds it for every project, not only the folder
the command was typed in. To replace an earlier entry: `claude mcp remove petty`, then add it again.

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
