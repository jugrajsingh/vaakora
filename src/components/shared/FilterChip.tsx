import type { ReactNode } from "react";

/** A toggle filter chip; the class string is the one ModelTable's capability filters use. */
export function FilterChip({
  pressed,
  onToggle,
  children,
}: {
  pressed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onToggle}
      className={`flex h-[26px] shrink-0 cursor-pointer items-center gap-[6px] whitespace-nowrap rounded-[7px] px-[8px] text-small font-medium transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-logo-primary ${
        pressed
          ? "bg-line text-text"
          : "text-ink-3 hover:bg-wash hover:text-text"
      }`}
    >
      {children}
    </button>
  );
}
