import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "./markdown.js";

// PETTY-342: an operator's legal text becomes plain data; nothing in the file can add HTML to the page.
describe("parseMarkdown", () => {
  it("reads headings, paragraphs, lists and wrapped lines", () => {
    expect(parseMarkdown("# Title\n\nFirst line\nsecond line.\n\n## Rights\n- one\n  more\n- two\n\n1. a\n2. b\n")).toEqual([
      { t: "h", level: 1, c: [{ t: "text", v: "Title" }] },
      { t: "p", c: [{ t: "text", v: "First line second line." }] },
      { t: "h", level: 2, c: [{ t: "text", v: "Rights" }] },
      { t: "ul", items: [[{ t: "text", v: "one more" }], [{ t: "text", v: "two" }]] },
      { t: "ol", items: [[{ t: "text", v: "a" }], [{ t: "text", v: "b" }]] },
    ]);
  });

  it("keeps bold and safe links, and shows anything else as text", () => {
    expect(parseInline("**Controller:** [mail](mailto:a@b.c), [page](/terms), [site](https://uodo.gov.pl)")).toEqual([
      { t: "b", c: [{ t: "text", v: "Controller:" }] },
      { t: "text", v: " " },
      { t: "a", href: "mailto:a@b.c", c: [{ t: "text", v: "mail" }] },
      { t: "text", v: ", " },
      { t: "a", href: "/terms", c: [{ t: "text", v: "page" }] },
      { t: "text", v: ", " },
      { t: "a", href: "https://uodo.gov.pl", c: [{ t: "text", v: "site" }] },
    ]);
    // a script link, plain http and a protocol-relative link are not links
    for (const bad of ["[x](javascript:alert(1))", "[x](http://a.b)", "[x](//evil.example)"]) {
      expect(parseInline(bad).every((n) => n.t === "text"), bad).toBe(true);
    }
  });

  it("raw HTML is only text", () => {
    expect(parseMarkdown("<script>alert(1)</script>\n<img src=x onerror=alert(1)>")).toEqual([
      { t: "p", c: [{ t: "text", v: "<script>alert(1)</script> <img src=x onerror=alert(1)>" }] },
    ]);
  });
});
