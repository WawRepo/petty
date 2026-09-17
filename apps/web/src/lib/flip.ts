import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * FLIP reorder animation (PETTY-55). Children of the container that carry
 * `data-flip-id` are measured after every render; the ones that moved get the
 * inverse transform and then ease to their new place, so a re-sorted list looks
 * like the items travelled there. Transforms are set through the CSSOM (allowed
 * by the CSP, which forbids only inline style attributes). Off when the user
 * asked for reduced motion.
 */
export function useFlip(container: RefObject<HTMLElement | null>, enabled = true): void {
  const previous = useRef(new Map<string, { top: number; left: number }>());
  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;
    const reduce = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const next = new Map<string, { top: number; left: number }>();
    for (const el of root.querySelectorAll<HTMLElement>("[data-flip-id]")) {
      const id = el.dataset["flipId"] ?? "";
      if (next.has(id)) continue; // a drawer under two tags is listed twice: the first copy is the one that travels
      const rect = el.getBoundingClientRect();
      next.set(id, { top: rect.top, left: rect.left });
      const old = previous.current.get(id);
      if (!enabled || reduce || !old) continue;
      const dy = old.top - rect.top;
      const dx = old.left - rect.left;
      if (Math.abs(dy) < 1 && Math.abs(dx) < 1) continue;
      el.style.transition = "none";
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      el.style.zIndex = dy > 0 ? "2" : "1"; // the ones rising pass over the ones sinking
      requestAnimationFrame(() => {
        el.style.transition = "transform 460ms cubic-bezier(0.22, 1, 0.36, 1)";
        el.style.transform = "";
        const done = () => { el.style.transition = ""; el.style.zIndex = ""; el.removeEventListener("transitionend", done); };
        el.addEventListener("transitionend", done);
      });
    }
    previous.current = next;
  });
}
