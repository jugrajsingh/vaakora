import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  CircleAlert,
  ClipboardPaste,
  Pause,
  Play,
  TriangleAlert,
  X,
} from "lucide-react";
import type { SessionSnapshot } from "@/bindings";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Textarea";
import { Tooltip } from "@/components/ui/Tooltip";
import { createFollower, followTarget } from "@/lib/utils/followScroll";
import { routePopupKey } from "./actions";
import {
  highlightedText,
  progressPresentation,
  popupMode,
  reasonLine,
  registerPopupPaste,
  restorePopupEditor,
  routeTextClick,
  stateWord,
  textEditable,
  timeLabel,
} from "./presentation";
const focusRing = "focus-visible:ring-2 focus-visible:ring-logo-primary";

const markInView = (preview: HTMLElement, mark: HTMLElement) => {
  const view = preview.getBoundingClientRect();
  const box = mark.getBoundingClientRect();
  return box.bottom > view.top && box.top < view.bottom;
};

export interface PopupProps {
  text: string;
  snapshot: SessionSnapshot;
  heading: { model: string; voice: string } | null;
  editing: boolean;
  enterEdit: (text: string) => void;
  edit: (text: string) => void;
  toggle: () => void;
  close: () => void;
  readClipboard: () => void;
  models: () => void;
}
export function ReadAloudPopup({
  text,
  snapshot,
  heading,
  editing,
  enterEdit,
  edit,
  toggle,
  close,
  readClipboard,
  models,
}: PopupProps) {
  const { t } = useTranslation();
  const mark = useRef<HTMLElement>(null);
  const preview = useRef<HTMLDivElement | null>(null);
  const editor = useRef<HTMLTextAreaElement | null>(null);
  const caret = useRef<{ start: number; end: number } | null>(null);
  const [follower] = useState(createFollower);
  const attachPreview = useCallback(
    (node: HTMLDivElement | null) => {
      preview.current = node;
      if (node) follower.reset();
    },
    [follower],
  );
  const parts = highlightedText(
    text,
    snapshot.source_start,
    snapshot.source_end,
  );
  const progress = progressPresentation(snapshot);
  const time = timeLabel(snapshot, t);
  const word = stateWord(snapshot.state);
  const reason = reasonLine(snapshot);
  const mode = popupMode(snapshot.state, editing);
  const playing =
    snapshot.state === "playing" || snapshot.state === "buffering";
  useEffect(() => follower.reset(), [follower, text]);
  useEffect(() => {
    follower.sentenceStarted(snapshot.source_start);
    const view = preview.current;
    const current = mark.current;
    if (!view || !current || !follower.shouldFollow()) return;
    const box = current.getBoundingClientRect();
    const target = followTarget({
      markTop: box.top - view.getBoundingClientRect().top + view.scrollTop,
      lineHeight:
        Number.parseFloat(getComputedStyle(view).lineHeight) || box.height,
    });
    const before = view.scrollTop;
    view.scrollTop = target;
    if (view.scrollTop !== before) follower.programmatic();
  }, [follower, snapshot.source_start, snapshot.source_end, mode]);
  useLayoutEffect(() => {
    if (mode !== "editing" || !caret.current || !editor.current) return;
    restorePopupEditor(editor.current, caret.current);
    caret.current = null;
  });
  const textSelection = () => {
    const selection = window.getSelection();
    const root = preview.current;
    if (!selection?.rangeCount || !root) return null;
    const selected = selection.getRangeAt(0);
    if (
      !root.contains(selected.startContainer) ||
      !root.contains(selected.endContainer)
    )
      return null;
    const prefix = selected.cloneRange();
    prefix.selectNodeContents(root);
    prefix.setEnd(selected.startContainer, selected.startOffset);
    const start = prefix.toString().length;
    return { start, end: start + selected.toString().length };
  };
  useEffect(() =>
    registerPopupPaste(window, {
      isEditorTarget: (target) => target === editor.current,
      getText: () => text,
      getSelection: () =>
        mode === "reading"
          ? textSelection()
          : editor.current
            ? {
                start: editor.current.selectionStart,
                end: editor.current.selectionEnd,
              }
            : null,
      isActive: () => !textEditable(snapshot.state),
      enterEdit: (next, position) => {
        caret.current = { start: position, end: position };
        enterEdit(next);
      },
    }),
  );
  return (
    <section
      className="h-screen flex flex-col overflow-hidden rounded-card border border-line-strong bg-background text-text text-[14px] leading-[20px]"
      aria-label={t("tts.title")}
      onKeyDownCapture={(event) => routePopupKey(event, { close, toggle })}
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-3 py-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 font-medium">{t("tts.title")}</span>
          {heading && (
            <Tooltip
              text={t("tts.modelVoice", heading)}
              className="min-w-0 grid-cols-[minmax(0,1fr)]"
            >
              <span className="min-w-0 truncate text-ink-2">
                {t("tts.modelVoice", heading)}
              </span>
            </Tooltip>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className={focusRing}
            onClick={() => {
              caret.current = { start: text.length, end: text.length };
              enterEdit(text);
            }}
          >
            {t("tts.editText")}
          </Button>
          <Tooltip title={t("tts.close")} text={t("tts.keys.close")}>
            <Button
              variant="ghost"
              size="sm"
              className={`size-[28px] rounded-full! p-0! inline-flex items-center justify-center bg-wash ${focusRing}`}
              onClick={close}
              aria-label={t("tts.close")}
              aria-keyshortcuts="Escape"
            >
              <X className="h-[12px] w-[12px]" aria-hidden="true" />
            </Button>
          </Tooltip>
        </div>
      </header>
      <div className="min-h-0 flex-1 p-2">
        {mode === "reading" ? (
          <div
            ref={attachPreview}
            className="h-full overflow-auto whitespace-pre-wrap break-words rounded-md px-3 py-2 cursor-text"
            data-source-preview
            onScroll={(event) => {
              if (mark.current)
                follower.userScrolled(
                  markInView(event.currentTarget, mark.current),
                );
            }}
            onClick={() =>
              routeTextClick(snapshot.state, () => {
                caret.current = textSelection() ?? {
                  start: text.length,
                  end: text.length,
                };
                enterEdit(text);
              })
            }
          >
            <span className="text-ink-2">{parts.before}</span>
            <mark
              ref={mark}
              className="rounded box-decoration-clone bg-logo-primary/25 text-text"
            >
              {parts.current}
            </mark>
            {parts.after}
          </div>
        ) : (
          <div
            className="h-full"
            ref={(node) => {
              editor.current = node?.querySelector("textarea") ?? null;
            }}
          >
            <Textarea
              aria-label={t("tts.textLabel")}
              placeholder={t("tts.placeholder")}
              variant="compact"
              className="w-full h-full min-h-0! resize-none! font-normal!"
              value={text}
              onChange={(event) => edit(event.target.value)}
            />
          </div>
        )}
      </div>
      {reason?.kind === "error" && (
        <div
          role="alert"
          className="flex shrink-0 items-start gap-1.5 px-3 pb-1 text-xs text-error"
        >
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="line-clamp-2 min-w-0 flex-1 break-words">
            {t("tts.failedLine", { reason: t(reason.key) })}
          </span>
          {reason.chooseModel && (
            <Button
              variant="ghost"
              size="sm"
              className={`shrink-0 whitespace-nowrap ${focusRing}`}
              onClick={models}
            >
              {t("tts.chooseModel")}
            </Button>
          )}
        </div>
      )}
      {reason?.kind === "fallback" && (
        <div
          className="flex shrink-0 items-center gap-1.5 px-3 pb-1 text-xs text-ink-2"
          data-output-fallback
        >
          <TriangleAlert
            className="h-4 w-4 shrink-0 text-warning"
            aria-hidden="true"
          />
          <span>{t("tts.outputFallback")}</span>
        </div>
      )}
      <div className="flex shrink-0 items-center gap-2 border-t border-line px-3 py-2">
        <Tooltip
          title={t(playing ? "tts.pause" : "tts.play")}
          text={t("tts.keys.toggle")}
        >
          <Button
            variant="secondary"
            size="sm"
            className={focusRing}
            onClick={toggle}
            disabled={!text.trim() || snapshot.state === "starting"}
            aria-label={t(playing ? "tts.pause" : "tts.play")}
            aria-keyshortcuts="Control+Enter"
          >
            {playing ? (
              <Pause className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Play className="h-4 w-4" aria-hidden="true" />
            )}
          </Button>
        </Tooltip>
        <Button
          variant="secondary"
          size="sm"
          className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap ${focusRing}`}
          onClick={readClipboard}
        >
          <ClipboardPaste className="h-4 w-4" aria-hidden="true" />
          {t("tts.readClipboard")}
        </Button>
        <div
          role="progressbar"
          aria-label={t("tts.progress")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress.percent}
          className="h-1.5 min-w-8 flex-1 overflow-hidden rounded-full bg-line"
        >
          <div
            className="h-full rounded-full bg-logo-primary"
            style={{ width: `${progress.percent}%` }}
          />
        </div>
        {time && (
          <span className="tabular-nums text-label whitespace-nowrap">
            {time}
          </span>
        )}
        {word && (
          <span role="status" className="text-label text-ink-2">
            {t(word)}
          </span>
        )}
      </div>
    </section>
  );
}
