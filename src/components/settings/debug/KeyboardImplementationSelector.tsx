import React from "react";
import { useTranslation } from "react-i18next";
import { type } from "@tauri-apps/plugin-os";
import { SettingContainer } from "../../ui/SettingContainer";
import { Dropdown, type DropdownOption } from "../../ui/Dropdown";
import { useSettings } from "../../../hooks/useSettings";
import { commands } from "@/bindings";
import { notify } from "@/stores/noticeStore";

interface KeyboardImplementationSelectorProps {
  descriptionMode?: "tooltip" | "inline";
  grouped?: boolean;
}

export const KeyboardImplementationSelector: React.FC<
  KeyboardImplementationSelectorProps
> = ({ descriptionMode = "tooltip", grouped = false }) => {
  const { t } = useTranslation();
  const { getSetting, isUpdating, refreshSettings } = useSettings();
  const options: DropdownOption[] = [
    { value: "tauri", label: "Tauri Global Shortcut" },
    // The stored value stays `handy_keys`; only the label is the brand's.
    {
      value: "handy_keys",
      label: t("settings.debug.keyboardImplementation.builtIn"),
    },
    // Linux only: for Wayland, where the compositor owns keybindings and
    // triggers the app via `vaakora --toggle-transcription`.
    ...(type() === "linux" ? [{ value: "none", label: "None" }] : []),
  ];
  const currentImplementation =
    getSetting("keyboard_implementation") ?? "tauri";

  const handleSelect = async (value: string) => {
    if (value === currentImplementation) return;

    try {
      const result = await commands.changeKeyboardImplementationSetting(value);

      if (result.status === "error") {
        console.error(
          "Failed to update keyboard implementation:",
          result.error,
        );
        notify({ title: String(result.error) });
        return;
      }

      // If any bindings were reset due to incompatibility, notify the user
      if (result.data.reset_bindings.length > 0) {
        notify({
          title: t("settings.debug.keyboardImplementation.bindingsReset"),
          level: "warning",
        });
      }

      await refreshSettings();
    } catch (error) {
      console.error("Failed to update keyboard implementation:", error);
      notify({ title: String(error) });
    }
  };

  return (
    <SettingContainer
      title={t("settings.debug.keyboardImplementation.title")}
      description={t("settings.debug.keyboardImplementation.description")}
      descriptionMode={descriptionMode}
      grouped={grouped}
      layout="horizontal"
    >
      <Dropdown
        options={options}
        selectedValue={currentImplementation}
        onSelect={handleSelect}
        disabled={isUpdating("keyboard_implementation")}
      />
    </SettingContainer>
  );
};
