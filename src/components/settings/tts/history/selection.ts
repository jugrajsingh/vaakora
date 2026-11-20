import type { ReadHistoryEntry } from "@/bindings";
import { openEntry } from "@/lib/utils/historyPresentation";
import {
  selectionText,
  snapSelection,
  type Token,
  type TokenSelection,
} from "./alignment";

/** A drag in progress: the token pressed and the token the pointer is over now. */
export interface Drag {
  anchor: number;
  focus: number;
}

/** A finished selection and the read it was made in. */
export interface ReadSelection {
  entry: number;
  range: TokenSelection;
}

export function beginDrag(index: number): Drag {
  return { anchor: index, focus: index };
}

/** The pointer moved onto a token: the drag follows it, and nothing starts without a press. */
export function extendDrag(drag: Drag | null, index: number): Drag | null {
  return drag ? { ...drag, focus: index } : null;
}

/** The pointer was released: the whole tokens dragged over are selected and the drag is over. */
export function releaseDrag(
  drag: Drag,
  select: (selection: TokenSelection) => void,
): null {
  select(snapSelection(drag.anchor, drag.focus));
  return null;
}

/** The tokens to highlight: the drag in progress, else the saved selection. */
export function shownSelection(
  drag: Drag | null,
  selection: TokenSelection | null,
): TokenSelection | null {
  return drag ? snapSelection(drag.anchor, drag.focus) : selection;
}

/** The saved selection when it belongs to the read on show; a pruned or other read has none. */
export function activeRange(
  selection: ReadSelection | null,
  entry: ReadHistoryEntry | undefined,
): TokenSelection | null {
  return selection && entry && selection.entry === entry.id
    ? selection.range
    : null;
}

/** What the correction box opens with: the chunk as written and as spoken, in the read's own voice model. */
export function correctionFor(
  entry: ReadHistoryEntry,
  tokens: readonly Token[],
  range: TokenSelection,
) {
  const { written, spokenAs } = selectionText(entry, tokens, range);
  return {
    key: `${entry.id}:${range.start}-${range.end}`,
    written,
    spokenAs,
    readingModel: entry.model_id,
  };
}

export type CorrectionTarget = ReturnType<typeof correctionFor>;

/** The open read, the words selected in it, and the correction a selection opened. */
export interface ReadView {
  open: number | null;
  selection: ReadSelection | null;
  correction: CorrectionTarget | null;
}

export const NO_READ_VIEW: ReadView = {
  open: null,
  selection: null,
  correction: null,
};

export type ReadViewAction =
  | { type: "loaded"; ids: readonly number[] }
  | { type: "cleared" }
  | { type: "toggle"; id: number }
  | {
      type: "select";
      entry: ReadHistoryEntry;
      tokens: readonly Token[];
      range: TokenSelection;
    }
  | { type: "closeCorrection" };

/**
 * One read is open at a time. A list reload drops the open read once it is gone and Clear history
 * drops it at once (ids restart after a clear); the correction is its own snapshot and only
 * closeCorrection ends it.
 */
export function readView(state: ReadView, action: ReadViewAction): ReadView {
  switch (action.type) {
    case "loaded": {
      const open = openEntry(state.open, action.ids);
      const selection =
        state.selection && state.selection.entry === open
          ? state.selection
          : null;
      return { ...state, open, selection };
    }
    case "cleared":
      return { ...state, open: null, selection: null };
    case "toggle":
      return {
        ...state,
        open: state.open === action.id ? null : action.id,
        selection: null,
      };
    case "select":
      return state.open === action.entry.id
        ? {
            ...state,
            selection: { entry: action.entry.id, range: action.range },
            correction: correctionFor(
              action.entry,
              action.tokens,
              action.range,
            ),
          }
        : state;
    case "closeCorrection":
      return { ...state, selection: null, correction: null };
  }
}
