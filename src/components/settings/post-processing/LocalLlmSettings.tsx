import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  commands,
  type LocalLlmContext,
  type LocalLlmModelInfo,
  type LocalLlmStructure,
  type LocalLlmStyling,
} from "@/bindings";
import { Dropdown, SettingContainer } from "@/components/ui";
import { Alert } from "../../ui/Alert";
import { useSettings } from "../../../hooks/useSettings";
import { useLocalLlmStatus } from "../../../hooks/useLocalLlmStatus";
import { jobModelState, type JobModelState } from "../../shared/JobModelGroup";
import { LocalLlmAttribution } from "./LocalLlmAttribution";
import {
  createLocalLlmActions,
  createModelsLoader,
  whileAlive,
} from "./localLlmActions";
import { isLocalLlmBusy } from "./localLlmRowActions";
import { promptControls } from "@/lib/utils/localLlmPresentation";
import {
  initializeLocalLlmDownloadProgress,
  useLocalLlmDownloadStore,
} from "@/stores/localLlmDownloadStore";

export const LOCAL_LLM_PROVIDER_ID = "local_llm";

const STYLINGS: LocalLlmStyling[] = [
  "casual",
  "semi_casual",
  "semi_formal",
  "formal",
];
const STRUCTURES: LocalLlmStructure[] = ["prose", "lists"];
const CONTEXTS: LocalLlmContext[] = ["general", "email"];

export type ModelsLoadState = "loading" | "loaded" | "failed";

/** The Job Model group's state for the cleanup models: loading before the first read, empty without a downloaded model. */
export function cleanupJobState(
  load: ModelsLoadState,
  models: readonly LocalLlmModelInfo[],
): JobModelState {
  if (load === "failed") return "failed";
  return jobModelState(
    load === "loading" ? null : models.filter((m) => m.downloaded).length,
  );
}

/** Whether the component is still mounted. */
function useAlive(): () => boolean {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return useCallback(() => alive.current, []);
}

/** Registry entries with their download state; `reload` re-reads them. */
export const useLocalLlmModels = () => {
  const [models, setModels] = useState<LocalLlmModelInfo[]>([]);
  const [loadState, setLoadState] = useState<ModelsLoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const alive = useAlive();
  const version = useLocalLlmDownloadStore((state) => state.version);
  const reloadChecked = useCallback(
    () =>
      createModelsLoader({
        fetch: () => commands.getLocalLlmModels(),
        set: (next) => {
          setModels(next);
          setLoadState("loaded");
        },
        alive,
      })(),
    [alive],
  );
  const reload = useCallback(async () => {
    await reloadChecked().catch((error: unknown) => {
      console.error("Failed to load local LLM models:", error);
      whileAlive(alive, (reason: string) => {
        setLoadError(reason);
        setLoadState((state) => (state === "loaded" ? state : "failed"));
      })(error instanceof Error ? error.message : String(error));
    });
  }, [reloadChecked, alive]);
  useEffect(() => {
    void initializeLocalLlmDownloadProgress().catch((error: unknown) => {
      console.error("Failed to listen for local LLM download progress:", error);
    });
  }, []);
  useEffect(() => {
    void reload();
  }, [reload, version]);
  return { models, loadState, loadError, reload, reloadChecked };
};

/**
 * The select, download and delete actions of the cleanup models, with the delete-busy id from the
 * download store (one source for every page) and this page's error. Its error is not set after unmount.
 */
export function useLocalLlmActions(reloadChecked: () => Promise<void>): {
  actions: ReturnType<typeof createLocalLlmActions>;
  deletingId: string | null;
  error: string | null;
} {
  const { refreshSettingsChecked } = useSettings();
  const deletingId = useLocalLlmDownloadStore((state) => state.deletingId);
  const [error, setError] = useState<string | null>(null);
  const alive = useAlive();
  const store = useLocalLlmDownloadStore;
  const actions = createLocalLlmActions({
    isBusy: () =>
      isLocalLlmBusy({
        downloadId: store.getState().modelId,
        deletingId: store.getState().deletingId,
      }),
    clearError: store.getState().clearError,
    setError: whileAlive(alive, setError),
    setDeletingId: store.getState().setDeletingId,
    setLocalLlmModel: commands.setLocalLlmModel,
    deleteLocalLlmModel: commands.deleteLocalLlmModel,
    downloadLocalLlmModel: store.getState().download,
    refreshSettingsChecked,
    reloadChecked,
    modelsChanged: store.getState().modelsChanged,
  });
  return { actions, deletingId, error };
}

