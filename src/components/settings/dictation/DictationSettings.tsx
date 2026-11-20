import React from "react";
import { useTranslation } from "react-i18next";
import { SettingsGroup } from "../../ui/SettingsGroup";
import { Alert } from "../../ui/Alert";
import { JobModelGroup, jobModelState } from "../../shared/JobModelGroup";
import { DictationModelSelect } from "./DictationModelSelect";
import { LanguageSelector } from "../LanguageSelector";
import { TranslateToEnglish } from "../TranslateToEnglish";
import { PreferredLanguages } from "../PreferredLanguages";
import { ChineseScriptSetting } from "../ChineseScript";
import { MicrophoneSelector } from "../MicrophoneSelector";
import { ChannelSelector } from "../ChannelSelector";
import { MuteWhileRecording } from "../MuteWhileRecording";
import { PasteMethodSetting } from "../PasteMethod";
import { TypingToolSetting } from "../TypingTool";
import { ClipboardHandlingSetting } from "../ClipboardHandling";
import { AutoSubmit } from "../AutoSubmit";
import { AppendTrailingSpace } from "../AppendTrailingSpace";
import { CustomWords } from "../CustomWords";
import { FillerWordRemoval } from "../FillerWordRemoval";
import { ShowOverlay } from "../ShowOverlay";
import { HistoryLimit } from "../HistoryLimit";
import { RecordingRetentionPeriodSelector } from "../RecordingRetentionPeriod";
import {
  CompareViewSetting,
  RecordingsFolderSetting,
} from "../history/HistoryRows";
import { useSettings } from "@/hooks/useSettings";
import { useModelStore } from "@/stores/modelStore";
import { isChinese } from "@/lib/utils/languageSuggestions";
import { groupAnchor } from "@/lib/navigation";
import { capabilityRows } from "./capabilities";

export const DictationSettings: React.FC<{ manageModels: () => void }> = ({
  manageModels,
}) => {
  const { t } = useTranslation();
  const { getSetting } = useSettings();
  const { currentModel, models, initialized, error } = useModelStore();
  const currentModelInfo = models.find((model) => model.id === currentModel);
  const capabilities = capabilityRows(currentModelInfo);
  // Only for Chinese speakers, or anyone who already picked a script.
  const speaksChinese =
    (getSetting("spoken_languages") ?? []).some(isChinese) ||
    (getSetting("chinese_script") ?? "as_transcribed") !== "as_transcribed";
  return (
    <div className="w-full max-w-3xl min-w-0 space-y-6">
      <JobModelGroup
        role="dictation"
        state={jobModelState(
          initialized ? models.filter((m) => m.is_downloaded).length : null,
        )}
        manage={manageModels}
        select={<DictationModelSelect />}
      >
        {currentModelInfo && capabilities.language && (
          <LanguageSelector
            descriptionMode="tooltip"
            grouped={true}
            modelId={currentModelInfo.id}
            supportedLanguages={currentModelInfo.supported_languages}
          />
        )}
        {capabilities.translate && (
          <TranslateToEnglish descriptionMode="tooltip" grouped={true} />
        )}
      </JobModelGroup>
      {error && (
        <div role="alert">
          <Alert>{error}</Alert>
        </div>
      )}
      <div id={groupAnchor("languages")}>
        <SettingsGroup title={t("settings.groups.languages")}>
          <PreferredLanguages descriptionMode="tooltip" grouped={true} />
          {speaksChinese && (
            <ChineseScriptSetting descriptionMode="tooltip" grouped={true} />
          )}
        </SettingsGroup>
      </div>
      <SettingsGroup title={t("settings.groups.microphone")}>
        <MicrophoneSelector descriptionMode="tooltip" grouped={true} />
        <ChannelSelector descriptionMode="tooltip" grouped={true} />
        <MuteWhileRecording descriptionMode="tooltip" grouped={true} />
      </SettingsGroup>
      <SettingsGroup title={t("settings.groups.output")}>
        <PasteMethodSetting descriptionMode="tooltip" grouped={true} />
        <TypingToolSetting descriptionMode="tooltip" grouped={true} />
        <ClipboardHandlingSetting descriptionMode="tooltip" grouped={true} />
        <AutoSubmit descriptionMode="tooltip" grouped={true} />
        <AppendTrailingSpace descriptionMode="tooltip" grouped={true} />
      </SettingsGroup>
      <SettingsGroup title={t("settings.groups.text")}>
        <CustomWords descriptionMode="tooltip" grouped={true} />
        <FillerWordRemoval descriptionMode="tooltip" grouped={true} />
      </SettingsGroup>
      <SettingsGroup title={t("settings.groups.overlay")}>
        <ShowOverlay descriptionMode="tooltip" grouped={true} />
      </SettingsGroup>
      <div id={groupAnchor("dictationHistory")}>
        <SettingsGroup title={t("settings.groups.history")}>
          <HistoryLimit grouped={true} />
          <RecordingRetentionPeriodSelector grouped={true} />
          <CompareViewSetting />
          <RecordingsFolderSetting />
        </SettingsGroup>
      </div>
    </div>
  );
};
