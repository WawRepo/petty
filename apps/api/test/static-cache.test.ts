import { describe, expect, it } from "vitest";
import { staticCacheControl } from "../src/app.js";

// PETTY-57: a deploy must show up on the next load. The shell, the service worker and the manifest are
// re-validated every time; hashed assets never change. The .br/.gz twins that @fastify/static sends to a
// browser that accepts compression must follow the same rule as the plain file.
describe("staticCacheControl", () => {
  it("re-validates the entry files, compressed or not", () => {
    for (const f of ["/d/index.html", "/d/index.html.br", "/d/index.html.gz", "/d/sw.js", "/d/sw.js.br", "/d/registerSW.js", "/d/manifest.webmanifest"]) {
      expect(staticCacheControl(f), f).toBe("no-cache");
    }
  });
  it("keeps hashed assets for a year", () => {
    expect(staticCacheControl("/d/assets/index-abc123.js")).toContain("immutable");
    expect(staticCacheControl("/d/assets/index-abc123.js.br")).toContain("immutable");
  });
  it("re-validates the landing captures, whose names do not change between deploys (PETTY-144)", () => {
    expect(staticCacheControl("/d/landing/places-en-light.webp")).toBe("no-cache");
  });
  it("caches other files for an hour", () => {
    expect(staticCacheControl("/d/icon-192.png")).toBe("public, max-age=3600");
  });
});
