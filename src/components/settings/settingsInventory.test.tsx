import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import en from "../../i18n/locales/en/translation.json";
import { brand, i18nInterpolation } from "@/lib/brand";
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

mock.module("@/i18n", () => ({ default: i18next }));
mock.module("@tauri-apps/plugin-os", () => ({
  type: () => "windows",
  arch: () => "x86_64",
  platform: () => "windows",
}));
mock.module("@tauri-apps/api/app", () => ({ getVersion: async () => "0.0.0" }));
const opened: string[] = [];
mock.module("@tauri-apps/plugin-opener", () => ({
  openUrl: async (url: string) => {
    opened.push(url);
  },
}));
const stored: Record<string, unknown> = {
  experimental_enabled: true,
  post_process_enabled: true,
  spoken_languages: ["zh"],
};
mock.module("@/hooks/useSettings", () => ({
  useSettings: () => ({
    audioFeedbackEnabled: true,
    updateChecksLocked: true,
    getSetting: (key: string) => stored[key],
  }),
}));
const model = {
  id: "model-a",
  name: "Model A",
  is_downloaded: true,
  supports_language_selection: true,
  supports_translation: true,
  supported_languages: ["en"],
};
mock.module("@/stores/modelStore", () => ({
  useModelStore: () => ({
    currentModel: model.id,
    models: [model],
    initialized: true,
    error: null,
  }),
}));
const markers: [string, string][] = [
  ["./dictation/DictationModelSelect", "DictationModelSelect"],
  ["./LanguageSelector", "LanguageSelector"],
  ["./TranslateToEnglish", "TranslateToEnglish"],
  ["./PreferredLanguages", "PreferredLanguages"],
  ["./ChineseScript", "ChineseScriptSetting"],
  ["./MicrophoneSelector", "MicrophoneSelector"],
  ["./ChannelSelector", "ChannelSelector"],
  ["./MuteWhileRecording", "MuteWhileRecording"],
  ["./PasteMethod", "PasteMethodSetting"],
  ["./TypingTool", "TypingToolSetting"],
  ["./ClipboardHandling", "ClipboardHandlingSetting"],
  ["./AutoSubmit", "AutoSubmit"],
  ["./AppendTrailingSpace", "AppendTrailingSpace"],
  ["./CustomWords", "CustomWords"],
  ["./FillerWordRemoval", "FillerWordRemoval"],
  ["./ShowOverlay", "ShowOverlay"],
  ["./HistoryLimit", "HistoryLimit"],
  ["./RecordingRetentionPeriod", "RecordingRetentionPeriodSelector"],
  ["./ShortcutInput", "ShortcutInput"],
  ["./ShortcutActivation", "ShortcutActivationSetting"],
  ["./OutputDeviceSelector", "OutputDeviceSelector"],
  ["./AudioFeedback", "AudioFeedback"],
  ["./VolumeSlider", "VolumeSlider"],
  ["./ModelUnloadTimeout", "ModelUnloadTimeoutSetting"],
  ["./StartHidden", "StartHidden"],
  ["./AutostartToggle", "AutostartToggle"],
  ["./ShowTrayIcon", "ShowTrayIcon"],
  ["./ExperimentalToggle", "ExperimentalToggle"],
  ["./debug/KeyboardImplementationSelector", "KeyboardImplementationSelector"],
  ["./VoiceActivityDetection", "VoiceActivityDetection"],
  ["./LongFormChunking", "LongFormChunking"],
  ["./LanguageDetection", "LanguageDetection"],
  ["./AccelerationSelector", "AccelerationSelector"],
  ["./LazyStreamClose", "LazyStreamClose"],
  ["./AirPodsMode", "AirPodsMode"],
  ["./VadBackendSelector", "VadBackendSelector"],
  ["./SoundPicker", "SoundPicker"],
  ["./AppLanguageSelector", "AppLanguageSelector"],
  ["./ThemeSelector", "ThemeSelector"],
  ["./AppDataDirectory", "AppDataDirectory"],
  ["./ShowWhatsNewOnUpdate", "ShowWhatsNewOnUpdate"],
  ["./debug", "LogDirectory"],
  ["./debug/WordCorrectionThreshold", "WordCorrectionThreshold"],
  ["./debug/LogLevelSelector", "LogLevelSelector"],
  ["./debug/LiveLogViewer", "LiveLogViewer"],
  ["./debug/PasteDelay", "PasteDelay"],
  ["./debug/HoldThreshold", "HoldThreshold"],
  ["./debug/ReliablePaste", "ReliablePasteToggle"],
  ["./debug/RecordingBuffer", "RecordingBuffer"],
  ["./debug/LanguageDetectionWindow", "LanguageDetectionWindow"],
  ["./AlwaysOnMicrophone", "AlwaysOnMicrophone"],
  ["./ClamshellMicrophoneSelector", "ClamshellMicrophoneSelector"],
  ["./UpdateChecksToggle", "UpdateChecksToggle"],
  ["./debug/WhatsNewPreview", "WhatsNewPreview"],
  ["./debug/KeyboardDiagnostic", "KeyboardDiagnostic"],
];
// The last props each marker row was rendered with.
const propsOf: Record<string, Record<string, unknown>> = {};
for (const [path, name] of markers) {
  mock.module(path, () => ({
    [name]: (props: Record<string, unknown>) => {
      propsOf[name] = props;
      return <i data-row={name} />;
    },
  }));
}
mock.module("./debug/OnboardingPreview", () => ({
  OnboardingPreview: () => <i data-row="OnboardingPreview" />,
  DebugRun: () => <i data-row="DebugRun" />,
}));
const { DictationSettings } = await import("./dictation/DictationSettings");
const { GeneralSettings } = await import("./general/GeneralSettings");
const { AdvancedSettings } = await import("./advanced/AdvancedSettings");
const { AboutSettings, openSourceCode } = await import("./about/AboutSettings");
const { DebugSettings } = await import("./debug/DebugSettings");
const i18n = i18next.createInstance();
await i18n.init({
  lng: "en",
  resources: { en: { translation: en } },
  interpolation: i18nInterpolation,
});

