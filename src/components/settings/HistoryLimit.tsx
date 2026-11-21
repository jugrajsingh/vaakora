import React, { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettings } from "../../hooks/useSettings";
import { createLimitField, MAX_LIMIT } from "../../lib/utils/limitField";
import {
  currentKeep,
  dictationChangeDeletes,
  dictationLimitRow,
  routeChange,
  type DictationKeep,
} from "../../lib/utils/retention";
import {
  CONTROL_TARGETS,
  createPendingConfirm,
  InlineConfirm,
  useRefocusOnClose,
} from "../shared/InlineConfirm";
import { Input } from "../ui/Input";
import { SettingContainer } from "../ui/SettingContainer";

interface HistoryLimitProps {
  grouped?: boolean;
}

export const HistoryLimit: React.FC<HistoryLimitProps> = ({
  grouped = false,
}) => {
  const { t } = useTranslation();
  const { getSetting, updateSetting, isUpdating } = useSettings();

  const historyLimit = getSetting("history_limit") ?? 5;

  const [draft, setDraft] = useState<string | null>(null);
  const [pending, setPending] = useState<DictationKeep | null>(null);
  const keep = currentKeep(getSetting);
  const latest = useRef({ keep, updateSetting });
  latest.current = { keep, updateSetting };
  const { field, confirm } = useMemo(() => {
    const apply = (to: DictationKeep) =>
      latest.current.updateSetting("history_limit", to.limit);
    const confirm = createPendingConfirm<DictationKeep>({
      show: setPending,
      apply,
    });
    const field = createLimitField({
      current: () => latest.current.keep.limit,
      update: (limit) => {
        const from = latest.current.keep;
        routeChange(
          { ...from, limit },
          {
            deletes: (to) => dictationChangeDeletes(from, to),
            ask: confirm.ask,
            apply,
          },
        );
      },
      show: setDraft,
    });
    return { field, confirm };
  }, []);

  const rowsRef = useRefocusOnClose(pending ? "limit" : null, CONTROL_TARGETS);
  const limitRow = dictationLimitRow(keep.period);
  return (
    <SettingContainer
      title={t("settings.dictationHistory.limitTitle")}
      description={
        limitRow.reasonKey
          ? t(limitRow.reasonKey)
          : t("settings.dictationHistory.limitHelp")
      }
      descriptionMode={limitRow.disabled ? "inline" : "tooltip"}
      disabled={limitRow.disabled}
      grouped={grouped}
      layout={pending ? "stacked" : "horizontal"}
    >
      <div ref={rowsRef} data-confirm-row="limit">
        {pending ? (
          <InlineConfirm
            message={t("settings.history.retentionConfirm.preserveLimit", {
              count: pending.limit,
            })}
            action={t("settings.history.retentionConfirm.action")}
            onCancel={confirm.cancel}
            onConfirm={() => void confirm.confirm()}
          />
        ) : (
          <div className="flex items-center space-x-2">
            <Input
              type="number"
              min="0"
              max={MAX_LIMIT}
              value={draft ?? historyLimit}
              onChange={(event) => field.type(event.target.value)}
              onBlur={field.commit}
              onKeyDown={(event) => {
                // Enter's keypress would otherwise click the Cancel button the confirmation focuses.
                if (event.key === "Enter") event.preventDefault();
                field.key(event.key);
              }}
              disabled={limitRow.disabled || isUpdating("history_limit")}
              className="w-20"
            />
            <span className="text-sm text-text">
              {t("settings.dictationHistory.limitUnit")}
            </span>
          </div>
        )}
      </div>
    </SettingContainer>
  );
};
