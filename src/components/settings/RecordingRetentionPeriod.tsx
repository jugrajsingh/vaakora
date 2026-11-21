import React, { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dropdown } from "../ui/Dropdown";
import { SettingContainer } from "../ui/SettingContainer";
import { useSettings } from "../../hooks/useSettings";
import { RecordingRetentionPeriod } from "@/bindings";
import {
  AUTO_DELETE_OPTIONS,
  autoDeleteConfirm,
  currentKeep,
  dictationChangeDeletes,
  routeChange,
  type DictationKeep,
} from "../../lib/utils/retention";
import {
  CONTROL_TARGETS,
  createPendingConfirm,
  InlineConfirm,
  useRefocusOnClose,
} from "../shared/InlineConfirm";

interface RecordingRetentionPeriodProps {
  grouped?: boolean;
}

export const RecordingRetentionPeriodSelector: React.FC<RecordingRetentionPeriodProps> =
  React.memo(({ grouped = false }) => {
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

    const rowsRef = useRefocusOnClose(
      sentence ? "period" : null,
      CONTROL_TARGETS,
    );
    const retentionOptions = AUTO_DELETE_OPTIONS.map(({ value, key }) => ({
      value,
      label: t(key, { count: Number(historyLimit) }),
    }));

    return (
      <SettingContainer
        title={t("settings.dictationHistory.autoDeleteTitle")}
        description={t("settings.dictationHistory.autoDeleteHelp")}
        descriptionMode="inline"
        grouped={grouped}
        layout={pending ? "stacked" : "horizontal"}
      >
        <div ref={rowsRef} data-confirm-row="period">
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
        </div>
      </SettingContainer>
    );
  });

RecordingRetentionPeriodSelector.displayName =
  "RecordingRetentionPeriodSelector";
