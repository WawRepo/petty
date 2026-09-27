import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

/** How long one swap takes: the new content starts 200 ms in and takes 500 ms (.morph-in in base.css). */
export const SWAP_MS = 700;

/**
 * Content that changes smoothly (PETTY-248). When `k` changes, the previous content fades up and out
 * while the new fades up and in, after `delay` ms; `className` can give the pair another motion (the
 * landing picture's icons pop instead). Only the current content is live; the leaving copy is hidden
 * from assistive tech and removed once it has gone.
 */
export function Roll({ k, delay = 0, className = "", children }: { k: string; delay?: number; className?: string; children: ReactNode }) {
  const last = useRef<{ k: string; node: ReactNode }>({ k, node: children });
  const [prev, setPrev] = useState<{ k: string; node: ReactNode } | null>(null);
  useLayoutEffect(() => {
    if (last.current.k !== k) setPrev(last.current);
    last.current = { k, node: children };
  }, [k, children]);
  useEffect(() => {
    if (!prev) return;
    const h = window.setTimeout(() => setPrev(null), SWAP_MS + delay + 40);
    return () => window.clearTimeout(h);
  }, [prev, delay]);
  const style = { "--d": `${delay}ms` } as CSSProperties;
  return (
    <span className={`morph ${className}`}>
      {prev ? <span key={`out-${prev.k}`} className="morph-out" style={style} aria-hidden="true">{prev.node}</span> : null}
      <span key={`in-${k}`} className={prev ? "morph-in" : "morph-now"} style={style}>{children}</span>
    </span>
  );
}
