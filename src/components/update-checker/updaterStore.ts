// Module-level updater state shared by every mounted UpdateChecker, so an
// install and a tray check request outlive the About page that shows them.

/** True only when the stored switch is on and the system lock is known to be off. */
export function updateChecksAllowed(
  stored: boolean | undefined,
  locked: boolean | null,
): boolean {
  return stored === true && locked === false;
}

export interface UpdaterState {
  readonly installing: boolean;
  readonly progress: number;
}

export type MountCheck = "none" | "manual" | "auto";

let state: UpdaterState = { installing: false, progress: 0 };
let manualCheckRequested = false;
const subscribers = new Set<() => void>();
const manualCheckSubscribers = new Set<() => void>();

function publish(next: UpdaterState): void {
  state = next;
  subscribers.forEach((notify) => notify());
}

export function getUpdaterState(): UpdaterState {
  return state;
}

export function subscribeUpdater(notify: () => void): () => void {
  subscribers.add(notify);
  return () => {
    subscribers.delete(notify);
  };
}

/** Starts an install; false when one is already running, so it is never started twice. */
export function beginInstall(): boolean {
  if (state.installing) return false;
  publish({ installing: true, progress: 0 });
  return true;
}

export function setInstallProgress(progress: number): void {
  if (!state.installing) return;
  publish({ installing: true, progress });
}

export function endInstall(): void {
  publish({ installing: false, progress: 0 });
}

/** The tray event: raise the request and tell the mounted checker, if any. */
export function requestManualCheck(): void {
  manualCheckRequested = true;
  manualCheckSubscribers.forEach((notify) => notify());
}

export function subscribeManualCheck(notify: () => void): () => void {
  manualCheckSubscribers.add(notify);
  return () => {
    manualCheckSubscribers.delete(notify);
  };
}

/** Consumes a pending request; true only when a manual check may run now (never during an install). */
export function takeManualCheck(): boolean {
  const requested = manualCheckRequested;
  manualCheckRequested = false;
  return requested && !state.installing;
}

/** What a freshly mounted checker does about checking; always clears a pending request. */
export function mountCheck(): MountCheck {
  if (state.installing) {
    manualCheckRequested = false;
    return "none";
  }
  return takeManualCheck() ? "manual" : "auto";
}
