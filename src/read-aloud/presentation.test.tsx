import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import en from "../i18n/locales/en/translation.json";
import type { SessionSnapshot } from "../bindings";
import {
  highlightedText,
  progressPresentation,
  popupMode,
  formatTime,
  pasteText,
  enterPopupEdit,
  readerHeading,
  reasonLine,
  routeTextClick,
  stateWord,
  textEditable,
  timeLabel,
  togglePopupPlayback,
} from "./presentation";
import { routePopupKey } from "./actions";
import { ReadAloudPopup } from "./ReadAloudPopup";
await i18next.init({
  lng: "en",
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
});
const t = i18next.t.bind(i18next);
const snapshot: SessionSnapshot = {
  epoch: 0,
  state: "buffering",
  source_start: 2,
  source_end: 7,
  elapsed_seconds: 9.4,
  remaining_seconds: 40.6,
  progress: 0.2,
  error: null,
  output_fallback: false,
  queued_audio_seconds: 1,
  buffering_pauses: 1,
  head_start_seconds: 4,
};
assert.deepEqual(highlightedText("A😀BC", 1, 3), {
  before: "A",
  current: "😀",
  after: "BC",
});
assert.deepEqual(highlightedText("abc", -1, 99), {
  before: "",
  current: "abc",
  after: "",
});
assert.equal(progressPresentation({ ...snapshot, progress: 2 }).percent, 100);
const render = (
  state: SessionSnapshot,
  editing = false,
  heading: { model: string; voice: string } | null = {
    model: "Supertonic 3",
    voice: "alba",
  },
  i18n: typeof i18next = i18next,
) =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <ReadAloudPopup
        text="A sentence"
        heading={heading}
        editing={editing}
        enterEdit={() => {}}
        snapshot={state}
        edit={() => {}}
        toggle={() => {}}
        close={() => {}}
        readClipboard={() => {}}
        models={() => {}}
      />
    </I18nextProvider>,
  );
const buffering = render(snapshot);
const status = buffering.match(/<span role="status"[^>]*>(.*?)<\/span>/s)?.[1];
assert.ok(status?.includes("Buffering"), status);
const mark = buffering.match(/<mark[^>]*>(.*?)<\/mark>/s)?.[1];
assert.equal(mark, "sente");
console.log("popup presentation: UTF-16/highlight/Buffering assertions passed");

