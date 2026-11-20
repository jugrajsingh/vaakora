import type { Device, Result, TtsModelInfo } from "@/bindings";
import { runOutcome } from "./ReadAloudRows";

/** Whether the page is still mounted; every outcome that lands later goes through `live`. */
export function pageLife() {
  let alive = true;
  return {
    isAlive: () => alive,
    start: () => {
      alive = true;
    },
    dispose: () => {
      alive = false;
    },
    /** Wraps a UI setter so it applies only while the page is mounted. */
    live:
      <A extends unknown[]>(apply: (...args: A) => void) =>
      (...args: A): void => {
        if (alive) apply(...args);
      },
  };
}

export interface PageDeps {
  models: () => Promise<TtsModelInfo[]>;
  devices: () => Promise<Device[]>;
  refreshDownloads: () => Promise<void>;
  refreshSettings: () => Promise<void>;
  setModels: (models: TtsModelInfo[]) => void;
  setAvailable: (devices: Device[]) => void;
  setError: (error: string | null) => void;
  setDeletingId: (id: string | null) => void;
  deleteModel: (id: string) => Promise<Result<unknown, string>>;
  /** Speaks one voice; rejects when it could not start. */
  speak: (voice: string) => Promise<void>;
}

/** The page's async work with injected dependencies; no outcome applies after `life.dispose()`. */
export function pageActions(life: ReturnType<typeof pageLife>, deps: PageDeps) {
  const refresh = async () => {
    const next = await deps.models();
    life.live(deps.setModels)(next);
  };
  const run = (job: Promise<Result<unknown, string>>) =>
    runOutcome(job, {
      refresh,
      refreshSettings: deps.refreshSettings,
      show: life.live(deps.setError),
    });
  return {
    refresh,
    run,
    /** One poll: models, then downloads. */
    update: async () => {
      try {
        const next = await deps.models();
        life.live(deps.setModels)(next);
        await deps.refreshDownloads();
      } catch {
        life.live(deps.setError)("tts.errors.generic");
      }
    },
    loadDevices: () => {
      void deps
        .devices()
        .then(life.live(deps.setAvailable))
        .catch(() => {});
    },
    /** Deletes a model; the busy mark clears only while the page is mounted. */
    remove: (id: string) => {
      deps.setDeletingId(id);
      void run(deps.deleteModel(id)).finally(() =>
        life.live(deps.setDeletingId)(null),
      );
    },
    preview: async (voice: string) => {
      try {
        await deps.speak(voice);
      } catch {
        life.live(deps.setError)("tts.errors.generic");
      }
    },
    /** Shows each preview error the backend emits; returns the stop for the page's cleanup. */
    watchPreviewErrors: (
      register: (listener: (payload: string) => void) => Promise<() => void>,
    ): (() => void) => {
      let stop: (() => void) | undefined;
      void register(
        life.live((payload: string) =>
          deps.setError(
            payload.startsWith("tts.errors.") ? payload : "tts.errors.generic",
          ),
        ),
      ).then((unlisten) => {
        if (life.isAlive()) stop = unlisten;
        else unlisten();
      });
      return () => stop?.();
    },
  };
}

/** The page's open-row handler: any change of the open row discards the token draft. */
export function openChange(
  hide: () => void,
  setOpenId: (id: string | null) => void,
): (id: string | null) => void {
  return (id) => {
    hide();
    setOpenId(id);
  };
}
