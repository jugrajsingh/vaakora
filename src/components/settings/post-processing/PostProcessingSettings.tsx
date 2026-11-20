import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCcw } from "lucide-react";
import {
  commands,
  type LLMPrompt,
  type PostProcessApiFormat,
} from "@/bindings";
import { cleanupHost, promptControls } from "@/lib/utils/localLlmPresentation";

import { Alert } from "../../ui/Alert";
import { Dropdown, SettingContainer, SettingsGroup } from "@/components/ui";
import { Button } from "../../ui/Button";
import { ResetButton } from "../../ui/ResetButton";

import { ProviderSelect } from "../PostProcessingSettingsApi/ProviderSelect";
import { BaseUrlField } from "../PostProcessingSettingsApi/BaseUrlField";
import { ApiKeyField } from "../PostProcessingSettingsApi/ApiKeyField";
import { ModelSelect } from "../PostProcessingSettingsApi/ModelSelect";
import {
  usePostProcessProviderState,
  type PostProcessProviderState,
} from "../PostProcessingSettingsApi/usePostProcessProviderState";
import { useSettings } from "../../../hooks/useSettings";
import {
  LOCAL_LLM_PROVIDER_ID,
  LocalLlmSettings,
  useLocalLlmModels,
} from "./LocalLlmSettings";
import { PromptDialog } from "./PromptDialog";

const PostProcessingProvider: React.FC<{ state: PostProcessProviderState }> = ({
  state,
}) => {
  const { t } = useTranslation();
  return (
    <SettingContainer
      title={t("settings.postProcessing.api.provider.title")}
      description={t("settings.postProcessing.api.provider.description")}
      descriptionMode="tooltip"
      layout="horizontal"
      grouped={true}
    >
      <div className="flex items-center gap-2">
        <ProviderSelect
          options={state.providerOptions}
          value={state.selectedProviderId}
          onChange={state.handleProviderSelect}
        />
      </div>
    </SettingContainer>
  );
};

const PostProcessingSettingsApiComponent: React.FC<{
  state: PostProcessProviderState;
}> = ({ state }) => {
  const { t } = useTranslation();
  const isLocalLlm = state.selectedProvider?.id === LOCAL_LLM_PROVIDER_ID;

  return (
    <>
      {isLocalLlm ? null : state.isAppleProvider ? (
        state.appleIntelligenceUnavailable ? (
          <Alert variant="error" contained>
            {t("settings.postProcessing.api.appleIntelligence.unavailable")}
          </Alert>
        ) : null
      ) : (
        <>
          {state.isCustomProvider && (
            <SettingContainer
              title={t("settings.postProcessing.api.apiFormat.title")}
              description={t(
                "settings.postProcessing.api.apiFormat.description",
              )}
              descriptionMode="tooltip"
              layout="horizontal"
              grouped={true}
            >
              <Dropdown
                options={[
                  {
                    value: "openai",
                    label: t(
                      "settings.postProcessing.api.apiFormat.options.openai",
                    ),
                  },
                  {
                    value: "anthropic",
                    label: t(
                      "settings.postProcessing.api.apiFormat.options.anthropic",
                    ),
                  },
                ]}
                selectedValue={state.apiFormat}
                onSelect={(value) =>
                  state.handleApiFormatChange(value as PostProcessApiFormat)
                }
                disabled={state.isApiFormatUpdating}
              />
            </SettingContainer>
          )}

          {state.selectedProvider?.id === "custom" && (
            <SettingContainer
              title={t("settings.postProcessing.api.baseUrl.title")}
              description={t("settings.postProcessing.api.baseUrl.description")}
              descriptionMode="tooltip"
              layout="horizontal"
              grouped={true}
            >
              <div className="flex items-center gap-2">
                <BaseUrlField
                  value={state.baseUrl}
                  onBlur={state.handleBaseUrlChange}
                  placeholder={
                    state.apiFormat === "anthropic"
                      ? t(
                          "settings.postProcessing.api.baseUrl.placeholderAnthropic",
                        )
                      : t("settings.postProcessing.api.baseUrl.placeholder")
                  }
                  disabled={state.isBaseUrlUpdating}
                  className="min-w-[380px]"
                />
              </div>
            </SettingContainer>
          )}

          <SettingContainer
            title={t("settings.postProcessing.api.apiKey.title")}
            description={t("settings.postProcessing.api.apiKey.description")}
            descriptionMode="tooltip"
            layout="horizontal"
            grouped={true}
          >
            <div className="flex items-center gap-2">
              <ApiKeyField
                value={state.apiKey}
                onBlur={state.handleApiKeyChange}
                placeholder={t(
                  "settings.postProcessing.api.apiKey.placeholder",
                )}
                disabled={state.isApiKeyUpdating}
                className="min-w-[320px]"
              />
            </div>
          </SettingContainer>
        </>
      )}

      {!state.isAppleProvider && !isLocalLlm && (
        <SettingContainer
          title={t("settings.postProcessing.api.model.title")}
          description={
            state.isCustomProvider
              ? t("settings.postProcessing.api.model.descriptionCustom")
              : t("settings.postProcessing.api.model.descriptionDefault")
          }
          descriptionMode="tooltip"
          layout="stacked"
          grouped={true}
        >
          <div className="flex items-center gap-2">
            <ModelSelect
              value={state.model}
              options={state.modelOptions}
              disabled={state.isModelUpdating}
              isLoading={state.isFetchingModels}
              placeholder={
                state.modelOptions.length > 0
                  ? t(
                      "settings.postProcessing.api.model.placeholderWithOptions",
                    )
                  : t("settings.postProcessing.api.model.placeholderNoOptions")
              }
              onSelect={state.handleModelSelect}
              onCreate={state.handleModelCreate}
              onBlur={() => {}}
              className="flex-1 min-w-[380px]"
            />
            <ResetButton
              onClick={state.handleRefreshModels}
              disabled={state.isFetchingModels}
              ariaLabel={t("settings.postProcessing.api.model.refreshModels")}
              className="flex h-10 w-10 items-center justify-center"
            >
              <RefreshCcw
                className={`h-4 w-4 ${state.isFetchingModels ? "animate-spin" : ""}`}
              />
            </ResetButton>
          </div>
        </SettingContainer>
      )}
    </>
  );
};