{
  // one_reason_line
  const alertsIn = (html: string) => [
    ...html.matchAll(/<div role="alert"([^>]*)>(.*?)<\/div>/gs),
  ];
  const plain = (html: string) =>
    html
      .replace(/<[^>]*>/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const classes = (attributes: string) =>
    (attributes.match(/class="([^"]*)"/)?.[1] ?? "").split(/\s+/);
  const fallbackIn = (html: string) =>
    html.match(/<div([^>]*data-output-fallback[^>]*)>(.*?)<\/div>/s);
  const failed = (error: string | null, output_fallback = false) =>
    render({ ...snapshot, state: "error", error, output_fallback });
  const above = (html: string, marker: string) =>
    html.indexOf(marker) !== -1 &&
    html.indexOf(marker) < html.indexOf('role="progressbar"');

  assert.deepEqual(reasonLine({ ...snapshot, error: "tts.errors.audio" }), {
    kind: "error",
    key: "tts.errors.audio",
    chooseModel: false,
  });
  assert.deepEqual(
    reasonLine({ ...snapshot, error: "tts.errors.notDownloaded" }),
    { kind: "error", key: "tts.errors.notDownloaded", chooseModel: true },
  );
  assert.deepEqual(reasonLine({ ...snapshot, output_fallback: true }), {
    kind: "fallback",
  });
  assert.deepEqual(
    reasonLine({
      ...snapshot,
      error: "tts.errors.audio",
      output_fallback: true,
    }),
    { kind: "error", key: "tts.errors.audio", chooseModel: false },
    "one_reason_line: the error wins over the fallback",
  );
  assert.equal(reasonLine(snapshot), null);

  const audio = failed("tts.errors.audio");
  const lines = alertsIn(audio);
  assert.equal(lines.length, 1, "one_reason_line: one alert");
  const [, lineAttributes, lineInner] = lines[0];
  assert.equal(
    plain(lineInner),
    "Read aloud failed. The output device could not be opened.",
  );
  assert.ok(classes(lineAttributes).includes("text-error"), lineAttributes);
  assert.ok(
    /<svg[^>]*lucide-circle-alert/.test(lineInner),
    "one_reason_line: the error line carries the CircleAlert icon",
  );
  assert.ok(
    /<span class="[^"]*\bline-clamp-2\b[^"]*"/.test(lineInner),
    "one_reason_line: the reason is clamped to two lines",
  );
  assert.equal(audio.includes(en.tts.chooseModel), false, "no Choose a model");
  assert.equal(audio.includes("data-output-fallback"), false);
  assert.ok(
    above(audio, 'role="alert"'),
    "one_reason_line: the line sits above the transport",
  );
  assert.equal(
    audio.includes("text-ink-3"),
    false,
    "one_reason_line: no ink-3 in the reader",
  );

  const missing = failed("tts.errors.notDownloaded");
  const [, , missingInner] = alertsIn(missing)[0];
  assert.equal(alertsIn(missing).length, 1);
  assert.equal(
    plain(missingInner.replace(/<button.*<\/button>/s, "")),
    "Read aloud failed. Download this model before reading.",
  );
  const chooser = [
    ...missingInner.matchAll(/<button([^>]*)>(.*?)<\/button>/gs),
  ];
  assert.equal(chooser.length, 1, "one_reason_line: one Choose a model button");
  assert.equal(plain(chooser[0][2]), "Choose a model");
  for (const token of [
    "focus-visible:ring-2",
    "focus-visible:ring-logo-primary",
  ])
    assert.ok(classes(chooser[0][1]).includes(token), token);

  const fallback = render({
    ...snapshot,
    state: "playing",
    output_fallback: true,
  });
  const note = fallbackIn(fallback);
  assert.ok(note, "one_reason_line: the fallback line renders");
  assert.equal(plain(note[2]), "Using the default output device");
  assert.ok(classes(note[1]).includes("text-ink-2"), note[1]);
  assert.equal(
    /text-ink-3/.test(note[1] + note[2]),
    false,
    "one_reason_line: the fallback is not ink-3",
  );
  assert.ok(
    /<svg[^>]*lucide-triangle-alert[^>]*text-warning|<svg[^>]*text-warning[^>]*lucide-triangle-alert/.test(
      note[2],
    ),
    "one_reason_line: the fallback carries a warning TriangleAlert",
  );
  assert.equal(fallback.includes('role="alert"'), false);
  assert.ok(above(fallback, "data-output-fallback"));

  const both = failed("tts.errors.audio", true);
  assert.equal(alertsIn(both).length, 1, "one_reason_line: both -> error only");
  assert.equal(fallbackIn(both), null);

  const neither = render({ ...snapshot, state: "playing" });
  assert.equal(alertsIn(neither).length, 0, "one_reason_line: neither");
  assert.equal(fallbackIn(neither), null);

  assert.equal(en.tts.failedLine, "Read aloud failed. {{reason}}");
  assert.equal(en.tts.chooseModel, "Choose a model");
  console.log("popup one reason line: error, Choose a model, fallback passed");
}

{
  // finished_and_failed_keep_the_reading_view
  assert.equal(
    popupMode("finished", false),
    "reading",
    "finished_and_failed_keep_the_reading_view: finished",
  );
  assert.equal(
    popupMode("error", false),
    "reading",
    "finished_and_failed_keep_the_reading_view: error",
  );
  assert.equal(popupMode("waiting", false), "editing", "waiting");
  for (const state of ["finished", "error", "playing"] as const) {
    const html = render({ ...snapshot, state, error: "tts.errors.audio" });
    assert.ok(
      html.includes("data-source-preview"),
      `finished_and_failed_keep_the_reading_view: ${state} with an error`,
    );
  }
}
{
  // finished_render_has_no_textarea
  for (const state of ["finished", "error"] as const) {
    const html = render({ ...snapshot, state });
    assert.equal(
      html.includes("<textarea"),
      false,
      `finished_render_has_no_textarea: ${state}`,
    );
  }
}
for (const state of [
  "waiting",
  "starting",
  "buffering",
  "playing",
  "paused",
  "finished",
  "error",
] as const) {
  const mode = state === "waiting" ? "editing" : "reading";
  assert.equal(popupMode(state, false), mode, state);
  assert.equal(popupMode(state, true), "editing", `${state} explicit edit`);
  for (const editing of [false, true]) {
    const html = render({ ...snapshot, state }, editing);
    const readonly = html.includes("data-source-preview");
    const textarea = html.includes("<textarea");
    assert.notEqual(readonly, textarea, `${state}: exactly one text view`);
    assert.equal(
      textarea,
      editing || mode === "editing",
      `${state}: expected text view`,
    );
  }
}
{
  // text_editable_only_without_a_place_to_lose
  const editable = Object.fromEntries(
    (
      [
        "waiting",
        "starting",
        "buffering",
        "playing",
        "paused",
        "finished",
        "error",
      ] as const
    ).map((state) => [state, textEditable(state)]),
  );
  assert.deepEqual(
    editable,
    {
      waiting: true,
      starting: false,
      buffering: false,
      playing: false,
      paused: false,
      finished: true,
      error: true,
    },
    "text_editable_only_without_a_place_to_lose",
  );
  for (const [state, expected] of [
    ["playing", 0],
    ["paused", 0],
    ["starting", 0],
    ["finished", 1],
    ["error", 1],
  ] as const) {
    let clicks = 0;
    routeTextClick(state, () => {
      clicks++;
    });
    assert.equal(clicks, expected, `text click in ${state}`);
  }
}
{
  // edit_text_button_in_every_state
  for (const state of [
    "waiting",
    "starting",
    "buffering",
    "playing",
    "paused",
    "finished",
    "error",
  ] as const) {
    for (const editing of [false, true]) {
      const header = render({ ...snapshot, state }, editing).match(
        /<header[^>]*>(.*?)<\/header>/s,
      )?.[1];
      const buttons = [
        ...(header?.matchAll(/<button([^>]*)>(.*?)<\/button>/gs) ?? []),
      ];
      const named = buttons.filter(
        (match) => match[2].trim() === en.tts.editText,
      );
      assert.equal(
        named.length,
        1,
        `edit_text_button_in_every_state: ${state} editing=${editing}`,
      );
      assert.equal(/\sdisabled(=|\s|>)/.test(named[0][1]), false, state);
      assert.ok(
        buttons.indexOf(named[0]) <
          buttons.findIndex((match) => match[1].includes('aria-label="Close"')),
        `${state}: Edit text sits left of Close`,
      );
    }
  }
  assert.equal(en.tts.editText, "Edit text");
}
{
  // the editor's normal weight wins over the Textarea's font-semibold
  const textarea = render({ ...snapshot, state: "waiting" }).match(
    /<textarea[^>]*class="([^"]*)"/,
  )?.[1];
  assert.ok(
    textarea?.split(/\s+/).includes("font-normal!"),
    `editor weight token: ${textarea}`,
  );
}
{
  // read_text_and_state_use_ink_2
  const html = render({ ...snapshot, state: "playing" });
  const before = html.match(/<span class="([^"]*)">A <\/span>/)?.[1] ?? "";
  assert.ok(
    before.split(/\s+/).includes("text-ink-2"),
    `read_text_and_state_use_ink_2: before-part class ${before}`,
  );
  const stateClass =
    html.match(/<span role="status" class="([^"]*)"/)?.[1] ?? "";
  assert.ok(
    stateClass.split(/\s+/).includes("text-ink-2"),
    `read_text_and_state_use_ink_2: status class ${stateClass}`,
  );
  assert.equal(
    /text-ink-3/.test(before + stateClass),
    false,
    "read_text_and_state_use_ink_2: neither uses ink-3",
  );
}
{
  // reader_buttons_have_a_focus_ring
  const ring = ["focus-visible:ring-2", "focus-visible:ring-logo-primary"];
  for (const state of ["playing", "finished"] as const) {
    const html = render({ ...snapshot, state });
    const buttons = [...html.matchAll(/<button([^>]*)>(.*?)<\/button>/gs)];
    assert.equal(buttons.length, 4, `${state}: header and transport buttons`);
    for (const [, attributes, label] of buttons) {
      const classes = attributes.match(/class="([^"]*)"/)?.[1] ?? "";
      for (const token of ring)
        assert.ok(
          classes.split(/\s+/).includes(token),
          `reader_buttons_have_a_focus_ring: ${state} ${attributes.trim()} ${label.slice(0, 20)} lacks ${token}`,
        );
    }
    assert.ok(
      buttons.some(([, , label]) => label.trim() === en.tts.editText),
      `reader_buttons_have_a_focus_ring: ${state} covers Edit text`,
    );
  }
}
console.log(
  "popup reading view, text editable, Edit text and editor weight assertions passed",
);
for (const [seconds, expected] of [
  [0, "0:00"],
  [59, "0:59"],
  [60, "1:00"],
  [3599, "59:59"],
] as const)
  assert.equal(formatTime(seconds), expected);
