import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import {
  commands,
  type TtsModelInfo,
  type VocabularyTable as VocabularyData,
} from "@/bindings";
import { Alert } from "@/components/ui/Alert";
import { unwrapTts } from "../ModelsPage";
import { createVocabularyActions, type Failure } from "./actions";
import { NO_FILTERS, type Filters } from "./filter";
import {
  VocabularyView,
  type Correction,
  type EntryOpen,
} from "./VocabularyView";

export function VocabularyTab({ models }: { models: readonly TtsModelInfo[] }) {
  const { t } = useTranslation();
  const [table, setTable] = useState<VocabularyData | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [editing, setEditing] = useState<EntryOpen | null>(null);
  const [correction, setCorrection] = useState<Correction | "starting" | null>(
    null,
  );
  const actions = useMemo(
    () =>
      createVocabularyActions({
        load: async () => unwrapTts(await commands.getTtsVocabulary()),
        save: async (revision, edits) => {
          const result = await commands.saveTtsVocabulary(revision, edits);
          return result.status === "ok" ? result.data : result.error;
        },
        listen: async (text, model) => {
          unwrapTts(await commands.listenTtsVocabulary(text, model));
        },
        speak: async (written, model) =>
          unwrapTts(await commands.speakTtsText(written, model)),
        setTable,
        onPreviewError: (listener) =>
          listen<string>("tts-preview-error", ({ payload }) =>
            listener(payload),
          ),
        setError: (key, message) =>
          setFailure(key === null ? null : { key, message }),
      }),
    [],
  );
  useEffect(() => {
    void actions.load();
    return actions.watch();
  }, [actions]);
  if (!table) {
    return failure && <Alert>{t(failure.key)}</Alert>;
  }
  return (
    <VocabularyView
      table={table}
      models={models}
      failure={failure}
      filters={filters}
      setFilters={setFilters}
      editing={editing}
      setEditing={setEditing}
      correction={correction}
      setCorrection={setCorrection}
      readingModel={models.find((model) => model.active)?.id ?? ""}
      actions={actions}
      reload={() => void actions.load()}
      openFolder={() => void commands.openAppDataDir()}
    />
  );
}
