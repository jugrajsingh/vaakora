import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  AcronymStyle,
  Edit,
  EntryKey,
  EntryRow,
  Rule,
  TtsModelInfo,
  VocabularyTable as VocabularyData,
} from "@/bindings";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { createRowConfirm } from "@/components/shared/InlineConfirm";
import { AcronymStyles } from "./AcronymStyles";
import { CorrectionBox } from "./CorrectionBox";
import { CorrectionStart } from "./CorrectionStart";
import { visibleFailures, type Failure } from "./actions";
import { filterGroups, type Filters } from "./filter";
import {
  groupRows,
  type RowGroup,
  switchPlanFor,
  voiceChangePlan,
  voiceEdits,
  voiceOptions,
} from "./groups";
import { RowEditor } from "./RowEditor";
import { VocabularyFilters } from "./VocabularyFilters";
import { VocabularyTable } from "./VocabularyTable";

/**
 * An open editor: the row being edited (null for a new entry), every table row that shows as that
 * one row, and the table revision it came from.
 */
export interface Draft {
  initial: EntryRow | null;
  members: readonly EntryRow[];
  base: string;
}

/** A Reset to default waiting for its confirmation, with the table revision it was pressed on. */
interface PendingReset {
  group: RowGroup;
  base: string;
}

/** The shown row with this key still offers Reset to default. */
export function resetOffered(
  visible: readonly RowGroup[],
  readOnly: boolean,
  key: string,
): boolean {
  return (
    !readOnly &&
    visible.some((group) => group.key === key && group.overriding.length > 0)
  );
}

/** An open correction: the text the owner chose and what a read says for it. */
export interface Correction {
  written: string;
  spokenAs: string;
}

export interface VocabularyActions {
  reset: (rows: readonly EntryRow[], base: string) => unknown;
  remove: (rows: readonly EntryRow[], base: string) => unknown;
  applyPlan: (
    plan: (latest: VocabularyData) => Edit[] | null,
    base: string,
  ) => unknown;
  put: (
    entries: readonly EntryKey[],
    rule: Rule,
    previous: readonly (EntryKey | null)[],
    base: string,
  ) => Promise<boolean>;
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
  draft,
  setDraft,
  correction,
  setCorrection,
  readingModel,
  actions,
}: {
  table: VocabularyData;
  models: readonly TtsModelInfo[];
  failure: Failure | null;
  filters: Filters;
  setFilters: (filters: Filters) => void;
  draft: Draft | null;
  setDraft: (draft: Draft | null) => void;
  /** The correction box when open, or `starting` the text prompt before it. */
  correction: Correction | "starting" | null;
  setCorrection: (correction: Correction | "starting" | null) => void;
  /** The selected voice model, which a correction is read with. */
  readingModel: string;
  actions: VocabularyActions;
}) {
  const { t } = useTranslation();
  const readOnly = table.file_error !== null;
  const shown = visibleFailures(table.file_error, failure);
  const finish = async (
    open: Draft,
    entries: readonly EntryKey[],
    rule: Rule,
    previous: readonly (EntryKey | null)[],
  ) => {
    if (await actions.put(entries, rule, previous, open.base)) setDraft(null);
  };
  const modelIds = models.map((model) => model.id);
  const groups = groupRows(table.rows, modelIds);
  const visible = filterGroups(groups, filters);
  const [pendingReset, setPendingReset] = useState<PendingReset | null>(null);
  const latest = useRef({ reset: actions.reset, visible, readOnly });
  latest.current = { reset: actions.reset, visible, readOnly };
  const resetConfirm = useMemo(
    () =>
      createRowConfirm<PendingReset>({
        show: setPendingReset,
        present: ({ group }) =>
          resetOffered(
            latest.current.visible,
            latest.current.readOnly,
            group.key,
          ),
        apply: ({ group, base }) =>
          void latest.current.reset(group.overriding, base),
      }),
    [],
  );
  const resetting = pendingReset?.group.key ?? null;
  useEffect(() => resetConfirm.prune());
  return (
    <section className="max-w-3xl w-full mx-auto space-y-4">
      {shown.map(({ key, message }) => (
        <div role="alert" key={key}>
          <Alert>{t(key, { message })}</Alert>
        </div>
      ))}
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
            draft !== null ||
            correction !== null ||
            readingModel === ""
          }
          onClick={() => setCorrection("starting")}
        >
          {t("tts.correction.add")}
        </Button>
        <Button
          disabled={readOnly || draft !== null || correction !== null}
          onClick={() =>
            setDraft({ initial: null, members: [], base: table.revision })
          }
        >
          {t("tts.vocabulary.buttons.add")}
        </Button>
      </div>
      <VocabularyFilters
        filters={filters}
        models={models}
        setFilters={setFilters}
      />
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
      {draft !== null && (
        <RowEditor
          key={draft.initial ? JSON.stringify(draft.initial.id) : "new"}
          initial={draft.initial}
          members={draft.members}
          models={models}
          styles={table.acronym_styles}
          submit={(entries, rule, previous) =>
            void finish(draft, entries, rule, previous)
          }
          cancel={() => setDraft(null)}
        />
      )}
      {visible.length === 0 ? (
        <p className="text-sm text-ink-3 px-4">{t("tts.vocabulary.empty")}</p>
      ) : (
        <VocabularyTable
          groups={visible}
          models={models}
          readOnly={readOnly}
          editLocked={draft !== null || correction !== null}
          voiceOptions={(group) => voiceOptions(group, groups, modelIds)}
          changeVoice={(group, voice) => {
            if (!voiceEdits(group, voice, groups, modelIds)) return;
            const selected = voiceOptions(group, groups, modelIds).some(
              (option) => option.voice === voice && option.selected,
            );
            void actions.applyPlan(
              (latest) =>
                voiceChangePlan(
                  latest.rows,
                  modelIds,
                  group.key,
                  voice,
                  selected,
                ),
              table.revision,
            );
          }}
          toggle={(group) =>
            void actions.applyPlan(
              (latest) => switchPlanFor(latest.rows, modelIds, group.key),
              table.revision,
            )
          }
          edit={(group) =>
            setDraft({
              initial: group.members[0],
              members: group.members,
              base: table.revision,
            })
          }
          listen={(group) => void actions.listen(group.members[0])}
          remove={(group) => void actions.remove(group.members, table.revision)}
          reset={(group) => resetConfirm.ask({ group, base: table.revision })}
          resetting={resetting}
          confirmReset={resetConfirm.confirm}
          cancelReset={resetConfirm.cancel}
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
