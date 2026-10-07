import { Fragment, type ReactNode } from "react";
import { Link } from "react-router";
import { parseMarkdown, type Inline } from "../lib/markdown.js";

/**
 * An operator's legal text (PETTY-342), from the parsed subset in lib/markdown.ts: React elements only,
 * never HTML from the file. The page title is the h1, so the text's own headings start one level lower.
 */
function inline(nodes: readonly Inline[]): ReactNode {
  return nodes.map((n, i) => {
    if (n.t === "text") return <Fragment key={i}>{n.v}</Fragment>;
    if (n.t === "b") return <strong key={i}>{inline(n.c)}</strong>;
    if (n.href.startsWith("/")) return <Link key={i} to={n.href}>{inline(n.c)}</Link>;
    if (n.href.startsWith("mailto:")) return <a key={i} href={n.href}>{inline(n.c)}</a>;
    return <a key={i} href={n.href} target="_blank" rel="noopener noreferrer">{inline(n.c)}</a>;
  });
}

export function Markdown({ text, testId }: { text: string; testId?: string }) {
  return (
    <div className="legal-text" data-testid={testId}>
      {parseMarkdown(text).map((b, i) => {
        if (b.t === "h") return b.level === 1 ? <h2 key={i}>{inline(b.c)}</h2> : b.level === 2 ? <h3 key={i}>{inline(b.c)}</h3> : <h4 key={i}>{inline(b.c)}</h4>;
        if (b.t === "p") return <p key={i}>{inline(b.c)}</p>;
        const items = b.items.map((it, j) => <li key={j}>{inline(it)}</li>);
        return b.t === "ul" ? <ul key={i} className="list">{items}</ul> : <ol key={i} className="list">{items}</ol>;
      })}
    </div>
  );
}
