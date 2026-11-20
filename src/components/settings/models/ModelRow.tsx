import React from "react";
import { useTranslation } from "react-i18next";
import {
  DictationCells,
  ManagerRow,
} from "@/components/shared/modelTable/ManagerRow";
import type { ManagerModel } from "@/components/shared/modelTable/roles";
import type { Grading } from "@/lib/models/grading";
import { formatModelSize } from "@/lib/utils/format";
import { useModelStore } from "@/stores/modelStore";
import { useModelsLocked } from "@/stores/transcriptionJobsStore";
import { dictationRow, markPress } from "./managerRows";
import {
  cancelDownload,
  pickModel,
  useIsTarget,
  usePlace,
  type Entry,
} from "./modelEntries";

interface ModelRowProps {
  model: ManagerModel;
  entry: Entry;
  grading: Grading;
  open: boolean;
  toggle: () => void;
  /** The delete question's message while this row asks, else null. */
  asking: string | null;
  ask: () => void;
  cancel: () => void;
  confirm: () => void;
}

/** A Models, Dictation row: the mark selects, downloads or stops; the trash asks before deleting. */
export const ModelRow: React.FC<ModelRowProps> = ({
  model,
  entry,
  grading,
  open,
  toggle,
  asking,
  ask,
  cancel,
  confirm,
}) => {
  const { t } = useTranslation();
  const place = usePlace(entry.id);
  const target = useIsTarget(entry.id);
  const locked = useModelsLocked();
  const percent = useModelStore(
    (s) => s.downloadProgress[entry.id]?.percentage ?? 0,
  );
  const row = dictationRow(place, { locked });
  const press = markPress(row.mark, entry.id, {
    pick: pickModel,
    cancel: cancelDownload,
  });
  // While History transcribes, the model in use can't change or go away.
  const lockedActive = locked && place === "active";
  const resting = place === "ready" || place === "remote";

  const line = lockedActive ? (
    t("modelSelector.lockedWhileTranscribing")
  ) : place === "checking" ? (
    t("onboarding.download.checking")
  ) : place === "downloading" && target && !locked ? (
    <span className="tabular-nums">
      {t("settings.models.downloadingThenUse", {
        percent: Math.round(percent),
        total: formatModelSize(entry.sizeMb),
      })}
    </span>
  ) : resting && entry.kind === "custom" ? (
    t("modelTable.customLine")
  ) : resting && entry.kind === "legacy" ? (
    t("modelTable.legacyLine")
  ) : undefined;

  return (
    <ManagerRow
      model={model}
      open={open}
      toggle={toggle}
      cells={<DictationCells model={model} entry={entry} grading={grading} />}
      mark={
        press && {
          label: t(`models.mark.${row.mark}`, { name: model.name }),
          disabled: row.inert
            ? t("modelSelector.lockedWhileTranscribing")
            : undefined,
          press,
        }
      }
      remove={
        row.deletable
          ? { label: t("models.remove", { name: model.name }), press: ask }
          : undefined
      }
      question={
        asking === null ? undefined : { message: asking, confirm, cancel }
      }
      line={line}
      locked={lockedActive}
      onKeyDown={(e) => {
        if (e.key === "Escape" && asking !== null) {
          e.preventDefault();
          e.stopPropagation();
          cancel();
          return;
        }
        if (e.target !== e.currentTarget) return;
        if ((e.key === "Delete" || e.key === "Backspace") && row.deletable) {
          e.preventDefault();
          ask();
        }
      }}
    />
  );
};
