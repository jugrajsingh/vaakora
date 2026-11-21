import assert from "node:assert/strict";
import {
  boundShortcuts,
  cleanedText,
  copyHistoryRaw,
  historyCopyText,
  historyModelName,
  historyState,
  nextOpen,
  openEntry,
  revealIn,
  revealScrollTop,
  shortDateTime,
  type RevealBox,
} from "./historyPresentation";
function check(name: string, run: () => void): void {
  try {
    run();
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}
for (const post_processed_text of [null, "", " \n"]) {
  const entry = { transcription_text: "raw", post_processed_text };
  assert.equal(cleanedText(entry), null);
  assert.equal(historyCopyText(entry), "raw");
}
const entry = { transcription_text: "raw", post_processed_text: "Clean." };
assert.equal(cleanedText(entry), "Clean.");
assert.equal(historyCopyText(entry), "Clean.");
assert.equal(historyCopyText({ ...entry, transcription_text: "" }), "Clean.");
assert.equal(
  cleanedText({ ...entry, post_processed_text: " Clean. \n" }),
  " Clean. \n",
);
let failures = 0;
const onError = () => {
  failures++;
};
await copyHistoryRaw(async () => true, onError);
assert.equal(failures, 0);
await copyHistoryRaw(async () => false, onError);
assert.equal(failures, 1);
await copyHistoryRaw(async () => {
  throw new Error("clipboard failed");
}, onError);
assert.equal(failures, 2);
const equalEntry = {
  transcription_text: "raw",
  post_processed_text: "raw",
  post_process_provider: "local_llm",
  post_process_model: "s1-mini-q4km",
};
assert.equal(cleanedText(equalEntry), "raw");
assert.equal(historyCopyText(equalEntry), "raw");
const registry = [
  { id: "s1-mini-q4km", display_name: "S1-mini by Superwhisper" },
];
assert.equal(
  historyModelName(
    { post_process_provider: "local_llm", post_process_model: "s1-mini-q4km" },
    registry,
  ),
  "S1-mini by Superwhisper",
);
assert.equal(
  historyModelName(
    { post_process_provider: "openai", post_process_model: "s1-mini-q4km" },
    registry,
  ),
  "s1-mini-q4km",
);
assert.equal(
  historyModelName(
    { post_process_provider: "local_llm", post_process_model: "unknown" },
    registry,
  ),
  "unknown",
);
assert.equal(
  historyModelName(
    { post_process_provider: null, post_process_model: null },
    registry,
  ),
  null,
);
assert.equal(
  historyModelName(
    { post_process_provider: null, post_process_model: "s1-mini-q4km" },
    registry,
  ),
  "S1-mini by Superwhisper",
);
assert.equal(
  historyModelName(
    { post_process_provider: "local_llm", post_process_model: "s1-mini-q4km" },
    [],
  ),
  "s1-mini-q4km",
);
check("short_date_is_day_month_time", () => {
  const gb = shortDateTime(1763324820, "en-GB", "UTC");
  assert.ok(gb.includes("Nov"), gb);
  assert.ok(gb.includes("16"), gb);
  assert.ok(gb.includes("20:27"), gb);
  assert.ok(!gb.includes("2025"), gb);
  const en = shortDateTime(1763324820, "en", "UTC");
  assert.ok(en.includes("Nov"), en);
  assert.ok(en.includes("16"), en);
  assert.ok(en.includes("08:27"), en);
  assert.ok(!en.includes("2025"), en);
  assert.equal(shortDateTime(Number.NaN, "en-GB", "UTC"), "NaN");
  assert.equal(shortDateTime(8.64e15 + 1, "en-GB", "UTC"), String(8.64e15 + 1));
});
check("open_entry_drops_a_gone_id", () => {
  assert.equal(openEntry(7, [9, 8, 7]), 7);
  assert.equal(openEntry(7, [9, 8]), null);
  assert.equal(openEntry(null, [9, 8, 7]), null);
  assert.equal(openEntry(7, []), null);
  assert.equal(nextOpen(7, { loading: true, ids: [] }), 7);
  assert.equal(nextOpen(null, { loading: true, ids: [7] }), null);
  assert.equal(nextOpen(7, { loading: false, ids: [8] }), null);
});
check("reveal_keeps_the_top_visible", () => {
  const view = { top: 100, bottom: 500, scrollTop: 1000 };
  // Below the fold and shorter than the view: its bottom lines up with the view's.
  assert.equal(revealScrollTop(view, { top: 450, bottom: 600 }), 1100);
  // Below the fold and taller than the view: its top lines up with the view's.
  assert.equal(revealScrollTop(view, { top: 450, bottom: 1000 }), 1350);
  // Above the view, under the toolbar: its top lines up with the view's.
  assert.equal(revealScrollTop(view, { top: 50, bottom: 200 }), 950);
  assert.equal(revealScrollTop(view, { top: 50, bottom: 900 }), 950);
  assert.equal(revealScrollTop(view, { top: 150, bottom: 400 }), null);
  assert.equal(revealScrollTop(view, { top: 100, bottom: 500 }), null);
});
check("reveal_in_scrolls_an_opened_row_into_view", () => {
  const TOOLBAR = "[data-model-toolbar]";
  const scroller = () => {
    const writes: number[] = [];
    let top = 200;
    return {
      writes,
      get scrollTop() {
        return top;
      },
      set scrollTop(value: number) {
        writes.push(value);
        top = value;
      },
      getBoundingClientRect: (): RevealBox => ({ top: 40, bottom: 564 }),
      querySelector: (selector: string) =>
        selector === TOOLBAR
          ? {
              getBoundingClientRect: (): RevealBox => ({ top: 40, bottom: 84 }),
            }
          : null,
    };
  };
  const reveal = (top: number, bottom: number, toolbar = TOOLBAR) => {
    const box = scroller();
    revealIn(
      {
        getBoundingClientRect: () => ({ top, bottom }),
        closest: (selector: string) =>
          selector === "[data-settings-scroll]" ? box : null,
      },
      toolbar,
    );
    return box;
  };
  // Below the fold: its bottom lines up with the view's.
  assert.equal(reveal(500, 760).scrollTop, 396);
  // In view: unchanged, nothing assigned.
  const inView = reveal(100, 300);
  assert.equal(inView.scrollTop, 200);
  assert.deepEqual(inView.writes, []);
  // Under the toolbar: its top lines up with the toolbar's bottom.
  assert.equal(reveal(60, 200).scrollTop, 176);
  // Taller than the view: its top goes to the toolbar's bottom.
  assert.equal(reveal(300, 900).scrollTop, 416);
  // No toolbar: the view starts at the scroller's top.
  assert.equal(reveal(20, 100, "[data-history-toolbar]").scrollTop, 180);
  assert.equal(reveal(20, 100).scrollTop, 136);
  // Outside a scroller, or no row: nothing assigned, no throw.
  const away = scroller();
  revealIn(
    {
      getBoundingClientRect: () => ({ top: 500, bottom: 760 }),
      closest: () => null,
    },
    TOOLBAR,
  );
  revealIn(null, TOOLBAR);
  assert.deepEqual(away.writes, []);
});
check("history_state_precedence", () => {
  const base = { loading: false, failed: false, count: 0, kept: true };
  assert.equal(historyState({ ...base, loading: true, count: 3 }), "loading");
  assert.equal(
    historyState({ ...base, loading: true, failed: true, kept: false }),
    "loading",
  );
  assert.equal(
    historyState({ ...base, failed: true, count: 2, kept: false }),
    "list",
  );
  assert.equal(historyState({ ...base, count: 1, kept: false }), "list");
  assert.equal(historyState({ ...base, failed: true, kept: false }), "failed");
  assert.equal(historyState({ ...base, kept: false }), "notKept");
  assert.equal(historyState(base), "empty");
});
check("bound_shortcuts", () => {
  const ids = ["transcribe", "transcribe_with_post_process"];
  const bindings = {
    transcribe: { current_binding: "super+alt+d" },
    transcribe_with_post_process: { current_binding: "super+alt+c" },
  };
  assert.deepEqual(boundShortcuts(bindings, ids), [
    { id: "transcribe", binding: "super+alt+d" },
    { id: "transcribe_with_post_process", binding: "super+alt+c" },
  ]);
  assert.deepEqual(
    boundShortcuts({ ...bindings, transcribe: { current_binding: "" } }, ids),
    [{ id: "transcribe_with_post_process", binding: "super+alt+c" }],
  );
  assert.deepEqual(boundShortcuts({ transcribe: bindings.transcribe }, ids), [
    { id: "transcribe", binding: "super+alt+d" },
  ]);
  assert.deepEqual(boundShortcuts({}, ids), []);
  assert.deepEqual(boundShortcuts(undefined, ids), []);
  assert.deepEqual(
    boundShortcuts({ transcribe: { current_binding: "" } }, [
      "transcribe_with_post_process",
      "transcribe",
    ]),
    [],
  );
  assert.deepEqual(
    boundShortcuts(bindings, [
      "transcribe_with_post_process",
      "transcribe",
    ]).map((shortcut) => shortcut.id),
    ["transcribe_with_post_process", "transcribe"],
    "the order of ids is kept",
  );
});
console.log("historyPresentation: all assertions passed");
