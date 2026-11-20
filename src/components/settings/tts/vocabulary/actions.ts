import type {
  AcronymStyle,
  Edit,
  EntryRow,
  ListenText,
  SaveError,
  VocabularyTable,
} from "@/bindings";
import type { EntryPlan, EntryRefusal } from "./entryPlan";

const ERRORS = "tts.vocabulary.errors";

export interface VocabularyDependencies {
  load: () => Promise<VocabularyTable>;
  save: (
    revision: string,
    edits: Edit[],
  ) => Promise<VocabularyTable | SaveError>;
  listen: (text: ListenText, model: string | null) => Promise<void>;
  speak: (written: string, model: string) => Promise<string>;
  setTable: (table: VocabularyTable) => void;
  setError: (key: string | null, message?: string) => void;
  /** Failures of a Listen after its command was accepted; resolves to an unsubscribe. */
  onPreviewError: (listener: (message: string) => void) => Promise<() => void>;
}

export interface Failure {
  key: string;
  message?: string;
}

/** A file error always shows, first, because it is why editing is off; the last failure follows. */
export function visibleFailures(
  fileError: string | null,
  failure: Failure | null,
): Failure[] {
  const fileInvalid = {
    key: `${ERRORS}.fileInvalid`,
    message: fileError ?? "",
  };
  return [
    ...(fileError === null ? [] : [fileInvalid]),
    ...(failure && !(fileError !== null && failure.key === fileInvalid.key)
      ? [failure]
      : []),
  ];
}

/** What the owner is told when a save wrote nothing. */
export function saveFailure(error: SaveError): Failure {
  switch (error.kind) {
    case "changed":
      return { key: `${ERRORS}.changed` };
    case "file_invalid":
      return { key: `${ERRORS}.fileInvalid`, message: error.message };
    case "invalid_edit":
      return { key: `${ERRORS}.invalidEdit`, message: error.message };
    case "too_large":
      return { key: `${ERRORS}.tooLarge` };
    case "io":
      return { key: `${ERRORS}.io`, message: error.message };
  }
}

/**
 * What a dialog save did: saved, a conflict (the table was reloaded; `revision` is the one now
 * shown), refused by its plan, or failed with nothing written.
 */
export type SaveResult =
  | { status: "saved" }
  | { status: "conflict"; revision: string }
  | { status: "refused"; reason: EntryRefusal }
  | { status: "failed"; failure: Failure };

/** What one save did; `unloaded` is a conflict whose reload failed. */
type Applied =
  | Exclude<SaveResult, { status: "refused" }>
  | { status: "unloaded"; failure: Failure };

/** Backend errors arrive as `tts.errors.*` keys; anything else is the generic failure. */
const keyOf = (message: string) =>
  message.startsWith("tts.errors.") ? message : "tts.errors.generic";
const errorKey = (reason: unknown) =>
  keyOf(reason instanceof Error ? reason.message : "");

/**
 * Edits to the owner's file. Every edit names the revision of the table the owner was looking at
 * (`base`). The lineage holds the revisions of this table since its last reload: the loaded one
 * and each one a save of ours returned. An edit whose base is not in the lineage was made against
 * a table that has since been replaced by a reload (after a conflict or a file error), so it is
 * dropped, queued or not, and nothing made against the old table is saved over what changed on
 * disk. Saves run one after another and send the current revision, which the backend checks last.
 */
