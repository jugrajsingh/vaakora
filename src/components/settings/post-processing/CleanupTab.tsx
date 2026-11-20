import React from "react";
import { useSettings } from "@/hooks/useSettings";
import { SettingsGroup } from "../../ui/SettingsGroup";
import { PostProcessingToggle } from "../PostProcessingToggle";
import { PostProcessingSettings } from "./PostProcessingSettings";

/** Dictation, Cleanup; `manage` opens Models, Cleanup. */
export const CleanupTab: React.FC<{ manage: () => void }> = ({ manage }) => {
  const { getSetting } = useSettings();

  return (
    <div className="w-full max-w-3xl min-w-0 space-y-6">
      <SettingsGroup>
        <PostProcessingToggle descriptionMode="tooltip" grouped />
      </SettingsGroup>
      {getSetting("post_process_enabled") && (
        <PostProcessingSettings manage={manage} />
      )}
    </div>
  );
};
