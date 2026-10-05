import { describe, expect, it } from "vitest";
import { ORIGIN } from "../lib.js";

/**
 * PETTY-320: what the image tells a search engine, a shared link and an install prompt. Petty holds money,
 * things and notes, so none of these may describe a cash-only ledger. Before, the page had no description
 * at all and the install manifest said "A ledger for cash kept in several places."
 */
describe("how the page describes Petty", () => {
  it("the page has a description and link-preview tags", async () => {
    const r = await fetch(`${ORIGIN}/`);
    expect(r.status).toBe(200);
    const html = await r.text();
    const meta = (attr: string, name: string) => new RegExp(`<meta ${attr}="${name}" content="([^"]+)"`).exec(html)?.[1];
    expect(meta("name", "description")).toMatch(/what you keep and where/);
    expect(meta("property", "og:title")).toBe("Petty — everything you keep, in its place");
    expect(meta("property", "og:description")).toMatch(/money, things and notes/);
    expect(meta("name", "twitter:card")).toBe("summary");
    expect(html).not.toMatch(/ledger for (physical )?cash/i);
  });

  it("the install manifest says what Petty is now", async () => {
    const r = await fetch(`${ORIGIN}/manifest.webmanifest`);
    expect(r.status).toBe(200);
    const m = (await r.json()) as { name: string; description: string };
    expect(m.name).toBe("Petty");
    expect(m.description).toBe("Everything you keep, in its place. End-to-end encrypted.");
  });
});