export function createVocabularyActions(deps: VocabularyDependencies) {
  let table: VocabularyTable | null = null;
  let lineage: string[] = [];
  let queue: Promise<unknown> = Promise.resolve();

  /** Loads and shows the table; a failure is shown on the tab and returned. */
  const reload = async (): Promise<
    { loaded: VocabularyTable } | { failure: Failure }
  > => {
    try {
      const loaded = await deps.load();
      table = loaded;
      deps.setTable(loaded);
      lineage = [loaded.revision];
      return { loaded };
    } catch (reason) {
      const failure = { key: errorKey(reason) };
      deps.setError(failure.key);
      return { failure };
    }
  };

  /** Sends one save; on the tab it only clears on success or shows a failed reload. */
  const apply = async (
    current: VocabularyTable,
    edits: Edit[],
  ): Promise<Applied> => {
    try {
      const result = await deps.save(current.revision, edits);
      if (!("kind" in result)) {
        table = result;
        deps.setTable(result);
        lineage.push(result.revision);
        deps.setError(null);
        return { status: "saved" };
      }
      if (result.kind === "changed") {
        const reloaded = await reload();
        return "failure" in reloaded
          ? { status: "unloaded", failure: reloaded.failure }
          : { status: "conflict", revision: reloaded.loaded.revision };
      }
      if (result.kind === "file_invalid") await reload();
      return { status: "failed", failure: saveFailure(result) };
    } catch (reason) {
      return { status: "failed", failure: { key: errorKey(reason) } };
    }
  };

  /** True when the edit is finished: saved, or the table was reloaded after a conflict. */
  const finish = async (edits: Edit[]) => {
    if (!table) return false;
    const applied = await apply(table, edits);
    switch (applied.status) {
      case "saved":
      case "unloaded":
        return true;
      case "conflict":
        deps.setError(`${ERRORS}.changed`);
        return true;
      case "failed":
        deps.setError(applied.failure.key, applied.failure.message);
        return false;
    }
  };

  const run = (edits: Edit[], base: string) => {
    const next = queue.then(() =>
      lineage.includes(base) ? finish(edits) : false,
    );
    queue = next;
    return next;
  };

  return {
    load: async () => {
      if ("loaded" in (await reload())) deps.setError(null);
    },
    /**
     * Saves the edits `plan` makes from the latest table, in one save. The plan runs when the
     * edit leaves the queue, so an edit queued behind another sees what that one saved; a plan
     * that returns `null` no longer applies and nothing is saved.
     */
    applyPlan: (
      plan: (latest: VocabularyTable) => Edit[] | null,
      base: string,
    ) => {
      const next = queue.then(async () => {
        if (!table || !lineage.includes(base)) return false;
        const edits = plan(table);
        if (edits === null) {
          deps.setError(`${ERRORS}.voicesChanged`);
          return false;
        }
        return edits.length === 0 ? false : finish(edits);
      });
      queue = next;
      return next;
    },
    /**
     * Saves the edits `plan` makes from the latest table, queued like `applyPlan`, and reports
     * the outcome only through its result. A `base` this table no longer has, or a save the
     * file changed under, is a conflict: nothing is saved and the result names the revision now
     * shown.
     */
    saveEntry: (
      plan: (latest: VocabularyTable) => EntryPlan,
      base: string,
    ): Promise<SaveResult> => {
      const next = queue.then(async (): Promise<SaveResult> => {
        if (!table) {
          return { status: "failed", failure: { key: "tts.errors.generic" } };
        }
        if (!lineage.includes(base)) {
          return { status: "conflict", revision: table.revision };
        }
        const edits = plan(table);
        if (typeof edits === "string") {
          return { status: "refused", reason: edits };
        }
        if (edits.length === 0) return { status: "saved" };
        const applied = await apply(table, edits);
        return applied.status === "unloaded"
          ? { status: "failed", failure: applied.failure }
          : applied;
      });
      queue = next;
      return next;
    },
    /** `null` removes the owner's choice for the voice (every voice when `model` is `null`). */
    setAcronymStyle: (
      model: string | null,
      style: AcronymStyle | null,
      base: string,
    ) => run([{ kind: "set_acronym_style", model, style }], base),
    /** A table the correction box saved and returned replaces the one on screen. */
    adopt: (saved: VocabularyTable) => {
      table = saved;
      deps.setTable(saved);
      lineage = [saved.revision];
      deps.setError(null);
    },
    /** What a read says for the text; the failure is shown on the tab. */
    speak: async (written: string, model: string) => {
      try {
        const spoken = await deps.speak(written, model);
        deps.setError(null);
        return spoken;
      } catch (reason) {
        deps.setError(errorKey(reason));
        return null;
      }
    },
    /** Shows preview errors on the tab as long as it is open; returns the stop function. */
    watch: () => {
      let stop: (() => void) | undefined;
      let open = true;
      void deps
        .onPreviewError((message) => deps.setError(keyOf(message)))
        .then((unsubscribe) => {
          if (open) stop = unsubscribe;
          else unsubscribe();
        });
      return () => {
        open = false;
        stop?.();
      };
    },
    listen: async (row: EntryRow) => {
      try {
        await deps.listen({ written: row.sample }, row.id.entry.model);
        deps.setError(null);
      } catch (reason) {
        deps.setError(errorKey(reason));
      }
    },
  };
}
