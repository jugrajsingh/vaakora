import type {
  AppSettings,
  ReadHistoryEntry,
  ReadHistoryRetention,
  RecordingRetentionPeriod,
} from "@/bindings";

/** What the dictation history keeps: the Auto-delete choice and the history limit. */
export type DictationKeep = { period: RecordingRetentionPeriod; limit: number };

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
