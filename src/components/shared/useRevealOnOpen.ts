import type React from "react";
import { useLayoutEffect, useRef } from "react";
import { revealIn } from "@/lib/utils/historyPresentation";

/** The row's toggle, marking an open by it (not a close) as one to reveal. */
export function revealingToggle(
  open: boolean,
  reveal: { current: boolean },
  toggle: () => void,
): () => void {
  return () => {
    reveal.current = !open;
    toggle();
  };
}

/** Scrolls a row into view below `toolbar` when its own toggle opens it; mounting already open never scrolls. */
export function useRevealOnOpen<T extends HTMLElement>(
  open: boolean,
  toggle: () => void,
  toolbar: string,
): { ref: React.RefObject<T>; toggle: () => void } {
  const ref = useRef<T>(null);
  const reveal = useRef(false);
  useLayoutEffect(() => {
    const wanted = reveal.current;
    reveal.current = false;
    if (open && wanted) revealIn(ref.current, toolbar);
  }, [open]);
  return { ref, toggle: revealingToggle(open, reveal, toggle) };
}
