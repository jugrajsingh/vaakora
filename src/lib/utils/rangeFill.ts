/** Side a range input's filled track grows towards: the native thumb runs right to left in right-to-left layouts. */
export function fillTowards(direction: "ltr" | "rtl"): "right" | "left" {
  return direction === "rtl" ? "left" : "right";
}

/** Thumb nudge at the end of a track: towards the end of the track, so left in right-to-left layouts. Whole class names: Tailwind finds classes by scanning source text. */
export function endNudgeClass(direction: "ltr" | "rtl"): string {
  return direction === "rtl"
    ? "[&::-webkit-slider-thumb]:-translate-x-0.5 [&::-moz-range-thumb]:-translate-x-0.5"
    : "[&::-webkit-slider-thumb]:translate-x-0.5 [&::-moz-range-thumb]:translate-x-0.5";
}
