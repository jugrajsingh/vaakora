import { beginInstall, endInstall, setInstallProgress } from "./updaterStore";

export type InstallEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

export interface UpdateHandle {
  downloadAndInstall(onEvent: (event: InstallEvent) => void): Promise<void>;
}

export interface InstallDeps {
  /** Current permission, read live: the switch can change while a call is pending. */
  allowed(): boolean;
  isPortable(): Promise<boolean>;
  check(): Promise<UpdateHandle | null>;
  relaunch(): Promise<void>;
  showPortableDialog(): void;
}

/** Install action: permission is re-read after each await, before the next network call. */
export async function runInstall(deps: InstallDeps): Promise<void> {
  if (!deps.allowed()) return;

  const portable = await deps.isPortable();
  if (!deps.allowed()) return;
  if (portable) {
    deps.showPortableDialog();
    return;
  }

  if (!beginInstall()) return;

  try {
    const update = await deps.check();
    if (!deps.allowed()) return;
    if (!update) {
      console.log("No update available during install attempt");
      return;
    }

    let downloaded = 0;
    let contentLength = 0;
    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          downloaded = 0;
          contentLength = event.data.contentLength ?? 0;
          break;
        case "Progress":
          downloaded += event.data.chunkLength;
          setInstallProgress(
            Math.min(
              contentLength > 0
                ? Math.round((downloaded / contentLength) * 100)
                : 0,
              100,
            ),
          );
          break;
      }
    });
    if (!deps.allowed()) return;
    await deps.relaunch();
  } catch (error) {
    console.error("Failed to install update:", error);
  } finally {
    endInstall();
  }
}
