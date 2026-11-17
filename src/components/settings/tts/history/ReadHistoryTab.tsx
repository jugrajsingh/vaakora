import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ask } from "@tauri-apps/plugin-dialog";
import { commands, type ReadHistoryEntry, type TtsModelInfo } from "@/bindings";
import { Alert } from "@/components/ui/Alert";
import { useSettings } from "@/hooks/useSettings";
import { unwrapTts } from "../ModelsPage";
import { CorrectionBox } from "../vocabulary/CorrectionBox";
import {
  createHistoryActions,
  createSettingSetters,
  shownEntry,
} from "./actions";
import { tokensOf, type TokenSelection } from "./alignment";
import { HistorySettingsRow } from "./HistorySettingsRow";
import { entryHeading, entryLines } from "./presentation";
import { ReadingView } from "./ReadingView";
import { activeRange, correctionFor, type ReadSelection } from "./selection";

/** The past reads, the selected one word under word, and a correction for a chunk dragged over. */
export function ReadHistoryTab({
  models,
}: {
  models: readonly TtsModelInfo[];
}) {
  const { t, i18n } = useTranslation();
  const { refreshSettings } = useSettings();
  const [entries, setEntries] = useState<ReadHistoryEntry[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [chosen, setChosen] = useState<number | null>(null);
  const [selection, setSelection] = useState<ReadSelection | null>(null);
  const actions = useMemo(() => {
    const setters = createSettingSetters({
      setLimit: (limit) => commands.setTtsHistoryLimit(limit),
      setRetention: (retention) => commands.setTtsHistoryRetention(retention),
      refresh: refreshSettings,
    });
    return createHistoryActions({
      load: async () => unwrapTts(await commands.getTtsHistory()),
      clear: async () => unwrapTts(await commands.clearTtsHistory()),
      confirm: (count) =>
        ask(t("tts.history.clear.confirmation", { count }), {
          title: t("tts.history.clear.title"),
          kind: "warning",
          okLabel: t("tts.history.clear.title"),
          cancelLabel: t("tts.vocabulary.buttons.cancel"),
        }),
      ...setters,
      setEntries,
      setClearing,
      setError: setFailure,
    });
  }, [t, refreshSettings]);
  useEffect(() => {
    void actions.load();
  }, [actions]);
  const entry = shownEntry(entries, chosen);
  const tokens = useMemo(() => (entry ? tokensOf(entry) : []), [entry]);
  const range = activeRange(selection, entry);
  const correction =
    entry && range ? correctionFor(entry, tokens, range) : null;
  const select = (next: TokenSelection) =>
    entry && setSelection({ entry: entry.id, range: next });
  return (
    <section className="max-w-3xl w-full mx-auto space-y-4">
      {failure && (
        <div role="alert">
          <Alert>{t(failure)}</Alert>
        </div>
      )}
      <HistorySettingsRow
        entries={entries}
        refresh={actions.load}
        clearing={clearing}
        canClear={(entries?.length ?? 0) > 0}
        clear={() => void actions.clear(entries?.length ?? 0)}
        changeLimit={(limit) => void actions.changeLimit(limit)}
        changeRetention={(retention) => void actions.changeRetention(retention)}
      />
      {entry ? (
        <div className="flex gap-4 items-start">
          <ul className="w-56 shrink-0 space-y-1">
            {entries?.map((row) => {
              const lines = entryLines(models, row, i18n.language);
              return (
                <li key={row.id}>
                  <button
                    type="button"
                    aria-current={row.id === entry.id}
                    onClick={() => {
                      setChosen(row.id);
                      setSelection(null);
                    }}
                    className={`w-full text-start px-3 py-2 rounded-lg text-sm cursor-pointer transition-colors ${
                      row.id === entry.id
                        ? "bg-logo-primary/20 font-medium"
                        : "hover:bg-logo-primary/10"
                    }`}
                  >
                    <span className="block">{lines.when}</span>
                    <span className="block text-xs text-ink-3">
                      {lines.voice}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="flex-grow min-w-0 space-y-4">
            <p className="text-xs text-ink-3">
              {entryHeading(t, models, entry, i18n.language)}
            </p>
            <p className="text-xs text-ink-3">{t("tts.history.hint")}</p>
            <ReadingView
              key={entry.id}
              tokens={tokens}
              selection={range}
              onSelect={select}
            />
            {correction && (
              <CorrectionBox
                key={correction.key}
                written={correction.written}
                spokenAs={correction.spokenAs}
                readingModel={correction.readingModel}
                models={models}
                onSaved={() => {}}
                onClose={() => setSelection(null)}
              />
            )}
          </div>
        </div>
      ) : (
        entries && (
          <p className="text-sm text-ink-3 px-4">{t("tts.history.empty")}</p>
        )
      )}
    </section>
  );
}
