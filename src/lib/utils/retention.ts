import type {
  AppSettings,
  ReadHistoryEntry,
  ReadHistoryRetention,
  RecordingRetentionPeriod,
} from "@/bindings";
import type { Recount } from "@/components/shared/InlineConfirm";

/** What the dictation history keeps: the Auto-delete choice and the history limit. */
export type DictationKeep = { period: RecordingRetentionPeriod; limit: number };

/** The read history limit while the setting is unset (`tts_history_limit`). */
export const DEFAULT_READ_LIMIT = 5;

const DAY = 24 * 60 * 60;

/** Days each time choice keeps; serde stores `days3` while the specta binding names it `days_3`. */
const PERIOD_DAYS: Record<string, number> = {
  days_3: 3,
  days3: 3,
  weeks_2: 14,
  weeks2: 14,
  months_3: 90,
  months3: 90,
};

/** Auto-delete choices with the spellings the settings store writes (serde's `days3`, not the binding's `days_3`). */
export const AUTO_DELETE_OPTIONS: readonly {
  value: RecordingRetentionPeriod;
  key: string;
}[] = [
  { value: "never", key: "settings.dictationHistory.options.never" },
  {
    value: "preserve_limit",
    key: "settings.dictationHistory.options.preserveLimit",
  },
  {
    value: "days3" as RecordingRetentionPeriod,
    key: "settings.dictationHistory.options.days3",
  },
  {
    value: "weeks2" as RecordingRetentionPeriod,
    key: "settings.dictationHistory.options.weeks2",
  },
  {
    value: "months3" as RecordingRetentionPeriod,
    key: "settings.dictationHistory.options.months3",
  },
];

/** Keep the latest is not used with a time limit; the reason shows under the row. */
export function dictationLimitRow(period: RecordingRetentionPeriod | string): {
  disabled: boolean;
  reasonKey: string | null;
} {
  return PERIOD_DAYS[period] !== undefined
    ? { disabled: true, reasonKey: "settings.dictationHistory.limitTimeLimit" }
    : { disabled: false, reasonKey: null };
}

/** Keep the latest is not used while read history is off. */
export function readLimitRow(retention: ReadHistoryRetention): {
  disabled: boolean;
  reasonKey: string | null;
} {
  return retention === "keep_nothing"
    ? { disabled: true, reasonKey: "settings.readAloudHistory.limitOff" }
    : { disabled: false, reasonKey: null };
}

/** The stored dictation keep, unset values read as the backend defaults (`settings.rs`). */
export function currentKeep(
  getSetting: <K extends keyof AppSettings>(
    key: K,
  ) => AppSettings[K] | undefined,
): DictationKeep {
  return {
    period: getSetting("recording_retention_period") ?? "preserve_limit",
    limit: getSetting("history_limit") ?? 5,
  };
}

/**
 * Whether moving the dictation history from `from` to `to` deletes entries now, mirroring
 * `retention_candidates` in `src-tauri/src/managers/history.rs`: Never deletes nothing, Keep latest
 * keeps the newest `limit`, and a time choice ignores the limit and deletes what is older.
 */
export function dictationChangeDeletes(
  from: DictationKeep,
  to: DictationKeep,
): boolean {
  if (to.period === "never") return false;
  if (to.period === "preserve_limit") {
    return from.period !== "preserve_limit" || to.limit < from.limit;
  }
  const fromDays = PERIOD_DAYS[from.period];
  return fromDays === undefined || fromDays > PERIOD_DAYS[to.period];
}

/**
 * The Auto-delete confirmation sentence for a pending period. Confirming writes only the period,
 * so the backend prunes with the limit stored at that moment; the sentence names that limit.
 */
export function autoDeleteConfirm(
  pending: DictationKeep,
  stored: DictationKeep,
): { key: string; count: number } {
  const name =
    pending.period === "preserve_limit"
      ? "preserveLimit"
      : pending.period.replace("_", "");
  return {
    key: `settings.history.retentionConfirm.${name}`,
    count: stored.limit,
  };
}

/**
 * How many stored reads `keep` deletes now, mirroring `prune_in` in `src-tauri/src/tts/history.rs`:
 * a limit of 0 or Never keep deletes all, a time choice deletes reads older than its cutoff, then
 * all but the newest `limit` go.
 */
export function readsRemovedBy(
  entries: readonly Pick<ReadHistoryEntry, "id" | "timestamp">[],
  keep: { limit: number; retention: ReadHistoryRetention },
  nowSeconds: number,
): number {
  if (keep.limit === 0 || keep.retention === "keep_nothing") {
    return entries.length;
  }
  const days = PERIOD_DAYS[keep.retention];
  const cutoff = days === undefined ? null : nowSeconds - days * DAY;
  const recent = entries.filter(
    (entry) => cutoff === null || entry.timestamp >= cutoff,
  ).length;
  return entries.length - Math.min(recent, keep.limit);
}

/**
 * Checks a read-retention question against the stored list when it is confirmed. The asked
 * change holds how many reads it deletes and the newest stored id; the backend prunes on save,
 * so a read added while the question was open can leave the count unchanged and only the newest
 * id differs. Either differing asks again with the fresh values, a list that cannot be read drops
 * the change, and a count of nothing or an unchanged list applies it.
 */
export function readRecount<
  C extends {
    count: number;
    newest: number | null;
    next: { limit: number; retention: ReadHistoryRetention };
  },
>(
  asked: C,
  stored: readonly Pick<ReadHistoryEntry, "id" | "timestamp">[] | null,
  nowSeconds: number,
): Recount<C> {
  if (stored === null) return "drop";
  const count = readsRemovedBy(stored, asked.next, nowSeconds);
  const newest = stored[0]?.id ?? null;
  if (count === 0 || (count === asked.count && newest === asked.newest)) {
    return "apply";
  }
  return { ...asked, count, newest };
}

/** A history toolbar's summary: the locale key, its count and whether anything is kept. */
export interface HistorySummary {
  key: string;
  count?: number;
  kept: boolean;
}

/** The keys of the time choices, by the days each keeps. */
const AGE_KEYS: Record<number, string> = {
  3: "days3",
  14: "weeks2",
  90: "months3",
};

/** The dictation toolbar's sentence for the stored Auto-delete choice and history limit. */
export function dictationSummary(keep: DictationKeep): HistorySummary {
  const base = "history.summary.dictation";
  if (keep.period === "never") return { key: `${base}.never`, kept: true };
  const days = PERIOD_DAYS[keep.period];
  if (days !== undefined)
    return { key: `${base}.${AGE_KEYS[days]}`, kept: true };
  if (keep.limit === 0) return { key: `${base}.none`, kept: false };
  return { key: `${base}.latest`, count: keep.limit, kept: true };
}

/** The read toolbar's sentence for the stored history limit and retention. */
export function readSummary(
  limit: number,
  retention: ReadHistoryRetention,
): HistorySummary {
  if (limit === 0 || retention === "keep_nothing") {
    return { key: "history.notKept", kept: false };
  }
  const base = "history.summary.read";
  const days = PERIOD_DAYS[retention];
  const key = days === undefined ? "latest" : AGE_KEYS[days];
  return { key: `${base}.${key}`, count: limit, kept: true };
}

/** Applies a change that deletes nothing; a change that deletes waits for a confirmation. */
export function routeChange<C>(
  change: C,
  deps: {
    deletes: (change: C) => boolean;
    ask: (change: C) => void;
    apply: (change: C) => void;
  },
): void {
  if (deps.deletes(change)) deps.ask(change);
  else deps.apply(change);
}
