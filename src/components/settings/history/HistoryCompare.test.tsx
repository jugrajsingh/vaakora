import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const {
  mock,
}: {
  mock: {
    module: (name: string, factory: () => unknown) => void;
    restore: () => void;
  };
} = createRequire(import.meta.url)("bun:test");
import type { AppSettings } from "@/bindings";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../../../i18n/locales/en/translation.json";
import { HistoryCompare } from "./HistoryCompare";
import { HistoryActions } from "./HistoryActions";
await i18next.use(initReactI18next).init({
  lng: "en",
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
});
const entry = {
  transcription_text: "raw words",
  post_processed_text: "Clean words",
  post_process_model: "s1-mini-q4km",
};
const render = (view: "diff" | "side_by_side" | "stacked", value = entry) =>
  renderToStaticMarkup(
    <HistoryCompare
      entry={value}
      view={view}
      modelName="S1-mini by Superwhisper"
    />,
  );
const caption = (html: string) =>
  html.match(/<p class="text-xs text-ink-2">([^<]*)<\/p>/u)?.[1];
const diff = render("diff");
assert.equal(
  caption(diff),
  "Cleaned with S1-mini by Superwhisper. Showing differences from the original transcript.",
);
assert.match(diff, /<\/p><p class="text-xs text-ink-2">[^<]*<\/p><\/div>$/u);
assert.ok(!diff.includes("text-logo-primary"));
assert.ok(!diff.includes(entry.post_process_model));
assert.ok(!diff.includes("<button"));
assert.match(diff, /<del[^>]*>raw<\/del>/);
assert.match(diff, /<mark[^>]*>Clean<\/mark>/);
assert.match(diff, /<span>words<\/span>/);
const sideBySide = render("side_by_side");
assert.match(sideBySide, /<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">/);
assert.match(
  sideBySide,
  /<h3[^>]*>Original transcript<\/h3><p[^>]*>raw words<\/p>/,
);
assert.match(sideBySide, /<h3[^>]*>Cleaned text<\/h3><p[^>]*>Clean words<\/p>/);
assert.equal(caption(sideBySide), "Cleaned with S1-mini by Superwhisper.");
assert.match(
  sideBySide,
  /<\/div><p class="text-xs text-ink-2">[^<]*<\/p><\/div>$/u,
);
const stacked = render("stacked");
assert.match(stacked, /<div class="flex flex-col gap-3">/);
assert.equal(caption(stacked), "Cleaned with S1-mini by Superwhisper.");
for (const post_process_model of [entry.post_process_model, null]) {
  const old = renderToStaticMarkup(
    <HistoryCompare
      entry={{ ...entry, post_process_model }}
      view="stacked"
      modelName={null}
    />,
  );
  assert.equal(caption(old), "Cleaned text");
  assert.ok(!old.includes(entry.post_process_model));
  assert.ok(!old.includes("S1-mini by Superwhisper"));
}
for (const post_processed_text of [null, "", " \n"]) {
  const raw = renderToStaticMarkup(
    <HistoryCompare
      entry={{ ...entry, post_processed_text }}
      view="diff"
      modelName="S1-mini by Superwhisper"
    />,
  );
  assert.match(raw, /^<p[^>]*>raw words<\/p>$/);
}
for (const longSide of ["transcription_text", "post_processed_text"] as const) {
  const long = render("diff", {
    ...entry,
    [longSide]: Array(4001).fill("word").join(" "),
  });
  assert.match(long, /<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">/);
  assert.equal(caption(long), "Cleaned with S1-mini by Superwhisper.");
  assert.ok(!long.includes("<del"));
  assert.ok(!long.includes("<mark"));
}
for (const view of ["diff", "side_by_side", "stacked"] as const) {
  const equal = render(view, {
    ...entry,
    post_processed_text: entry.transcription_text,
  });
  assert.equal(caption(equal), "Cleaned with S1-mini by Superwhisper.");
  assert.equal((equal.match(/<p\b/gu) ?? []).length, 2);
  assert.match(equal, /<p[^>]*>raw words<\/p>/);
  assert.ok(!equal.includes("<del"));
  assert.ok(!equal.includes("<mark"));
  assert.ok(!equal.includes("<button"));
  assert.ok(!equal.includes("<h3"));
}
assert.equal(
  i18next.t("settings.history.retranscribeError"),
  "Could not re-transcribe this entry.",
);
const callbacks = {
  onCopy: () => undefined,
  onToggleSaved: () => undefined,
};
const buttonsOf = (html: string) =>
  Array.from(html.matchAll(/<button\b([^>]*)>/gu), (match) => match[1]);
const titlesOf = (html: string) =>
  Array.from(
    html.matchAll(/<button[^>]*title="([^"]+)"/gu),
    (match) => match[1],
  );
const actions = renderToStaticMarkup(
  <HistoryActions
    processed
    hasText
    saved={false}
    retrying={false}
    copied={false}
    {...callbacks}
  />,
);
assert.deepEqual(titlesOf(actions), ["Copy cleaned text", "Star"]);
assert.match(actions, /^<div class="flex items-center"/u);
assert.ok(
  buttonsOf(actions).every((button) => !button.includes('disabled=""')),
);
const rawActions = renderToStaticMarkup(
  <HistoryActions
    processed={false}
    hasText
    saved={false}
    retrying={false}
    copied={false}
    {...callbacks}
  />,
);
assert.deepEqual(titlesOf(rawActions), ["Copy text", "Star"]);
assert.ok(
  buttonsOf(rawActions).every((button) => !button.includes('disabled=""')),
);
const starred = renderToStaticMarkup(
  <HistoryActions
    processed
    hasText
    saved
    retrying={false}
    copied={false}
    {...callbacks}
  />,
);
assert.deepEqual(titlesOf(starred), ["Copy cleaned text", "Remove star"]);
const busy = renderToStaticMarkup(
  <HistoryActions
    processed
    hasText
    saved
    retrying
    copied={false}
    {...callbacks}
  />,
);
assert.equal(buttonsOf(busy).length, 2);
assert.ok(buttonsOf(busy).every((button) => button.includes('disabled=""')));
const unavailable = renderToStaticMarkup(
  <HistoryActions
    processed={false}
    hasText={false}
    saved={false}
    retrying={false}
    copied={false}
    {...callbacks}
  />,
);
const [copyButton, starButton] = buttonsOf(unavailable);
assert.ok(copyButton.includes('disabled=""'));
assert.ok(!starButton.includes('disabled=""'));
mock.module("@/hooks/useOsType", () => ({ useOsType: () => "linux" }));
mock.module("@/hooks/useSettings", () => ({
  useSettings: () => ({
    getSetting: (key: keyof AppSettings) =>
      key === "history_compare_view" ? "side_by_side" : undefined,
  }),
}));
mock.module("../post-processing/LocalLlmSettings", () => ({
  useLocalLlmModels: () => ({ models: [] }),
}));
mock.module("@/stores/noticeStore", () => ({ notify: () => undefined }));
mock.module("@/i18n", () => ({ default: i18next }));
const { HistorySettings, DictationStateLine } = await import(
  "./HistorySettings"
);
const history = renderToStaticMarkup(
  <HistorySettings changeRetention={() => undefined} />,
);
assert.ok(!history.includes("Compare view"), "the header has no compare view");
assert.ok(history.includes(">Clear history</button>"));
const toolbar = history
  .match(/<div\b[^>]*\bdata-history-toolbar\b[^>]*>/u)?.[0]
  .match(/class="([^"]*)"/u)?.[1];