function markup(page: React.ReactElement): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>{page}</I18nextProvider>,
  );
}

function markerNames(html: string): string[] {
  return [...html.matchAll(/data-row="([^"]+)"/g)].map((m) => m[1]);
}

function rows(page: React.ReactElement): string[] {
  return markerNames(markup(page));
}

// Each group title with the marker rows that follow it, in page order.
function groups(page: React.ReactElement): { title: string; rows: string[] }[] {
  return markup(page)
    .split("<h2")
    .slice(1)
    .map((chunk) => ({
      title: chunk.slice(chunk.indexOf(">") + 1, chunk.indexOf("</h2>")),
      rows: markerNames(chunk),
    }));
}

const noop = () => {};
const debugPage = (
  <DebugSettings
    onPreviewOnboarding={noop}
    onRunOnboarding={noop}
    onRunModelMigration={noop}
  />
);

const HOME: Record<string, "dictation" | "general" | "advanced"> = {
  PreferredLanguages: "dictation",
  MicrophoneSelector: "dictation",
  ChannelSelector: "dictation",
  MuteWhileRecording: "dictation",
  PasteMethodSetting: "dictation",
  TypingToolSetting: "dictation",
  ClipboardHandlingSetting: "dictation",
  AutoSubmit: "dictation",
  AppendTrailingSpace: "dictation",
  CustomWords: "dictation",
  FillerWordRemoval: "dictation",
  ShowOverlay: "dictation",
  HistoryLimit: "dictation",
  RecordingRetentionPeriodSelector: "dictation",
  SoundPicker: "general",
  AppLanguageSelector: "general",
  ThemeSelector: "general",
  StartHidden: "general",
  AutostartToggle: "general",
  ShowTrayIcon: "general",
  ModelUnloadTimeoutSetting: "advanced",
  VoiceActivityDetection: "advanced",
  LongFormChunking: "advanced",
  ExperimentalToggle: "advanced",
};

