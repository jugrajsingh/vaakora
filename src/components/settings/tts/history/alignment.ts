import type { ReadHistoryEntry, WordSpan } from "@/bindings";

/** One written word of a stored read, with the words that were said for it. */
export interface Token {
  written: string;
  spoken: string;
  changed: boolean;
  /** Position of the chunk the word was spoken in. */
  chunk: number;
  span: WordSpan;
}

/** A run of whole tokens, `end` included. */
export interface TokenSelection {
  start: number;
  end: number;
}

/**
 * Every written word of the entry in reading order. Spans are UTF-16 ranges, so JavaScript
 * string slices read them directly. The spoken words are cut from the stored chunk text; a
 * skipped word has an empty spoken range.
 */
export function tokensOf(entry: ReadHistoryEntry): Token[] {
  return entry.chunks.flatMap((aligned, chunk) =>
    aligned.words.map((span) => {
      const written = entry.source.slice(span.source_start, span.source_end);
      const spoken = aligned.chunk.text.slice(
        span.spoken_start,
        span.spoken_end,
      );
      return { written, spoken, changed: written !== spoken, chunk, span };
    }),
  );
}

/** A drag from one token to another selects every token between them, whichever way it went. */
export function snapSelection(anchor: number, focus: number): TokenSelection {
  return { start: Math.min(anchor, focus), end: Math.max(anchor, focus) };
}

/**
 * The text a selection stands for: the source from its first token to its last, and the words
 * said for those tokens. A skipped token has nothing to say, so it adds no word.
 */
export function selectionText(
  entry: ReadHistoryEntry,
  tokens: readonly Token[],
  selection: TokenSelection,
) {
  const picked = tokens.slice(selection.start, selection.end + 1);
  const first = picked[0];
  const last = picked[picked.length - 1];
  if (!first || !last) return { written: "", spokenAs: "" };
  return {
    written: entry.source.slice(first.span.source_start, last.span.source_end),
    spokenAs: picked
      .map((token) => token.spoken)
      .filter((spoken) => spoken !== "")
      .join(" "),
  };
}
