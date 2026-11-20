import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReadHistoryEntry, ReadHistoryRetention } from "@/bindings";
import {
  createPendingConfirm,
  InlineConfirm,
} from "@/components/shared/InlineConfirm";
import { Dropdown } from "@/components/ui/Dropdown";
import { Input } from "@/components/ui/Input";
import { SettingContainer } from "@/components/ui/SettingContainer";
import { SettingsGroup } from "@/components/ui/SettingsGroup";
import { useSettings } from "@/hooks/useSettings";
import { createLimitField, MAX_LIMIT } from "@/lib/utils/limitField";
import {
  DEFAULT_READ_LIMIT,
  readLimitRow,
  readRecount,
  readsRemovedBy,
  routeChange,
} from "@/lib/utils/retention";
import { retentionOptions } from "./presentation";

/** A limit or retention change, with how many stored reads it deletes now and the newest read counted. */
type ReadChange = {
  control: "limit" | "retention";
  count: number;
  newest: number | null;
  next: { limit: number; retention: ReadHistoryRetention };
  apply: () => void;
};

/**
 * The read history settings: how many reads to keep and when older ones go. The limit and
 * retention wait for `entries`; a change reads the stored list again through `refresh` (`null`
 * when it fails, which drops the change) and asks first when it deletes stored reads. Confirming
 * reads the list once more: a changed count or newest read asks again with the new number.
 */
export function ReadRetentionGroup({
  entries,
  refresh,
  changeLimit,
  changeRetention,
}: {
  entries: readonly ReadHistoryEntry[] | null;
  refresh: () => Promise<readonly ReadHistoryEntry[] | null>;
  changeLimit: (limit: number) => void;
  changeRetention: (retention: ReadHistoryRetention) => void;
}) {
  const { t } = useTranslation();
  const { getSetting, isUpdating } = useSettings();
  const limit = getSetting("tts_history_limit") ?? DEFAULT_READ_LIMIT;
  const retention = getSetting("tts_history_retention") ?? "keep_limit";
  const [draft, setDraft] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadChange | null>(null);
  const latest = useRef({ refresh, limit, retention, changeLimit });
  latest.current = { refresh, limit, retention, changeLimit };
  const { field, confirm, route } = useMemo(() => {
    const confirm = createPendingConfirm<ReadChange>({
      show: setPending,
      apply: (change) => change.apply(),
      recount: async (change) =>
        readRecount(
          change,
          await latest.current.refresh(),
          Math.floor(Date.now() / 1000),
        ),
    });
    const route = async (
      next: { limit: number; retention: ReadHistoryRetention },
      control: ReadChange["control"],
      apply: () => void,
    ) => {
      const stored = await latest.current.refresh();
      if (stored === null) return;
      const count = readsRemovedBy(stored, next, Math.floor(Date.now() / 1000));
      routeChange(
        { control, count, newest: stored[0]?.id ?? null, next, apply },
        {
          deletes: (change) => change.count > 0,
          ask: confirm.ask,
          apply: (change) => change.apply(),
        },
      );
    };
    const field = createLimitField({
      current: () => latest.current.limit,
      update: (value) =>
        void route(
          { limit: value, retention: latest.current.retention },
          "limit",
          () => latest.current.changeLimit(value),
        ),
      show: setDraft,
    });
    return { field, confirm, route };
  }, []);
  useEffect(() => confirm.cancel, [confirm]);
  const waiting = entries === null;
  const limitRow = readLimitRow(retention);
  const confirmation = (control: ReadChange["control"]) =>
    pending?.control === control ? (
      <InlineConfirm
        key={`${pending.count}:${pending.newest}`}
        message={t("tts.history.retentionConfirm.message", {
          count: pending.count,
        })}
        action={t("tts.history.retentionConfirm.action")}
        onCancel={confirm.cancel}
        onConfirm={() => void confirm.confirm()}
      />
    ) : null;
  return (
    <SettingsGroup title={t("settings.groups.history")}>
      <SettingContainer
        title={t("settings.readAloudHistory.keepTitle")}
        description={t("settings.readAloudHistory.keepHelp")}
        descriptionMode="inline"
        grouped
        layout={pending?.control === "retention" ? "stacked" : "horizontal"}
      >
        {confirmation("retention") ?? (
          <Dropdown
            options={retentionOptions(t, Number(limit))}
            selectedValue={retention}
            onSelect={(value) => {
              const next = value as ReadHistoryRetention;
              void route({ limit, retention: next }, "retention", () =>
                changeRetention(next),
              );
            }}
            disabled={waiting || isUpdating("tts_history_retention")}
          />
        )}
      </SettingContainer>
      <SettingContainer
        title={t("settings.readAloudHistory.limitTitle")}
        description={
          limitRow.reasonKey
            ? t(limitRow.reasonKey)
            : t("settings.readAloudHistory.limitHelp")
        }
        descriptionMode={limitRow.disabled ? "inline" : "tooltip"}
        disabled={limitRow.disabled}
        grouped
        layout={pending?.control === "limit" ? "stacked" : "horizontal"}
      >
        {confirmation("limit") ?? (
          <div className="flex items-center space-x-2">
            <Input
              type="number"
              min="0"
              max={MAX_LIMIT}
              value={draft ?? limit}
              onChange={(event) => field.type(event.target.value)}
              onBlur={field.commit}
              onKeyDown={(event) => {
                // Enter's keypress would otherwise click the Cancel button the confirmation focuses.
                if (event.key === "Enter") event.preventDefault();
                field.key(event.key);
              }}
              disabled={
                limitRow.disabled || waiting || isUpdating("tts_history_limit")
              }
              className="w-20"
            />
            <span className="text-sm text-text">
              {t("settings.readAloudHistory.limitUnit")}
            </span>
          </div>
        )}
      </SettingContainer>
    </SettingsGroup>
  );
}
