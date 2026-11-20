import React from "react";
import { useTranslation } from "react-i18next";
import { type } from "@tauri-apps/plugin-os";
import { ShortcutInput } from "../ShortcutInput";
import { SettingsGroup } from "../../ui/SettingsGroup";
import { OutputDeviceSelector } from "../OutputDeviceSelector";
import { ShortcutActivationSetting } from "../ShortcutActivation";
import { AudioFeedback } from "../AudioFeedback";
import { useSettings } from "../../../hooks/useSettings";
import { VolumeSlider } from "../VolumeSlider";
import { SoundPicker } from "../SoundPicker";
import { AppLanguageSelector } from "../AppLanguageSelector";
import { ThemeSelector } from "../ThemeSelector";
import { StartHidden } from "../StartHidden";
import { AutostartToggle } from "../AutostartToggle";
import { ShowTrayIcon } from "../ShowTrayIcon";
import { generalShortcutRows } from "@/lib/utils/shortcutPresentation";

export const GeneralSettings: React.FC = () => {
  const { t } = useTranslation();
  const { audioFeedbackEnabled, getSetting } = useSettings();
  const isLinux = type() === "linux";
  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <SettingsGroup title={t("settings.groups.shortcuts")}>
        {/* Linux shows how to cancel instead of the Cancel shortcut, which is unreliable there. */}
        {generalShortcutRows(
          getSetting("post_process_enabled") ?? false,
          isLinux,
        ).map((row) => {
          if (row === "activation") {
            return (
              <ShortcutActivationSetting
                key={row}
                title={t("settings.shortcuts.activation")}
                description={t("settings.shortcuts.activationHelp")}
                descriptionMode="inline"
                grouped={true}
              />
            );
          }
          if (row === "cancelHelp") {
            return (
              <p
                key={row}
                data-row="cancel-help"
                className="px-4 py-2 text-sm text-ink-2"
              >
                {t("settings.shortcuts.cancelLinuxHelp")}
              </p>
            );
          }
          return <ShortcutInput key={row} shortcutId={row} grouped={true} />;
        })}
      </SettingsGroup>
      <SettingsGroup title={t("settings.groups.sound")}>
        <AudioFeedback descriptionMode="tooltip" grouped={true} />
        <OutputDeviceSelector
          descriptionMode="tooltip"
          grouped={true}
          disabled={!audioFeedbackEnabled}
          disabledReason={t("settings.sound.outputDevice.offReason")}
        />
        <VolumeSlider
          disabled={!audioFeedbackEnabled}
          disabledReason={t("settings.sound.volume.offReason")}
        />
        <SoundPicker
          label={t("settings.debug.soundTheme.label")}
          description={t("settings.debug.soundTheme.description")}
        />
      </SettingsGroup>
      <SettingsGroup title={t("settings.groups.appearance")}>
        <AppLanguageSelector descriptionMode="tooltip" grouped={true} />
        <ThemeSelector descriptionMode="tooltip" grouped={true} />
      </SettingsGroup>
      <SettingsGroup title={t("settings.groups.startup")}>
        <StartHidden descriptionMode="tooltip" grouped={true} />
        <AutostartToggle descriptionMode="tooltip" grouped={true} />
        <ShowTrayIcon descriptionMode="tooltip" grouped={true} />
      </SettingsGroup>
    </div>
  );
};
