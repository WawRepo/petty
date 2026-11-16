import { SOURCE_URL } from "./links.js";

/**
 * Where a person gets the programs that run on their own computer: the command line, the MCP program
 * and the Claude Desktop add-on (PETTY-418). They run outside the browser and hold an access token, so
 * they should not have to be taken on this server's word.
 *
 * When this Petty runs a release (v1.2.3) whose source is a GitHub repository, the buttons and commands
 * point at that version's GitHub release. Its files carry a signed build attestation, so a person can
 * check them. Any other build (a local one, a fork with its own version names, a source on another host)
 * has no such release: the only copy is the one this Petty serves under /downloads/, which nothing
 * checks. The screens say which of the two it is.
 */
export interface Release {
  /** owner/name on GitHub */
  repo: string;
  version: string;
  /** the folder of the release's files */
  url: string;
}

export function releaseFor(version: string | null, base: string = SOURCE_URL): Release | null {
  const repo = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)\/?$/.exec(base)?.[1];
  if (!repo || !version || !/^v\d+\.\d+\.\d+$/.test(version)) return null;
  return { repo, version, url: `https://github.com/${repo}/releases/download/${version}` };
}

/**
 * One file's address: in the release when there is one, else this Petty's own copy. A link passes no
 * origin and gets a path on this site; a command to paste into a terminal passes `location.origin`.
 */
export const downloadUrl = (file: string, release: Release | null, origin = ""): string =>
  release ? `${release.url}/${file}` : `${origin}/downloads/${file}`;

/**
 * The command that checks a downloaded file: it passes only if the release workflow of that repository,
 * run from main, built exactly these bytes (docs/cli.md, "Check what you download").
 */
export const verifyCommand = (path: string, release: Release): string =>
  `gh attestation verify ${path} --repo ${release.repo} --signer-workflow ${release.repo}/.github/workflows/release.yml --source-ref refs/heads/main`;