assert.ok(
  buffering.match(/<span class="tabular-nums[^>]*>(.*?)<\/span>/s)?.[1] ===
    "0:09 / about 0:50",
  "time_reads_about_the_total: elapsed plus remaining gives the total",
);
const progressBar = buffering.match(/<div[^>]*role="progressbar"[^>]*>/)?.[0];
assert.ok(
  progressBar?.includes('aria-label="Progress"') &&
    progressBar.includes('aria-valuemax="100"') &&
    progressBar.includes('aria-valuenow="20"'),
  progressBar,
);
assert.equal(en.tts.readClipboard, "Read clipboard");
const header = buffering.match(/<header[^>]*>(.*?)<\/header>/s)?.[1];
assert.ok(
  header?.includes("Supertonic 3, alba") &&
    header.includes('aria-label="Close"'),
);
const everyState = [
  "waiting",
  "starting",
  "buffering",
  "playing",
  "paused",
  "finished",
  "error",
] as const;
// Name of every button in document order: aria-label, else its text.
const buttonNames = (html: string) =>
  [...html.matchAll(/<button([^>]*)>(.*?)<\/button>/gs)].map(
    ([, attributes, inner]) =>
      attributes.match(/aria-label="([^"]*)"/)?.[1] ??
      inner.replace(/<[^>]*>/g, "").trim(),
  );
{
  // transport_has_no_stop
  for (const state of everyState) {
    const html = render({ ...snapshot, state });
    assert.equal(
      html.includes('aria-label="Stop"'),
      false,
      `transport_has_no_stop: ${state} has no Stop button`,
    );
    assert.equal(
      /Stopped|>Stop</.test(html),
      false,
      `transport_has_no_stop: ${state} shows no Stop word`,
    );
    assert.deepEqual(
      buttonNames(html),
      [
        en.tts.editText,
        en.tts.close,
        state === "playing" || state === "buffering"
          ? en.tts.pause
          : en.tts.play,
        en.tts.readClipboard,
      ],
      `transport_has_no_stop: ${state} buttons in order`,
    );
    const readButton = html.match(
      /<button[^>]*>(?:(?!<\/button>).)*Read clipboard<\/button>/s,
    )?.[0];
    assert.ok(
      readButton,
      `transport_has_no_stop: ${state} Read clipboard text`,
    );
    assert.ok(readButton.includes("<svg"), `${state}: Read clipboard icon`);
    assert.ok(readButton.includes('aria-hidden="true"'), state);
    assert.equal(/\sdisabled(=|\s|>)/.test(readButton), false, state);
    assert.ok(
      /[\s"]bg-wash\s/.test(readButton),
      `${state}: Read clipboard is the secondary variant: ${readButton.slice(0, 120)}`,
    );
  }
  assert.equal(en.tts.readClipboard, "Read clipboard");
  assert.equal("stop" in en.tts, false, "the unused tts.stop key is gone");
  assert.equal("time" in en.tts, false, "the unused tts.time key is gone");
}
{
  // time_reads_about_the_total
  const timeSpan = (html: string) =>
    html.match(/<span class="tabular-nums[^>]*>(.*?)<\/span>/s)?.[1];
  const statusSpan = (html: string) =>
    html.match(/<span role="status"[^>]*>(.*?)<\/span>/s)?.[1];
  const buffering78 = {
    ...snapshot,
    state: "buffering" as const,
    elapsed_seconds: 78,
    remaining_seconds: 11,
  };
  assert.equal(timeSpan(render(buffering78)), "1:18 / about 1:29");
  assert.equal(timeLabel(buffering78, t), "1:18 / about 1:29");
  const finished89 = {
    ...snapshot,
    state: "finished" as const,
    elapsed_seconds: 89,
    remaining_seconds: 0,
    progress: 1,
  };
  assert.equal(
    timeSpan(render(finished89)),
    "1:29 / about 1:29",
    "one format in every state",
  );
  const waiting = {
    ...snapshot,
    state: "waiting" as const,
    elapsed_seconds: 0,
    remaining_seconds: 0,
    progress: 0,
  };
  const waitingHtml = render(waiting);
  assert.equal(timeLabel(waiting, t), null);
  assert.equal(timeSpan(waitingHtml), undefined, "waiting shows no time");
  assert.equal(statusSpan(waitingHtml), undefined, "waiting shows no word");
  assert.equal(stateWord("waiting"), null);
  assert.ok(
    waitingHtml
      .match(/<div[^>]*role="progressbar"[^>]*>/)?.[0]
      .includes('aria-valuenow="0"'),
    "waiting progress is 0",
  );
  for (const state of everyState.filter((state) => state !== "waiting")) {
    const html = render({ ...snapshot, state });
    assert.ok(timeSpan(html)?.includes("about"), `${state} shows the time`);
    assert.equal(statusSpan(html), t(`tts.states.${state}`), `${state} word`);
    assert.equal(stateWord(state), `tts.states.${state}`);
  }
  assert.equal(en.tts.states.error, "Failed");
  assert.equal(en.tts.timeAbout, "{{elapsed}} / about {{total}}");
  assert.equal("timeDone" in en.tts, false, "no separate finished format");
}
{
  // header_names_model_and_voice
  const models = [
    {
      id: "pocket-en",
      display_name: "Pocket (English)",
      default_voice: "alba",
    },
    {
      id: "phonon-31m-en",
      display_name: "Phonon 31M (English)",
      default_voice: "default",
    },
  ];
  assert.deepEqual(
    readerHeading(
      { tts_model_id: "phonon-31m-en", tts_voice: { "phonon-31m-en": "alba" } },
      models,
    ),
    { model: "Phonon 31M (English)", voice: "alba" },
  );
  assert.deepEqual(
    readerHeading({ tts_model_id: "phonon-31m-en", tts_voice: {} }, models),
    { model: "Phonon 31M (English)", voice: "default" },
    "no stored voice shows the model's default voice",
  );
  assert.deepEqual(
    readerHeading({}, models),
    { model: "Pocket (English)", voice: "alba" },
    "no stored model reads as pocket-en",
  );
  assert.equal(
    readerHeading({ tts_model_id: "unknown-model", tts_voice: {} }, models),
    null,
  );
  const named = render(
    snapshot,
    false,
    readerHeading(
      { tts_model_id: "phonon-31m-en", tts_voice: { "phonon-31m-en": "alba" } },
      models,
    ),
  );
  const head = named.match(/<header[^>]*>(.*?)<\/header>/s)?.[1] ?? "";
  const title = head.match(/<span class="([^"]*)">Read aloud<\/span>/);
  const detail = head.match(
    /<span class="([^"]*)">Phonon 31M \(English\), alba<\/span>/,
  );
  assert.ok(title && detail, `title and detail render: ${head.slice(0, 300)}`);
  assert.ok(head.indexOf("Read aloud") < head.indexOf("Phonon 31M"));
  assert.ok(title[1].split(/\s+/).includes("font-medium"));
  assert.equal(
    title[1].includes("truncate"),
    false,
    "the title never truncates",
  );
  assert.ok(detail[1].split(/\s+/).includes("truncate"));
  assert.ok(detail[1].split(/\s+/).includes("min-w-0"));
  assert.ok(detail[1].split(/\s+/).includes("text-ink-2"));
  const unnamed = render(snapshot, false, null).match(
    /<header[^>]*>(.*?)<\/header>/s,
  )?.[1];
  assert.ok(unnamed?.includes("Read aloud"), "no model: the title stays");
  assert.equal(en.tts.modelVoice, "{{model}}, {{voice}}");
}
{
  // keys_are_named
  for (const state of everyState) {
    const html = render({ ...snapshot, state });
    const buttons = [...html.matchAll(/<button([^>]*)>(.*?)<\/button>/gs)];
    const play = buttons.find(([, attributes]) =>
      /aria-label="(Play|Pause)"/.test(attributes),
    );
    const close = buttons.find(([, attributes]) =>
      attributes.includes('aria-label="Close"'),
    );
    assert.ok(
      play?.[1].includes('aria-keyshortcuts="Control+Enter"'),
      `keys_are_named: ${state} Play or Pause names Ctrl+Enter`,
    );
    assert.ok(
      close?.[1].includes('aria-keyshortcuts="Escape"'),
      `keys_are_named: ${state} Close names Escape`,
    );
  }
  assert.equal(en.tts.keys.toggle, "Ctrl+Enter");
  assert.equal(en.tts.keys.close, "Esc");
}
{
  // keys_are_named: the Tooltip is closed in static markup, so its props are read from the source
  const source = readFileSync(
    new URL("./ReadAloudPopup.tsx", import.meta.url),
    "utf8",
  );
  const tooltips = [...source.matchAll(/<Tooltip\b[\s\S]*?<\/Tooltip>/g)].map(
    ([block]) => block,
  );
  const tipOf = (key: string) =>
    tooltips.filter((block) => block.includes(`text={t("${key}")}`));
  const toggle = tipOf("tts.keys.toggle");
  assert.equal(toggle.length, 1, "one Tooltip receives tts.keys.toggle");
  assert.ok(
    toggle[0].includes('title={t(playing ? "tts.pause" : "tts.play")}') &&
      toggle[0].includes('aria-keyshortcuts="Control+Enter"') &&
      toggle[0].includes("onClick={toggle}"),
    "keys_are_named: the Play/Pause Tooltip wraps the toggle button and names Ctrl+Enter",
  );
  const close = tipOf("tts.keys.close");
  assert.equal(close.length, 1, "one Tooltip receives tts.keys.close");
  assert.ok(
    close[0].includes('title={t("tts.close")}') &&
      close[0].includes('aria-keyshortcuts="Escape"') &&
      close[0].includes("onClick={close}"),
    "keys_are_named: the Close Tooltip wraps the close button and names Esc",
  );
}
{
  // reader_escape_survives_an_open_tooltip
  const source = readFileSync(
    new URL("./ReadAloudPopup.tsx", import.meta.url),
    "utf8",
  );
  const tooltipSource = readFileSync(
    new URL("../components/ui/Tooltip.tsx", import.meta.url),
    "utf8",
  );
  // the injected handler below mirrors this one: it skips a prevented event and, on Escape, stops it
  assert.ok(
    /event\.key !== "Escape"[\s\S]*?!open[\s\S]*?event\.defaultPrevented[\s\S]*?event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*hide\(\);/.test(
      tooltipSource,
    ),
    "the Tooltip Escape handler still prevents and stops the event",
  );
  const root = source.match(/<section\b[^>]*>/)?.[0] ?? "";
  const capturing = root.includes("onKeyDownCapture=");
  const deliver = (key: string, ctrlKey: boolean) => {
    const trace = { closes: 0, toggles: 0, tooltipConsumed: 0 };
    let stopped = false;
    const event = {
      key,
      ctrlKey,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    const actions = {
      close: () => {
        trace.closes++;
      },
      toggle: () => {
        trace.toggles++;
      },
    };
    const reader = () => routePopupKey(event, actions);
    const openTooltip = () => {
      if (key !== "Escape" || event.defaultPrevented) return;
      trace.tooltipConsumed++;
      event.preventDefault();
      stopped = true;
    };
    // DOM order: capture on the reader root, the focused button's tooltip, bubble on the root, then the window
    const phases = capturing ? [reader, openTooltip] : [openTooltip, reader];
    for (const phase of phases) if (!stopped) phase();
    if (!stopped) routePopupKey(event, actions);
    return trace;
  };
  assert.deepEqual(
    deliver("Escape", false),
    { closes: 1, toggles: 0, tooltipConsumed: 0 },
    "reader_escape_survives_an_open_tooltip: one Escape closes once and the tooltip does not consume it",
  );
  assert.deepEqual(
    deliver("Enter", true),
    { closes: 0, toggles: 1, tooltipConsumed: 0 },
    "reader_escape_survives_an_open_tooltip: Ctrl+Enter with a tooltip open toggles once",
  );
  assert.ok(
    capturing && !/\sonKeyDown=/.test(root),
    `the reader root routes keys in the capture phase: ${root}`,
  );
}
{
  // every_locale_renders_the_reader_header
  const failed: Record<string, string> = {
    ar: "فشل",
    bg: "Неуспешно",
    ca: "Ha fallat",
    cs: "Selhalo",
    da: "Mislykkedes",
    de: "Fehlgeschlagen",
    en: "Failed",
    es: "Fallido",
    fr: "Échec",
    he: "נכשל",
    hi: "विफल",
    id: "Gagal",
    it: "Non riuscito",
    ja: "失敗",
    ko: "실패",
    ne: "असफल",
    nl: "Mislukt",
    pl: "Nie powiodło się",
    pt: "Falhou",
    ru: "Не удалось",
    sv: "Misslyckades",
    th: "ไม่สำเร็จ",
    tr: "Başarısız",
    uk: "Не вдалося",
    vi: "Thất bại",
    zh: "失败",
    "zh-TW": "失敗",
  };
  const locales = readdirSync(new URL("../i18n/locales/", import.meta.url));
  assert.equal(locales.length, 27);
  for (const locale of locales) {
    const translation = JSON.parse(
      readFileSync(
        new URL(`../i18n/locales/${locale}/translation.json`, import.meta.url),
        "utf8",
      ),
    );
    const instance = i18next.createInstance();
    await instance.init({
      lng: locale,
      fallbackLng: false,
      interpolation: { escapeValue: false },
      resources: { [locale]: { translation } },
    });
    const html = render(
      {
        ...snapshot,
        state: "buffering",
        elapsed_seconds: 78,
        remaining_seconds: 11,
      },
      false,
      { model: "Phonon 31M (English)", voice: "alba" },
      instance,
    );
    const head = html.match(/<header[^>]*>(.*?)<\/header>/s)?.[1] ?? "";
    assert.ok(head.includes(translation.tts.title), `${locale} title`);
    assert.ok(
      head.includes("Phonon 31M (English)") && head.includes("alba"),
      `${locale} model and voice render: ${head.slice(0, 200)}`,
    );
    assert.equal(/\{\{|tts\./.test(html), false, `${locale}: no raw key`);
    const time = html.match(
      /<span class="tabular-nums[^>]*>(.*?)<\/span>/s,
    )?.[1];
    assert.ok(
      time?.includes("1:18") &&
        time.includes("1:29") &&
        time.length > "1:18 / 1:29".length,
      `${locale} time carries its qualifier: ${time}`,
    );
    for (const key of ["toggle", "close"])
      assert.ok(translation.tts.keys[key]?.trim(), `${locale} tts.keys.${key}`);
    assert.equal("stop" in translation.tts, false, `${locale} tts.stop gone`);
    assert.equal("time" in translation.tts, false, `${locale} tts.time gone`);
    const errorHtml = render(
      { ...snapshot, state: "error" },
      false,
      null,
      instance,
    );
    assert.equal(
      errorHtml.match(/<span role="status"[^>]*>(.*?)<\/span>/s)?.[1],
      failed[locale],
      `${locale} Failed word`,
    );
  }
}
{
  // edit_text_in_an_editable_state_keeps_the_read
  const run = (
    text: string,
    state: SessionSnapshot["state"],
    current: string,
  ) => {
    const calls: string[] = [];
    enterPopupEdit(text, state, {
      current,
      setEditing: (value) => calls.push(`setEditing:${value}`),
      edit: (value) => calls.push(`edit:${value}`),
    });
    return calls;
  };
  for (const state of ["finished", "error", "waiting"] as const)
    assert.deepEqual(
      run("read this", state, "read this"),
      ["setEditing:true"],
      `${state}: unchanged text keeps the read`,
    );
  assert.deepEqual(
    run("new text", "finished", "read this"),
    ["setEditing:true", "edit:new text"],
    "a paste with new text in finished still edits",
  );
  assert.deepEqual(
    run("new text", "error", "read this"),
    ["setEditing:true", "edit:new text"],
    "a paste with new text in failed still edits",
  );
  for (const state of ["playing", "paused", "buffering", "starting"] as const)
    assert.deepEqual(
      run("read this", state, "read this"),
      ["setEditing:true", "edit:read this"],
      `${state}: Edit text replaces an active read`,
    );
}
console.log(
  "popup transport, time, header, keys, locale and Edit text assertions passed",
);
assert.ok(
  buffering.match(/<mark[^>]*class="[^"]*bg-logo-primary/),
  "themed highlight",
);
assert.equal(pasteText("abcdef", "XY", 2, 4), "abXYef");
assert.equal(pasteText("abcdef", "new"), "new");
const edits: string[] = [];
let editingMode = false;
enterPopupEdit("keep text", "playing", {
  current: "keep text",
  edit: (value) => edits.push(value),
  setEditing: (value) => {
    editingMode = value;
  },
});
assert.deepEqual(
  edits,
  ["keep text"],
  "click edit goes through revision-aware edit path",
);
assert.equal(editingMode, true);
let toggles = 0;
togglePopupPlayback({
  toggle: () => {
    toggles++;
  },
  setEditing: (value) => {
    editingMode = value;
  },
});
assert.equal(toggles, 1);
assert.equal(editingMode, false, "Play leaves edit mode");
console.log("popup mode, time, controls and edit/paste seam assertions passed");

const { registerPopupPaste, restorePopupEditor, routePopupPaste } =
  await import("./presentation");
const { createPopupAdapter } = await import("./adapter");
const listeners = new Set<
  (event: import("./presentation").PopupPasteEvent) => void
>();
const pasteWindow = {
  addEventListener: (
    _type: "paste",
    listener: (event: import("./presentation").PopupPasteEvent) => void,
  ) => {
    listeners.add(listener);
  },
  removeEventListener: (
    _type: "paste",
    listener: (event: import("./presentation").PopupPasteEvent) => void,
  ) => {
    listeners.delete(listener);
  },
};
const editorTarget = {};
const bodyTarget = {};
let view = {
  ...snapshot,
  state: "waiting" as SessionSnapshot["state"],
  text: "old text",
};
let explicitEdit = true;
let editorMounted = true;
let selection: { start: number; end: number } | null = null;
let pendingCaret: number | null = null;
let editingWrite = Promise.resolve();
const pasteTrace: string[] = [];
const replacements: { text: string; revision: number }[] = [];
const adapter = createPopupAdapter(
  () => view,
  (next) => {
    view = next;
  },
  {
    play: async () => {
      pasteTrace.push("play");
    },
    pause: async () => {},
    stop: async () => {
      pasteTrace.push("stop");
    },
    replaceText: async (text, revision) => {
      replacements.push({ text, revision });
    },
    close: async () => {},
    readClipboard: async () => {},
    error: () => assert.fail("unexpected paste error"),
  },
);
const detachPaste = registerPopupPaste(pasteWindow, {
  isEditorTarget: (target) => editorMounted && target === editorTarget,
  getText: () => view.text,
  getSelection: () => selection,
  isActive: () => !textEditable(view.state),
  enterEdit: (text, caret) => {
    pendingCaret = caret;
    enterPopupEdit(text, view.state, {
      current: view.text,
      setEditing: (value) => {
        explicitEdit = value;
      },
      edit: (value) => {
        editingWrite = adapter.edit(value);
      },
    });
  },
});
routePopupKey(
  {
    key: "Enter",
    ctrlKey: true,
    defaultPrevented: false,
    preventDefault: () => {},
  },
  {
    close: () => {},
    toggle: () =>
      togglePopupPlayback({
        toggle: () => {
          editingWrite = adapter.toggle();
        },
        setEditing: (value) => {
          explicitEdit = value;
        },
      }),
  },
);
await editingWrite;
view = { ...view, state: "playing" };
editorMounted = false;
assert.equal(popupMode(view.state, explicitEdit), "reading");
const dispatchPaste = (target: unknown, text: string) => {
  let prevented = false;
  const event = {
    target,
    defaultPrevented: false,
    clipboardData: { getData: () => text },
    preventDefault: () => {
      prevented = true;
    },
  };
  for (const listener of listeners) listener(event);
  return prevented;
};
assert.equal(
  dispatchPaste(bodyTarget, "new text"),
  false,
  "paste_during_an_active_read_does_nothing: body paste while playing",
);
assert.deepEqual(pasteTrace, ["play"], "a paste while playing never stops");
assert.deepEqual(replacements, [], "a paste while playing never edits");
assert.equal(explicitEdit, false);
view = { ...view, state: "finished" };
assert.equal(popupMode(view.state, explicitEdit), "reading");
assert.equal(
  dispatchPaste(bodyTarget, "new text"),
  true,
  "window registration captures body paste after the read finishes",
);
await editingWrite;
assert.deepEqual(pasteTrace, ["play", "stop"]);
assert.deepEqual(replacements, [{ text: "new text", revision: 1 }]);
assert.equal(explicitEdit, true);
assert.equal(view.text, "new text");
assert.equal(
  pendingCaret,
  8,
  "body paste prepares editor focus/caret at inserted text end",
);
editorMounted = true;
selection = { start: 4, end: 8 };
assert.equal(
  dispatchPaste(editorTarget, "words"),
  false,
  "Textarea paste retains native insertion",
);
assert.equal(
  replacements.length,
  1,
  "window listener does not also insert Textarea paste",
);
// The native input change sends its resulting value through the existing edit path.
await adapter.edit(pasteText(view.text, "words", 4, 8));
assert.deepEqual(
  replacements,
  [
    { text: "new text", revision: 1 },
    { text: "new words", revision: 2 },
  ],
  "Textarea paste inserts exactly once with one client revision",
);
selection = { start: 4, end: 9 };
assert.equal(dispatchPaste(bodyTarget, "text"), true);
await editingWrite;
assert.equal(
  view.text,
  "new text",
  "non-Textarea paste uses the retained editor selection",
);
assert.equal(pendingCaret, 8);
detachPaste();
assert.equal(
  listeners.size,
  0,
  "cleanup removes the registered window listener",
);
assert.equal(dispatchPaste(bodyTarget, "ignored"), false);
assert.equal(view.text, "new text", "unmounted listener cannot edit");
console.log(
  "window paste: keyboard Play/body target, revision, native exactly-once, caret and cleanup assertions passed",
);

const restored: (string | number[])[] = [];
restorePopupEditor(
  {
    focus: () => {
      restored.push("focus");
    },
    setSelectionRange: (start, end) => {
      restored.push([start, end]);
    },
  },
  { start: 8, end: 8 },
);
assert.deepEqual(
  restored,
  ["focus", [8, 8]],
  "pending paste caret restores editor focus and selection",
);
for (const event of [
  { defaultPrevented: true, clipboardData: { getData: () => "ignored" } },
  { defaultPrevented: false, clipboardData: null },
]) {
  routePopupPaste(
    {
      ...event,
      target: bodyTarget,
      preventDefault: () =>
        assert.fail("must not intercept unavailable/handled paste"),
    },
    {
      isEditorTarget: () => false,
      getText: () => "",
      getSelection: () => null,
      isActive: () => false,
      enterEdit: () => assert.fail("must not edit unavailable/handled paste"),
    },
  );
}
{
  // paste_during_an_active_read_does_nothing
  let prevented = 0;
  let edited = 0;
  routePopupPaste(
    {
      target: bodyTarget,
      defaultPrevented: false,
      clipboardData: { getData: () => "pasted" },
      preventDefault: () => {
        prevented++;
      },
    },
    {
      isEditorTarget: () => false,
      getText: () => "reading",
      getSelection: () => null,
      isActive: () => true,
      enterEdit: () => {
        edited++;
      },
    },
  );
  assert.deepEqual(
    { prevented, edited },
    { prevented: 0, edited: 0 },
    "paste_during_an_active_read_does_nothing",
  );
}
console.log("popup paste during an active read assertions passed");
{
  // reader_popup_is_rounded_themed_and_spec_sized
  const classOf = (tag: string) =>
    (tag.match(/class="([^"]*)"/)?.[1] ?? "").split(/\s+/);
  for (const state of ["playing", "finished"] as const) {
    const html = render({ ...snapshot, state });
    const card = classOf(html.match(/<section[^>]*>/)?.[0] ?? "");
    for (const token of [
      "rounded-card",
      "border",
      "border-line-strong",
      "bg-background",
      "text-[14px]",
      "leading-[20px]",
    ])
      assert.ok(card.includes(token), `${state}: card has ${token}`);
    for (const token of ["rounded-xl", "border-line", "text-sm"])
      assert.equal(
        card.includes(token),
        false,
        `${state}: card drops ${token}`,
      );

    const close = [...html.matchAll(/<button[^>]*>.*?<\/button>/gs)]
      .map(([button]) => button)
      .find((button) => button.includes('aria-label="Close"'));
    assert.ok(close, `${state}: Close renders`);
    const closeClasses = classOf(close);
    for (const token of [
      "size-[28px]",
      "rounded-full!",
      "p-0!",
      "bg-wash",
      "focus-visible:ring-2",
      "focus-visible:ring-logo-primary",
    ])
      assert.ok(closeClasses.includes(token), `${state}: Close has ${token}`);
    const icon = classOf(close.match(/<svg[^>]*>/)?.[0] ?? "");
    assert.ok(
      icon.includes("h-[12px]") && icon.includes("w-[12px]"),
      `${state}: Close X is 12 px: ${icon.join(" ")}`,
    );

    const time = html.match(/<span class="tabular-nums[^>]*>/)?.[0] ?? "";
    assert.ok(classOf(time).includes("text-label"), `${state}: time label`);
    assert.equal(classOf(time).includes("text-xs"), false, state);
    const word = html.match(/<span role="status"[^>]*>/)?.[0] ?? "";
    assert.ok(classOf(word).includes("text-label"), `${state}: state label`);
    assert.equal(classOf(word).includes("text-xs"), false, state);

    const fill = html.match(
      /<div class="[^"]*bg-logo-primary[^"]*" style="width/,
    )?.[0];
    assert.ok(fill?.includes("rounded-full"), `${state}: progress fill`);
    const markTag = html.match(/<mark[^>]*>/)?.[0] ?? "";
    assert.ok(
      classOf(markTag).includes("box-decoration-clone"),
      `${state}: wrapped highlight keeps rounded ends`,
    );
  }
}
{
  // reader_root_is_transparent: App.css paints `:root`, so the page needs a rule that outranks it
  const page = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  assert.ok(
    /html:root,\s*body\s*\{\s*background:\s*transparent;?\s*\}/.test(page),
    "read-aloud/index.html makes the root transparent so only the rounded card paints",
  );
  const css = readFileSync(new URL("../App.css", import.meta.url), "utf8");
  assert.ok(
    /:root\s*\{[^}]*background-color:\s*var\(--color-background\)/.test(css),
    "App.css still paints :root, which is why the rule must be html:root",
  );
}
{
  // reader_window_has_no_native_shadow
  const source = readFileSync(
    new URL("../../src-tauri/src/tts/window.rs", import.meta.url),
    "utf8",
  );
  assert.ok(
    /\.transparent\(true\)\s*\.shadow\(false\)/.test(source),
    "the reader window builder drops the native shadow like the overlay",
  );
}
console.log(
  "popup rounded, themed, close-button and transparent-root assertions passed",
);
