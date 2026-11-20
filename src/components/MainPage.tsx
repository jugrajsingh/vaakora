import React from "react";
import {
  AboutSettings,
  AdvancedSettings,
  DebugSettings,
  GeneralSettings,
  HistorySettings,
  ModelsSettings,
} from "./settings";
import { CleanupTab } from "./settings/post-processing/CleanupTab";
import { CleanupModelsPage } from "./settings/post-processing/CleanupModelsPage";
import { DictationSettings } from "./settings/dictation/DictationSettings";
import { SettingsPage as TtsSettingsPage } from "./settings/tts/SettingsPage";
import { ModelsPage as TtsModelsPage } from "./settings/tts/ModelsPage";
import type { OnboardingStep } from "./onboarding/onboardingStore";
import { LINKS, type Link, type Location } from "@/lib/navigation";

export interface MainPageProps {
  location: Location;
  navigate: (to: Link) => void;
  onPreviewOnboarding: (step: OnboardingStep) => void;
  onRunOnboarding: () => void;
  onRunModelMigration: () => void;
}

/** The existing page shown for each destination and tab. */
export function MainPage({
  location,
  navigate,
  onPreviewOnboarding,
  onRunOnboarding,
  onRunModelMigration,
}: MainPageProps): React.JSX.Element {
  switch (location.destination) {
    case "dictation":
      switch (location.tab) {
        case "history":
          return (
            <HistorySettings
              changeRetention={() => navigate(LINKS.dictationRetention)}
            />
          );
        case "settings":
          return (
            <DictationSettings
              manageModels={() => navigate(LINKS.dictationModels)}
            />
          );
        case "cleanup":
          return <CleanupTab manage={() => navigate(LINKS.cleanupModels)} />;
      }
      break;
    case "readAloud":
      switch (location.tab) {
        case "history":
        case "settings":
        case "vocabulary":
          return (
            <TtsSettingsPage
              tab={location.tab}
              changeRetention={() => navigate(LINKS.readAloudRetention)}
            />
          );
      }
      break;
    case "models":
      switch (location.tab) {
        case "dictation":
          return (
            <ModelsSettings
              onChangeLanguages={() => navigate(LINKS.languages)}
            />
          );
        case "readAloud":
          return <TtsModelsPage />;
        case "cleanup":
          return <CleanupModelsPage />;
      }
      break;
    case "settings":
      switch (location.tab) {
        case "general":
          return <GeneralSettings />;
        case "advanced":
          return <AdvancedSettings />;
        case "about":
          return <AboutSettings />;
        case "debug":
          return (
            <DebugSettings
              onPreviewOnboarding={onPreviewOnboarding}
              onRunOnboarding={onRunOnboarding}
              onRunModelMigration={onRunModelMigration}
            />
          );
      }
      break;
  }
  const unreachable: never = location;
  return unreachable;
}
