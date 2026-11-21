import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import en from "../../../i18n/locales/en/translation.json";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const {
  describe,
  it,
  mock,
}: {
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => void) => void;
  mock: { module: (name: string, factory: () => unknown) => void };
} = createRequire(import.meta.url)("bun:test");

type Model = {
  id: string;
  name: string;
  is_downloaded: boolean;
  supports_language_selection: boolean;
  supports_translation: boolean;
  supported_languages: string[];
};

mock.module("@/i18n", () => ({ default: i18next }));
const stored: Record<string, unknown> = {};
mock.module("@/hooks/useSettings", () => ({
  useSettings: () => ({ getSetting: (key: string) => stored[key] }),
}));
const modelState: {
  currentModel: string;
  models: Model[];
  initialized: boolean;
  error: string | null;
} = {
  currentModel: "",
  models: [],
  initialized: true,
  error: null,
};
mock.module("@/stores/modelStore", () => ({
  useModelStore: () => modelState,
}));
const rendered: [string, Record<string, unknown>][] = [];
const groupProps: {
  role: string;
  state: string;
  manage: () => void;
}[] = [];
// Records the Model group's props and renders the real group as well.
const { JobModelGroup: RealJobModelGroup } = await import(
  "@/components/shared/JobModelGroup"
);
mock.module("@/components/shared/JobModelGroup", () => ({
  JobModelGroup: (props: Parameters<typeof RealJobModelGroup>[0]) => {
    groupProps.push(props);
    return RealJobModelGroup(props);
  },
  jobModelState: (downloaded: number | null) =>
    downloaded === null ? "loading" : downloaded === 0 ? "empty" : "ready",
}));
const markers: [string, string][] = [
  ["./DictationModelSelect", "DictationModelSelect"],
  ["../LanguageSelector", "LanguageSelector"],
  ["../TranslateToEnglish", "TranslateToEnglish"],
  ["../PreferredLanguages", "PreferredLanguages"],
  ["../ChineseScript", "ChineseScriptSetting"],
  ["../MicrophoneSelector", "MicrophoneSelector"],
  ["../ChannelSelector", "ChannelSelector"],
  ["../MuteWhileRecording", "MuteWhileRecording"],
  ["../PasteMethod", "PasteMethodSetting"],
  ["../TypingTool", "TypingToolSetting"],
  ["../ClipboardHandling", "ClipboardHandlingSetting"],
  ["../AutoSubmit", "AutoSubmit"],
  ["../AppendTrailingSpace", "AppendTrailingSpace"],
  ["../CustomWords", "CustomWords"],
  ["../FillerWordRemoval", "FillerWordRemoval"],
  ["../ShowOverlay", "ShowOverlay"],
  ["../HistoryLimit", "HistoryLimit"],
  ["../RecordingRetentionPeriod", "RecordingRetentionPeriodSelector"],
];
for (const [path, name] of markers) {
  mock.module(path, () => ({
    [name]: (props: Record<string, unknown>) => {
      rendered.push([name, props]);
      return <i data-row={name} />;
    },
  }));
}
mock.module("../history/HistoryRows", () => ({
  CompareViewSetting: (props: Record<string, unknown>) => {
    rendered.push(["CompareViewSetting", props]);
    return <i data-row="CompareViewSetting" />;
  },
  RecordingsFolderSetting: (props: Record<string, unknown>) => {
    rendered.push(["RecordingsFolderSetting", props]);
    return <i data-row="RecordingsFolderSetting" />;
  },
}));
const { DictationSettings } = await import("./DictationSettings");
const { capabilityRows } = await import("./capabilities");
const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: en } } });

const model = (language: boolean, translate: boolean): Model => ({
  id: "model-a",
  name: "Model A",
  is_downloaded: true,
  supports_language_selection: language,
  supports_translation: translate,
  supported_languages: ["en", "de"],
});

function render(
  current: Model | undefined,
  spoken: string[] = [],
  manageModels: () => void = () => {},
): string {
  modelState.currentModel = current?.id ?? "";
  modelState.models = current ? [current] : [];
  modelState.initialized = true;
  modelState.error = null;
  stored.spoken_languages = spoken;
  stored.chinese_script = undefined;
  rendered.length = 0;
  groupProps.length = 0;
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <DictationSettings manageModels={manageModels} />
    </I18nextProvider>,
  );
}

