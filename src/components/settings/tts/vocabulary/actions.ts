import type {
  AcronymStyle,
  Edit,
  EntryKey,
  EntryRow,
  ListenText,
  Rule,
  SaveError,
  VocabularyTable,
} from "@/bindings";

const ERRORS = "tts.vocabulary.errors";

export interface VocabularyDependencies {
  load: () => Promise<VocabularyTable>;
  save: (
    revision: string,
    edits: Edit[],
  ) => Promise<VocabularyTable | SaveError>;
  listen: (text: ListenText, model: string | null) => Promise<void>;
  speak: (written: string, model: string) => Promise<string>;
  confirmDelete: (row: EntryRow) => Promise<boolean>;
  setTable: (table: VocabularyTable) => void;
  setError: (key: string | null, message?: string) => void;
  /** A table was loaded, first or after a conflict: close any open draft. */
  discard: () => void;
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

  const reload = async () => {
    try {
      table = await deps.load();
      deps.setTable(table);
      lineage = [table.revision];
      deps.discard();
      return true;
    } catch (reason) {
      deps.setError(errorKey(reason));
      return false;
    }
  };

  /** True when the edit is finished: saved, or the table was reloaded after a conflict. */
  const apply = async (edits: Edit[]) => {
    if (!table) return false;
    try {
      const result = await deps.save(table.revision, edits);
      if (!("kind" in result)) {
        table = result;
        deps.setTable(result);
        lineage.push(result.revision);
        deps.setError(null);
        return true;
      }
      const failure = saveFailure(result);
      if (result.kind === "changed") {
        if (await reload()) deps.setError(failure.key);
        return true;
      }
      if (result.kind === "file_invalid") await reload();
      deps.setError(failure.key, failure.message);
      return false;
    } catch (reason) {
      deps.setError(errorKey(reason));
      return false;
    }
  };

  const run = (edits: Edit[], base: string) => {
    const next = queue.then(() =>
      lineage.includes(base) ? apply(edits) : false,
    );
    queue = next;
    return next;
  };

  return {
    load: async () => {
      if (await reload()) deps.setError(null);
    },
    /** Deletes every owner row after one confirmation, in one save. */
    remove: async (rows: readonly EntryRow[], base: string) => {
      if (
        rows.some((row) => row.id.origin !== "owner") ||
        !(await deps.confirmDelete(rows[0]))
      ) {
        return false;
      }
      return run(
        rows.map((row) => ({ kind: "delete", entry: row.id.entry })),
        base,
      );
    },
    reset: (rows: readonly EntryRow[], base: string) =>
      run(
        rows.map((row) => ({ kind: "reset", entry: row.id.entry })),
        base,
      ),
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
        return edits.length === 0 ? false : apply(edits);
      });
      queue = next;
      return next;
    },
    /**
     * One save puts the rule at every entry; `previous[i]` is the key entry `i` replaces (a
     * rename), or none.
     */
    put: (
      entries: readonly EntryKey[],
      rule: Rule,
      previous: readonly (EntryKey | null)[],
      base: string,
    ) =>
      run(
        entries.map((entry, index) => ({
          kind: "put",
          entry,
          rule,
          previous: previous[index] ?? null,
        })),
        base,
      ),
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
