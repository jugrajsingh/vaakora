import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Play } from "lucide-react";
import type { Device, Result, RunOn, TtsModelInfo } from "@/bindings";
import { Tag } from "@/components/shared/Tag";
import type { RowConfirm } from "@/components/shared/InlineConfirm";
import {
  ManagerRow,
  RoleCells,
  RoleHeads,
} from "@/components/shared/modelTable/ManagerRow";
import {
  ManagerTable,
  RoleLegend,
  type ManagerSection,
} from "@/components/shared/modelTable/ManagerTable";
import {
  applyChips,
  matchesQuery,
  readAloudModel,
  type Chip,
  type ManagerModel,
} from "@/components/shared/modelTable/roles";
import {
  deleteMessage,
  type DeleteAsk,
} from "@/components/settings/models/managerRows";
import { languageName } from "@/lib/constants/languages";
import { formatBytes } from "@/lib/utils/format";
import {
  rowActions,
  type DownloadSnapshot,
  type TtsDownloadProgress,
  type TtsRowState,
} from "./actions";
import type { DeviceRating, ModelRating } from "./presentation";
import { RunOnControl } from "./RunOnControl";
import { TokenField } from "./TokenField";
import { groupModels, type TokenActions, type TokenEntryState } from "./token";

export function completeRating(model: TtsModelInfo): ModelRating {
  const { cpu, gpu, npu } = model.rating.devices;
  if (!cpu || !gpu || !npu) throw new Error("tts.errors.invalidRatings");
  const adapt = (row: typeof cpu): DeviceRating => {
    const placement: Record<string, Device> = {};
    for (const [name, device] of Object.entries(row.placement)) {
      if (device !== undefined) placement[name] = device;
    }
    return { ...row, placement };
  };
  return {
    quality: model.rating.quality,
    devices: { cpu: adapt(cpu), gpu: adapt(gpu), npu: adapt(npu) },
  };
}

/** A delete question as asked: the model, whether it was the selected one, and its words. */
export type AskedDelete = DeleteAsk & { message: string };

/** The delete question for a model: what goes, what it frees, the consequence when it is selected, what is kept. */
export function askedFor(
  t: TFunction,
  info: Pick<TtsModelInfo, "id" | "display_name" | "size_bytes">,
  selected: boolean,
  language: string,
): AskedDelete {
  return {
    id: info.id,
    selected,
    message: deleteMessage(
      t,
      {
        name: info.display_name,
        size: formatBytes(info.size_bytes),
        selected,
        role: "readAloud",
      },
      language,
    ),
  };
}

/** What the delete question checks against: the rendered models, downloads and delete. */
export interface DeleteView {
  asked: DeleteAsk | null;
  models: readonly TtsModelInfo[];
  active: readonly string[];
  deletingId: string | null;
}

const NO_CALLBACKS = { use: () => {}, download: () => {}, delete: () => {} };

/** The row state `rowActions` reads: the selected model, the download in flight and the delete. */
export function rowState(
  view: Pick<DeleteView, "models" | "active" | "deletingId">,
  id: string,
): TtsRowState {
  return {
    selectedId: view.models.find((model) => model.active)?.id ?? "",
    downloadId: view.active.includes(id) ? id : (view.active[0] ?? null),
    deletingId: view.deletingId,
  };
}

/** The question stays only while its model can be deleted under `rowActions` and is as selected as when asked. */
export function presentFor(view: () => DeleteView): (id: string) => boolean {
  return (id) => {
    const now = view();
    const model = now.models.find((row) => row.id === id);
    if (now.asked === null || now.asked.id !== id || model === undefined)
      return false;
    const row = rowActions(model, rowState(now, id), NO_CALLBACKS);
    return row.canDelete && row.isActive === now.asked.selected;
  };
}

/** Confirm: delete the asked model only when the question still holds. */
export function applyFor(
  view: () => DeleteView,
  remove: (id: string) => void,
): (id: string) => void {
  const present = presentFor(view);
  return (id) => {
    if (present(id)) remove(id);
  };
}

