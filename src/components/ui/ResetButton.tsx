import React from "react";
import ResetIcon from "../icons/ResetIcon";

interface ResetButtonProps {
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  children?: React.ReactNode;
}

export const ResetButton = React.memo(
  React.forwardRef<HTMLButtonElement, ResetButtonProps>(function ResetButton(
    { onClick, disabled = false, className = "", ariaLabel, children },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type="button"
        aria-label={ariaLabel}
        className={`p-1 rounded-md border border-transparent transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-logo-primary ${
          disabled
            ? "opacity-50 cursor-not-allowed text-ink-3"
            : "hover:bg-logo-primary/20 active:bg-logo-primary/50 active:translate-y-[1px] hover:cursor-pointer hover:border-logo-primary text-text"
        } ${className}`}
        onClick={onClick}
        disabled={disabled}
      >
        {children ?? <ResetIcon />}
      </button>
    );
  }),
);