const EXPERIMENTAL_ROWS = [
  "KeyboardImplementationSelector",
  "AccelerationSelector",
  "LazyStreamClose",
  "AirPodsMode",
  "VadBackendSelector",
  "LanguageDetection",
];

describe("settings inventory", () => {
  it("every_moved_row_has_one_home", () => {
    stored.experimental_enabled = true;
    const pages = {
      dictation: rows(<DictationSettings manageModels={noop} />),
      general: rows(<GeneralSettings />),
      advanced: rows(<AdvancedSettings />),
      about: rows(<AboutSettings />),
      debug: rows(debugPage),
    };
    const all = Object.values(pages).flat();
    for (const [name, home] of Object.entries(HOME)) {
      assert.equal(all.filter((row) => row === name).length, 1, name);
      assert.ok(pages[home].includes(name), name + " in " + home);
    }
  });

  it("general_groups_in_order", () => {
    assert.deepEqual(groups(<GeneralSettings />), [
      {
        title: "Shortcuts",
        rows: [
          "ShortcutInput",
          "ShortcutInput",
          "ShortcutActivationSetting",
          "ShortcutInput",
          "ShortcutInput",
        ],
      },
      {
        title: "Sound",
        rows: [
          "AudioFeedback",
          "OutputDeviceSelector",
          "VolumeSlider",
          "SoundPicker",
        ],
      },
      { title: "Appearance", rows: ["AppLanguageSelector", "ThemeSelector"] },
      {
        title: "Startup",
        rows: ["StartHidden", "AutostartToggle", "ShowTrayIcon"],
      },
    ]);
    assert.equal(propsOf.SoundPicker.label, "Sound theme");
    assert.equal(
      propsOf.SoundPicker.description,
      "Choose a sound theme for recording start and stop feedback",
    );
  });

  it("advanced_groups_in_order", () => {
    stored.experimental_enabled = true;
    assert.deepEqual(groups(<AdvancedSettings />), [
      {
        title: "Models",
        rows: ["ModelUnloadTimeoutSetting"],
      },
      {
        title: "Dictation engine",
        rows: ["VoiceActivityDetection", "LongFormChunking"],
      },
      {
        title: "Experimental",
        rows: ["ExperimentalToggle", ...EXPERIMENTAL_ROWS],
      },
    ]);
    assert.equal(propsOf.ModelUnloadTimeoutSetting.title, "Unload idle models");
    assert.equal(propsOf.AccelerationSelector.title, "Run dictation models on");
  });

  it("experimental_off_shows_only_the_switch", () => {
    stored.experimental_enabled = false;
    const advanced = groups(<AdvancedSettings />);
    stored.experimental_enabled = true;
    const experimental = advanced.find((g) => g.title === "Experimental");
    assert.ok(experimental, "Experimental title is present");
    assert.deepEqual(experimental.rows, ["ExperimentalToggle"]);
    for (const name of EXPERIMENTAL_ROWS) {
      assert.ok(!advanced.some((g) => g.rows.includes(name)), name);
    }
  });

  it("about_shows_update_state", () => {
    const html = markup(<AboutSettings />);
    const about = en.settings.about;
    const version = html.indexOf(">" + about.version.title + "<");
    const updates = html.indexOf(">" + about.updates.title + "<");
    const marker = html.indexOf('data-row="updates"');
    const whatsNew = html.indexOf('data-row="ShowWhatsNewOnUpdate"');
    assert.ok(version >= 0, "Version row is rendered");
    assert.ok(
      version < updates && updates < marker && marker < whatsNew,
      "Updates row follows Version and precedes the next row",
    );
    assert.equal(
      rows(<AboutSettings />).filter((row) => row === "updates").length,
      1,
    );
    const row = html.slice(marker, whatsNew);
    assert.ok(row.includes("Update checks are off"), "off state is shown");
    assert.ok(!row.includes("Check for updates"), "no check button when off");
    const footer = readFileSync(
      new URL("../footer/Footer.tsx", import.meta.url),
      "utf8",
    );
    assert.ok(!footer.includes("UpdateChecker"), "Footer has no UpdateChecker");
    assert.ok(!footer.includes("getVersion"), "Footer has no version");
  });

  it("fork_strings_follow_terms", () => {
    const read = (path: string): unknown =>
      path
        .split(".")
        .reduce<unknown>((node, key) => (node as never)?.[key], en);
    const wanted: Record<string, string> = {
      "tray.transcriptionModel": "Dictation model",
      "tray.unloadModel": "Unload dictation model",
      "tray.cleanup": "Cleanup model",
      "tray.noCleanupModel": "No cleanup model",
      "tray.unloadPostProcessingModel": "Unload cleanup model",
      "tray.cleanupError": "failed",
      "tray.ttsModel": "Read-aloud model",
      "tray.ttsUnload": "Unload read-aloud model",
      "tray.ttsStarting": "Loading",
      "tray.ttsReady": "Ready",
      "tray.ttsUnloaded": "Not loaded",
      "tts.status.starting": "Loading",
      "tts.status.unloaded": "Not loaded",
      "settings.postProcessing.localLlm.plainDescription":
        "Uses your selected prompt.",
      "settings.postProcessing.localLlm.status.description":
        "The model loads when a dictation with cleanup starts and unloads after the model unload timeout.",
      "settings.postProcessing.localLlm.status.error": "Failed: {{reason}}",
      "settings.postProcessing.localLlm.styling.description":
        "How formal the cleaned text reads.",
      "settings.postProcessing.localLlm.promptRequired":
        "Select a non-empty prompt in the Instructions group. Until then, cleanup is skipped and the original transcript is used.",
      "tts.errors.worker": "The read-aloud worker stopped.",
      "tts.errors.notReady": "Read aloud is still loading.",
      "tts.errors.generic": "Something went wrong.",
      "tts.errors.busy": "Another read-aloud action is still running.",
      "tts.errors.path": "The read-aloud storage folder is unavailable.",
      "tts.errors.protocol":
        "The read-aloud worker returned an invalid response.",
      "tts.errors.registry": "The read-aloud model list is invalid.",
      "tts.errors.settings": "The read-aloud settings could not be saved.",
      "tts.errors.start": "The read-aloud worker could not start.",
      "tts.errors.starting": "The read-aloud worker is loading.",
      "tts.errors.unknownModel": "The selected read-aloud model is unknown.",
      "tts.errors.memory": "At least 1.1 GB of available memory is required.",
      "tts.vocabulary.errors.tooLarge":
        "The vocabulary file would be larger than 1 MB, so nothing was saved.",
      "tts.vocabulary.check.transcribeFailed":
        "The dictation model could not transcribe the voice.",
      "tts.correction.microphone.transcribeFailed":
        "The dictation model could not transcribe what you said.",
      "tts.vocabulary.derive.notExplained":
        "No single entry makes the text read this way.",
      "tts.correction.deriving": "Working out the entry...",
      "tts.history.retentionConfirm.message_one":
        "Delete {{count}} entry now? Your vocabulary is not changed.",
      "tts.history.retentionConfirm.message":
        "Delete {{count}} entries now? Your vocabulary is not changed.",
      "tts.history.retentionConfirm.action": "Delete entries",
      "errors.vocabularyInvalidTitle": "Vocabulary file has an error",
      "errors.readAloudBusyPasting":
        "Still pasting. Try Read aloud again after the paste finishes.",
      "history.failedLine":
        "This entry could not be transcribed. Use {{action}} to try again.",
      "history.notTranscribedLine":
        "This entry is not transcribed yet. Use {{action}} to transcribe it.",
      "tts.history.copyFailed": "Could not copy the text to the clipboard.",
      "settings.sound.feedbackOutputDevice": "Feedback output device",
      "tts.sameAsHandy": "Same as the feedback output device",
      "settings.shortcuts.inUse": "Already used by {{name}}",
      "settings.shortcuts.cannotClear": "{{name}} cannot be cleared",
    };
    for (const [key, value] of Object.entries(wanted)) {
      assert.equal(read(key), value, key);
    }
    // Upstream keys on rows the redesign moved: casing only, en only.
    const casing: Record<string, string> = {
      "tray.checkUpdates": "Check for updates...",
      "tray.copyLastTranscript": "Copy last transcript",
      "tray.otherLanguages": "Other languages",
      "settings.sound.audioFeedback.label": "Audio feedback",
      "settings.advanced.lazyStreamClose.label":
        "Keep mic open between transcriptions",
      "settings.advanced.airpodsMode.label": "AirPods mode",
      "settings.advanced.pasteMethod.options.externalScript": "External script",
      "settings.advanced.clipboardHandling.options.dontModify":
        "Don't modify clipboard",
      "settings.advanced.clipboardHandling.options.copyToClipboard":
        "Copy to clipboard",
      "settings.advanced.languageDetection.title": "Limit Auto to my languages",
      "settings.advanced.vadBackend.title": "Voice activity backend",
      "settings.advanced.chineseScript.options.asTranscribed": "As transcribed",
      "settings.postProcessing.api.apiFormat.title": "API format",
      "settings.postProcessing.api.apiKey.title": "API key",
      "settings.postProcessing.prompts.selectedPrompt.title": "Selected prompt",
      "settings.postProcessing.prompts.promptLabel": "Prompt label",
      "settings.postProcessing.prompts.promptInstructions":
        "Prompt instructions",
      "settings.about.appDataDirectory.title": "App data directory",
      "settings.about.sourceCode.title": "Source code",
    };
    for (const [key, value] of Object.entries(casing)) {
      assert.equal(read(key), value, key);
    }
    // Retired fork keys are gone from every locale.
    const root = new URL("../../i18n/locales/", import.meta.url);
    const languages = readdirSync(root);
    assert.equal(languages.length, 27);
    const forbidden =
      /post-?processing|post-processed|text-to-speech|speech-to-text|\bTTS\b|MiB|GiB|stored reads?|retry icon/i;
    const scoped = [
      "tray",
      "tts.errors",
      "tts.status",
      "settings.postProcessing.localLlm",
      "tts.history.retentionConfirm",
    ];
    const leaves = (node: unknown, path: string): [string, string][] =>
      typeof node === "string"
        ? [[path, node]]
        : Object.entries(node as Record<string, unknown>).flatMap(
            ([key, child]) => leaves(child, `${path}.${key}`),
          );
    for (const language of languages) {
      const locale = JSON.parse(
        readFileSync(new URL(`${language}/translation.json`, root), "utf8"),
      );
      const value = (path: string) =>
        path
          .split(".")
          .reduce<unknown>((node, key) => (node as never)?.[key], locale);
      assert.ok(!String(value("tts.sameAsHandy")).includes("{{"), language);
      assert.equal(value("tts.errors.unavailable"), undefined, language);
      assert.equal(value("tts.errors.model"), undefined, language);
      for (const key of Object.keys(wanted)) {
        const text = value(key);
        assert.equal(typeof text, "string", `${language} ${key}`);
        assert.notEqual(text, "", `${language} ${key}`);
        if (language !== "en") {
          assert.notEqual(text, wanted[key], `${language} ${key}`);
        }
        if (/\{\{[a-z]+\}\}/.test(wanted[key])) {
          for (const variable of wanted[key].match(/\{\{[a-z]+\}\}/g) ?? []) {
            assert.ok(String(text).includes(variable), `${language} ${key}`);
          }
        }
      }
      for (const scope of language === "en" ? scoped : []) {
        for (const [path, text] of leaves(value(scope), scope)) {
          assert.ok(!forbidden.test(text), `${language} ${path}: ${text}`);
        }
      }
    }
    const sources = (file: string) =>
      readFileSync(new URL(file, import.meta.url), "utf8");
    const output = sources("./OutputDeviceSelector.tsx");
    assert.ok(output.includes("settings.sound.feedbackOutputDevice"));
    assert.ok(!output.includes("settings.sound.outputDevice.title"));
  });

  it("about_has_no_donate_and_opens_the_brand_repository", async () => {
    const html = markup(<AboutSettings />);
    assert.ok(html.includes(">" + en.settings.about.sourceCode.title + "<"));
    assert.ok(!html.includes("Support development"), "no donate row");
    assert.ok(!html.includes("donate"), "no donate link");
    assert.equal(
      (en.settings.about as Record<string, unknown>).supportDevelopment,
      undefined,
      "the donate strings are gone",
    );
    opened.length = 0;
    await openSourceCode();
    assert.deepEqual(opened, [brand.links.repo]);
  });

  it("no_locale_value_names_handy", () => {
    const root = new URL("../../i18n/locales/", import.meta.url);
    const languages = readdirSync(root);
    assert.equal(languages.length, 27);
    type Leaf = [string, string];
    const leaves = (node: unknown, path: string): Leaf[] =>
      typeof node === "string"
        ? [[path, node]]
        : Object.entries(node as Record<string, unknown>).flatMap(
            ([key, child]) => leaves(child, `${path}.${key}`),
          );
    for (const language of languages) {
      const locale = JSON.parse(
        readFileSync(new URL(`${language}/translation.json`, root), "utf8"),
      );
      for (const [path, text] of leaves(locale, language)) {
        // Values only: key names (tts.sameAsHandy) are internal.
        assert.ok(!/\bhandy\b/i.test(text), `${path} names Handy: ${text}`);
        assert.ok(!/Handy/.test(text), `${path} names Handy: ${text}`);
      }
      // The tray strings are copied by build.rs and never interpolated.
      const tray: Leaf[] = [
        ...leaves(locale.tray, `${language}.tray`),
        ...Object.entries(locale.errors as Record<string, string>)
          .filter(([key]) => key.endsWith("Title"))
          .map(([key, text]): Leaf => [`${language}.errors.${key}`, text]),
      ];
      for (const [path, text] of tray) {
        assert.ok(!text.includes("{{"), `${path} carries a placeholder`);
      }
    }
  });

  it("renders_the_brand_name_through_interpolation", () => {
    assert.equal(
      i18n.t("settings.about.version.description"),
      "Current version of Vaakora",
    );
    assert.equal(
      i18n
        .t("settings.shortcuts.cancelLinuxHelp")
        .endsWith("run vaakora --cancel."),
      true,
    );
    const index = readFileSync(
      new URL("../../i18n/index.ts", import.meta.url),
      "utf8",
    );
    assert.ok(
      index.includes("interpolation: i18nInterpolation"),
      "the app instance uses the shared interpolation",
    );
  });

  it("thai_keeps_every_interpolation_and_tag_of_english", () => {
    const thai = JSON.parse(
      readFileSync(
        new URL("../../i18n/locales/th/translation.json", import.meta.url),
        "utf8",
      ),
    );
    const leaves = (node: unknown, path: string): [string, string][] =>
      typeof node === "string"
        ? [[path, node]]
        : Object.entries(node as Record<string, unknown>).flatMap(
            ([key, child]) => leaves(child, `${path}.${key}`),
          );
    const marks = (text: string) =>
      (text.match(/\{\{[^}]+\}\}|<\/?[A-Za-z][^>]*>/g) ?? []).sort();
    const theirs = new Map(leaves(thai, ""));
    const english = leaves(en, "");
    assert.equal(theirs.size, english.length);
    for (const [path, text] of english) {
      assert.deepEqual(
        marks(theirs.get(path) ?? ""),
        marks(text),
        `th${path} keeps the marks of English`,
      );
    }
  });
});
