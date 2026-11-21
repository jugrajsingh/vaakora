import React, {
  useState,
  useEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { openUrl } from "@tauri-apps/plugin-opener";
import { arch, platform } from "@tauri-apps/plugin-os";
import { ProgressBar } from "../shared";
import { useSettings } from "../../hooks/useSettings";
import { useSettingsStore } from "../../stores/settingsStore";
import { commands } from "../../bindings";
import {
  resolvePortableInstallerUrl,
  PORTABLE_RELEASES_URL,
} from "./portableInstaller";
import { runInstall } from "./installUpdate";
import {
  getUpdaterState,
  mountCheck,
  subscribeManualCheck,
  subscribeUpdater,
  takeManualCheck,
  updateChecksAllowed,
} from "./updaterStore";

// Read from the store, not render state: the switch can change after this
// component has gone, while an install call is still pending.
function currentUpdateChecksAllowed(): boolean {
  const { settings, updateChecksLocked } = useSettingsStore.getState();
  return updateChecksAllowed(
    settings?.update_checks_enabled,
    updateChecksLocked,
  );
}

interface UpdateCheckerProps {
  className?: string;
}

const UpdateChecker: React.FC<UpdateCheckerProps> = ({ className = "" }) => {
  const { t } = useTranslation();
  // Update checking state
  const [isChecking, setIsChecking] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const { installing: isInstalling, progress: downloadProgress } =
    useSyncExternalStore(subscribeUpdater, getUpdaterState, getUpdaterState);
  const [showUpToDate, setShowUpToDate] = useState(false);
  const [showPortableUpdateDialog, setShowPortableUpdateDialog] =
    useState(false);
  const [portableInstallerUrl, setPortableInstallerUrl] = useState<string>(
    PORTABLE_RELEASES_URL,
  );

  const { settings, isLoading, updateChecksLocked } = useSettings();
  // Wait for the lock state too (null = not loaded yet), otherwise the first
  // render could fire an update check before HANDY_DISABLE_UPDATER is known.
  const settingsLoaded =
    !isLoading && settings !== null && updateChecksLocked !== null;
  // Forced-off by system configuration (HANDY_DISABLE_UPDATER) overrides the
  // stored preference without persisting it, mirroring the backend's effective
  // updater state.
  const updateChecksEnabled = updateChecksAllowed(
    settings?.update_checks_enabled,
    updateChecksLocked,
  );

  const upToDateTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const isManualCheckRef = useRef(false);

  useEffect(() => {
    // Wait for settings to load before doing anything
    if (!settingsLoaded) return;

    const mountPlan = mountCheck();

    if (!updateChecksEnabled) {
      if (upToDateTimeoutRef.current) {
        clearTimeout(upToDateTimeoutRef.current);
      }
      setIsChecking(false);
      setUpdateAvailable(false);
      setShowUpToDate(false);
      return;
    }

    if (mountPlan !== "none") {
      isManualCheckRef.current = mountPlan === "manual";
      checkForUpdates();
    }

    // Listen for update check events
    const unsubscribe = subscribeManualCheck(() => {
      if (takeManualCheck()) handleManualUpdateCheck();
    });

    return () => {
      unsubscribe();
      if (upToDateTimeoutRef.current) {
        clearTimeout(upToDateTimeoutRef.current);
      }
    };
  }, [settingsLoaded, updateChecksEnabled]);

  // Update checking functions
  const checkForUpdates = async () => {
    if (!updateChecksEnabled || isChecking) return;

    try {
      setIsChecking(true);
      const update = await check();

      if (update) {
        setUpdateAvailable(true);
        setShowUpToDate(false);
        // Portable installs can't self-update in place — the manual dialog links
        // straight at the matching installer from this manifest instead.
        setPortableInstallerUrl(
          resolvePortableInstallerUrl(update.rawJson, platform(), arch()),
        );
      } else {
        setUpdateAvailable(false);

        if (isManualCheckRef.current) {
          setShowUpToDate(true);
          if (upToDateTimeoutRef.current) {
            clearTimeout(upToDateTimeoutRef.current);
          }
          upToDateTimeoutRef.current = setTimeout(() => {
            setShowUpToDate(false);
          }, 3000);
        }
      }
    } catch (error) {
      console.error("Failed to check for updates:", error);
    } finally {
      setIsChecking(false);
      isManualCheckRef.current = false;
    }
  };

  const handleManualUpdateCheck = () => {
    if (!updateChecksEnabled) return;
    isManualCheckRef.current = true;
    checkForUpdates();
  };

  const installUpdate = () =>
    runInstall({
      allowed: currentUpdateChecksAllowed,
      isPortable: () => commands.isPortable(),
      check,
      relaunch,
      showPortableDialog: () => setShowPortableUpdateDialog(true),
    });

  // Update status functions
  const getUpdateStatusText = () => {
    if (!updateChecksEnabled) {
      return t("footer.updateCheckingDisabled");
    }
    if (isInstalling) {
      return downloadProgress > 0 && downloadProgress < 100
        ? t("footer.downloading", {
            progress: downloadProgress.toString().padStart(3),
          })
        : downloadProgress === 100
          ? t("footer.installing")
          : t("footer.preparing");
    }
    if (isChecking) return t("footer.checkingUpdates");
    if (showUpToDate) return t("footer.upToDate");
    if (updateAvailable) return t("footer.updateAvailableShort");
    return t("footer.checkForUpdates");
  };

  const getUpdateStatusAction = () => {
    if (!updateChecksEnabled) return undefined;
    if (updateAvailable && !isInstalling) return installUpdate;
    if (!isChecking && !isInstalling && !updateAvailable)
      return handleManualUpdateCheck;
    return undefined;
  };

  const isUpdateDisabled = !updateChecksEnabled || isChecking || isInstalling;
  const isUpdateClickable =
    !isUpdateDisabled && (updateAvailable || (!isChecking && !showUpToDate));

  // When no installer could be resolved for this target the button falls back to
  // the releases index, so the dialog has to say "browse" rather than "download".
  const hasDirectInstaller = portableInstallerUrl !== PORTABLE_RELEASES_URL;

  return (
    <>
      {showPortableUpdateDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-background border border-line rounded-lg p-6 max-w-md w-full mx-4 space-y-4">
            <h2 className="text-base font-semibold">
              {t("footer.portableUpdateTitle")}
            </h2>
            <p className="text-sm text-ink-2">
              {hasDirectInstaller
                ? t("footer.portableUpdateMessage")
                : t("footer.portableUpdateBrowseMessage")}
            </p>
            <div className="flex gap-2 justify-end">
              <button
                className="px-3 py-1.5 text-sm rounded border border-line hover:bg-wash transition-colors"
                onClick={() => setShowPortableUpdateDialog(false)}
              >
                {t("common.close")}
              </button>
              <button
                className="px-3 py-1.5 text-sm rounded bg-logo-primary text-white hover:bg-logo-primary/80 transition-colors"
                onClick={() => {
                  openUrl(portableInstallerUrl);
                  setShowPortableUpdateDialog(false);
                }}
              >
                {hasDirectInstaller
                  ? t("footer.portableUpdateButton")
                  : t("footer.portableUpdateBrowseButton")}
              </button>
            </div>
          </div>
        </div>
      )}
      <div className={`flex items-center gap-3 ${className}`}>
        {isUpdateClickable ? (
          <button
            onClick={getUpdateStatusAction()}
            disabled={isUpdateDisabled}
            className={`rounded transition-colors disabled:opacity-50 tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-logo-primary ${
              updateAvailable
                ? "text-logo-primary hover:text-logo-primary font-medium"
                : "text-ink-2 hover:text-text"
            }`}
          >
            {getUpdateStatusText()}
          </button>
        ) : (
          <span className="text-ink-2 tabular-nums">
            {getUpdateStatusText()}
          </span>
        )}

        {isInstalling && downloadProgress > 0 && downloadProgress < 100 && (
          <ProgressBar
            progress={[
              {
                id: "update",
                percentage: downloadProgress,
              },
            ]}
            size="large"
          />
        )}
      </div>
    </>
  );
};

export default UpdateChecker;
