export type TtsTab = "settings" | "history" | "vocabulary";

/** The tabs of the Text-to-speech page, in display order; History appears once it exists. */
export function visibleTabs(historyReady: boolean): TtsTab[] {
  return historyReady
    ? ["settings", "history", "vocabulary"]
    : ["settings", "vocabulary"];
}
