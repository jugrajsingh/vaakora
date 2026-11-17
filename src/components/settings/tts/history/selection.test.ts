import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { AlignedChunk, ReadHistoryEntry } from "@/bindings";
import { tokensOf, type TokenSelection } from "./alignment";
import {
  activeRange,
  beginDrag,
  correctionFor,
  extendDrag,
  releaseDrag,
  shownSelection,
} from "./selection";
const {
  describe,
  it,
}: {
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => void) => void;
} = createRequire(import.meta.url)("bun:test");

const chunk: AlignedChunk = {
  chunk: {
    index: 0,
    text: "Open README dot markdown now.",
    source_start: 0,
    source_end: 18,
    pause_ms: 450,
  },
  words: [
    { source_start: 0, source_end: 4, spoken_start: 0, spoken_end: 4 },
    { source_start: 5, source_end: 14, spoken_start: 5, spoken_end: 24 },
    { source_start: 15, source_end: 18, spoken_start: 25, spoken_end: 28 },
  ],
};
const ENTRY: ReadHistoryEntry = {
  id: 12,
  timestamp: 1_700_000_000,
  model_id: "supertonic-3",
  voice: "alba",
  speed: 1,
  technical: true,
  source: "Open README.md now",
  chunks: [chunk],
};

describe("drag lifecycle", () => {
  it("begins on the pressed token and follows the pointer", () => {
    const drag = extendDrag(beginDrag(1), 3);
    assert.deepEqual(drag, { anchor: 1, focus: 3 });
  });
  it("ignores the pointer entering a token when no drag is running", () => {
    assert.equal(extendDrag(null, 2), null);
  });
  it("shows the dragged tokens in either direction, else the saved selection", () => {
    assert.deepEqual(shownSelection({ anchor: 3, focus: 1 }, null), {
      start: 1,
      end: 3,
    });
    assert.deepEqual(shownSelection({ anchor: 1, focus: 3 }, null), {
      start: 1,
      end: 3,
    });
    const saved: TokenSelection = { start: 0, end: 0 };
    assert.deepEqual(shownSelection(null, saved), saved);
    assert.equal(shownSelection(null, null), null);
  });
  it("drag_release_opens_saved_selection", () => {
    const released: TokenSelection[] = [];
    const forward = releaseDrag(extendDrag(beginDrag(0), 1)!, (range) =>
      released.push(range),
    );
    const backward = releaseDrag(extendDrag(beginDrag(2), 1)!, (range) =>
      released.push(range),
    );
    assert.equal(forward, null);
    assert.equal(backward, null);
    assert.deepEqual(released, [
      { start: 0, end: 1 },
      { start: 1, end: 2 },
    ]);
    const saved = correctionFor(ENTRY, tokensOf(ENTRY), released[1]);
    assert.equal(saved.written, "README.md now");
    assert.equal(saved.spokenAs, "README dot markdown now");
  });
});

describe("saved selection", () => {
  it("applies only to the read it was made in", () => {
    const range = { start: 0, end: 1 };
    assert.deepEqual(activeRange({ entry: 12, range }, ENTRY), range);
    assert.equal(activeRange({ entry: 99, range }, ENTRY), null);
    assert.equal(activeRange({ entry: 12, range }, undefined), null);
    assert.equal(activeRange(null, ENTRY), null);
  });
});

describe("correctionFor", () => {
  it("history_selection_uses_entry_model", () => {
    const correction = correctionFor(ENTRY, tokensOf(ENTRY), {
      start: 1,
      end: 1,
    });
    assert.deepEqual(
      {
        written: correction.written,
        spokenAs: correction.spokenAs,
        readingModel: correction.readingModel,
      },
      {
        written: "README.md",
        spokenAs: "README dot markdown",
        readingModel: "supertonic-3",
      },
    );
  });
  it("gives a different key per read and selection so the box reopens fresh", () => {
    const tokens = tokensOf(ENTRY);
    const one = correctionFor(ENTRY, tokens, { start: 0, end: 0 });
    const two = correctionFor(ENTRY, tokens, { start: 1, end: 1 });
    const other = correctionFor({ ...ENTRY, id: 13 }, tokens, {
      start: 0,
      end: 0,
    });
    assert.equal(new Set([one.key, two.key, other.key]).size, 3);
  });
});
