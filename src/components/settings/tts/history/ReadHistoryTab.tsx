import { useEffect, useMemo, useReducer, useState, type Dispatch } from "react";
import { Trans, useTranslation } from "react-i18next";
import { ClipboardCopy, Copy } from "lucide-react";
import { commands, type ReadHistoryEntry, type TtsModelInfo } from "@/bindings";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { ClearHistory } from "@/components/shared/ClearHistory";
import {
  HistoryRow,
  HistoryStateLine,
  HistoryToolbar,
} from "@/components/shared/HistoryList";
import { Keycaps } from "@/components/shared/Keycaps";
import { useOsType } from "@/hooks/useOsType";
import { useSettings } from "@/hooks/useSettings";
import {
  boundShortcuts,
  copyHistoryRaw,
  historyState,
  shortDateTime,
} from "@/lib/utils/historyPresentation";
import type { OSType } from "@/lib/utils/keyboard";
import { DEFAULT_READ_LIMIT, readSummary } from "@/lib/utils/retention";
import { notify } from "@/stores/noticeStore";
import { formatDateTime } from "@/utils/dateFormat";
import { copyToClipboard } from "../../history/clipboard";
import { unwrapTts } from "../ModelsPage";
import { CorrectionBox } from "../vocabulary/CorrectionBox";
import {
  createHistoryActions,
  sameReadCount,
  type HistoryDependencies,
} from "./actions";
import { tokensOf } from "./alignment";
import { entryTag } from "./presentation";
import { ReadingView } from "./ReadingView";
import {
  activeRange,
  NO_READ_VIEW,
  readView,
  type ReadView,
  type ReadViewAction,
} from "./selection";

/** The read actions wired to the view reducer: every loaded list and a clear reach it. */
export function readHistoryActions({
  dispatch,
  setEntries,
  ...deps
}: Omit<HistoryDependencies, "cleared"> & {
  dispatch: Dispatch<ReadViewAction>;
}) {
  return createHistoryActions({
    ...deps,
    setEntries: (entries) => {
      setEntries(entries);
      dispatch({ type: "loaded", ids: entries.map((entry) => entry.id) });
    },
    cleared: () => dispatch({ type: "cleared" }),
  });
}

/** One read per line, opening in place with the reading view; a correction shows from the view. */
export function ReadHistoryRows({
  entries,
  models,
  view,
  dispatch,
  copy,
}: {
  entries: readonly ReadHistoryEntry[];
  models: readonly TtsModelInfo[];
  view: ReadView;
  dispatch: Dispatch<ReadViewAction>;
  copy: (text: string) => Promise<boolean>;
}) {
  const { t, i18n } = useTranslation();
  const open = entries.find((entry) => entry.id === view.open);
  const tokens = useMemo(() => (open ? tokensOf(open) : []), [open]);
  const copyRead = (entry: ReadHistoryEntry) =>
    copyHistoryRaw(
      () => copy(entry.source),
      () => notify({ title: t("tts.history.copyFailed") }),
    );
  return (
    <>
      {entries.map((entry) => (
        <HistoryRow
          key={entry.id}
          id={entry.id}
          open={entry.id === view.open}
          onToggle={() => dispatch({ type: "toggle", id: entry.id })}
          when={{
            short: shortDateTime(entry.timestamp, i18n.language),
            long: formatDateTime(String(entry.timestamp), i18n.language),
          }}
          excerpt={entry.source.replace(/\s+/g, " ").trim()}
          tag={entryTag(models, entry)}
          actions={
            <button
              type="button"
              title={t("history.copy")}
              aria-label={t("history.copy")}
              onClick={() => void copyRead(entry)}
              className="p-1.5 rounded-md flex items-center justify-center text-ink-2 hover:text-logo-primary transition-colors cursor-pointer"
            >
              <Copy width={16} height={16} />
            </button>
          }
        >
          <div className="space-y-3">
            <p className="text-xs text-ink-2">{t("tts.history.readingHint")}</p>
            <ReadingView
              key={entry.id}
              tokens={tokens}
              selection={activeRange(view.selection, entry)}
              onSelect={(range) =>
                dispatch({ type: "select", entry, tokens, range })
              }
            />
            <Button
              variant="secondary"
              size="sm"
              className="flex items-center gap-1.5"
              onClick={() => void copyRead(entry)}
            >
              <ClipboardCopy className="w-3.5 h-3.5" />
              {t("history.copy")}
            </Button>
          </div>
        </HistoryRow>
      ))}
      {view.correction && (
        <CorrectionBox
          key={view.correction.key}
          written={view.correction.written}
          spokenAs={view.correction.spokenAs}
          readingModel={view.correction.readingModel}
          models={models}
          onSaved={() => {}}
          onClose={() => dispatch({ type: "closeCorrection" })}
        />
      )}
    </>
  );
}

