import type { TFunction } from "i18next";
import type {
  ReadHistoryEntry,
  ReadHistoryRetention,
  TtsModelInfo,
} from "@/bindings";
import { formatDateTime } from "@/utils/dateFormat";
import { modelName } from "../vocabulary/labels";

/** The two lines of a read in the list: when it was read, and the voice model with its voice. */
export function entryLines(
  models: readonly TtsModelInfo[],
  entry: ReadHistoryEntry,
  language: string,
) {
  return {
    when: formatDateTime(String(entry.timestamp), language),
    voice: `${modelName(models, entry.model_id)} · ${entry.voice}`,
  };
}

/** The line above the selected read: time, voice model, voice and speed. */
export function entryHeading(
  t: TFunction,
  models: readonly TtsModelInfo[],
  entry: ReadHistoryEntry,
  language: string,
) {
  const { when, voice } = entryLines(models, entry, language);
  return `${when} · ${voice} · ${t("tts.speed", { value: entry.speed.toFixed(1) })}`;
}

const RETENTIONS: readonly { value: ReadHistoryRetention; label: string }[] = [
  { value: "keep_nothing", label: "keepNothing" },
  { value: "keep_limit", label: "keepLimit" },
  { value: "days_3", label: "days3" },
  { value: "weeks_2", label: "weeks2" },
  { value: "months_3", label: "months3" },
];

/** The auto-delete choices; Keep latest names the current limit. */
export function retentionOptions(t: TFunction, limit: number) {
  return RETENTIONS.map(({ value, label }) => ({
    value,
    label: t(`tts.history.retention.${label}`, { count: limit }),
  }));
}
