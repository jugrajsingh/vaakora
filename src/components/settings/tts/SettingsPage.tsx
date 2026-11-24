import type React from "react";
import { useEffect, useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { listen, emit } from "@tauri-apps/api/event";
import {
  commands,
  type ReadHistoryEntry,
  type AppSettings,
  type Selection,
  type TtsModelInfo,
} from "@/bindings";
import { useSettings } from "@/hooks/useSettings";
import { unwrapTts } from "./ModelsPage";
import { previewVoice, selectionEntries } from "./actions";
import {
  createRetentionActions,
  createSettingSetters,
} from "./history/actions";
import { ReadRetentionGroup } from "./history/ReadRetentionGroup";
import { ModelSelect } from "./ModelSelect";
import { ReadHistoryTab } from "./history/ReadHistoryTab";
import { VocabularyTab } from "./vocabulary/VocabularyTab";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Dropdown } from "@/components/ui/Dropdown";
import { SettingContainer } from "@/components/ui/SettingContainer";
import {
  JobModelGroup,
  jobModelState,
} from "@/components/shared/JobModelGroup";
import { SettingsGroup } from "@/components/ui/SettingsGroup";
import { Slider } from "@/components/ui/Slider";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import { groupAnchor, type TabOf } from "@/lib/navigation";

/** Lists the models; a failed listing is reported and never becomes an empty list. */
export async function loadModels(deps: {
  load: () => Promise<TtsModelInfo[]>;
  show: (models: TtsModelInfo[]) => void;
  fail: () => void;
}): Promise<void> {
  try {
    deps.show(await deps.load());
  } catch {
    deps.fail();
  }
}

