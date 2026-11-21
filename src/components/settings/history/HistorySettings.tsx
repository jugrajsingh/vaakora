import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { readFile } from "@tauri-apps/plugin-fs";
import { ClipboardCopy, FileAudio, FilePlus, Trash2 } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { notify } from "@/stores/noticeStore";
import {
  commands,
  events,
  type HistoryCompareView,
  type HistoryEntry,
} from "@/bindings";
import { useOsType } from "@/hooks/useOsType";
import {
  useTranscriptionJobsStore,
  type ActiveJobStatus,
} from "@/stores/transcriptionJobsStore";
import { useSettings } from "@/hooks/useSettings";
import {
  boundShortcuts,
  cleanedText,
  copyHistoryRaw,
  historyCopyText,
  historyModelName,
  historyState,
  nextOpen,
  type BoundShortcut,
  shortDateTime,
} from "@/lib/utils/historyPresentation";
import { formatDateTime } from "@/utils/dateFormat";
import { Alert } from "../../ui/Alert";
import { AudioPlayer, AudioPlayerGroup } from "../../ui/AudioPlayer";
import { Button } from "../../ui/Button";
import { copyToClipboard } from "./clipboard";
import {
  pickAndTranscribeFiles,
  useFileReadsStore,
  type FileRead,
} from "./transcribeFiles";
import { HistoryCompare } from "./HistoryCompare";
import { HistoryActions } from "./HistoryActions";
import {
  InlineConfirm,
  useRowConfirm,
} from "@/components/shared/InlineConfirm";
import { ClearHistory } from "@/components/shared/ClearHistory";
import {
  HISTORY_ROW_GRID,
  HistoryRow,
  HistoryStateLine,
  HistoryToolbar,
} from "@/components/shared/HistoryList";
import { Keycaps } from "@/components/shared/Keycaps";
import { shortcutNameKey } from "@/lib/utils/shortcutPresentation";
import type { OSType } from "@/lib/utils/keyboard";
import { currentKeep, dictationSummary } from "@/lib/utils/retention";
import { useLocalLlmModels } from "../post-processing/LocalLlmSettings";
import {
  PageGeneration,
  createHistoryClear,
  createHistoryPageLoader,
  reloadHistoryOnUpdate,
  createHistoryScrollAnchor,
  createHistoryEntryActions,
  sameSummary,
} from "./pageGeneration";

const PAGE_SIZE = 30;

// The pulse of an entry's text while it's being transcribed.
const TRANSCRIBE_PULSE = {
  animation: "transcribe-pulse 3s ease-in-out infinite",
};

const TranscribePulseKeyframes: React.FC = () => (
  <style>{`
    @keyframes transcribe-pulse {
      0%, 100% { color: var(--color-ink-3); }
      50% { color: var(--color-text); }
    }
  `}</style>
);

// A dropped or picked file while its audio is read, before it's an entry.
const FileReadRow: React.FC<{ read: FileRead }> = ({ read }) => {
  const { t } = useTranslation();
  return (
    <div className="border-b border-line">
      <div className={HISTORY_ROW_GRID}>
        <span
          className="flex items-center gap-1 text-xs text-ink-2 whitespace-nowrap"
          title={read.name}
        >
          <FileAudio width={14} height={14} className="shrink-0" />
          <span className="max-w-[8rem] truncate">{read.name}</span>
        </span>
        <p className="min-w-0 text-sm" style={TRANSCRIBE_PULSE}>
          <TranscribePulseKeyframes />
          {t("settings.history.readingFile")}
        </p>
      </div>
    </div>
  );
};

