import React from "react";
import { useTranslation } from "react-i18next";
import { ModelUnloadTimeoutSetting } from "../ModelUnloadTimeout";
import { SettingsGroup } from "../../ui/SettingsGroup";
import { ExperimentalToggle } from "../ExperimentalToggle";
import { useSettings } from "../../../hooks/useSettings";
import { KeyboardImplementationSelector } from "../debug/KeyboardImplementationSelector";
import { VoiceActivityDetection } from "../VoiceActivityDetection";
import { LongFormChunking } from "../LongFormChunking";
import { LanguageDetection } from "../LanguageDetection";
import { AccelerationSelector } from "../AccelerationSelector";
import { LazyStreamClose } from "../LazyStreamClose";
import { AirPodsMode } from "../AirPodsMode";
import { HfTokenSetting } from "../tts/HfTokenSetting";
import { VadBackendSelector } from "../VadBackendSelector";

export const AdvancedSettings: React.FC = () => {
  const { t } = useTranslation();
  const { getSetting } = useSettings();
  const experimentalEnabled = getSetting("experimental_enabled") || false;

  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <SettingsGroup title={t("settings.groups.models")}>
        <ModelUnloadTimeoutSetting
          title={t("settings.rows.unloadIdle")}
          descriptionMode="tooltip"
          grouped={true}
        />
        <HfTokenSetting />
      </SettingsGroup>

      <SettingsGroup title={t("settings.groups.dictationEngine")}>
        <VoiceActivityDetection descriptionMode="tooltip" grouped={true} />
        <LongFormChunking descriptionMode="tooltip" grouped={true} />
      </SettingsGroup>

      <SettingsGroup title={t("settings.groups.experimental")}>
        <ExperimentalToggle descriptionMode="tooltip" grouped={true} />
        {experimentalEnabled && (
          <>
            <KeyboardImplementationSelector
              descriptionMode="tooltip"
              grouped={true}
            />
            <AccelerationSelector
              title={t("settings.rows.runOn")}
              descriptionMode="tooltip"
              grouped={true}
            />
            <LazyStreamClose descriptionMode="tooltip" grouped={true} />
            <AirPodsMode descriptionMode="tooltip" grouped={true} />
            <VadBackendSelector descriptionMode="tooltip" grouped={true} />
            <LanguageDetection descriptionMode="tooltip" grouped={true} />
          </>
        )}
      </SettingsGroup>
    </div>
  );
};
