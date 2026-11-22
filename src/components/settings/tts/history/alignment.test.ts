import assert from "node:assert/strict";
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
