import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useRef,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { platform } from "@tauri-apps/plugin-os";
import { listen } from "@tauri-apps/api/event";
import {
  checkAccessibilityPermission,
  checkMicrophonePermission,
} from "tauri-plugin-macos-permissions-api";
import "./App.css";
import SecureInputWarning from "./components/SecureInputWarning";
import Footer from "./components/footer";
import { OnboardingFlow } from "./components/onboarding/OnboardingFlow";
import ModelMigration from "./components/onboarding/ModelMigration";
import {
  ReplaceModel,
  ReturningPermissions,
} from "./components/onboarding/StandaloneScreens";
import {
  clearOnboardingProgress,
  type OnboardingStep as OnboardingPreviewStep,
} from "./components/onboarding/onboardingStore";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { FileDropOverlay } from "./components/FileDropOverlay";
import { MainPage } from "./components/MainPage";
import { Sidebar } from "./components/Sidebar";
import { PANEL_ID, TabStrip, tabId } from "./components/shared/TabStrip";
import { WhatsNewGate } from "./components/whats-new";
import { requestManualCheck } from "./components/update-checker/updaterStore";
import { useSettings } from "./hooks/useSettings";
import { useSettingsStore } from "./stores/settingsStore";
import { commands } from "@/bindings";
import { deleteRetiredModel } from "@/lib/models/retired";
import { NoticePanel } from "@/components/notices/NoticePanel";
import { getLanguageDirection, initializeRTL } from "@/lib/utils/rtl";
import {
  LINKS,
  afterOnboarding,
  createNavigator,
  defaultStorage,
  firstTab,
  labelKey,
  loadLocation,
  normalizeLocation,
  revealGroup,
  visibleTabs,
  type GroupId,
  type Location,
} from "@/lib/navigation";

// flow is first-run onboarding; the rest are single screens for returning users.
type OnboardingStep =
  | "flow"
  | "permissions"
  | "migration"
  | "replaceModel"
  | "done";