function titles(html: string): string[] {
  return [...html.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((m) => m[1]);
}

// Rows per group title, in markup order.
function groups(html: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const part of html.split(/<h2[^>]*>/).slice(1)) {
    const title = part.slice(0, part.indexOf("</h2>"));
    result[title] = [...part.matchAll(/data-row="([^"]+)"/g)].map((m) => m[1]);
  }
  return result;
}

describe("DictationSettings", () => {
  it("release_note_names_paste_method_place", () => {
    const note = readFileSync(
      new URL(
        "../../../content/release-notes/0.10.1.linux.md",
        import.meta.url,
      ),
      "utf8",
    );
    const place = [
      "nav.dictation",
      "nav.settings",
      "settings.groups.output",
      "settings.advanced.pasteMethod.title",
    ]
      .map((key) => i18n.t(key))
      .join(" → ");
    assert.ok(note.includes(`**${place}**`), place);
    assert.ok(!note.includes("Advanced → Paste Method"));
  });
  it("groups_follow_the_job_order", () => {
    const html = render(model(true, true));
    assert.deepEqual(titles(html), [
      "Model",
      "Languages",
      "Microphone",
      "Output",
      "Text",
      "Overlay",
      "History",
    ]);
    assert.deepEqual(groups(html), {
      Model: ["DictationModelSelect", "LanguageSelector", "TranslateToEnglish"],
      Languages: ["PreferredLanguages"],
      Microphone: [
        "MicrophoneSelector",
        "ChannelSelector",
        "MuteWhileRecording",
      ],
      Output: [
        "PasteMethodSetting",
        "TypingToolSetting",
        "ClipboardHandlingSetting",
        "AutoSubmit",
        "AppendTrailingSpace",
      ],
      Text: ["CustomWords", "FillerWordRemoval"],
      Overlay: ["ShowOverlay"],
      History: [
        "HistoryLimit",
        "RecordingRetentionPeriodSelector",
        "CompareViewSetting",
        "RecordingsFolderSetting",
      ],
    });
    const ownHelp = ["HistoryLimit", "RecordingRetentionPeriodSelector"];
    for (const [name, props] of rendered) {
      if (name === "DictationModelSelect") continue;
      if (name === "CompareViewSetting" || name === "RecordingsFolderSetting") {
        assert.deepEqual(props, {}, name);
        continue;
      }
      if (ownHelp.includes(name)) {
        assert.equal(props.descriptionMode, undefined, name);
      } else {
        assert.equal(props.descriptionMode, "tooltip", name);
      }
      assert.equal(props.grouped, true, name);
    }
    assert.match(html, /^<div class="w-full max-w-3xl min-w-0 space-y-6">/);
    const none = render(undefined);
    assert.deepEqual(titles(none), [
      "Model",
      "Languages",
      "Microphone",
      "Output",
      "Text",
      "Overlay",
      "History",
    ]);
    assert.deepEqual(groups(none).Model, []);
    const plain = render(model(false, false));
    assert.equal(titles(plain)[0], "Model");
    assert.deepEqual(groups(plain).Model, ["DictationModelSelect"]);
  });

  it("history_group_rows", () => {
    const html = render(model(true, true));
    assert.deepEqual(groups(html).History, [
      "HistoryLimit",
      "RecordingRetentionPeriodSelector",
      "CompareViewSetting",
      "RecordingsFolderSetting",
    ]);
  });

  it("model_group_state_follows_the_list", () => {
    render(model(true, true));
    assert.deepEqual(
      groupProps.map(({ role, state }) => [role, state]),
      [["dictation", "ready"]],
    );
    render(undefined);
    assert.equal(groupProps[0].state, "empty");
    const notDownloaded = { ...model(true, true), is_downloaded: false };
    render(notDownloaded);
    assert.equal(groupProps[0].state, "empty");
    modelState.initialized = false;
    modelState.models = [];
    groupProps.length = 0;
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <DictationSettings manageModels={() => {}} />
      </I18nextProvider>,
    );
    assert.equal(groupProps[0].state, "loading");
    assert.ok(html.includes("Loading models"));
  });

  it("manage_models_opens_models_dictation", () => {
    let calls = 0;
    render(model(true, true), [], () => (calls += 1));
    assert.equal(groupProps.length, 1);
    groupProps[0].manage();
    assert.equal(calls, 1);
  });

  it("model_store_error_shows_under_the_model_row", () => {
    const clean = render(model(true, true));
    assert.equal(clean.includes('role="alert"'), false);
    modelState.error = "Failed to switch to model: boom";
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <DictationSettings manageModels={() => {}} />
      </I18nextProvider>,
    );
    const alert = html.match(/<div role="alert">(.*?)<\/div>/s)?.[1];
    assert.ok(alert?.includes("Failed to switch to model: boom"), alert);
    assert.ok(alert?.includes("bg-error-wash"));
    assert.ok(
      html.indexOf("Model</h2>") < html.indexOf('role="alert"') &&
        html.indexOf('role="alert"') < html.indexOf("Languages</h2>"),
      "the alert sits between the Model group and Languages",
    );
  });

  it("capability_rows_follow_the_model", () => {
    assert.deepEqual(capabilityRows(undefined), {
      language: false,
      translate: false,
    });
    assert.deepEqual(capabilityRows(model(true, false)), {
      language: true,
      translate: false,
    });
    assert.deepEqual(capabilityRows(model(false, true)), {
      language: false,
      translate: true,
    });
    assert.deepEqual(capabilityRows(model(true, true)), {
      language: true,
      translate: true,
    });
    render(model(true, false));
    const languages = rendered.filter(([name]) => name === "LanguageSelector");
    assert.equal(languages.length, 1);
    assert.equal(languages[0][1].modelId, "model-a");
    assert.deepEqual(languages[0][1].supportedLanguages, ["en", "de"]);
    assert.equal(
      rendered.some(([name]) => name === "TranslateToEnglish"),
      false,
    );
  });

  it("languages_group_carries_its_anchor", () => {
    const html = render(model(true, true));
    const anchor = html.indexOf('id="group-languages"');
    assert.ok(anchor >= 0, "anchor present");
    assert.equal(titles(html.slice(anchor))[0], "Languages");
    assert.equal(titles(html.slice(0, anchor)).includes("Languages"), false);
  });

  it("chinese_script_follows_the_rule", () => {
    render(undefined, ["zh"]);
    assert.ok(rendered.some(([name]) => name === "ChineseScriptSetting"));
    const html = render(undefined, ["en"]);
    assert.equal(
      rendered.some(([name]) => name === "ChineseScriptSetting"),
      false,
    );
    assert.deepEqual(groups(html).Languages, ["PreferredLanguages"]);
  });

  it("moved_titles_are_sentence_case", () => {
    const expected: [string, string][] = [
      ["settings.groups.model", "Model"],
      ["settings.groups.languages", "Languages"],
      ["settings.groups.microphone", "Microphone"],
      ["settings.groups.output", "Output"],
      ["settings.groups.text", "Text"],
      ["settings.groups.overlay", "Overlay"],
      ["settings.groups.history", "History"],
      ["settings.general.preferredLanguages.title", "Preferred languages"],
      ["settings.advanced.chineseScript.title", "Chinese script"],
      ["settings.sound.channel.title", "Input channel"],
      ["settings.debug.muteWhileRecording.label", "Mute while recording"],
      ["settings.advanced.pasteMethod.title", "Paste method"],
      ["settings.advanced.typingTool.title", "Typing tool"],
      ["settings.advanced.clipboardHandling.title", "Clipboard handling"],
      ["settings.advanced.autoSubmit.title", "Auto submit"],
      ["settings.debug.appendTrailingSpace.label", "Append trailing space"],
      ["settings.advanced.customWords.title", "Custom words"],
      ["settings.advanced.fillerWordRemoval.title", "Remove filler words"],
    ];
    for (const [key, text] of expected) {
      assert.equal(i18n.t(key), text, key);
    }
  });
});
