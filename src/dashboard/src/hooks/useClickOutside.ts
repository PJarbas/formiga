// ══════════════════════════════════════════════════════════════════════
// useClickOutside.ts — Close dropdowns on outside click / Escape key
// ══════════════════════════════════════════════════════════════════════

import { useEffect } from "react";

/**
 * Calls `handler` when:
 * 1. A mousedown event fires outside the element referenced by `ref`
 * 2. The Escape key is pressed
 */
export function useClickOutside(
  ref: React.RefObject<HTMLElement | null>,
  handler: () => void,
) {
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) handler();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") handler();
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [ref, handler]);
}