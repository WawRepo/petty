/**
 * The public source-code URL. AGPL-3.0 section 13 requires that everyone who interacts with a
 * network deployment be offered the source, so this link appears on the landing footer, the
 * privacy page, the AI page and Settings → About. A fork that runs a modified build sets
 * VITE_SOURCE_URL at build time (the image takes it as a build argument) to point at its own
 * source, as the licence expects; the default is the upstream repo.
 */
export const SOURCE_URL = (import.meta.env.VITE_SOURCE_URL as string | undefined)?.trim() || "https://github.com/WawRepo/petty";

/**
 * The source of the version that runs here (PETTY-292, review S4): for a release (v1.2.3) on GitHub,
 * the tree at its tag; otherwise, or on another host whose paths differ, the repository itself.
 */
export function sourceUrlFor(version: string | null, base: string = SOURCE_URL): string {
  const onGitHub = /^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/.test(base);
  return version && onGitHub && /^v\d+\.\d+\.\d+$/.test(version) ? `${base.replace(/\/$/, "")}/tree/${version}` : base;
}
