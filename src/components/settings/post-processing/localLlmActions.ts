import type { LocalLlmModelInfo, Result } from "@/bindings";

export interface LocalLlmActionDependencies {
  isBusy: () => boolean;
  clearError: () => void;
  setError: (message: string | null) => void;
  setDeletingId: (id: string | null) => void;
  setLocalLlmModel: (id: string) => Promise<Result<null, string>>;
  deleteLocalLlmModel: (id: string) => Promise<Result<null, string>>;
  downloadLocalLlmModel: (id: string) => Promise<void>;
  refreshSettingsChecked: () => Promise<void>;
  reloadChecked: () => Promise<void>;
  modelsChanged: () => void;
}

export function createLocalLlmActions(deps: LocalLlmActionDependencies) {
  const begin = () => {
    if (deps.isBusy()) return false;
    deps.clearError();
    deps.setError(null);
    return true;
  };
  const errorMessage = (error: unknown) =>
    error instanceof Error ? error.message : String(error);
  return {
    select: async (id: string) => {
      if (!begin()) return;
      try {
        const result = await deps.setLocalLlmModel(id);
        if (result.status === "error") throw new Error(result.error);
        await deps.refreshSettingsChecked();
      } catch (error: unknown) {
        deps.setError(errorMessage(error));
      }
    },
    download: async (id: string) => {
      if (!begin()) return;
      try {
        await deps.downloadLocalLlmModel(id);
      } catch (error: unknown) {
        deps.setError(errorMessage(error));
      }
    },
    delete: async (id: string) => {
      if (!begin()) return;
      deps.setDeletingId(id);
      try {
        const result = await deps.deleteLocalLlmModel(id);
        if (result.status === "error") throw new Error(result.error);
        deps.modelsChanged();
        await deps.reloadChecked();
        await deps.refreshSettingsChecked();
      } catch (error: unknown) {
        deps.setError(errorMessage(error));
      } finally {
        deps.setDeletingId(null);
      }
    },
  };
}

/** Applies `apply` only when `alive()` holds: a page's own state is not set once the page is gone. */
export function whileAlive<A extends unknown[]>(
  alive: () => boolean,
  apply: (...args: A) => void,
): (...args: A) => void {
  return (...args) => {
    if (alive()) apply(...args);
  };
}

/** Reads the registry and sets the list only when the page is alive; a failed read rejects. */
export function createModelsLoader(deps: {
  fetch: () => Promise<LocalLlmModelInfo[]>;
  set: (models: LocalLlmModelInfo[]) => void;
  alive: () => boolean;
}): () => Promise<void> {
  return async () => {
    const models = await deps.fetch();
    whileAlive(deps.alive, deps.set)(models);
  };
}
