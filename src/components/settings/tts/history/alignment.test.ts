import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { AlignedChunk, ReadHistoryEntry } from "@/bindings";
import { selectionText, snapSelection, tokensOf } from "./alignment";
const {
  describe,
  it,
}: {
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => void) => void;
} = createRequire(import.meta.url)("bun:test");

const entryOf = (source: string, chunks: AlignedChunk[]): ReadHistoryEntry => ({
  id: 1,
  timestamp: 1_700_000_000,
  model_id: "pocket-en",
  voice: "alba",
  speed: 1,
  technical: true,
  source,
  origin: "app",
  chunks,
});

const chunkOf = (
  text: string,
  source_start: number,
  source_end: number,
  words: [number, number, number, number][],
): AlignedChunk => ({
  chunk: { index: 0, text, source_start, source_end, pause_ms: 450 },
  words: words.map(([source_start, source_end, spoken_start, spoken_end]) => ({
    source_start,
    source_end,
    spoken_start,
    spoken_end,
  })),
});

// Spans as the reader stores them for "Open README.md now" (README.md is spoken in full).
const OPEN = entryOf("Open README.md now", [
  chunkOf("Open README dot markdown now.", 0, 18, [
    [0, 4, 0, 4],
    [5, 14, 5, 24],
    [15, 18, 25, 28],
  ]),
]);

// Spans the reader stores for "😀 see **README.md**, ok": the emoji is two UTF-16 units, the
// wrapped token's span starts after the `**`, and its spoken form keeps the comma.
const EMOJI = entryOf("😀 see **README.md**, ok", [
  chunkOf("see README dot markdown, ok.", 3, 24, [
    [3, 6, 0, 3],
    [9, 21, 4, 24],
    [22, 24, 25, 27],
  ]),
]);

// ABC-123 is a skipped word: an empty spoken range between "Open" and "now".
const SKIPPED = entryOf("Open ABC-123 now", [
  chunkOf("Open now.", 0, 16, [
    [0, 4, 0, 4],
    [5, 12, 4, 4],
    [13, 16, 5, 8],
  ]),
]);

describe("tokensOf", () => {
  it("tokens_mark_changed_words", () => {
    assert.deepEqual(
      tokensOf(OPEN).map(({ written, spoken, changed }) => ({
        written,
        spoken,
        changed,
      })),
      [
        { written: "Open", spoken: "Open", changed: false },
        { written: "README.md", spoken: "README dot markdown", changed: true },
        { written: "now", spoken: "now", changed: false },
      ],
    );
  });
  it("marks a skipped word as changed with nothing spoken", () => {
    const skipped = tokensOf(SKIPPED)[1];
    assert.equal(skipped.written, "ABC-123");
    assert.equal(skipped.spoken, "");
    assert.equal(skipped.changed, true);
  });
  it("numbers the chunk each token was spoken in", () => {
    const entry = entryOf("a b", [
      chunkOf("a.", 0, 1, [[0, 1, 0, 1]]),
      chunkOf("b.", 2, 3, [[2, 3, 0, 1]]),
    ]);
    assert.deepEqual(
      tokensOf(entry).map((token) => token.chunk),
      [0, 1],
    );
  });
});

describe("snapSelection", () => {
  it("orders a backwards drag", () => {
    assert.deepEqual(snapSelection(5, 2), { start: 2, end: 5 });
  });
  it("keeps a single token", () => {
    assert.deepEqual(snapSelection(3, 3), { start: 3, end: 3 });
  });
});

describe("selectionText", () => {
  it("selection_slices_source_and_spoken_by_utf16", () => {
    const tokens = tokensOf(EMOJI);
    const picked = selectionText(EMOJI, tokens, snapSelection(1, 1));
    assert.equal(
      picked.written,
      EMOJI.source.slice(
        EMOJI.chunks[0].words[1].source_start,
        EMOJI.chunks[0].words[1].source_end,
      ),
    );
    assert.ok(picked.written.includes("README.md"));
    assert.equal(picked.spokenAs, "README dot markdown,");
  });
  it("takes the source from the first token's start to the last token's end", () => {
    const picked = selectionText(OPEN, tokensOf(OPEN), snapSelection(2, 0));
    assert.equal(picked.written, "Open README.md now");
    assert.equal(picked.spokenAs, "Open README dot markdown now");
  });
  it("skipped_tokens_are_left_out_of_spoken_as", () => {
    const picked = selectionText(SKIPPED, tokensOf(SKIPPED), {
      start: 0,
      end: 2,
    });
    assert.equal(picked.written, "Open ABC-123 now");
    assert.equal(picked.spokenAs, "Open now");
  });
});