function App() {
  const { t, i18n } = useTranslation();
  const [onboardingStep, setOnboardingStep] = useState<OnboardingStep | null>(
    null,
  );
  const [onboardingPreview, setOnboardingPreview] =
    useState<OnboardingPreviewStep | null>(null);
  // Set when a returning user's selected model is a retired (ONNX) model that
  // is still on disk: they must update it before the app can transcribe.
  const [migrationModelId, setMigrationModelId] = useState<string | null>(null);
  const [location, setLocation] = useState<Location>(() =>
    loadLocation(defaultStorage()),
  );
  // A new object per navigation, so revealing the same group again re-runs the scroll.
  const [reveal, setReveal] = useState<{ group: GroupId | null }>({
    group: null,
  });
  const navigation = useMemo(
    () =>
      createNavigator({
        storage: defaultStorage(),
        set: setLocation,
        reveal: (group) => setReveal({ group }),
      }),
    [],
  );
  const showHistory = useCallback(
    () => navigation.navigate(LINKS.dictationHistory),
    [navigation],
  );
  const { settings, updateSetting } = useSettings();
  const debug = settings?.debug_mode ?? false;
  // Normalised for display only; a stored Debug tab returns once debug mode is known.
  const shown = normalizeLocation(location, debug);
  const direction = getLanguageDirection(i18n.language);
  const refreshAudioDevices = useSettingsStore(
    (state) => state.refreshAudioDevices,
  );
  const refreshOutputDevices = useSettingsStore(
    (state) => state.refreshOutputDevices,
  );
  const hasCompletedPostOnboardingInit = useRef(false);
  const settingsScrollRef = useRef<HTMLDivElement>(null);
  // Scroll to the linked group, else to the top, whenever the shown page changes.
  useLayoutEffect(() => {
    revealGroup(reveal.group, {
      find: (id) =>
        settingsScrollRef.current?.querySelector<HTMLElement>("#" + id) ?? null,
      top: () => settingsScrollRef.current?.scrollTo({ top: 0 }),
    });
  }, [shown.destination, shown.tab, reveal]);

  useEffect(() => {
    checkOnboardingStatus();
  }, []);

  useEffect(() => {
    const unlisten = listen("open-tts-models", () => {
      navigation.navigate(LINKS.readAloudModels);
      void commands.showMainWindowCommand();
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, [navigation]);

  useEffect(() => {
    const unlisten = listen("check-for-updates", () => {
      requestManualCheck();
      navigation.navigate(LINKS.about);
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, [navigation]);

  // Initialize RTL direction when language changes
  useEffect(() => {
    initializeRTL(i18n.language);
  }, [i18n.language]);

  // Initialize Enigo, shortcuts, and refresh audio devices when main app loads
  useEffect(() => {
    if (onboardingStep === "done" && !hasCompletedPostOnboardingInit.current) {
      hasCompletedPostOnboardingInit.current = true;
      Promise.all([
        commands.initializeEnigo(),
        commands.initializeShortcuts(),
      ]).catch((e) => {
        console.warn("Failed to initialize:", e);
      });
      refreshAudioDevices();
      refreshOutputDevices();
    }
  }, [onboardingStep, refreshAudioDevices, refreshOutputDevices]);

  // Handle keyboard shortcuts for debug mode toggle
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Check for Ctrl+Shift+D (Windows/Linux) or Cmd+Shift+D (macOS)
      const isDebugShortcut =
        event.shiftKey &&
        event.key.toLowerCase() === "d" &&
        (event.ctrlKey || event.metaKey);

      if (isDebugShortcut) {
        event.preventDefault();
        const currentDebugMode = settings?.debug_mode ?? false;
        updateSetting("debug_mode", !currentDebugMode);
      }
    };

    // Add event listener when component mounts
    document.addEventListener("keydown", handleKeyDown);

    // Cleanup event listener when component unmounts
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [settings?.debug_mode, updateSetting]);

  const revealMainWindowForPermissions = async () => {
    try {
      await commands.showMainWindowCommand();
    } catch (e) {
      console.warn("Failed to show main window for permission onboarding:", e);
    }
  };

  const getMigrationModelId = async (
    selectedModel: string,
  ): Promise<string | null> => {
    const retired = await commands.getRetiredModels();
    return retired.some((m) => m.id === selectedModel) ? selectedModel : null;
  };

  // Returning users land in the app unless their model needs updating. The
  // window may start hidden, so bring it forward for the update screen.
  const finishReturningUser = async (retiredModelId: string | null) => {
    if (retiredModelId) {
      await revealMainWindowForPermissions();
      setOnboardingStep("migration");
    } else {
      setOnboardingStep("done");
    }
  };

  const checkOnboardingStatus = async () => {
    try {
      const settingsResult = await commands.getAppSettings();
      const hasCompletedOnboarding =
        settingsResult.status === "ok" &&
        settingsResult.data.onboarding_completed === true;
      const currentPlatform = platform();

      if (hasCompletedOnboarding) {
        // Returning user - check if they need to grant permissions first
        const retiredModelId = await getMigrationModelId(
          settingsResult.data.selected_model ?? "",
        );
        setMigrationModelId(retiredModelId);

        if (currentPlatform === "macos") {
          try {
            const [hasAccessibility, hasMicrophone] = await Promise.all([
              checkAccessibilityPermission(),
              checkMicrophonePermission(),
            ]);
            if (!hasAccessibility || !hasMicrophone) {
              await revealMainWindowForPermissions();
              setOnboardingStep("permissions");
              return;
            }
          } catch (e) {
            console.warn("Failed to check macOS permissions:", e);
            // If we can't check, proceed to main app and let them fix it there
          }
        }

        if (currentPlatform === "windows") {
          try {
            const microphoneStatus =
              await commands.getWindowsMicrophonePermissionStatus();
            if (
              microphoneStatus.supported &&
              microphoneStatus.overall_access === "denied"
            ) {
              await revealMainWindowForPermissions();
              setOnboardingStep("permissions");
              return;
            }
          } catch (e) {
            console.warn("Failed to check Windows microphone permissions:", e);
            // If we can't check, proceed to main app and let them fix it there
          }
        }

        await finishReturningUser(retiredModelId);
      } else {
        // New user - start full onboarding
        setOnboardingStep("flow");
      }
    } catch (error) {
      console.error("Failed to check onboarding status:", error);
      setOnboardingStep("flow");
    }
  };

  // Debug: the real onboarding from Welcome, for testing it end to end.
  const runOnboarding = () => {
    clearOnboardingProgress();
    setOnboardingStep("flow");
  };

  // Debug: the real model migration screen. It leads with the selected model
  // if that's retired, otherwise with the first retired model on disk.
  const runModelMigration = async () => {
    const retired = await commands.getRetiredModels();
    if (retired.length === 0) {
      console.info("Model migration: no old-format models on disk");
      return;
    }
    const selected = settings?.selected_model;
    setMigrationModelId(
      retired.find((m) => m.id === selected)?.id ?? retired[0].id,
    );
    setOnboardingStep("migration");
  };

  const handleModelSelected = async () => {
    // Reached when the user picks a different model instead of updating.
    for (const model of await commands.getRetiredModels()) {
      await deleteRetiredModel(model.id);
    }
    setOnboardingStep("done");
  };

  // Still checking onboarding status
  if (onboardingStep === null) {
    return null;
  }

  // Select the content for the current step. NoticePanel is rendered once,
  // beside this node, so errors surface on every step, including onboarding.
  let content: ReactNode;
  if (onboardingPreview) {
    // Previews render in the same top-level slot as real onboarding, inert:
    // no prompts, downloads or setting writes.
    content = (
      <>
        <OnboardingFlow
          preview
          previewStep={onboardingPreview}
          onComplete={(then) =>
            afterOnboarding(then, {
              close: () => setOnboardingPreview(null),
              navigate: navigation.navigate,
            })
          }
        />
        <button
          type="button"
          onClick={() => setOnboardingPreview(null)}
          className="fixed top-4 end-4 z-50 rounded-lg border border-line bg-background px-4 py-2 text-sm font-medium text-text shadow-lg hover:bg-logo-primary/20 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-logo-primary"
        >
          {t("settings.debug.onboardingPreview.exitButton")}
        </button>
      </>
    );
  } else if (onboardingStep === "flow") {
    content = (
      <OnboardingFlow
        onComplete={(then) =>
          afterOnboarding(then, {
            close: () => setOnboardingStep("done"),
            navigate: navigation.navigate,
          })
        }
      />
    );
  } else if (onboardingStep === "permissions") {
    content = (
      <ReturningPermissions
        onComplete={() => finishReturningUser(migrationModelId)}
      />
    );
  } else if (onboardingStep === "migration" && migrationModelId) {
    content = (
      <ModelMigration
        inUseModelId={migrationModelId}
        onComplete={() => setOnboardingStep("done")}
        onChooseAnother={() => setOnboardingStep("replaceModel")}
      />
    );
  } else if (onboardingStep === "replaceModel") {
    content = (
      <ReplaceModel
        onBack={() => setOnboardingStep("migration")}
        onComplete={handleModelSelected}
      />
    );
  } else {
    content = (
      <div
        dir={direction}
        className="h-screen flex flex-col select-none cursor-default"
      >
        <ErrorBoundary context="What's New">
          <WhatsNewGate />
        </ErrorBoundary>
        {/* Main content area that takes remaining space */}
        <div className="flex-1 flex overflow-hidden">
          <Sidebar
            active={shown.destination}
            navigate={(destination) =>
              navigation.navigate(firstTab(destination, debug))
            }
          />
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            {/* The tab strip sits outside the scroll body, so it stays pinned. */}
            <div className="shrink-0 border-b border-line px-4">
              <div className="mx-auto w-full min-w-0 max-w-3xl">
                <TabStrip
                  label={t(labelKey(shown.destination))}
                  tabs={visibleTabs(shown.destination, debug)}
                  active={shown.tab}
                  select={(tab) =>
                    navigation.navigate({
                      destination: shown.destination,
                      tab,
                    } as Location)
                  }
                  rtl={direction === "rtl"}
                />
              </div>
            </div>
            <div
              ref={settingsScrollRef}
              data-settings-scroll
              style={{ overflowAnchor: "none" }}
              className="flex-1 overflow-y-auto"
              role="tabpanel"
              id={PANEL_ID}
              aria-labelledby={tabId(shown.tab)}
            >
              <div className="flex flex-col gap-4 p-4">
                <SecureInputWarning />
                <div className="mx-auto flex min-h-0 w-full min-w-0 max-w-3xl flex-1 flex-col">
                  <MainPage
                    location={shown}
                    navigate={navigation.navigate}
                    onPreviewOnboarding={setOnboardingPreview}
                    onRunOnboarding={runOnboarding}
                    onRunModelMigration={runModelMigration}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
        {/* Fixed footer at bottom */}
        <Footer navigate={navigation.navigate} />
        <FileDropOverlay onDropped={showHistory} />
      </div>
    );
  }

  return (
    <>
      {content}
      <NoticePanel />
    </>
  );
}

export default App;
