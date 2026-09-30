# Security policy

Petty is an end-to-end encrypted ledger. The server stores drawer content only as ciphertext and cannot read
it (it does see account and activity metadata, listed in the threat model). The design, the threat model and the settled decisions are in
`docs/threat-model.md` and `docs/decisions.md`.

## Reporting a vulnerability

Please report security problems **privately**: email <petty@szatanik.dev>, or use
**Security → Report a vulnerability** on this repository. Do not open a public issue.

Include what you found, how to reproduce it, and what an attacker gains. We answer within
7 days and agree a disclosure date with you, normally within 90 days.

## In scope

- Anything that lets the server, another user or a network attacker read or change drawer
  content, entries or photos without the key.
- Ciphertext that decrypts in a row, line or drawer it did not come from (the AAD binding).
- Bypassing the server-side permission checks (read-only members writing, removed members
  reading new data).
- Weaknesses in the vault, the passkey unlock or the recovery code.
- Plaintext written to disk, logs or telemetry.

## Out of scope

- A compromised device or browser of the user.
- Denial of service by volume.
- Findings in a deployment's own infrastructure (reverse proxy, database host); report those
  to its operator.

## Known dependency advisories

CI fails a pull request on any *high* or *critical* advisory in the shipped dependencies
(`pnpm audit --prod --audit-level high`). Lower-severity advisories are triaged, not ignored; the
current accepted ones, with the reason, are:

| Advisory | Package | Why accepted (2026-09-24) |
|---|---|---|
| GHSA-w5hq-g745-h8pq | `uuid@8.3.2` | Reached only through `@clerk/clerk-js → @solana/… → jayson`, Clerk's Solana-wallet sign-in path. Petty never enables a Web3 wallet, the code sits in a lazily-loaded Clerk-only chunk, and no Petty input flows into it. |
| GHSA-528h-pc64-c93x | `stream-json@1.9.1` | Same path; a server-side streaming JSON parser that the browser bundle never invokes. |

These are re-checked at every dependency update; a compatible upstream bump removes them.

## Supported versions

The latest tagged release and the `main` branch receive security fixes. The current line is 1.x.
Every release raises the patch number, also when it adds features, so this is not strict semver:
read the release's section in `CHANGELOG.md` before you upgrade.
