import type {
  ReadHistoryEntry,
  ReadHistoryRetention,
  Result,
} from "@/bindings";

export interface HistoryDependencies {
  load: () => Promise<ReadHistoryEntry[]>;
  clear: () => Promise<number>;
  confirm: (count: number) => Promise<boolean>;
  setLimit: (limit: number) => Promise<void>;
  setRetention: (retention: ReadHistoryRetention) => Promise<void>;
  setEntries: (entries: ReadHistoryEntry[]) => void;
  setClearing: (clearing: boolean) => void;
  setError: (key: string | null) => void;
}

const GENERIC = "tts.errors.generic";

/** A refusal arrives as a translation key; anything else is shown as the generic error. */
const keyOf = (reason: unknown) =>
  reason instanceof Error && reason.message.startsWith("tts.errors.")
    ? reason.message
    : GENERIC;

export function createHistoryActions(deps: HistoryDependencies) {
  let clearing = false;
  /** Reads the stored list and shows it; returns it, or `null` after showing the load error. */
  const load = async (): Promise<ReadHistoryEntry[] | null> => {
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
  /** Clears the read history after the owner confirms. The vocabulary is a different file and is not touched. */
  const clear = async (count: number): Promise<void> => {
    if (clearing) return;
    clearing = true;
    deps.setClearing(true);
    deps.setError(null);
    try {
      if (!(await deps.confirm(count))) return;
      await deps.clear();
      await load();
    } catch {
      deps.setError(GENERIC);
    } finally {
      clearing = false;
      deps.setClearing(false);
    }
  };
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
    clear,
    changeLimit: (limit: number) => applied(() => deps.setLimit(limit)),
    changeRetention: (retention: ReadHistoryRetention) =>
      applied(() => deps.setRetention(retention)),
  };
}

/** The read on show: the chosen one when it still exists, otherwise the newest. */
export function shownEntry(
  entries: readonly ReadHistoryEntry[] | null,
  chosen: number | null,
): ReadHistoryEntry | undefined {
  return entries?.find((entry) => entry.id === chosen) ?? entries?.[0];
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
