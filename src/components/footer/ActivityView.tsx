import React from "react";
import { ProgressLine } from "@/components/shared/ProgressLine";
import type { FooterActivity, FooterDot } from "./activity";

const DOT: Record<FooterDot, string> = {
  idle: "bg-ink-3",
  recording: "bg-background-ui",
  busy: "bg-logo-primary animate-pulse motion-reduce:animate-none",
  reading: "bg-logo-primary",
};

/** The footer's status line: a dot, the text (a button when it opens a page) and a progress line for one download. */
export function ActivityView({
  activity,
  text,
  onOpen,
}: {
  activity: FooterActivity;
  text: string;
  onOpen?: () => void;
}): React.JSX.Element {
  return (
    <div
      role="status"
      className="flex min-w-0 flex-1 items-center gap-2 text-ink-2"
    >
      <span
        aria-hidden="true"
        className={`h-2 w-2 shrink-0 rounded-full ${DOT[activity.dot]}`}
      />
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 cursor-pointer truncate rounded-sm text-start tabular-nums transition-colors hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-logo-primary"
        >
          {text}
        </button>
      ) : (
        <span className="min-w-0 truncate">{text}</span>
      )}
      {activity.percent !== null && (
        <ProgressLine
          value={activity.percent / 100}
          className="h-[3px] w-12 shrink-0"
        />
      )}
    </div>
  );
}
