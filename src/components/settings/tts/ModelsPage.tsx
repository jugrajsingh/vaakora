import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import {
  commands,
  type Device,
  type TtsModelInfo,
  type Result,
} from "@/bindings";
import { listen } from "@tauri-apps/api/event";
import { useRowConfirm } from "@/components/shared/InlineConfirm";
import { useSettings } from "@/hooks/useSettings";
import { useSettingsStore } from "@/stores/settingsStore";
import {
  downloadController,
  previewVoice,
  type TtsDownloadProgress,
} from "./actions";
import {
  ReadAloudRows,
  applyFor,
  presentFor,
  type AskedDelete,
} from "./ReadAloudRows";
import { openChange, pageActions, pageLife } from "./pageActions";
import { useToken } from "./useToken";
export function unwrapTts<T>(result: Result<T, string>): T {
  if (result.status === "error") throw new Error(result.error);
  return result.data;
}
const downloads = downloadController({
  query: async () =>
    unwrapTts(await commands.getTtsModels())
      .filter((model) => model.downloading)
      .map((model) => model.id),
  watch: async (listener) => {
    await listen<TtsDownloadProgress>("tts-download-progress", ({ payload }) =>
      listener(payload),
    );
  },
  download: async (id) => {
    unwrapTts(await commands.downloadTtsModel(id));
    await useSettingsStore.getState().refreshSettingsChecked();
  },
  cancel: async (id) => {
    unwrapTts(await commands.cancelTtsDownload(id));
  },
});
export function ModelsPage() {
  const { t } = useTranslation();
  const { refreshSettingsChecked } = useSettings();
  const [models, setModels] = useState<TtsModelInfo[]>([]);
  const [available, setAvailable] = useState<Device[]>(["cpu"]);
  const downloadState = useSyncExternalStore(
    downloads.subscribe,
    downloads.snapshot,
    downloads.snapshot,
  );
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [life] = useState(pageLife);
  const asked = useRef<AskedDelete | null>(null);
  const token = useToken();
  const actions = pageActions(life, {
    models: async () => unwrapTts(await commands.getTtsModels()),
    devices: async () => unwrapTts(await commands.getTtsDevices()),
    refreshDownloads: downloads.refresh,
    refreshSettings: refreshSettingsChecked,
    setModels,
    setAvailable,
    setError,
    setDeletingId,
    deleteModel: commands.deleteTtsModel,
    speak: async (voice) => {
      unwrapTts(
        await previewVoice(t, voice, (name, text) =>
          commands.previewTtsVoice(name, text),
        ),
      );
    },
  });
  useEffect(() => {
    life.start();
    void actions.update();
    actions.loadDevices();
    const stopWatching = actions.watchPreviewErrors((listener) =>
      listen<string>("tts-preview-error", ({ payload }) => listener(payload)),
    );
    const timer = setInterval(() => void actions.update(), 500);
    return () => {
      life.dispose();
      stopWatching();
      clearInterval(timer);
    };
  }, []);
  const view = () => ({
    asked: asked.current,
    models,
    active: downloadState.active,
    deletingId,
  });
  const deletion = useRowConfirm<string>({
    apply: applyFor(view, actions.remove),
    present: presentFor(view),
  });
  const shownError = error ?? downloadState.error;
  return (
    <div className="w-full max-w-3xl min-w-0">
      {shownError && (
        <p role="alert" className="px-[12px] pb-[8px] text-small text-text">
          {t(shownError)}
        </p>
      )}
      <div ref={deletion.rowsRef}>
        <ReadAloudRows
          models={models}
          available={available}
          downloads={downloadState}
          deletingId={deletingId}
          tokenSet={token.present}
          tokenState={token.state}
          tokenActions={token.entry}
          deletion={deletion}
          asked={asked.current}
          openId={openId}
          onOpenChange={openChange(token.entry.hide, setOpenId)}
          act={{
            use: (id) => void actions.run(commands.setTtsModel(id)),
            download: (id) => void downloads.download(id),
            cancel: (id) => void downloads.cancel(id),
            runOn: (id, value) =>
              void actions.run(commands.setTtsRunOn(id, value)),
            preview: actions.preview,
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
