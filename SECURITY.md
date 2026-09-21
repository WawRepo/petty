# Security policy

Petty is an end-to-end encrypted ledger. The server stores only ciphertext and cannot read
drawer content. The design, the threat model and the settled decisions are in
`petty-app-spec.md` (sections "Security" and "Decisions log").

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

## Supported versions

The latest tagged release and the `main` branch receive security fixes. Petty follows semver; the current line is 1.x.