const PostProcessingSettingsPromptsComponent: React.FC = () => {
  const { t } = useTranslation();
  const { getSetting, updateSetting, isUpdating, refreshSettings } =
    useSettings();
  /** The open dialog and the prompt it edits (null for a new one), fixed when it opened. */
  const [dialog, setDialog] = useState<{ prompt: LLMPrompt | null } | null>(
    null,
  );

  const prompts = getSetting("post_process_prompts") || [];
  const selectedPromptId = getSetting("post_process_selected_prompt_id") || "";
  const selectedPrompt =
    prompts.find((prompt) => prompt.id === selectedPromptId) || null;

  const handlePromptSelect = (promptId: string | null) => {
    if (!promptId) return;
    updateSetting("post_process_selected_prompt_id", promptId);
  };

  const refresh = async () => {
    try {
      await refreshSettings();
    } catch (error) {
      console.error("Failed to refresh settings:", error);
    }
  };

  const addPrompt = async (name: string, text: string) => {
    try {
      const result = await commands.addPostProcessPrompt(name, text);
      if (result.status !== "ok") return false;
      await refresh();
      updateSetting("post_process_selected_prompt_id", result.data.id);
      return true;
    } catch (error) {
      console.error("Failed to create prompt:", error);
      return false;
    }
  };

  const updatePrompt = async (id: string, name: string, text: string) => {
    try {
      const result = await commands.updatePostProcessPrompt(id, name, text);
      if (result.status !== "ok") return false;
      await refresh();
      return true;
    } catch (error) {
      console.error("Failed to update prompt:", error);
      return false;
    }
  };

  const deletePrompt = async (id: string) => {
    try {
      const result = await commands.deletePostProcessPrompt(id);
      if (result.status !== "ok") return false;
      await refresh();
      return true;
    } catch (error) {
      console.error("Failed to delete prompt:", error);
      return false;
    }
  };

  const hasPrompts = prompts.length > 0;
  const editing = dialog?.prompt ?? null;

  return (
    <SettingContainer
      title={t("settings.postProcessing.prompts.selectedPrompt.title")}
      description={t(
        "settings.postProcessing.prompts.selectedPrompt.description",
      )}
      descriptionMode="tooltip"
      layout="stacked"
      grouped={true}
    >
      <div className="space-y-3">
        <div className="flex gap-2 min-w-0">
          <Dropdown
            selectedValue={selectedPromptId || null}
            options={prompts.map((p) => ({
              value: p.id,
              label: p.name,
            }))}
            onSelect={(value) => handlePromptSelect(value)}
            placeholder={
              prompts.length === 0
                ? t("settings.postProcessing.prompts.noPrompts")
                : t("settings.postProcessing.prompts.selectPrompt")
            }
            disabled={isUpdating("post_process_selected_prompt_id")}
            className="flex-1 min-w-0"
          />
          <Button
            onClick={() =>
              selectedPrompt && setDialog({ prompt: selectedPrompt })
            }
            variant="secondary"
            size="md"
            disabled={!selectedPrompt}
            className="shrink-0"
          >
            {t("settings.cleanup.prompt.edit")}
          </Button>
          <Button
            onClick={() => setDialog({ prompt: null })}
            variant="primary"
            size="md"
            className="shrink-0"
          >
            {t("settings.cleanup.prompt.new")}
          </Button>
        </div>

        {!selectedPrompt && (
          <div className="p-3 bg-wash rounded-md border border-line">
            <p className="text-sm text-ink-3">
              {hasPrompts
                ? t("settings.postProcessing.prompts.selectToEdit")
                : t("settings.cleanup.prompt.createFirst")}
            </p>
          </div>
        )}

        {dialog && (
          <PromptDialog
            prompt={dialog.prompt}
            canDelete={prompts.length > 1}
            save={
              editing
                ? (name, text) => updatePrompt(editing.id, name, text)
                : addPrompt
            }
            remove={editing ? () => deletePrompt(editing.id) : undefined}
            close={() => setDialog(null)}
          />
        )}
      </div>
    </SettingContainer>
  );
};

