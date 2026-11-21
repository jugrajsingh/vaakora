import { useState, type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import type {
  AcronymStyle,
  Edit,
  EntryRow,
  TtsModelInfo,
  VocabularyTable as VocabularyData,
} from "@/bindings";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { AcronymStyles } from "./AcronymStyles";
import { CorrectionBox } from "./CorrectionBox";
import { CorrectionStart } from "./CorrectionStart";
import { visibleFailures, type Failure, type SaveResult } from "./actions";
import { EntryDialog } from "./EntryDialog";
import {
  deletePlan,
  entryEdits,
  resetPlan,
  type EntryDraft,
  type EntryPlan,
} from "./entryPlan";
import { emptyState, filterGroups, NO_FILTERS, type Filters } from "./filter";
import { groupRows, scopesOf, switchPlanFor, type RowGroup } from "./groups";
import { VocabularyFilters } from "./VocabularyFilters";
import { VocabularyTable } from "./VocabularyTable";

/**
 * An open entry dialog: the group it edits (null for Add entry) as it was when the dialog opened,
 * the revision its saves are based on, and the line it shows.
 */
export interface EntryOpen {
  group: RowGroup | null;
  base: string;
  notice: Failure | null;
}

/** The dialog after a save, delete or reset: closed when saved, else open with what happened. */
export function dialogOutcome(
  open: EntryOpen,
  result: SaveResult,
): EntryOpen | null {
  switch (result.status) {
    case "saved":
      return null;
    case "conflict":
      return {
        ...open,
        base: result.revision,
        notice: { key: "tts.vocabulary.dialog.conflict" },
      };
    case "refused":
      return { ...open, notice: { key: "tts.vocabulary.dialog.refused" } };
    case "failed":
      return { ...open, notice: result.failure };
  }
}

/** The dialog's identity; a rebase keeps it, so the typed form survives a conflict. */
export const entryDialogKey = (open: EntryOpen) => open.group?.key ?? "new";

/** An open correction: the text the owner chose and what a read says for it. */
export interface Correction {
  written: string;
  spokenAs: string;
}

export interface VocabularyActions {
  applyPlan: (
    plan: (latest: VocabularyData) => Edit[] | null,
    base: string,
  ) => unknown;
  saveEntry: (
    plan: (latest: VocabularyData) => EntryPlan,
    base: string,
  ) => Promise<SaveResult>;
  listen: (row: EntryRow) => unknown;
  setAcronymStyle: (
    model: string | null,
    style: AcronymStyle | null,
    base: string,
  ) => unknown;
  speak: (written: string, model: string) => Promise<string | null>;
  adopt: (table: VocabularyData) => void;
}

export function VocabularyView({
  table,
  models,
  failure,
  filters,
  setFilters,
  editing,
  setEditing,
  correction,
  setCorrection,
  readingModel,
  actions,
  reload,
  openFolder,
}: {
  table: VocabularyData;
  models: readonly TtsModelInfo[];
  failure: Failure | null;
  filters: Filters;
  setFilters: (filters: Filters) => void;
  editing: EntryOpen | null;
  setEditing: Dispatch<SetStateAction<EntryOpen | null>>;
  /** The correction dialog when open, or `starting` the text dialog before it. */
  correction: Correction | "starting" | null;
  setCorrection: (correction: Correction | "starting" | null) => void;
  /** The selected voice model, which a correction is read with. */
  readingModel: string;
  actions: VocabularyActions;
  /** Reads the vocabulary file again. */
  reload: () => void;
  /** Opens the folder that holds the vocabulary file. */
  openFolder: () => void;
}) {
  const { t } = useTranslation();
  const readOnly = table.file_error !== null;
  // visibleFailures lists a file error first; the invalid-file block below shows that one.
  const shown = visibleFailures(table.file_error, failure).slice(
    readOnly ? 1 : 0,
  );
  const [busy, setBusy] = useState(false);
  const modelIds = models.map((model) => model.id);
  const groups = groupRows(table.rows, modelIds);
  const visible = filterGroups(groups, filters);
  const open = (group: RowGroup | null) =>
    setEditing({ group, base: table.revision, notice: null });
  /** Runs one dialog save; its outcome reaches the dialog only if that one is still open. */
  const settle = async (
    current: EntryOpen,
    plan: (latest: VocabularyData) => EntryPlan,
  ) => {
    setBusy(true);
    try {
      const result = await actions.saveEntry(plan, current.base);
      setEditing((now) =>
        now === current ? dialogOutcome(current, result) : now,
      );
    } finally {
      setBusy(false);
    }
  };
  const save = (current: EntryOpen, draft: EntryDraft) =>
    settle(current, (latest) =>
      entryEdits(latest.rows, modelIds, current.group?.key ?? null, draft),
    );
  /** Delete or Reset to default of the dialog's group, at the scopes it opened with. */
  const removeWith = (current: EntryOpen, plan: typeof deletePlan) => {
    const { group } = current;
    if (!group) return;
    const opened = scopesOf(group, modelIds);
    void settle(current, (latest) =>
      plan(latest.rows, modelIds, group.key, opened),
    );
  };
  const empty = emptyState(filters);
  return (
    <section className="w-full max-w-3xl min-w-0 space-y-4">
      <div className="sticky top-0 z-10 space-y-2 bg-background py-2">
        <div className="flex items-center gap-2">
          <Input
            type="search"
            className="flex-grow"
            aria-label={t("tts.vocabulary.filter")}
            placeholder={t("tts.vocabulary.filter")}
            value={filters.query}
            onChange={(event) =>
              setFilters({ ...filters, query: event.target.value })
            }
          />
          <Button
            variant="secondary"
            disabled={
              readOnly ||
              editing !== null ||
              correction !== null ||
              readingModel === ""
            }
            onClick={() => setCorrection("starting")}
          >
            {t("tts.correction.title")}
          </Button>
          <Button
            disabled={readOnly || editing !== null || correction !== null}
            onClick={() => open(null)}
          >
            {t("tts.vocabulary.buttons.add")}
          </Button>
        </div>
        <VocabularyFilters
          filters={filters}
          models={models}
          setFilters={setFilters}
        />
      </div>
      {readOnly && (
        <div
          role="alert"
          className="space-y-2 rounded-lg bg-error-wash p-4 text-sm"
        >
          <p className="text-error">
            {t("tts.vocabulary.errors.fileInvalid", {
              message: table.file_error,
            })}
          </p>
          <p dir="ltr" className="font-mono break-all text-ink-2">
            {table.path}
          </p>
          <p className="text-ink-2">
            {t("tts.vocabulary.invalid.builtinUsed")}
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={reload}>
              {t("tts.vocabulary.invalid.reload")}
            </Button>
            <Button size="sm" variant="secondary" onClick={openFolder}>
              {t("tts.vocabulary.invalid.openFolder")}
            </Button>
          </div>
        </div>
      )}
      {shown.map(({ key, message }) => (
        <div role="alert" key={key}>
          <Alert>{t(key, { message })}</Alert>
        </div>
      ))}
      {correction === "starting" && (
        <CorrectionStart
          speak={(written) => actions.speak(written, readingModel)}
          open={(written, spokenAs) => setCorrection({ written, spokenAs })}
          cancel={() => setCorrection(null)}
        />
      )}
      {correction !== null && correction !== "starting" && (
        <CorrectionBox
          key={correction.written}
          written={correction.written}
          spokenAs={correction.spokenAs}
          readingModel={readingModel}
          models={models}
          onSaved={actions.adopt}
          onClose={() => setCorrection(null)}
        />
      )}
      {editing !== null && (
        <EntryDialog
          key={entryDialogKey(editing)}
          group={editing.group}
          rows={table.rows}
          modelIds={modelIds}
          models={models}
          styles={table.acronym_styles}
          notice={editing.notice}
          fileError={table.file_error}
          busy={busy}
          save={(draft) => void save(editing, draft)}
          remove={() => removeWith(editing, deletePlan)}
          reset={() => removeWith(editing, resetPlan)}
          close={() => setEditing(null)}
        />
      )}
      {visible.length === 0 ? (
        <div className="space-y-2 py-6 text-center text-sm text-ink-3">
          <p>{t(empty.key, { query: empty.query })}</p>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setFilters(NO_FILTERS)}
          >
            {t("tts.vocabulary.clearFilters")}
          </Button>
        </div>
      ) : (
        <VocabularyTable
          groups={visible}
          models={models}
          readOnly={readOnly}
          toggle={(group) =>
            void actions.applyPlan(
              (latest) => switchPlanFor(latest.rows, modelIds, group.key),
              table.revision,
            )
          }
          edit={open}
          listen={(group) => void actions.listen(group.members[0])}
        />
      )}
      <AcronymStyles
        styles={table.acronym_styles}
        models={models}
        readOnly={readOnly}
        set={(model, style) =>
          void actions.setAcronymStyle(model, style, table.revision)
        }
      />
    </section>
  );
}
