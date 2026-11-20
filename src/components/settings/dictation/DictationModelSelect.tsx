import React from "react";
import { useTranslation } from "react-i18next";
import { Dropdown } from "@/components/ui/Dropdown";
import { getTranslatedModelName } from "@/lib/utils/modelTranslation";
import { useModelStore } from "@/stores/modelStore";
import { useModelsLocked } from "@/stores/transcriptionJobsStore";

export const DictationModelSelect: React.FC = () => {
  const { t } = useTranslation();
  const { models, currentModel, selectModel } = useModelStore();
  const locked = useModelsLocked();
  return (
    <Dropdown
      options={models
        .filter((model) => model.is_downloaded)
        .map((model) => ({
          value: model.id,
          label: getTranslatedModelName(model, t),
        }))}
      selectedValue={currentModel}
      onSelect={(id) => void selectModel(id)}
      disabled={locked}
    />
  );
};
