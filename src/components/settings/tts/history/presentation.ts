import type { TFunction } from "i18next";
import type {
  ReadHistoryEntry,
  ReadHistoryRetention,
  TtsModelInfo,
} from "@/bindings";
import { modelName } from "../vocabulary/labels";

/** The tag on a read's row: the voice model and its voice. A read from an agent also gets its own "from agent" tag beside it. */
export function entryTag(
  models: readonly TtsModelInfo[],
  entry: ReadHistoryEntry,
): string {
  return `${modelName(models, entry.model_id)}, ${entry.voice}`;
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

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/** A line of box-drawing characters, `|`, `+`, `-` and `=` only: a table's border, never its text. */
const BORDER = /^[\s\u2500-\u257F|+\-=]*$/;
const FENCE = /^\s*(```|~~~)/;
const WALLS = /[\u2500-\u257F|]/g;

/**
 * What a read's collapsed row shows: the written text on one line. A read that starts with a box
 * or ASCII table (its first grid block, found by the backend) shows the first line of that table
 * that holds text, its walls stripped, never the top border. Any other read, and a table with no
 * text, shows its collapsed source.
 */
export function readExcerpt(
  entry: Pick<ReadHistoryEntry, "source" | "grid_blocks">,
): string {
  const block = entry.grid_blocks[0];
  const first = entry.source.length - entry.source.trimStart().length;
  if (block && block.start <= first && first < block.end) {
    const line = entry.source
      .slice(block.start, block.end)
      .split(/\r?\n/)
      .find((text) => !BORDER.test(text) && !FENCE.test(text));
    if (line !== undefined) return collapse(line.replace(WALLS, " "));
  }
  return collapse(entry.source);
}
