import type {
  ReadHistoryEntry,
  ReadHistoryRetention,
  Result,
} from "@/bindings";

interface ListDependencies {
  load: () => Promise<ReadHistoryEntry[]>;
  setEntries: (entries: ReadHistoryEntry[]) => void;
  setError: (key: string | null) => void;
}

export interface RetentionDependencies extends ListDependencies {
  setLimit: (limit: number) => Promise<void>;
  setRetention: (retention: ReadHistoryRetention) => Promise<void>;
}

export interface HistoryDependencies extends ListDependencies {
  clear: () => Promise<number>;
  /** Called once the stored reads are cleared, before the list is read again. */
  cleared: () => void;
}

/** How many reads Clear history deletes, and the newest, so a read saved since is noticed. */
export interface ReadClearCount {
  count: number;
  newest: number | null;
}

/** True when no read was added or removed: same count and the same newest read. */
export function sameReadCount(
  asked: ReadClearCount,
  fresh: ReadClearCount,
): boolean {
  return asked.count === fresh.count && asked.newest === fresh.newest;
}

const GENERIC = "tts.errors.generic";

/** A refusal arrives as a translation key; anything else is shown as the generic error. */
const keyOf = (reason: unknown) =>
  reason instanceof Error && reason.message.startsWith("tts.errors.")
    ? reason.message
    : GENERIC;

/** Reads the stored list and shows it; returns it, or `null` after showing the load error. */
const listLoader =
  (deps: ListDependencies) => async (): Promise<ReadHistoryEntry[] | null> => {
    deps.setError(null);
    try {
      const entries = await deps.load();
      deps.setEntries(entries);
      return entries;
    } catch {
      deps.setError(GENERIC);
      return null;
    }
  };

/** Loading the stored reads and applying the limit and retention settings, which prune them. */
export function createRetentionActions(deps: RetentionDependencies) {
  const load = listLoader(deps);
  /** A setting change prunes the stored reads once applied, so the list is read again afterwards. */
  const applied = async (change: () => Promise<void>): Promise<void> => {
    let failure: string | null = null;
    try {
      await change();
    } catch (reason) {
      failure = keyOf(reason);
    }
    await load();
    if (failure !== null) deps.setError(failure);
  };
  return {
    load,
    changeLimit: (limit: number) => applied(() => deps.setLimit(limit)),
    changeRetention: (retention: ReadHistoryRetention) =>
      applied(() => deps.setRetention(retention)),
  };
}

export function createHistoryActions(deps: HistoryDependencies) {
  const load = listLoader(deps);
  /** Reads the stored list again (the shown list too) and counts it; `null` when it cannot be read. */
  const count = async (): Promise<ReadClearCount | null> => {
    const entries = await load();
    return entries === null
      ? null
      : { count: entries.length, newest: entries[0]?.id ?? null };
  };
  /** Clears the read history. The vocabulary is a different file and is not touched. */
  const clear = async (): Promise<void> => {
    try {
      await deps.clear();
    } catch {
      deps.setError(GENERIC);
      return;
    }
    deps.cleared();
    await load();
  };
  return { load, count, clear };
}

/**
 * The production setters: the history command, then the settings store refreshed from the
 * backend (a refused change leaves the old value, a prune failure leaves the new one saved), then
 * a refusal thrown so the actions can show it.
 */
export function createSettingSetters(deps: {
  setLimit: (limit: number) => Promise<Result<null, string>>;
  setRetention: (
    retention: ReadHistoryRetention,
  ) => Promise<Result<null, string>>;
  refresh: () => Promise<void>;
}) {
  const settle = async (result: Result<null, string>): Promise<void> => {
    await deps.refresh();
    if (result.status === "error") throw new Error(result.error);
  };
  return {
    setLimit: async (limit: number) => settle(await deps.setLimit(limit)),
    setRetention: async (retention: ReadHistoryRetention) =>
      settle(await deps.setRetention(retention)),
  };
}
