import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import type {
  DictationActivity,
  ModelInfo,
  PlaybackState,
} from "../../bindings";
import en from "../../i18n/locales/en/translation.json";
import { LINKS } from "../../lib/navigation";
import {
  connectActivity,
  downloadInput,
  downloadName,
  fileJobInput,
  footerActivity,
  type ActivityInput,
} from "./activity";
import { ActivityView } from "./ActivityView";

const {
  test,
}: { test: (name: string, run: () => void | Promise<void>) => void } =
  createRequire(import.meta.url)("bun:test");

await i18next.init({
  lng: "en",
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
});
const t = i18next.t.bind(i18next);

const idle: ActivityInput = {
  dictation: "ready",
  reading: null,
  fileJob: null,
  download: null,
};
const text = (input: Partial<ActivityInput>) => {
  const activity = footerActivity({ ...idle, ...input });
  return t(activity.key, activity.values);
};
const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const settle = async () => {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
};

test("activity_priority", () => {
  const download = { name: "Whisper Medium", percent: 50 };
  const recording = footerActivity({
    ...idle,
    dictation: "recording",
    reading: "playing",
    download,
  });
  assert.equal(t(recording.key), "Recording");
  assert.equal(recording.dot, "recording");
  assert.equal(recording.link, null);

  const transcribing = footerActivity({
    ...idle,
    dictation: "transcribing",
    reading: "playing",
    fileJob: { percent: 40 },
  });
  assert.equal(t(transcribing.key), "Transcribing");
  assert.equal(transcribing.dot, "busy");

  const cleaning = footerActivity({
    ...idle,
    dictation: "cleaning_up",
    reading: "playing",
  });
  assert.equal(t(cleaning.key), "Cleaning up");
  assert.equal(cleaning.dot, "busy");

  const reading = footerActivity({
    ...idle,
    reading: "playing",
    fileJob: { percent: 40 },
  });
  assert.equal(t(reading.key), "Reading");
  assert.equal(reading.dot, "reading");

  const file = footerActivity({ ...idle, fileJob: { percent: 40 }, download });
  assert.equal(t(file.key, file.values), "Transcribing, 40%");
  assert.deepEqual(file.link, LINKS.dictationHistory);
  assert.equal(file.dot, "busy");
  assert.equal(text({ fileJob: { percent: 0 } }), "Transcribing");
  assert.equal(text({ fileJob: "waiting" }), "Waiting to transcribe");

  const one = footerActivity({ ...idle, download });
  assert.equal(t(one.key, one.values), "Downloading Whisper Medium 50%");
  assert.deepEqual(one.link, LINKS.dictationModels);
  assert.equal(one.percent, 50);

  const many = footerActivity({ ...idle, download: { count: 2 } });
  assert.equal(t(many.key, many.values), "Downloading 2 models");
  assert.deepEqual(many.link, LINKS.dictationModels);
  assert.equal(many.percent, null);

  const ready = footerActivity(idle);
  assert.equal(t(ready.key), "Ready");
  assert.equal(ready.dot, "idle");
  assert.equal(ready.link, null);
  assert.equal(ready.percent, null);
});

test("reader_states_that_read", () => {
  const states: [PlaybackState | null, boolean][] = [
    ["starting", true],
    ["buffering", true],
    ["playing", true],
    ["paused", true],
    ["waiting", false],
    ["finished", false],
    ["error", false],
    [null, false],
  ];
  for (const [reading, reads] of states) {
    assert.equal(text({ reading }) === "Reading", reads, String(reading));
  }
});

test("downloads_count_each_model_once_by_name", () => {
  const models = [
    { id: "medium", name: "Whisper Medium" },
    { id: "small", name: "Whisper Small" },
  ] as ModelInfo[];
  const name = (id: string) => downloadName(id, models, "language-detector", t);
  assert.equal(name("medium"), "Whisper Medium");
  assert.equal(name("language-detector"), "language detector");
  assert.equal(name("not-listed"), "not-listed");

  assert.equal(downloadInput({}, {}, name), null);
  assert.deepEqual(downloadInput({ medium: { percentage: 49.6 } }, {}, name), {
    name: "Whisper Medium",
    percent: 50,
  });
  assert.deepEqual(
    downloadInput({ medium: { percentage: 99.2 } }, { medium: true }, name),
    { name: "Whisper Medium", percent: 100 },
    "a verifying model is one download at 100",
  );
  assert.deepEqual(downloadInput({}, { small: true }, name), {
    name: "Whisper Small",
    percent: 100,
  });
  assert.deepEqual(
    downloadInput(
      { medium: { percentage: 20 }, small: { percentage: 100 } },
      { small: true },
      name,
    ),
    { count: 2 },
  );

  assert.equal(fileJobInput({}), null);
  assert.equal(fileJobInput({ 4: { state: "queued" } }), "waiting");
  assert.deepEqual(
    fileJobInput({
      3: { state: "queued" },
      4: { state: "running", percent: 40 },
    }),
    { percent: 40 },
  );
});

