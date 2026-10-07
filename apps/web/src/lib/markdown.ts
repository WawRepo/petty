/**
 * The small Markdown subset an operator's legal texts use (PETTY-342): headings (#, ##, ###),
 * paragraphs, one level of bullet or numbered lists, **bold**, and links to https:, mailto: or a page
 * of this app. Parsed to plain data, which the Markdown component turns into React elements: no HTML
 * from the file ever reaches the page, and anything else shows as the text it is.
 */
export type Inline =
  | { readonly t: "text"; readonly v: string }
  | { readonly t: "b"; readonly c: readonly Inline[] }
  | { readonly t: "a"; readonly href: string; readonly c: readonly Inline[] };
export type Block =
  | { readonly t: "h"; readonly level: 1 | 2 | 3; readonly c: readonly Inline[] }
  | { readonly t: "p"; readonly c: readonly Inline[] }
  | { readonly t: "ul" | "ol"; readonly items: readonly (readonly Inline[])[] };

// a page of this app is "/x", never "//host" (a protocol-relative link to another site)
const SAFE_HREF = /^(https:\/\/[^\s<>"]+|mailto:[^\s<>"]+|\/(?!\/)[A-Za-z0-9/_#?=&.-]*)$/;
const TOKEN = /\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let at = 0;
  for (const m of s.matchAll(TOKEN)) {
    if (m.index > at) out.push({ t: "text", v: s.slice(at, m.index) });
    if (m[1] !== undefined) out.push({ t: "b", c: parseInline(m[1]) });
    else if (SAFE_HREF.test(m[3]!)) out.push({ t: "a", href: m[3]!, c: parseInline(m[2]!) });
    else out.push({ t: "text", v: m[0] }); // a link to anywhere else stays as text
    at = m.index + m[0].length;
  }
  if (at < s.length) out.push({ t: "text", v: s.slice(at) });
  return out;
}

export function parseMarkdown(text: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { t: "ul" | "ol"; items: string[] } | null = null;
  const flush = () => {
    if (para.length) blocks.push({ t: "p", c: parseInline(para.join(" ")) });
    if (list) blocks.push({ t: list.t, items: list.items.map(parseInline) });
    para = [];
    list = null;
  };
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    const h = /^(#{1,3})\s+(.+)$/.exec(line);
    if (h) { flush(); blocks.push({ t: "h", level: h[1]!.length as 1 | 2 | 3, c: parseInline(h[2]!) }); continue; }
    const item = /^(?:([-*])|\d+[.)])\s+(.+)$/.exec(line);
    if (item) {
      const kind = item[1] ? "ul" : "ol";
      if (para.length || (list && list.t !== kind)) flush();
      list ??= { t: kind, items: [] };
      list.items.push(item[2]!);
      continue;
    }
    if (list) { list.items[list.items.length - 1] += ` ${line}`; continue; } // a wrapped list item
    para.push(line);
  }
  flush();
  return blocks;
}
