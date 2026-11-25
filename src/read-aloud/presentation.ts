import type { TFunction } from "i18next";
import type {
  AppSettings,
  GridBlock,
  SessionSnapshot,
  TtsModelInfo,
} from "@/bindings";
export function highlightedText(text: string, start: number, end: number) {
  const from = Math.max(0, Math.min(text.length, start));
  const to = Math.max(from, Math.min(text.length, end));
  return {
    before: text.slice(0, from),
    current: text.slice(from, to),
    after: text.slice(to),
  };
}
/** One run of the reader's text: prose, or a box or ASCII table block shown monospaced. */
export interface PreviewSegment {
  mono: boolean;
  before: string;
  current: string;
  after: string;
  /** Whether the segment draws a `<mark>`: it holds part of the current sentence, or it is where an empty mark sits. */
  mark: boolean;
}

/**
 * The text cut at its table blocks (UTF-16 ranges from the backend, which found them), each
 * piece split around the current sentence. Every character stays in order, so the cuts never
 * change what is selected or pasted. A block that is empty, reversed, overlapping an earlier one
 * or past the text is ignored; a block running past the end is cut at the end.
 */
export function previewSegments(
  text: string,
  blocks: readonly GridBlock[],
  start: number,
  end: number,
): PreviewSegment[] {
  const cuts: { from: number; to: number; mono: boolean }[] = [];
  let at = 0;
  for (const block of blocks) {
    const to = Math.min(text.length, block.end);
    if (block.start < at || to <= block.start) continue;
    if (block.start > at) cuts.push({ from: at, to: block.start, mono: false });
    cuts.push({ from: block.start, to, mono: true });
    at = to;
  }
  if (at < text.length || cuts.length === 0)
    cuts.push({ from: at, to: text.length, mono: false });
  const parts = cuts.map(({ from, to, mono }) => ({
    mono,
    ...highlightedText(text.slice(from, to), start - from, end - from),
  }));
  const held = parts.findIndex((part) => part.current !== "");
  return parts.map((part, index) => ({
    ...part,
    mark: part.current !== "" || index === Math.max(0, held),
  }));
}
export function progressPresentation(snapshot: SessionSnapshot) {
  return {
    percent: Math.max(0, Math.min(100, snapshot.progress * 100)),
    elapsed: Math.round(snapshot.elapsed_seconds),
    remaining: Math.round(snapshot.remaining_seconds),
  };
}

export function popupMode(state: SessionSnapshot["state"], editing: boolean) {
  return editing || state === "waiting" ? "editing" : "reading";
}

/** True when the text can be edited without losing a place in an active read. */
export function textEditable(state: SessionSnapshot["state"]) {
  return state === "waiting" || state === "finished" || state === "error";
}

export function routeTextClick(
  state: SessionSnapshot["state"],
  enterEdit: () => void,
) {
  if (textEditable(state)) enterEdit();
}

export function formatTime(seconds: number) {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** "1:18 / about 1:29"; `null` when nothing is read yet. */
export function timeLabel(
  snapshot: SessionSnapshot,
  t: TFunction,
): string | null {
  if (snapshot.state === "waiting") return null;
  return t("tts.timeAbout", {
    elapsed: formatTime(snapshot.elapsed_seconds),
    total: formatTime(snapshot.elapsed_seconds + snapshot.remaining_seconds),
  });
}

/** The key of the state word; `null` when nothing is read yet. */
export function stateWord(state: SessionSnapshot["state"]) {
  return state === "waiting" ? null : `tts.states.${state}`;
}

/** The one line above the transport: the error wins over the output fallback; `null` when neither. */
export function reasonLine(
  snapshot: SessionSnapshot,
):
  | { kind: "error"; key: string; chooseModel: boolean }
  | { kind: "fallback" }
  | null {
  if (snapshot.error)
    return {
      kind: "error",
      key: snapshot.error,
      chooseModel: snapshot.error === "tts.errors.notDownloaded",
    };
  return snapshot.output_fallback ? { kind: "fallback" } : null;
}

/** The model and voice the next read uses, or `null` when the model is not in the catalog. */
export function readerHeading(
  settings: Pick<AppSettings, "tts_model_id" | "tts_voice">,
  models: readonly Pick<
    TtsModelInfo,
    "id" | "display_name" | "default_voice"
  >[],
): { model: string; voice: string } | null {
  const id = settings.tts_model_id ?? "pocket-en";
  const model = models.find((candidate) => candidate.id === id);
  if (!model) return null;
  return {
    model: model.display_name,
    voice: settings.tts_voice?.[id] ?? model.default_voice,
  };
}

export function pasteText(
  text: string,
  pasted: string,
  start = 0,
  end = text.length,
) {
  return text.slice(0, start) + pasted + text.slice(end);
}

/** `current` is the text being read; an editable read given that same text is kept as it is. */
export function enterPopupEdit(
  text: string,
  state: SessionSnapshot["state"],
  actions: {
    current: string;
    edit: (text: string) => void;
    setEditing: (value: boolean) => void;
  },
) {
  actions.setEditing(true);
  if (textEditable(state) && text === actions.current) return;
  actions.edit(text);
}

export function togglePopupPlayback(actions: {
  toggle: () => void;
  setEditing: (value: boolean) => void;
}) {
  actions.setEditing(false);
  actions.toggle();
}

export interface PopupPasteEvent {
  target: unknown;
  defaultPrevented: boolean;
  clipboardData: { getData: (format: string) => string } | null;
  preventDefault: () => void;
}

interface PopupPasteDependencies {
  isEditorTarget: (target: unknown) => boolean;
  getText: () => string;
  getSelection: () => { start: number; end: number } | null;
  isActive: () => boolean;
  enterEdit: (text: string, caret: number) => void;
}

export function routePopupPaste(
  event: PopupPasteEvent,
  dependencies: PopupPasteDependencies,
) {
  if (
    event.defaultPrevented ||
    dependencies.isEditorTarget(event.target) ||
    !event.clipboardData ||
    dependencies.isActive()
  )
    return;
  event.preventDefault();
  const text = dependencies.getText();
  const range = dependencies.getSelection();
  const pasted = event.clipboardData.getData("text/plain");
  const next = range
    ? pasteText(text, pasted, range.start, range.end)
    : pasteText(text, pasted);
  dependencies.enterEdit(next, (range?.start ?? 0) + pasted.length);
}

export function registerPopupPaste(
  target: {
    addEventListener: (
      type: "paste",
      listener: (event: PopupPasteEvent) => void,
    ) => void;
    removeEventListener: (
      type: "paste",
      listener: (event: PopupPasteEvent) => void,
    ) => void;
  },
  dependencies: PopupPasteDependencies,
) {
  const listener = (event: PopupPasteEvent) =>
    routePopupPaste(event, dependencies);
  target.addEventListener("paste", listener);
  return () => target.removeEventListener("paste", listener);
}

export function restorePopupEditor(
  editor: {
    focus: () => void;
    setSelectionRange: (start: number, end: number) => void;
  },
  caret: { start: number; end: number },
) {
  editor.focus();
  editor.setSelectionRange(caret.start, caret.end);
}
