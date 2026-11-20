import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { commands, type HistoryCompareView } from "@/bindings";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Dropdown } from "@/components/ui/Dropdown";
import { SettingContainer } from "@/components/ui/SettingContainer";
import { useSettings } from "@/hooks/useSettings";
import { useSettingsStore } from "@/stores/settingsStore";
import { createCompareViewAction } from "./pageGeneration";

const COMPARE_VIEWS: readonly HistoryCompareView[] = [
  "diff",
  "side_by_side",
  "stacked",
];

/** How a cleaned entry shows against the original in Dictation, History. */
export const CompareViewSetting: React.FC = () => {
  const { t } = useTranslation();
  const { getSetting } = useSettings();
  const changeCompareView = useSettingsStore(
    (state) => state.changeHistoryCompareView,
  );
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changeView = useMemo(
    () =>
      createCompareViewAction({
        changeCompareView,
        setChangingView: setChanging,
        setError,
      }),
    [changeCompareView],
  );
  return (
    <div>
      <SettingContainer
        title={t("settings.history.compare.title")}
        description=""
        descriptionMode="inline"
        grouped
      >
        <Dropdown
          options={COMPARE_VIEWS.map((value) => ({
            value,
            label: t(`settings.history.compare.${value}`),
          }))}
          selectedValue={getSetting("history_compare_view") ?? "diff"}
          onSelect={(next) => void changeView(next)}
          disabled={changing}
          placeholder={t("settings.history.compare.title")}
        />
      </SettingContainer>
      {error && (
        <div role="alert" className="px-4 pb-2">
          <Alert>{error}</Alert>
        </div>
      )}
    </div>
  );
};

const openRecordingsFolder = async () => {
  try {
    const result = await commands.openRecordingsFolder();
    if (result.status !== "ok") {
      throw new Error(String(result.error));
    }
  } catch (error) {
    console.error("Failed to open recordings folder:", error);
  }
};

/** Opens the folder that holds the saved dictation recordings. */
export const RecordingsFolderSetting: React.FC = () => {
  const { t } = useTranslation();
  return (
    <SettingContainer
      title={t("settings.dictationHistory.folderTitle")}
      description=""
      descriptionMode="inline"
      grouped
    >
      <Button
        variant="secondary"
        size="sm"
        onClick={() => void openRecordingsFolder()}
      >
        {t("settings.dictationHistory.folderOpen")}
      </Button>
    </SettingContainer>
  );
};