/** The selection the stored settings describe; absent keys read as the defaults. */
export function persistedSelection(
  settings: AppSettings,
  models: TtsModelInfo[] | undefined,
): Selection {
  const id = settings.tts_model_id ?? "pocket-en";
  const model = models?.find((row) => row.id === id);
  return {
    model_id: id,
    voice: settings.tts_voice?.[id] ?? model?.default_voice ?? "alba",
    speed: settings.tts_speed ?? 1,
    pitch: settings.tts_pitch_semitones ?? 0,
    output_device: settings.tts_output_device ?? null,
    read_code: settings.tts_read_code_blocks ?? false,
    technical: settings.tts_technical_reading ?? true,
    full_paths: settings.tts_full_paths ?? true,
    full_links: settings.tts_full_links ?? false,
    tables: settings.tts_table_style ?? "name_each",
  };
}
export function SettingsPage({
  tab,
  changeRetention,
}: {
  tab: TabOf<"readAloud">;
  changeRetention: () => void;
}) {
  const { t } = useTranslation();
  const {
    settings,
    outputDevices,
    refreshSettings,
    refreshSettingsChecked,
    refreshOutputDevices,
  } = useSettings();
  const [models, setModels] = useState<TtsModelInfo[] | null>(null);
  const [modelsFailed, setModelsFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Selection | null>(null);
  const [readEntries, setReadEntries] = useState<ReadHistoryEntry[] | null>(
    null,
  );
  useEffect(() => {
    let alive = true;
    void loadModels({
      load: async () => unwrapTts(await commands.getTtsModels()),
      show: (value) => {
        if (alive) setModels(value);
      },
      fail: () => {
        if (alive) setModelsFailed(true);
      },
    });
    void refreshOutputDevices();
    let unlisten: (() => void) | undefined;
    void listen<string>("tts-preview-error", ({ payload }) => {
      if (alive) setError(payload);
    }).then((stop) => {
      if (alive) unlisten = stop;
      else stop();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [refreshOutputDevices]);
  const choose = useMemo(
    () =>
      selectionEntries({
        select: async (value) => {
          unwrapTts(await commands.setTtsSelection(value));
        },
        refresh: refreshSettingsChecked,
        error: setError,
        clearError: () => setError(null),
        display: setDraft,
      }),
    [refreshSettingsChecked],
  );
  const retentionActions = useMemo(
    () =>
      createRetentionActions({
        load: async () => unwrapTts(await commands.getTtsHistory()),
        ...createSettingSetters({
          setLimit: (limit) => commands.setTtsHistoryLimit(limit),
          setRetention: (retention) =>
            commands.setTtsHistoryRetention(retention),
          refresh: refreshSettings,
        }),
        setEntries: setReadEntries,
        setError,
      }),
    [refreshSettings],
  );
  useEffect(() => {
    if (tab === "settings") void retentionActions.load();
  }, [tab, retentionActions]);
  const persisted = useMemo<Selection | null>(
    () => (settings ? persistedSelection(settings, models ?? undefined) : null),
    [settings, models],
  );
  useEffect(() => {
    if (persisted) choose.sync(persisted);
  }, [choose, persisted]);
  if (!persisted) return null;
  const selected = draft ?? persisted;
  const change = (patch: Partial<Selection>) =>
    void choose.edit(patch, selected);
  return (
    <div className="space-y-6 w-full max-w-3xl min-w-0 mx-auto">
      {tab === "vocabulary" ? (
        <VocabularyTab models={models ?? []} />
      ) : tab === "history" ? (
        <ReadHistoryTab
          models={models ?? []}
          changeRetention={changeRetention}
        />
      ) : (
        <SettingsControls
          selected={selected}
          models={models}
          modelsFailed={modelsFailed}
          outputDevices={outputDevices}
          error={error}
          change={change}
          openModels={() => void emit("open-tts-models")}
          preview={() =>
            void previewVoice(t, selected.voice, (voice, text) =>
              commands.previewTtsVoice(voice, text),
            )
              .then(unwrapTts)
              .catch(() => setError("tts.errors.generic"))
          }
          rememberedVoices={settings?.tts_voice}
          retention={{
            entries: readEntries,
            refresh: retentionActions.load,
            changeLimit: (limit) => void retentionActions.changeLimit(limit),
            changeRetention: (retention) =>
              void retentionActions.changeRetention(retention),
          }}
        />
      )}
    </div>
  );
}

export function SettingsControls({
  selected,
  models,
  modelsFailed,
  outputDevices,
  error,
  change,
  preview,
  openModels,
  rememberedVoices,
  retention,
}: {
  selected: Selection;
  models: readonly TtsModelInfo[] | null;
  modelsFailed: boolean;
  outputDevices: readonly { name: string; index: string | number }[];
  error: string | null;
  change: (patch: Partial<Selection>) => void;
  preview: () => void;
  openModels: () => void;
  rememberedVoices?: Partial<Record<string, string>>;
  retention: React.ComponentProps<typeof ReadRetentionGroup>;
}) {
  const { t } = useTranslation();
  const model = models?.find((row) => row.id === selected.model_id);
  return (
    <section className="max-w-3xl w-full mx-auto space-y-6">
      {error && (
        <div role="alert">
          <Alert>{t(error)}</Alert>
        </div>
      )}
      <JobModelGroup
        role="readAloud"
        state={
          modelsFailed
            ? "failed"
            : jobModelState(
                models === null
                  ? null
                  : models.filter((row) => row.downloaded).length,
              )
        }
        manage={openModels}
        select={
          <ModelSelect
            models={models ?? []}
            value={selected.model_id}
            change={(next) =>
              change({
                model_id: next.id,
                voice: rememberedVoices?.[next.id] ?? next.default_voice,
              })
            }
          />
        }
      >
        <SettingContainer
          title={t("tts.voice")}
          description={t("tts.help.voice")}
          grouped
          layout="stacked"
        >
          <div className="flex items-center gap-2">
            <Dropdown
              options={(model?.voices ?? []).map((voice) => ({
                value: voice,
                label: voice,
              }))}
              selectedValue={selected.voice}
              placeholder={selected.voice}
              onSelect={(voice) => change({ voice })}
              disabled={!model?.voices.length}
            />
            <Button
              variant="secondary"
              onClick={preview}
              disabled={!model?.downloaded}
            >
              {t("tts.preview")}
            </Button>
          </div>
        </SettingContainer>
      </JobModelGroup>
      <SettingsGroup title={t("settings.groups.playback")}>
        <Slider
          label={t("tts.speedLabel")}
          description={t("tts.help.speed")}
          grouped
          min={0.5}
          max={2}
          step={0.1}
          value={selected.speed}
          formatValue={(value) => `${value.toFixed(1)}x`}
          onChange={(speed) => change({ speed })}
        />
        <Slider
          label={t("tts.pitchLabel")}
          description={t("tts.help.pitch")}
          grouped
          min={-6}
          max={6}
          step={1}
          value={selected.pitch}
          formatValue={(value) => value.toFixed(0)}
          onChange={(pitch) => change({ pitch })}
        />
        <SettingContainer
          title={t("tts.output")}
          description={t("tts.help.output")}
          grouped
          layout="stacked"
        >
          <Dropdown
            options={[
              {
                value: "",
                label: t("tts.sameAsHandy"),
              },
              ...outputDevices.map((device) => ({
                value: device.name,
                label: device.name,
              })),
            ]}
            selectedValue={selected.output_device ?? ""}
            onSelect={(value) => change({ output_device: value || null })}
          />
        </SettingContainer>
      </SettingsGroup>
      <SettingsGroup title={t("settings.groups.textHandling")}>
        <ToggleSwitch
          label={t("tts.readCode")}
          description={t("tts.help.readCode")}
          grouped
          checked={selected.read_code}
          onChange={(read_code) => change({ read_code })}
        />
        <ToggleSwitch
          label={t("tts.technicalReading")}
          description={t("tts.help.technicalReading")}
          grouped
          checked={selected.technical ?? false}
          onChange={(technical) => change({ technical })}
        />
        <div className="ps-6">
          <ToggleSwitch
            label={t("tts.fullPaths")}
            description={
              selected.technical
                ? t("tts.help.fullPaths")
                : t("tts.help.technicalOff")
            }
            descriptionMode={selected.technical ? "tooltip" : "inline"}
            grouped
            disabled={!selected.technical}
            checked={selected.full_paths ?? true}
            onChange={(full_paths) => change({ full_paths })}
          />
        </div>
        <div className="ps-6">
          <ToggleSwitch
            label={t("tts.fullLinks")}
            description={
              selected.technical
                ? t("tts.help.fullLinks")
                : t("tts.help.technicalOff")
            }
            descriptionMode={selected.technical ? "tooltip" : "inline"}
            grouped
            disabled={!selected.technical}
            checked={selected.full_links ?? false}
            onChange={(full_links) => change({ full_links })}
          />
        </div>
      </SettingsGroup>
      <div id={groupAnchor("readAloudHistory")}>
        <ReadRetentionGroup {...retention} />
      </div>
    </section>
  );
}
