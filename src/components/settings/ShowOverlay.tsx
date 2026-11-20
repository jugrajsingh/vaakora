import React from "react";
import { useTranslation } from "react-i18next";
import { Dropdown } from "../ui/Dropdown";
import { SettingContainer } from "../ui/SettingContainer";
import { CELLS, PositionGrid } from "./PositionGrid";
import { useSettings } from "../../hooks/useSettings";
import type { OverlayPosition, OverlayStyle } from "@/bindings";

interface ShowOverlayProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

export const ShowOverlay: React.FC<ShowOverlayProps> = React.memo(
  ({ descriptionMode = "tooltip", grouped = false }) => {
    const { t } = useTranslation();
    const { getSetting, updateSetting, isUpdating } = useSettings();

    const styleOptions = [
      {
        value: "none",
        label: t("settings.advanced.overlay.style.options.none"),
      },
      {
        value: "minimal",
        label: t("settings.advanced.overlay.style.options.minimal"),
      },
      {
        value: "live",
        label: t("settings.advanced.overlay.style.options.live"),
      },
    ];

    const selectedStyle = (getSetting("overlay_style") ||
      "live") as OverlayStyle;
    const storedPosition = getSetting("overlay_position");
    // A missing, empty or legacy "none" value selects the bottom centre cell.
    const selectedPosition: OverlayPosition =
      CELLS.find((cell) => cell === storedPosition) ?? "bottom";

    return (
      <>
        <SettingContainer
          title={t("settings.advanced.overlay.style.title")}
          description={t("floating.style.help")}
          descriptionMode={descriptionMode}
          grouped={grouped}
        >
          <Dropdown
            options={styleOptions}
            selectedValue={selectedStyle}
            onSelect={(value) =>
              updateSetting("overlay_style", value as OverlayStyle)
            }
            disabled={isUpdating("overlay_style")}
          />
        </SettingContainer>

        <SettingContainer
          title={t("settings.advanced.overlay.position.title")}
          description={t("floating.position.help")}
          descriptionMode={descriptionMode}
          grouped={grouped}
        >
          <PositionGrid
            value={selectedPosition}
            onChange={(cell) => updateSetting("overlay_position", cell)}
            label={t("settings.advanced.overlay.position.title")}
            cellLabel={(cell) => t(`floating.position.cells.${cell}`)}
          />
        </SettingContainer>
      </>
    );
  },
);