/** The read history's loading, not-kept and empty lines; the empty one names the shortcut. */
export function ReadHistoryStateLine({
  state,
  binding,
  osType,
}: {
  state: "loading" | "notKept" | "empty";
  binding: string | null;
  osType: OSType;
}) {
  const { t } = useTranslation();
  if (state === "loading")
    return (
      <HistoryStateLine state="loading" title={t("settings.history.loading")} />
    );
  if (state === "notKept")
    return <HistoryStateLine state="notKept" title={t("history.notKept")} />;
  return (
    <HistoryStateLine
      state="empty"
      title={t("history.empty.read")}
      hint={
        binding !== null && (
          <Trans
            i18nKey="history.empty.readHint"
            components={{
              keys: <Keycaps binding={binding} osType={osType} size="line" />,
            }}
          />
        )
      }
    />
  );
}

/** The past reads, one per line; the open one word under word, and a correction for a chunk dragged over. */
export function ReadHistoryTab({
  models,
  changeRetention,
}: {
  models: readonly TtsModelInfo[];
  changeRetention: () => void;
}) {
  const { t } = useTranslation();
  const osType = useOsType();
  const { getSetting } = useSettings();
  const summary = readSummary(
    getSetting("tts_history_limit") ?? DEFAULT_READ_LIMIT,
    getSetting("tts_history_retention") ?? "keep_limit",
  );
  const [entries, setEntries] = useState<ReadHistoryEntry[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [view, dispatch] = useReducer(readView, NO_READ_VIEW);
  const state = historyState({
    loading: entries === null && failure === null,
    failed: failure !== null,
    count: entries?.length ?? 0,
    kept: summary.kept,
  });
  const actions = useMemo(
    () =>
      readHistoryActions({
        load: async () => unwrapTts(await commands.getTtsHistory()),
        clear: async () => unwrapTts(await commands.clearTtsHistory()),
        setEntries,
        setError: setFailure,
        dispatch,
      }),
    [],
  );
  useEffect(() => {
    void actions.load();
  }, [actions]);
  return (
    <section className="max-w-3xl w-full mx-auto space-y-4">
      <HistoryToolbar
        summary={t(summary.key, { count: summary.count })}
        change={changeRetention}
      >
        <ClearHistory
          count={actions.count}
          empty={(counted) => counted.count === 0}
          same={sameReadCount}
          message={(counted) =>
            t("history.clear.readConfirm", { count: counted.count })
          }
          nothing={t("history.clear.nothing")}
          clear={actions.clear}
          disabled={!entries?.length}
        />
      </HistoryToolbar>
      {failure && (
        <div role="alert">
          <Alert>{t(failure)}</Alert>
        </div>
      )}
      {(state === "loading" || state === "notKept" || state === "empty") && (
        <ReadHistoryStateLine
          state={state}
          binding={
            boundShortcuts(getSetting("bindings"), ["read_aloud"])[0]
              ?.binding ?? null
          }
          osType={osType}
        />
      )}
      <ReadHistoryRows
        entries={entries ?? []}
        models={models}
        view={view}
        dispatch={dispatch}
        copy={copyToClipboard}
      />
    </section>
  );
}
