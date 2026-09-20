/**
 * The public source-code URL. AGPL-3.0 section 13 requires that everyone who interacts with a
 * network deployment be offered the source, so this link appears on the landing footer, the
 * privacy page and the AI page. A fork that runs a modified build sets VITE_SOURCE_URL at build
 * time to point at its own source (as the licence expects); the default is the upstream repo.
 */
export const SOURCE_URL = (import.meta.env.VITE_SOURCE_URL as string | undefined)?.trim() || "https://github.com/WawRepo/petty";
