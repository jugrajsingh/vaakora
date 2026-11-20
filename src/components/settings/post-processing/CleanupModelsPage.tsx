import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useRowConfirm } from "@/components/shared/InlineConfirm";
import { useSettings } from "@/hooks/useSettings";
import { useLocalLlmStatus } from "@/hooks/useLocalLlmStatus";
import { useLocalLlmDownloadStore } from "@/stores/localLlmDownloadStore";
import {
  CleanupRows,
  cleanupApply,
  cleanupPresent,
  cleanupRuntime,
  type CleanupAsked,
  type CleanupDeleteView,
} from "./CleanupRows";
import { useLocalLlmActions, useLocalLlmModels } from "./LocalLlmSettings";

/** Models, Cleanup: the local cleanup models in the shared manager table. */
export function CleanupModelsPage() {
  const { t } = useTranslation();
  const { getSetting } = useSettings();
  const { models, loadState, loadError, reloadChecked } = useLocalLlmModels();
  const { actions, deletingId, error } = useLocalLlmActions(reloadChecked);
  const { status, error: statusError } = useLocalLlmStatus();
  const downloadId = useLocalLlmDownloadStore((state) => state.modelId);
  const percentage = useLocalLlmDownloadStore((state) => state.percentage);
  const downloadError = useLocalLlmDownloadStore((state) => state.error);
  const [openId, setOpenId] = useState<string | null>(null);
  const asked = useRef<CleanupAsked | null>(null);
  const selectedId = getSetting("local_llm_model_id") ?? null;

  // The question checks the live download and delete, not the last render's.
  const view = (): CleanupDeleteView => ({
    asked: asked.current,
    models,
    selectedId,
    downloadId: useLocalLlmDownloadStore.getState().modelId,
    deletingId: useLocalLlmDownloadStore.getState().deletingId,
  });
  const deletion = useRowConfirm<string>({
    apply: cleanupApply(view, (id) => void actions.delete(id)),
    present: cleanupPresent(view),
  });

  if (loadState === "loading") {
    return (
      <p
        role="status"
        className="px-[12px] py-16 text-center text-small text-ink-3"
      >
        {t("settings.jobModel.loading")}
      </p>
    );
  }
  const shownError = downloadError ?? error ?? statusError ?? loadError;
  return (
    <div className="w-full max-w-3xl min-w-0">
      {shownError && (
        <p role="alert" className="px-[12px] pb-[8px] text-small text-text">
          {t("settings.postProcessing.localLlm.status.error", {
            reason: shownError,
          })}
        </p>
      )}
      <div ref={deletion.rowsRef}>
        <CleanupRows
          models={models}
          selectedId={selectedId}
          downloadId={downloadId}
          deletingId={deletingId}
          percentage={percentage}
          runtime={cleanupRuntime(status, selectedId)}
          deletion={deletion}
          asked={asked.current}
          openId={openId}
          onOpenChange={setOpenId}
          act={{
            select: (id) => void actions.select(id),
            download: (id) => void actions.download(id),
            ask: (next) => {
              asked.current = next;
              deletion.ask(next.id);
            },
          }}
        />
      </div>
    </div>
  );
}