export const PostProcessingSettingsApi = React.memo(
  PostProcessingSettingsApiComponent,
);
PostProcessingSettingsApi.displayName = "PostProcessingSettingsApi";

export const PostProcessingSettingsPrompts = React.memo(
  PostProcessingSettingsPromptsComponent,
);
PostProcessingSettingsPrompts.displayName = "PostProcessingSettingsPrompts";

export const PostProcessingSettings: React.FC = () => {
  const { t } = useTranslation();
  const state = usePostProcessProviderState();
  const { getSetting } = useSettings();
  const { models } = useLocalLlmModels();
  const localModel = models.find(
    (m) => m.id === getSetting("local_llm_model_id"),
  );
  const { hidePrompts } = promptControls(
    getSetting("post_process_provider_id"),
    models.length === 0 ? undefined : (localModel ?? null),
    getSetting("post_process_prompts") ?? [],
    getSetting("post_process_selected_prompt_id") ?? null,
  );

  const isLocalLlm = state.selectedProviderId === LOCAL_LLM_PROVIDER_ID;
  const host = cleanupHost(state.selectedProviderId, state.baseUrl);

  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <SettingsGroup title={t("settings.groups.provider")}>
        <PostProcessingProvider state={state} />
        {host !== null && (
          <p role="note" className="px-4 py-2 text-sm text-ink-2">
            {t("settings.cleanup.sentTo", { host })}
          </p>
        )}
        <PostProcessingSettingsApi state={state} />
      </SettingsGroup>

      {!hidePrompts && (
        <SettingsGroup title={t("settings.groups.instructions")}>
          <PostProcessingSettingsPrompts />
        </SettingsGroup>
      )}

      {isLocalLlm && (
        <SettingsGroup title={t("settings.groups.localModel")}>
          <LocalLlmSettings />
          {hidePrompts && (
            <p className="px-4 py-3 text-sm text-ink-3">
              {t("settings.postProcessing.localLlm.promptHidden")}
            </p>
          )}
        </SettingsGroup>
      )}
    </div>
  );
};