interface HeaderButtonProps {
  onClick: () => void;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const HeaderButton: React.FC<HeaderButtonProps> = ({
  onClick,
  label,
  icon: Icon,
}) => (
  <Button
    onClick={onClick}
    variant="secondary"
    size="sm"
    className="flex shrink-0 items-center gap-2"
    title={label}
  >
    <Icon className="w-4 h-4" />
    <span>{label}</span>
  </Button>
);

const DICTATION_SHORTCUTS = ["transcribe", "transcribe_with_post_process"];

/** The dictation history's loading, not-kept and empty lines; the empty one names every bound shortcut. */
export function DictationStateLine({
  state,
  shortcuts,
  osType,
  transcribeFile,
}: {
  state: "loading" | "notKept" | "empty";
  shortcuts: readonly BoundShortcut[];
  osType: OSType;
  transcribeFile: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  if (state === "loading")
    return (
      <HistoryStateLine state="loading" title={t("settings.history.loading")} />
    );
  if (state === "notKept")
    return <HistoryStateLine state="notKept" title={t("history.notKept")} />;
  const keys = (shortcut: BoundShortcut) => (
    <span title={t(shortcutNameKey(shortcut.id))}>
      <Keycaps binding={shortcut.binding} osType={osType} size="line" />
    </span>
  );
  const dictate = shortcuts.find((shortcut) => shortcut.id === "transcribe");
  const cleanup = shortcuts.find(
    (shortcut) => shortcut.id === "transcribe_with_post_process",
  );
  let hint: React.ReactNode;
  if (dictate && cleanup)
    hint = (
      <Trans
        i18nKey="history.empty.dictationHint"
        components={{ dictate: keys(dictate), cleanup: keys(cleanup) }}
      />
    );
  else if (dictate || cleanup)
    hint = (
      <Trans
        i18nKey={
          dictate
            ? "history.empty.dictationHintDictate"
            : "history.empty.dictationHintCleanup"
        }
        components={{ keys: keys((dictate ?? cleanup)!) }}
      />
    );
  return (
    <HistoryStateLine
      state="empty"
      title={t("history.empty.dictation")}
      hint={hint}
      action={
        <HeaderButton
          onClick={transcribeFile}
          label={t("history.transcribeFile")}
          icon={FilePlus}
        />
      }
    />
  );
}

export const HistorySettings: React.FC<{ changeRetention: () => void }> = ({
  changeRetention,
}) => {
  const { t } = useTranslation();
  const osType = useOsType();
  const jobs = useTranscriptionJobsStore((state) => state.jobs);
  const reads = useFileReadsStore((state) => state.reads);
  const { models: localModels } = useLocalLlmModels();
  const { getSetting } = useSettings();
  const view = getSetting("history_compare_view") ?? "diff";
  const summary = dictationSummary(currentKeep(getSetting));
  const [actionError, setActionError] = useState<string | null>(null);
  const generation = useRef(new PageGeneration());
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  // The one open entry; UI state only, never stored.
  const [open, setOpen] = useState<number | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const entriesRef = useRef<HistoryEntry[]>([]);
  const loadingRef = useRef(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollAnchor = useMemo(
    () =>
      createHistoryScrollAnchor({
        getViewport: () => {
          const scroller = rootRef.current?.closest<HTMLElement>(
            "[data-settings-scroll]",
          );
          if (!scroller) return null;
          return {
            top: scroller.getBoundingClientRect().top,
            scrollTop: scroller.scrollTop,
            rows: Array.from(
              rootRef.current?.querySelectorAll<HTMLElement>(
                "[data-history-entry-id]",
              ) ?? [],
            ).map((element) => {
              const rect = element.getBoundingClientRect();
              return {
                id: element.dataset.historyEntryId ?? "",
                top: rect.top,
                bottom: rect.bottom,
              };
            }),
          };
        },
        setScrollTop: (scrollTop) => {
          const scroller = rootRef.current?.closest<HTMLElement>(
            "[data-settings-scroll]",
          );
          if (scroller) scroller.scrollTop = scrollTop;
        },
      }),
    [],
  );
  useLayoutEffect(() => {
    scrollAnchor.restore();
  }, [entries, scrollAnchor]);

  // Keep ref in sync for use in IntersectionObserver callback
  useLayoutEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  useEffect(() => {
    setOpen((current) =>
      nextOpen(current, { loading, ids: entries.map((entry) => entry.id) }),
    );
  }, [entries, loading]);

  const {
    loadPage,
    loadPageChecked,
    applyHistoryUpdate,
    setSaved,
    removeEntry,
  } = useMemo(
    () =>
      createHistoryPageLoader({
        generation: generation.current,
        loadingRef,
        getEntries: () => entriesRef.current,
        fetchPage: commands.getHistoryEntries,
        setEntries,
        setLoading,
        setHasMore,
        setError: setActionError,
        beforeCommit: scrollAnchor.capture,
      }),
    [scrollAnchor],
  );

  const clear = useMemo(
    () =>
      createHistoryClear({
        getEntries: commands.getHistoryEntries,
        getSummary: commands.getHistoryClearSummary,
        clear: commands.clearHistory,
        reload: loadPageChecked,
        setError: setActionError,
      }),
    [loadPageChecked],
  );

  // Initial load
  useEffect(() => {
    loadPage();
  }, [loadPage]);

  // Infinite scroll via IntersectionObserver
  useEffect(() => {
    if (loading) return;

    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore) return;

    const observer = new IntersectionObserver(
      (observerEntries) => {
        const first = observerEntries[0];
        if (first.isIntersecting) {
          const lastEntry = entriesRef.current[entriesRef.current.length - 1];
          if (lastEntry) {
            loadPage(lastEntry.id);
          }
        }
      },
      { threshold: 0 },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loading, hasMore, loadPage]);

  // Listen for new entries added from the transcription pipeline
  useEffect(() => {
    const unlisten = events.historyUpdatePayload.listen((event) => {
      const payload = event.payload;
      if (payload.action === "cleared") scrollAnchor.clear();
      if (payload.action === "deleted") applyHistoryUpdate(payload);
      reloadHistoryOnUpdate(payload, loadPage, applyHistoryUpdate);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [loadPage, applyHistoryUpdate, scrollAnchor]);

  const entryActions = useMemo(
    () =>
      createHistoryEntryActions({
        getEntry: (id) => entriesRef.current.find((entry) => entry.id === id),
        setSaved,
        removeEntry,
        toggleSaved: commands.toggleHistoryEntrySaved,
        deleteEntry: commands.deleteHistoryEntry,
        reload: loadPage,
        setError: setActionError,
      }),
    [setSaved, removeEntry, loadPage],
  );

  const getAudioUrl = useCallback(
    async (fileName: string) => {
      try {
        const result = await commands.getAudioFilePath(fileName);
        if (result.status === "ok") {
          if (osType === "linux") {
            const fileData = await readFile(result.data);
            const blob = new Blob([fileData], { type: "audio/wav" });
            return URL.createObjectURL(blob);
          }
          return convertFileSrc(result.data, "asset");
        }
        return null;
      } catch (error) {
        console.error("Failed to get audio file path:", error);
        return null;
      }
    },
    [osType],
  );

  const transcribeFile = async () => {
    try {
      await pickAndTranscribeFiles();
    } catch (error) {
      console.error("Failed to pick a file to transcribe:", error);
      notify({ title: t("settings.history.transcribeFailed") });
    }
  };

  const state = historyState({
    loading,
    failed: actionError !== null && entries.length === 0,
    count: entries.length + reads.length,
    kept: summary.kept,
  });
  let content: React.ReactNode = null;

  if (state === "loading" || state === "notKept" || state === "empty") {
    content = (
      <DictationStateLine
        state={state}
        shortcuts={boundShortcuts(getSetting("bindings"), DICTATION_SHORTCUTS)}
        osType={osType}
        transcribeFile={transcribeFile}
      />
    );
  } else if (state === "list") {
    content = (
      <>
        <AudioPlayerGroup>
          <div>
            {reads.map((read) => (
              <FileReadRow key={`read-${read.id}`} read={read} />
            ))}
            {entries.map((entry) => (
              <HistoryEntryComponent
                key={entry.id}
                entry={entry}
                job={jobs[entry.id]}
                view={view}
                modelName={historyModelName(entry, localModels)}
                open={open === entry.id}
                toggle={() =>
                  setOpen((current) => (current === entry.id ? null : entry.id))
                }
                onToggleSaved={() => void entryActions.toggleSaved(entry.id)}
                onCopyText={() => copyToClipboard(historyCopyText(entry))}
                onCopyRaw={() => copyToClipboard(entry.transcription_text)}
                getAudioUrl={getAudioUrl}
                deleteAudio={entryActions.deleteEntry}
                retryTranscription={commands.retryHistoryEntryTranscription}
                cancelTranscription={commands.cancelHistoryEntryTranscription}
                captureAnchor={scrollAnchor.capture}
                restoreAnchor={scrollAnchor.restore}
              />
            ))}
          </div>
        </AudioPlayerGroup>
        {/* Sentinel for infinite scroll */}
        <div ref={sentinelRef} className="h-1" />
      </>
    );
  }

  return (
    <div ref={rootRef} className="w-full max-w-3xl min-w-0 space-y-2">
      <HistoryToolbar
        summary={t(summary.key, { count: summary.count })}
        change={changeRetention}
      >
        <HeaderButton
          onClick={transcribeFile}
          label={t("history.transcribeFile")}
          icon={FilePlus}
        />
        <ClearHistory
          count={clear.count}
          empty={(counted) => counted.entries === 0}
          same={sameSummary}
          message={(counted) =>
            t("history.clear.dictationConfirm", {
              count: counted.entries,
              recordings: t("history.clear.recordings", {
                count: counted.recordings,
              }),
            })
          }
          nothing={t("history.clear.nothing")}
          clear={clear.clear}
          disabled={loading}
        />
      </HistoryToolbar>
      {actionError && (
        <div role="alert" className="px-4">
          <Alert variant="error">{actionError}</Alert>
        </div>
      )}
      <div>{content}</div>
    </div>
  );
};

interface EntryBodyProps {
  entry: HistoryEntry;
  view: HistoryCompareView;
  modelName: string | null;
  /** The transcript, its progress, or why there is none. */
  text: React.ReactNode;
  muted?: boolean;
  retrying: boolean;
  cancelling: boolean;
  loadAudio: () => Promise<string | null>;
  onCopyRaw: () => void;
  onRetranscribe: () => void;
  onCancel: () => void;
  onDelete: () => Promise<void>;
}

/** The open entry: its text or comparison, the audio player, then labelled actions or the delete question. */
export function EntryBody({
  entry,
  view,
  modelName,
  text,
  muted = false,
  retrying,
  cancelling,
  loadAudio,
  onCopyRaw,
  onRetranscribe,
  onCancel,
  onDelete,
}: EntryBodyProps): React.JSX.Element {
  const { t } = useTranslation();
  const deletion = useRowConfirm<number>({ apply: () => onDelete() });
  const processed = cleanedText(entry) !== null;
  return (
    <div className="space-y-3">
      {!retrying && processed ? (
        <HistoryCompare entry={entry} view={view} modelName={modelName} />
      ) : (
        <p
          className={`text-sm whitespace-pre-wrap break-words select-text ${
            muted ? "text-ink-3" : "cursor-text"
          }`}
        >
          {text}
        </p>
      )}
      <AudioPlayer onLoadRequest={loadAudio} className="w-full" />
      <div ref={deletion.rowsRef} className="flex flex-wrap items-center gap-2">
        {deletion.asking !== null ? (
          <InlineConfirm
            message={t("settings.history.deleteConfirm")}
            action={t("settings.history.deleteConfirmAction")}
            onCancel={deletion.cancel}
            onConfirm={deletion.confirm}
          />
        ) : (
          <>
            {processed && (
              <Button
                variant="secondary"
                size="sm"
                className="flex items-center gap-1.5"
                disabled={
                  entry.transcription_text.trim().length === 0 || retrying
                }
                onClick={onCopyRaw}
              >
                <ClipboardCopy className="w-3.5 h-3.5" />
                {t("history.copyOriginal")}
              </Button>
            )}
            {retrying ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={cancelling}
                onClick={onCancel}
              >
                {t("history.cancelTranscription")}
              </Button>
            ) : (
              <Button variant="secondary" size="sm" onClick={onRetranscribe}>
                {t("history.retranscribe")}
              </Button>
            )}
            {/* Cancel returns focus to the first enabled button in this confirm row: Delete. */}
            <span data-confirm-row={entry.id} className="contents">
              <Button
                variant="secondary"
                size="sm"
                className="flex items-center gap-1.5"
                disabled={retrying}
                onClick={() => deletion.ask(entry.id)}
              >
                <Trash2 className="w-3.5 h-3.5" />
                {t("history.delete")}
              </Button>
            </span>
          </>
        )}
      </div>
    </div>
  );
}

interface HistoryEntryProps {
  entry: HistoryEntry;
  job?: ActiveJobStatus;
  view: HistoryCompareView;
  modelName: string | null;
  open: boolean;
  toggle: () => void;
  onToggleSaved: () => void;
  onCopyText: () => Promise<boolean>;
  onCopyRaw: () => Promise<boolean>;
  getAudioUrl: (fileName: string) => Promise<string | null>;
  deleteAudio: (id: number) => Promise<void>;
  retryTranscription: (id: number) => Promise<void>;
  cancelTranscription: (id: number) => Promise<void>;
  captureAnchor: () => void;
  restoreAnchor: () => void;
}

export const HistoryEntryComponent: React.FC<HistoryEntryProps> = ({
  entry,
  job,
  view,
  modelName,
  open,
  toggle,
  onToggleSaved,
  onCopyText,
  onCopyRaw,
  getAudioUrl,
  deleteAudio,
  retryTranscription,
  cancelTranscription,
  captureAnchor,
  restoreAnchor,
}) => {
  const { t, i18n } = useTranslation();
  const [showCopied, setShowCopied] = useState(false);
  // Pressed cancel: a running job stops after its current chunk. Kept here so closing the entry keeps it.
  const [cancelling, setCancelling] = useState(false);

  // Queued or being transcribed in the background.
  const retrying = job !== undefined;
  useLayoutEffect(() => {
    restoreAnchor();
  }, [retrying, restoreAnchor]);
  useEffect(() => {
    if (!retrying) setCancelling(false);
  }, [retrying]);
  const hasTranscription = historyCopyText(entry).trim().length > 0;
  const processed = cleanedText(entry) !== null;

  const handleLoadAudio = useCallback(
    () => getAudioUrl(entry.file_name),
    [getAudioUrl, entry.file_name],
  );

  const handleCopyText = async () => {
    if (!hasTranscription) {
      return;
    }

    const copied = await onCopyText();
    if (!copied) {
      notify({ title: t("settings.history.copyError") });
      return;
    }

    setShowCopied(true);
    setTimeout(() => setShowCopied(false), 2000);
  };

  const handleDeleteEntry = async () => {
    try {
      await deleteAudio(entry.id);
    } catch (error) {
      console.error("Failed to delete entry:", error);
      notify({ title: t("settings.history.deleteError") });
    }
  };

  const handleRetranscribe = async () => {
    captureAnchor();
    try {
      await retryTranscription(entry.id);
    } catch (error) {
      console.error("Failed to re-transcribe:", error);
      notify({ title: t("settings.history.retranscribeError") });
    }
  };

  let progressText = t("settings.history.transcribing");
  if (job?.state === "queued") {
    progressText = t("settings.history.waiting");
  } else if (job?.state === "running" && job.percent > 0) {
    progressText = t("settings.history.transcribingPercent", {
      percent: job.percent,
    });
  }

  const muted = !retrying && !hasTranscription;
  const text = retrying ? (
    <span style={TRANSCRIBE_PULSE}>
      <TranscribePulseKeyframes />
      {progressText}
    </span>
  ) : hasTranscription ? (
    historyCopyText(entry)
  ) : entry.source_name ? (
    // Cancelled, interrupted by a quit, or failed.
    t("history.notTranscribedLine", { action: t("history.retranscribe") })
  ) : (
    t("history.failedLine", { action: t("history.retranscribe") })
  );

  return (
    <HistoryRow
      id={entry.id}
      open={open}
      onToggle={toggle}
      when={{
        short: shortDateTime(entry.timestamp, i18n.language),
        long: formatDateTime(String(entry.timestamp), i18n.language),
      }}
      excerpt={text}
      excerptClass={muted ? "text-ink-3" : undefined}
      tag={
        entry.source_name ??
        (processed
          ? (modelName ?? t("history.cleaned"))
          : t("history.noCleanup"))
      }
      actions={
        <HistoryActions
          processed={processed}
          hasText={hasTranscription}
          saved={entry.saved}
          retrying={retrying}
          copied={showCopied}
          onCopy={() => void handleCopyText()}
          onToggleSaved={onToggleSaved}
        />
      }
    >
      <EntryBody
        entry={entry}
        view={view}
        modelName={modelName}
        text={text}
        muted={muted}
        retrying={retrying}
        cancelling={cancelling}
        loadAudio={handleLoadAudio}
        onCopyRaw={() =>
          void copyHistoryRaw(onCopyRaw, () =>
            notify({ title: t("settings.history.copyError") }),
          )
        }
        onRetranscribe={() => void handleRetranscribe()}
        onCancel={() => {
          setCancelling(true);
          void cancelTranscription(entry.id);
        }}
        onDelete={handleDeleteEntry}
      />
    </HistoryRow>
  );
};