// A stored chunk exactly as the Rust reader writes it.
const storedChunk = (
  index: number,
  text: string,
  [source_start, source_end]: [number, number],
  pause_ms: number,
  words: [number, number, number, number][],
): AlignedChunk => ({
  ...chunkOf(text, source_start, source_end, words),
  chunk: { index, text, source_start, source_end, pause_ms },
});

// The literal of text.rs `small_table_aligned_chunks_are_exact`.
const SMALL_TABLE = entryOf("| A | B |\n|---|---|\n| x y | z |", [
  storedChunk(0, "Table, 2 columns, 1 row.", [0, 9], 280, []),
  storedChunk(1, "Row 1. A: x y.", [20, 31], 280, [
    [22, 23, 10, 11],
    [24, 25, 12, 13],
  ]),
  storedChunk(2, "B: z.", [20, 31], 280, [[28, 29, 3, 4]]),
  storedChunk(3, "End of table.", [20, 31], 450, []),
]);

// Row 1 of the multi-line box table in tables/multiline.txt (style A), as the Rust reader
// prints it: every chunk covers the row's two lines (UTF-16 147..244).
const ROW = [147, 244] as [number, number];
const WRAPPED = entryOf(
  readFileSync(
    new URL(
      "../../../../../crates/handy-tts-core/tests/fixtures/text/tables/multiline.txt",
      import.meta.url,
    ),
    "utf8",
  ),
  [
    storedChunk(0, "Table, 3 columns, 2 rows.", [0, 97], 280, []),
    storedChunk(1, "Row 1. Lane: B, the walk.", ROW, 280, [
      [149, 151, 13, 15],
      [152, 155, 16, 19],
      [198, 202, 20, 24],
    ]),
    storedChunk(2, "Progress: Task B1 committed, working on B2.", ROW, 280, [
      [160, 164, 10, 14],
      [165, 167, 15, 17],
      [168, 178, 18, 28],
      [209, 216, 29, 36],
      [217, 219, 37, 39],
      [220, 223, 40, 43],
    ]),
    storedChunk(3, "Owner: Opus.", ROW, 280, [[181, 185, 7, 11]]),
  ],
);

describe("table reads", () => {
  it("table_rows_align_cell_words", () => {
    const tokens = tokensOf(SMALL_TABLE);
    assert.deepEqual(
      tokens.map(({ written, spoken, changed }) => ({
        written,
        spoken,
        changed,
      })),
      ["x", "y", "z"].map((word) => ({
        written: word,
        spoken: word,
        changed: false,
      })),
    );
    assert.deepEqual(selectionText(SMALL_TABLE, tokens, snapSelection(0, 2)), {
      written: "x y | z",
      spokenAs: "x y z",
    });
  });
  it("selection_inside_one_cell_of_a_wrapped_row", () => {
    const tokens = tokensOf(WRAPPED);
    assert.deepEqual(
      tokens.map((token) => token.written),
      [
        "B,",
        "the",
        "walk",
        "Task",
        "B1",
        "committed,",
        "working",
        "on",
        "B2.",
        "Opus",
      ],
    );
    assert.deepEqual(selectionText(WRAPPED, tokens, snapSelection(0, 2)), {
      written: "B, the   │ Task B1 committed, │ Opus         │\n│ walk",
      spokenAs: "B, the walk",
    });
    // Recorded behaviour, not a requirement (ruled 2026-11-22 Q3, backlogged): "walk" sits
    // on the second line and "Task" on the first, so the source slice from the first token's
    // start to the last token's end runs backwards and is empty.
    assert.deepEqual(selectionText(WRAPPED, tokens, snapSelection(2, 3)), {
      written: "",
      spokenAs: "walk Task",
    });
  });
});
