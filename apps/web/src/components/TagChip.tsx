/** A tag chip in the app's own style (PETTY-56): card surface, accent fill when selected; no per-tag colours. */
export function TagChip({ label, count, pressed, onClick }: { label: string; count?: number; pressed?: boolean; onClick?: () => void }) {
  if (!onClick) return <span className="tag-chip">{label}</span>;
  return <button type="button" className="tag-chip" aria-pressed={pressed} onClick={onClick}>{label}{count !== undefined ? <span className="tag-count">{count}</span> : null}</button>;
}