test("reader_query_yields_to_a_newer_event", async () => {
  const run = async (eventFirst: boolean) => {
    const applied: (PlaybackState | null)[] = [];
    let reader!: (state: PlaybackState) => void;
    let answer!: (state: PlaybackState | null) => void;
    const stop = connectActivity({
      listenDictation: async () => () => undefined,
      listenReader: async (apply) => {
        reader = apply;
        return () => undefined;
      },
      queryReader: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
      setDictation: () => undefined,
      setReader: (state) => applied.push(state),
    });
    await settle();
    if (eventFirst) reader("finished");
    answer("playing");
    await settle();
    stop();
    return applied;
  };
  assert.deepEqual(await run(false), ["playing"]);
  assert.deepEqual(
    await run(true),
    ["finished"],
    "a query answered after a newer event never overwrites it",
  );
});

test("events_after_unmount_apply_nothing", async () => {
  const applied: string[] = [];
  let dictation!: (activity: DictationActivity) => void;
  let reader!: (state: PlaybackState) => void;
  let answer!: (state: PlaybackState | null) => void;
  let stopped = 0;
  const stop = connectActivity({
    listenDictation: async (apply) => {
      dictation = apply;
      return () => {
        stopped += 1;
      };
    },
    listenReader: async (apply) => {
      reader = apply;
      return () => {
        stopped += 1;
      };
    },
    queryReader: () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
    setDictation: (activity) => applied.push(activity),
    setReader: (state) => applied.push(String(state)),
  });
  await settle();
  dictation("recording");
  stop();
  dictation("transcribing");
  reader("playing");
  answer("paused");
  await settle();
  assert.deepEqual(applied, ["recording"]);
  assert.equal(stopped, 2, "both listeners are released");
});

test("footer_is_one_line_with_the_chip", () => {
  const download = footerActivity({
    ...idle,
    download: { name: "Whisper Medium", percent: 50 },
  });
  const html = renderToStaticMarkup(
    <ActivityView
      activity={download}
      text="Downloading Whisper Medium 50%"
      onOpen={() => undefined}
    />,
  );
  const buttons = html.match(/<button\b[^>]*>[^<]*<\/button>/gu) ?? [];
  assert.equal(buttons.length, 1);
  assert.match(buttons[0], />Downloading Whisper Medium 50%<\/button>$/u);
  assert.match(
    buttons[0],
    /focus-visible:ring-2 focus-visible:ring-logo-primary/u,
  );
  assert.match(buttons[0], /\bmin-w-0\b/u);
  assert.match(buttons[0], /\btruncate\b/u);
  assert.match(html, /^<div role="status"/u);
  assert.match(html, /style="width:50\.0%"/u);

  const ready = renderToStaticMarkup(
    <ActivityView activity={footerActivity(idle)} text="Ready" />,
  );
  assert.ok(!ready.includes("<button"));
  assert.ok(!ready.includes("width:"));
  assert.match(ready, /<span class="min-w-0 truncate">Ready<\/span>/u);

  const footer = source("./Footer.tsx");
  assert.match(footer, /<footer className="[^"]*\bh-\[36px\][^"]*">/u);
  assert.match(
    footer,
    /<ActivityStatus navigate=\{navigate\} \/>\s*<NoticeChip \/>/u,
  );
  for (const gone of [
    "ModelSelector",
    "LocalLlmModelSelector",
    "UpdateChecker",
    "getVersion",
  ]) {
    assert.ok(!footer.includes(gone), gone);
  }
  assert.match(source("./ActivityStatus.tsx"), /<ActivityView\b/u);
  assert.match(
    source("../notices/NoticePanel.tsx"),
    /footerShown \? "bottom-\[36px\]"/u,
  );
  assert.match(
    source("../../App.tsx"),
    /<Footer navigate=\{navigation\.navigate\} \/>/u,
  );
});

test("footer_adds_no_key_handlers", () => {
  for (const file of [
    "./Footer.tsx",
    "./ActivityStatus.tsx",
    "./ActivityView.tsx",
  ]) {
    const code = source(file);
    for (const banned of ["keydown", "onKeyDown", "Tooltip"]) {
      assert.ok(!code.includes(banned), `${file} has ${banned}`);
    }
  }
});

test("no_selection_on_download_complete", () => {
  const root = new URL("../../", import.meta.url).pathname;
  const pickers = join(root, "components/model-selector");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (path !== pickers) walk(path);
      } else if (/\.tsx?$/u.test(name) && !/\.test\.tsx?$/u.test(name)) {
        files.push(path);
      }
    }
  };
  walk(root);
  assert.ok(files.length > 100, "walked the source tree");
  for (const path of files) {
    const code = readFileSync(path, "utf8");
    const name = relative(root, path);
    assert.ok(
      !(
        code.includes('"model-download-complete"') &&
        code.includes("selectModel(")
      ),
      `${name} selects a model when a download completes`,
    );
    assert.ok(
      !/from "[^"]*model-selector[^"]*"/u.test(code),
      `${name} imports the unused footer pickers`,
    );
  }
});
