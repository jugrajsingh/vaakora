import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReadHistoryEntry, ReadHistoryRetention } from "@/bindings";
import {
  createPendingConfirm,
  InlineConfirm,
} from "@/components/shared/InlineConfirm";
import { Button } from "@/components/ui/Button";
import { Dropdown } from "@/components/ui/Dropdown";
import { Input } from "@/components/ui/Input";
import { SettingContainer } from "@/components/ui/SettingContainer";
import { SettingsGroup } from "@/components/ui/SettingsGroup";
import { useSettings } from "@/hooks/useSettings";
import { createLimitField, MAX_LIMIT } from "@/lib/utils/limitField";
import { readsRemovedBy, routeChange } from "@/lib/utils/retention";
import { retentionOptions } from "./presentation";

const DEFAULT_LIMIT = 5;

/** A limit or retention change, with how many stored reads it deletes now. */
type ReadChange = {
  control: "limit" | "retention";
  count: number;
  apply: () => void;
};

/**
 * The history settings: how many reads to keep, when older ones go, and clearing them all. The
 * limit and retention wait for `entries`; a change reads the stored list again through `refresh`
 * (`null` when it fails, which drops the change) and asks first when it deletes stored reads.
 */
export function HistorySettingsRow({
  entries,
  refresh,
  clearing,
  canClear,
  clear,
  changeLimit,
  changeRetention,
}: {
  entries: readonly ReadHistoryEntry[] | null;
  refresh: () => Promise<readonly ReadHistoryEntry[] | null>;
  clearing: boolean;
  canClear: boolean;
  clear: () => void;
  changeLimit: (limit: number) => void;
  changeRetention: (retention: ReadHistoryRetention) => void;
}) {
  const { t } = useTranslation();
  const { getSetting, isUpdating } = useSettings();
  const limit = getSetting("tts_history_limit") ?? DEFAULT_LIMIT;
  const retention = getSetting("tts_history_retention") ?? "keep_limit";
  const [draft, setDraft] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadChange | null>(null);
  const latest = useRef({ refresh, limit, retention, changeLimit });
  latest.current = { refresh, limit, retention, changeLimit };
  const { field, confirm, route } = useMemo(() => {
    const confirm = createPendingConfirm<ReadChange>({
      show: setPending,
      apply: (change) => change.apply(),
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
        { control, count, apply },
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
  const waiting = entries === null;
  const confirmation = (control: ReadChange["control"]) =>
    pending?.control === control ? (
      <InlineConfirm
        message={t("tts.history.retentionConfirm.message", {
          count: pending.count,
        })}
        action={t("tts.history.retentionConfirm.action")}
        onCancel={confirm.cancel}
        onConfirm={() => void confirm.confirm()}
      />
    ) : null;
  return (
    <SettingsGroup title={t("tts.history.title")}>
      <SettingContainer
        title={t("tts.history.limit.title")}
        description={t("tts.history.limit.description")}
        descriptionMode="inline"
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
              disabled={waiting || isUpdating("tts_history_limit")}
              className="w-20"
            />
            <span className="text-sm text-text">
              {t("tts.history.limit.entries")}
            </span>
          </div>
        )}
      </SettingContainer>
      <SettingContainer
        title={t("tts.history.retention.title")}
        description={t("tts.history.retention.description")}
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
        title={t("tts.history.clear.title")}
        description={t("tts.history.clear.description")}
        grouped
      >
        <Button
          variant="secondary"
          size="sm"
          disabled={clearing || !canClear}
          onClick={clear}
        >
          {t("tts.history.clear.title")}
        </Button>
      </SettingContainer>
    </SettingsGroup>
  );
}
