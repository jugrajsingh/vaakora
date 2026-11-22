import type { TFunction } from "i18next";
import type {
  ReadHistoryEntry,
  ReadHistoryRetention,
  TtsModelInfo,
} from "@/bindings";
import { modelName } from "../vocabulary/labels";

/** The tag on a read's row: the voice model and its voice, then `fromAgent` for a read an agent asked for. */
export function entryTag(
  models: readonly TtsModelInfo[],
  entry: ReadHistoryEntry,
  fromAgent: string,
): string {
  const tag = `${modelName(models, entry.model_id)}, ${entry.voice}`;
  return entry.origin === "agent" ? `${tag}, ${fromAgent}` : tag;
}

/** Keep history choices; a label takes `{ count }` for the limit. */
export const READ_KEEP_OPTIONS: readonly {
  value: ReadHistoryRetention;
  key: string;
}[] = [
  {
    value: "keep_nothing",
    key: "settings.readAloudHistory.options.keepNothing",
  },
  { value: "keep_limit", key: "settings.readAloudHistory.options.keepLimit" },
  { value: "days_3", key: "settings.readAloudHistory.options.days3" },
  { value: "weeks_2", key: "settings.readAloudHistory.options.weeks2" },
  { value: "months_3", key: "settings.readAloudHistory.options.months3" },
];

/** The Keep history choices; each Keep the latest names the current limit. */
export function retentionOptions(t: TFunction, limit: number) {
  return READ_KEEP_OPTIONS.map(({ value, key }) => ({
    value,
    label: t(key, { count: limit }),
  }));
}