/** Awaits a model command; on failure shows its error and refreshes nothing, so the selection stays. */
export async function runOutcome(
  job: Promise<Result<unknown, string>>,
  deps: {
    refresh: () => Promise<void>;
    refreshSettings: () => Promise<void>;
    show: (error: string | null) => void;
  },
): Promise<boolean> {
  try {
    const result = await job;
    if (result.status === "error") throw new Error(result.error);
    await deps.refresh();
    await deps.refreshSettings();
    deps.show(null);
    return true;
  } catch (reason) {
    deps.show(
      reason instanceof Error && reason.message.startsWith("tts.errors.")
        ? reason.message
        : "tts.errors.generic",
    );
    return false;
  }
}

/** A usable GPU or NPU on this computer that the model supports. */
export function runsAccelerated(
  model: Pick<TtsModelInfo, "rating" | "npu_driver_too_old">,
  available: readonly Device[],
): boolean {
  return (["gpu", "npu"] as const).some(
    (device) =>
      available.includes(device) &&
      !(device === "npu" && model.npu_driver_too_old) &&
      model.rating.devices[device]?.supported === true,
  );
}

/** The machine every figure was measured on when there is one, else null. */
export function legendMachine(models: readonly TtsModelInfo[]): string | null {
  const machines = new Set(
    models.flatMap((model) => (model.measured ? [model.measured.machine] : [])),
  );
  return machines.size === 1 ? ([...machines][0] ?? null) : null;
}

const percentOf = (progress: TtsDownloadProgress | undefined): number | null =>
  progress && progress.total_bytes > 0
    ? Math.min(100, (progress.downloaded_bytes / progress.total_bytes) * 100)
    : null;

const VOICE_CLASS =
  "inline-flex h-[24px] cursor-pointer items-center gap-[5px] rounded-full border border-line-strong px-[8px] text-tag font-semibold text-ink-2 hover:bg-wash hover:text-text focus:outline-none focus-visible:ring-1 focus-visible:ring-logo-primary";

/** The voices: the count, then each name; with `preview`, each name is a Listen button. */
export function VoiceList({
  voices,
  preview,
  t,
}: {
  voices: readonly string[];
  preview?: (voice: string) => Promise<void>;
  t: TFunction;
}): React.JSX.Element {
  return (
    <span className="flex min-w-0 flex-col gap-[6px]">
      <span>{t("models.voiceCount", { count: voices.length })}</span>
      <span className="flex flex-wrap gap-[6px]">
        {voices.map((voice) =>
          preview ? (
            <button
              key={voice}
              type="button"
              aria-label={t("models.listen", { voice })}
              title={t("models.listen", { voice })}
              onClick={() => void preview(voice)}
              className={VOICE_CLASS}
            >
              <Play className="size-[10px]" aria-hidden="true" />
              {voice}
            </button>
          ) : (
            <Tag key={voice}>{voice}</Tag>
          ),
        )}
      </span>
    </span>
  );
}

export interface ReadAloudRowsProps {
  models: readonly TtsModelInfo[];
  available: readonly Device[];
  downloads: DownloadSnapshot;
  deletingId: string | null;
  /** Whether a token is set for this run; the field in a gated model's details shows it. */
  tokenSet: boolean;
  tokenState: TokenEntryState;
  tokenActions: TokenActions;
  deletion: RowConfirm<string>;
  asked: AskedDelete | null;
  openId: string | null;
  onOpenChange: (id: string | null) => void;
  act: {
    use: (id: string) => void;
    download: (id: string) => void;
    cancel: (id: string) => void;
    runOn: (id: string, value: RunOn) => void;
    preview: (voice: string) => Promise<void>;
    ask: (asked: AskedDelete) => void;
  };
}