assert.ok(toolbar, "the toolbar element");
for (const name of ["sticky", "top-0", "z-10", "flex-wrap", "bg-background"]) {
  assert.ok(toolbar.split(/\s+/).includes(name), `${name} in "${toolbar}"`);
}
assert.ok(
  history.includes("Keeps the latest 5 entries. Starred entries are kept."),
  "unset settings read as the defaults",
);
const buttonsInOrder = Array.from(
  history.matchAll(/<button\b[^>]*>(?:<svg.*?<\/svg><span>)?([^<]+)/gu),
  (match) => match[1],
);
assert.deepEqual(buttonsInOrder.slice(0, 3), [
  "Change",
  "Transcribe file",
  "Clear history",
]);
assert.ok(!history.includes("<h2"), "no page title");
const transcribe = history.match(
  /<button([^>]*)title="Transcribe file"([^>]*)>/u,
);
assert.ok(transcribe, "the Transcribe file button");
assert.match(`${transcribe[1]}${transcribe[2]}`, /class="[^"]*\bshrink-0\b/u);
const root = history.match(/^<div class="([^"]*)"/u)?.[1];
assert.ok(root, "the page root");
for (const name of ["w-full", "max-w-3xl", "min-w-0"]) {
  assert.ok(root.split(/\s+/).includes(name), `${name} in "${root}"`);
}
assert.match(
  history,
  /<p role="status" class="text-sm text-ink-2">Loading history\.\.\.<\/p>/u,
  "the first render is a status line",
);
assert.ok(!history.includes("No dictations yet."), "loading is not empty");
const stateLine = (
  props: Partial<Parameters<typeof DictationStateLine>[0]> = {},
) =>
  renderToStaticMarkup(
    <DictationStateLine
      state="empty"
      shortcuts={[]}
      osType="linux"
      transcribeFile={() => undefined}
      {...props}
    />,
  );