/** The cleanup model's status, S1 controls, errors and attribution; the model list is in Models, Cleanup. */
export const LocalLlmSettings: React.FC<{
  models: readonly LocalLlmModelInfo[];
  /** The error of the page's last select, download or delete. */
  actionError: string | null;
}> = ({ models, actionError }) => {
  const { t } = useTranslation();
  const { getSetting, updateSetting } = useSettings();
  const { status, error: statusError } = useLocalLlmStatus();
  const downloadError = useLocalLlmDownloadStore((state) => state.error);

  const selectedId = getSetting("local_llm_model_id") ?? null;
  const selected = models.find((m) => m.id === selectedId) ?? null;
  const error = downloadError ?? actionError ?? statusError;
  const controls = promptControls(
    getSetting("post_process_provider_id"),
    selected,
    getSetting("post_process_prompts") ?? [],
    getSetting("post_process_selected_prompt_id") ?? null,
  );

  const statusLabel = (() => {
    if (status?.state === "ready")
      return t("settings.postProcessing.localLlm.status.ready");
    if (status?.state === "starting")
      return t("settings.postProcessing.localLlm.status.loading");
    if (status?.error)
      return t("settings.postProcessing.localLlm.status.error", {
        reason: status.error,
      });
    return t("settings.postProcessing.localLlm.status.notLoaded");
  })();

  return (
    <>
      <SettingContainer
        title={t("settings.postProcessing.localLlm.status.title")}
        description={t("settings.postProcessing.localLlm.status.description")}
        descriptionMode="tooltip"
        layout="horizontal"
        grouped={true}
      >
        <span className="text-sm">{statusLabel}</span>
      </SettingContainer>

      {error && (
        <Alert variant="error" contained>
          {t("settings.postProcessing.localLlm.status.error", {
            reason: error,
          })}
        </Alert>
      )}

      {controls.missingPrompt && (
        <Alert variant="error" contained>
          {t("settings.postProcessing.localLlm.promptRequired")}
        </Alert>
      )}

      {controls.showS1Controls && (
        <>
          <SettingContainer
            title={t("settings.postProcessing.localLlm.styling.title")}
            description={t(
              "settings.postProcessing.localLlm.styling.description",
            )}
            descriptionMode="tooltip"
            layout="horizontal"
            grouped={true}
          >
            <Dropdown
              options={STYLINGS.map((value) => ({
                value,
                label: t(
                  `settings.postProcessing.localLlm.styling.options.${value}`,
                ),
              }))}
              selectedValue={getSetting("local_llm_styling") ?? "semi_formal"}
              onSelect={(value) =>
                void updateSetting(
                  "local_llm_styling",
                  value as LocalLlmStyling,
                )
              }
            />
          </SettingContainer>
          <SettingContainer
            title={t("settings.postProcessing.localLlm.structure.title")}
            description={t(
              "settings.postProcessing.localLlm.structure.description",
            )}
            descriptionMode="tooltip"
            layout="horizontal"
            grouped={true}
          >
            <Dropdown
              options={STRUCTURES.map((value) => ({
                value,
                label: t(
                  `settings.postProcessing.localLlm.structure.options.${value}`,
                ),
              }))}
              selectedValue={getSetting("local_llm_structure") ?? "prose"}
              onSelect={(value) =>
                void updateSetting(
                  "local_llm_structure",
                  value as LocalLlmStructure,
                )
              }
            />
          </SettingContainer>
          <SettingContainer
            title={t("settings.postProcessing.localLlm.context.title")}
            description={t(
              "settings.postProcessing.localLlm.context.description",
            )}
            descriptionMode="tooltip"
            layout="horizontal"
            grouped={true}
          >
            <Dropdown
              options={CONTEXTS.map((value) => ({
                value,
                label: t(
                  `settings.postProcessing.localLlm.context.options.${value}`,
                ),
              }))}
              selectedValue={getSetting("local_llm_context") ?? "general"}
              onSelect={(value) =>
                void updateSetting(
                  "local_llm_context",
                  value as LocalLlmContext,
                )
              }
            />
          </SettingContainer>
        </>
      )}

      {selected && <LocalLlmAttribution model={selected} />}
    </>
  );
};