/** Models, Read aloud: the manager table over the text-to-speech models, with plain props. */
export function ReadAloudRows({
  models,
  available,
  downloads,
  deletingId,
  tokenSet,
  tokenState,
  tokenActions,
  deletion,
  asked,
  openId,
  onOpenChange,
  act,
}: ReadAloudRowsProps): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState("");
  const [pressed, setPressed] = useState<ReadonlySet<string>>(new Set());
  const infoById = new Map(models.map((info) => [info.id, info]));
  const groups = groupModels(models, downloads.active);
  const modelOf = (info: TtsModelInfo): ManagerModel => {
    const failure = downloads.errors[info.id];
    return readAloudModel(info, {
      available,
      downloading: downloads.active.includes(info.id) ? info.id : null,
      percent: percentOf(downloads.progress[info.id]),
      error: failure === undefined ? null : t(failure),
      t,
    });
  };
  const chips: Chip[] = [
    {
      key: "accelerated",
      label: t("models.chips.accelerated"),
      test: (m) => {
        const info = infoById.get(m.id);
        return info !== undefined && runsAccelerated(info, available);
      },
    },
  ];
  const toggleChip = (key: string) =>
    setPressed((on) => {
      const next = new Set(on);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const keep = (list: readonly TtsModelInfo[]) =>
    applyChips(list.map(modelOf), pressed, chips).filter((m) =>
      matchesQuery(m, query, { t, language: i18n.language, languageName }),
    );
  const sections: ManagerSection[] = [
    {
      key: "downloaded",
      label: t("settings.models.sections.yours"),
      rows: keep(groups.downloaded),
    },
    {
      key: "available",
      label: t("models.sections.available"),
      rows: keep(groups.available),
    },
  ].filter((section) => section.rows.length > 0);

  const renderRow = (m: ManagerModel, open: boolean, toggle: () => void) => {
    const info = infoById.get(m.id);
    if (info === undefined) return null;
    const state = rowState(
      { models, active: downloads.active, deletingId },
      info.id,
    );
    const selected = info.downloaded && info.id === state.selectedId;
    const ask = () => act.ask(askedFor(t, info, selected, i18n.language));
    const row = rowActions(
      info,
      state,
      { use: act.use, download: act.download, delete: ask },
      tokenSet,
    );
    const name = info.display_name;
    const mark = ((): React.ComponentProps<typeof ManagerRow>["mark"] => {
      switch (m.state.kind) {
        case "selected":
          return null;
        case "downloading":
          return {
            label: t("models.mark.cancel", { name }),
            press: () => act.cancel(info.id),
          };
        case "downloaded":
          return {
            label: t("models.mark.select", { name }),
            disabled: row.canUse ? undefined : t("models.busy"),
            press: row.use,
          };
        case "remote":
        case "failed":
          return {
            label: t("models.mark.download", { name }),
            disabled: row.canDownload
              ? undefined
              : info.needs_token && !tokenSet
                ? t("models.mark.needsToken")
                : t("models.busy"),
            press: row.download,
          };
      }
    })();
    const invalidNpu =
      info.npu_driver_too_old ||
      (info.preparation.state === "failed" &&
        info.preparation.device === "npu");
    const needsToken = info.needs_token && (!info.downloaded || tokenSet);
    const question =
      deletion.asking === info.id && asked?.id === info.id
        ? {
            message: asked.message,
            confirm: deletion.confirm,
            cancel: deletion.cancel,
          }
        : undefined;
    return (
      <ManagerRow
        model={m}
        open={open}
        toggle={toggle}
        cells={<RoleCells model={m} />}
        mark={mark}
        remove={
          row.canDelete
            ? { label: t("models.remove", { name }), press: row.delete }
            : undefined
        }
        question={question}
        runOn={
          info.downloaded ? (
            <RunOnControl
              invalidNpu={invalidNpu}
              downloaded={info.downloaded}
              available={available}
              rating={completeRating(info)}
              value={info.run_on}
              preparation={info.preparation}
              change={(value) => act.runOn(info.id, value)}
            />
          ) : undefined
        }
        voices={
          <VoiceList
            voices={info.voices}
            preview={m.state.kind === "selected" ? act.preview : undefined}
            t={t}
          />
        }
        detail={
          needsToken && (
            <TokenField
              state={tokenState}
              actions={tokenActions}
              present={tokenSet}
            />
          )
        }
        onKeyDown={(event) => {
          if (event.key === "Escape" && question !== undefined) {
            event.preventDefault();
            event.stopPropagation();
            deletion.cancel();
            return;
          }
          if (event.target !== event.currentTarget) return;
          if (
            (event.key === "Delete" || event.key === "Backspace") &&
            row.canDelete
          ) {
            event.preventDefault();
            row.delete();
          }
        }}
      />
    );
  };

  return (
    <ManagerTable
      role="readAloud"
      sections={sections}
      query={query}
      setQuery={setQuery}
      chips={chips}
      pressed={pressed}
      toggleChip={toggleChip}
      heads={<RoleHeads />}
      legend={
        <RoleLegend role="readAloud" measuredOn={legendMachine(models)} />
      }
      openId={openId}
      onOpenChange={onOpenChange}
      renderRow={renderRow}
    />
  );
}
