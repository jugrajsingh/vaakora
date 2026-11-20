import type { HistoryEntry, LocalLlmModelInfo } from "@/bindings";

export function cleanedText(
  entry: Pick<HistoryEntry, "transcription_text" | "post_processed_text">,
): string | null {
  const text = entry.post_processed_text;
  return text !== null && text.trim() !== "" ? text : null;
}

export function historyCopyText(
  entry: Pick<HistoryEntry, "transcription_text" | "post_processed_text">,
): string {
  return cleanedText(entry) ?? entry.transcription_text;
}

export async function copyHistoryRaw(
  copy: () => Promise<boolean>,
  onError: () => void,
): Promise<void> {
  try {
    if (!(await copy())) onError();
  } catch {
    onError();
  }
}

export function historyModelName(
  entry: Pick<HistoryEntry, "post_process_model" | "post_process_provider">,
  models: Pick<LocalLlmModelInfo, "id" | "display_name">[],
): string | null {
  const id = entry.post_process_model;
  if (id === null) return null;
  if (
    entry.post_process_provider !== null &&
    entry.post_process_provider !== "local_llm"
  )
    return id;
  return models.find((model) => model.id === id)?.display_name ?? id;
}

/** Day, short month and time (no year); an invalid date returns the seconds as text. */
export function shortDateTime(
  seconds: number,
  locale: string,
  timeZone?: string,
): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone,
    }).format(new Date(seconds * 1000));
  } catch {
    return String(seconds);
  }
}

/** The open entry when it is still listed, else none. */
export function openEntry(
  open: number | null,
  ids: readonly number[],
): number | null {
  return open !== null && ids.includes(open) ? open : null;
}

/** The open entry after a list commit: kept during loading, dropped once its entry is gone. */
export function nextOpen(
  current: number | null,
  list: { loading: boolean; ids: readonly number[] },
): number | null {
  return list.loading ? current : openEntry(current, list.ids);
}

/** The scroll position that shows an opened row's top (nearest edge), or null when it is in view. */
export function revealScrollTop(
  view: { top: number; bottom: number; scrollTop: number },
  row: { top: number; bottom: number },
): number | null {
  if (row.top < view.top) return view.scrollTop - (view.top - row.top);
  if (row.bottom > view.bottom)
    return (
      view.scrollTop + Math.min(row.bottom - view.bottom, row.top - view.top)
    );
  return null;
}

export type HistoryState = "loading" | "failed" | "notKept" | "empty" | "list";

/** What a history page shows: loading, then any entries, then a failure, not kept, empty. */
export function historyState(input: {
  loading: boolean;
  failed: boolean;
  count: number;
  kept: boolean;
}): HistoryState {
  if (input.loading) return "loading";
  if (input.count > 0) return "list";
  if (input.failed) return "failed";
  return input.kept ? "empty" : "notKept";
}

export interface BoundShortcut {
  id: string;
  binding: string;
}

/** The ids that have a shortcut, in the order given. */
export function boundShortcuts(
  bindings: Partial<Record<string, { current_binding: string }>> | undefined,
  ids: readonly string[],
): BoundShortcut[] {
  return ids.flatMap((id) => {
    const binding = bindings?.[id]?.current_binding;
    return binding ? [{ id, binding }] : [];
  });
}
