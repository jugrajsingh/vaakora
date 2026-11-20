import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import en from "../../i18n/locales/en/translation.json";
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
mock.module("@tauri-apps/plugin-os", () => ({ type: () => "windows" }));
mock.module("@tauri-apps/api/app", () => ({ getVersion: async () => "0.0.0" }));
mock.module("@tauri-apps/plugin-opener", () => ({ openUrl: async () => {} }));
const stored: Record<string, unknown> = {
  experimental_enabled: true,
  post_process_enabled: true,
  spoken_languages: ["zh"],
};
mock.module("@/hooks/useSettings", () => ({
  useSettings: () => ({
    audioFeedbackEnabled: true,
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
const { AboutSettings } = await import("./about/AboutSettings");
const { DebugSettings } = await import("./debug/DebugSettings");
const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: en } } });

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
});