const keycapGroups = (html: string) => html.match(/role="img"/gu)?.length ?? 0;
const DICTATE = { id: "transcribe", binding: "super+alt+d" };
const CLEANUP = { id: "transcribe_with_post_process", binding: "super+alt+c" };
const both = stateLine({ shortcuts: [DICTATE, CLEANUP] });
assert.ok(both.includes("No dictations yet."));
assert.equal(keycapGroups(both), 2, "one keycaps group per bound shortcut");
assert.ok(both.includes('title="Dictate"'), "the first group is named");
assert.ok(both.includes('title="Dictate with cleanup"'));
assert.ok(both.includes("Press "));
assert.ok(both.includes(" to dictate or "));
assert.ok(both.includes(" to dictate with cleanup."));
assert.match(both, /<button[^>]*title="Transcribe file"/u);
assert.match(both, /^<div class="[^"]*\bpy-10\b[^"]*\btext-center\b/u);
assert.ok(!both.includes("italic"));
const onlyDictate = stateLine({ shortcuts: [DICTATE] });
assert.equal(keycapGroups(onlyDictate), 1);
assert.ok(onlyDictate.includes(" to dictate."));
assert.ok(!onlyDictate.includes("dictate with cleanup"));
assert.ok(!onlyDictate.includes(" or "));
const onlyCleanup = stateLine({ shortcuts: [CLEANUP] });
assert.equal(keycapGroups(onlyCleanup), 1);
assert.ok(onlyCleanup.includes(" to dictate with cleanup."));
assert.ok(!onlyCleanup.includes(" or "));
const none = stateLine();
assert.ok(none.includes("No dictations yet."));
assert.equal(keycapGroups(none), 0, "no hint line when none is bound");
assert.ok(!none.includes("Press "));
assert.match(none, /<button[^>]*title="Transcribe file"/u);
const notKept = stateLine({ state: "notKept", shortcuts: [DICTATE] });
assert.ok(notKept.includes("History is not being kept."));
assert.ok(!notKept.includes("<button"), "no second Change control");
assert.equal(keycapGroups(notKept), 0);
const loadingLine = stateLine({ state: "loading", shortcuts: [DICTATE] });
assert.match(loadingLine, /<p role="status" class="[^"]*">Loading history/u);
assert.ok(!loadingLine.includes("No dictations yet."));
let transcribed = 0;
let pressed: (() => void) | undefined;
let probe: React.ReactNode = null;
function Probe() {
  probe = DictationStateLine({
    state: "empty",
    shortcuts: [],
    osType: "linux",
    transcribeFile: () => {
      transcribed += 1;
    },
  });
  return null;
}
renderToStaticMarkup(<Probe />);
const find = (value: unknown): void => {
  if (Array.isArray(value)) return value.forEach(find);
  if (!React.isValidElement(value)) return;
  const props = value.props as Record<string, unknown>;
  if (typeof props.onClick === "function")
    pressed = props.onClick as () => void;
  Object.values(props).forEach(find);
};
find(probe);
pressed?.();
assert.equal(transcribed, 1, "Transcribe file runs the page action");
const pageSource = readFileSync(
  new URL("./HistorySettings.tsx", import.meta.url),
  "utf8",
);
assert.ok(pageSource.includes("historyState({"), "the page derives its state");
assert.ok(pageSource.includes("boundShortcuts("));
assert.equal(
  pageSource.match(/useOsType\(\)/gu)?.length,
  1,
  "osType is read once and passed down",
);
mock.restore();
console.log("HistoryCompare: all assertions passed");
