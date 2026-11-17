import React, { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dropdown } from "../ui/Dropdown";
import { SettingContainer } from "../ui/SettingContainer";
import { useSettings } from "../../hooks/useSettings";
import { RecordingRetentionPeriod } from "@/bindings";
import {
  autoDeleteConfirm,
  currentKeep,
  dictationChangeDeletes,
  routeChange,
  type DictationKeep,
} from "../../lib/utils/retention";
import { createPendingConfirm, InlineConfirm } from "../shared/InlineConfirm";

interface RecordingRetentionPeriodProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

export const RecordingRetentionPeriodSelector: React.FC<RecordingRetentionPeriodProps> =
  React.memo(({ descriptionMode = "tooltip", grouped = false }) => {
    const { t } = useTranslation();
    const { getSetting, updateSetting, isUpdating } = useSettings();

    const selectedRetentionPeriod =
      getSetting("recording_retention_period") || "never";
    const historyLimit = getSetting("history_limit") || 5;

    const keep = currentKeep(getSetting);
    const [pending, setPending] = useState<DictationKeep | null>(null);
    const write = useRef(updateSetting);
    write.current = updateSetting;
    const sentence = pending && autoDeleteConfirm(pending, keep);
    const confirm = useMemo(
      () =>
        createPendingConfirm<DictationKeep>({
          show: setPending,
          apply: (to) => write.current("recording_retention_period", to.period),
        }),
      [],
    );

    const handleRetentionPeriodSelect = (period: string) =>
      routeChange(
        { ...keep, period: period as RecordingRetentionPeriod },
        {
          deletes: (to) => dictationChangeDeletes(keep, to),
          ask: confirm.ask,
          apply: (to) =>
            void updateSetting("recording_retention_period", to.period),
        },
      );

    const retentionOptions = [
      { value: "never", label: t("settings.debug.recordingRetention.never") },
      {
        value: "preserve_limit",
        label: t("settings.debug.recordingRetention.preserveLimit", {
          count: Number(historyLimit),
        }),
      },
      { value: "days3", label: t("settings.debug.recordingRetention.days3") },
      { value: "weeks2", label: t("settings.debug.recordingRetention.weeks2") },
      {
        value: "months3",
        label: t("settings.debug.recordingRetention.months3"),
      },
    ];

    return (
      <SettingContainer
        title={t("settings.debug.recordingRetention.title")}
        description={t("settings.debug.recordingRetention.description")}
        descriptionMode={descriptionMode}
        grouped={grouped}
        layout={pending ? "stacked" : "horizontal"}
      >
        {sentence ? (
          <InlineConfirm
            message={t(sentence.key, { count: sentence.count })}
            action={t("settings.history.retentionConfirm.action")}
            onCancel={confirm.cancel}
            onConfirm={() => void confirm.confirm()}
          />
        ) : (
          <Dropdown
            options={retentionOptions}
            selectedValue={selectedRetentionPeriod}
            onSelect={handleRetentionPeriodSelect}
            placeholder={t("settings.debug.recordingRetention.placeholder")}
            disabled={isUpdating("recording_retention_period")}
          />
        )}
      </SettingContainer>
    );
  });

RecordingRetentionPeriodSelector.displayName =
  "RecordingRetentionPeriodSelector";
