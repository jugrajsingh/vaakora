import type React from "react";
import { useId } from "react";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useRevealOnOpen } from "@/components/shared/useRevealOnOpen";

/** A history row's header grid: date, excerpt, tag, then one cell for the actions and chevron. */
export const HISTORY_ROW_GRID =
  "grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-2.5 min-h-[42px] px-1.5 py-1";

export interface HistoryRowProps {
  id: number;
  open: boolean;
  onToggle: () => void;
  when: { short: string; long: string };
  excerpt: React.ReactNode;
  excerptClass?: string;
  tag: string | null;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}

/** One history entry: a one-line header that opens the entry in place under it. */
export function HistoryRow({
  id,
  open,
  onToggle,
  when,
  excerpt,
  excerptClass,
  tag,
  actions,
  children,
}: HistoryRowProps): React.JSX.Element {
  const { t } = useTranslation();
  const bodyId = useId();
  const { ref: rowRef, toggle } = useRevealOnOpen<HTMLDivElement>(
    open,
    onToggle,
    "[data-history-toolbar]",
  );
  const label = t(open ? "history.row.close" : "history.row.open");
  return (
    <div
      ref={rowRef}
      data-history-entry-id={id}
      className={
        open
          ? "my-1.5 rounded-lg border border-line bg-wash"
          : "border-b border-line"
      }
    >
      <div className={HISTORY_ROW_GRID}>
        <span
          className="cursor-pointer text-xs text-ink-2 whitespace-nowrap"
          title={when.long}
          onClick={toggle}
        >
          {when.short}
        </span>
        <div
          className={`line-clamp-2 min-w-0 cursor-pointer break-words text-sm ${excerptClass ?? ""}`}
          onClick={toggle}
        >
          {excerpt}
        </div>
        {tag !== null ? (
          <span
            className="max-w-[8rem] truncate rounded-full border border-line-strong px-2 text-xs text-ink-2"
            title={tag}
          >
            {tag}
          </span>
        ) : (
          <span />
        )}
        <div className="flex shrink-0 items-center">
          {actions}
          <button
            type="button"
            aria-expanded={open}
            aria-controls={bodyId}
            aria-label={label}
            title={label}
            onClick={toggle}
            className="p-1.5 rounded-md flex items-center justify-center text-ink-2 hover:text-logo-primary cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-logo-primary"
          >
            <ChevronDown
              width={16}
              height={16}
              className={`transition-transform ${open ? "rotate-180" : ""}`}
            />
          </button>
        </div>
      </div>
      {open && (
        <div id={bodyId} className="px-3 pb-3.5">
          {children}
        </div>
      )}
    </div>
  );
}

/** The sticky line over a history: how it is kept, a Change link, then the page's buttons. */
export function HistoryToolbar({
  summary,
  change,
  children,
}: {
  summary: string;
  change: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div
      data-history-toolbar
      className="sticky top-0 z-10 flex flex-wrap items-center gap-2 bg-background py-2"
    >
      <p className="min-w-0 flex-1 basis-[20rem] text-xs text-ink-2">
        {summary}{" "}
        <button
          type="button"
          aria-label={t("history.changeLabel")}
          onClick={change}
          className="text-logo-primary hover:underline cursor-pointer"
        >
          {t("history.change")}
        </button>
      </p>
      {children}
    </div>
  );
}

/** What a history shows in place of its rows: loading, not kept or empty. */
export function HistoryStateLine({
  state,
  title,
  hint,
  action,
}: {
  state: "loading" | "notKept" | "empty";
  title: string;
  hint?: React.ReactNode;
  action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="py-10 text-center">
      {state === "loading" ? (
        <p role="status" className="text-sm text-ink-2">
          {title}
        </p>
      ) : (
        <>
          <p className="text-sm text-text">{title}</p>
          {hint && <p className="mt-1 text-sm text-ink-2">{hint}</p>}
          {action && <div className="mt-3 flex justify-center">{action}</div>}
        </>
      )}
    </div>
  );
}
