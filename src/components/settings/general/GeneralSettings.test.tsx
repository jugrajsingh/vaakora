import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import en from "../../../i18n/locales/en/translation.json";
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
let os = "windows";
mock.module("@tauri-apps/plugin-os", () => ({ type: () => os }));
const stored: Record<string, unknown> = {};
let audioFeedbackEnabled = true;
mock.module("@/hooks/useSettings", () => ({
  useSettings: () => ({
    audioFeedbackEnabled,
    getSetting: (key: string) => stored[key],
  }),
}));
const activationProps: Record<string, unknown>[] = [];
mock.module("../ShortcutInput", () => ({
  ShortcutInput: ({ shortcutId }: { shortcutId: string }) => (
    <i data-row={"shortcut:" + shortcutId} />
  ),
}));
mock.module("../ShortcutActivation", () => ({
  ShortcutActivationSetting: (props: Record<string, unknown>) => {
    activationProps.push(props);
    return <i data-row="activation" />;
  },
}));
const markerProps: Record<string, Record<string, unknown>> = {};
const markers: [string, string][] = [
  ["../OutputDeviceSelector", "OutputDeviceSelector"],
  ["../AudioFeedback", "AudioFeedback"],
  ["../VolumeSlider", "VolumeSlider"],
  ["../SoundPicker", "SoundPicker"],
  ["../AppLanguageSelector", "AppLanguageSelector"],
  ["../ThemeSelector", "ThemeSelector"],
  ["../StartHidden", "StartHidden"],
  ["../AutostartToggle", "AutostartToggle"],
  ["../ShowTrayIcon", "ShowTrayIcon"],
];
for (const [path, name] of markers) {
  mock.module(path, () => ({
    [name]: (props: Record<string, unknown>) => {
      markerProps[name] = props;
      return <i data-row={name} />;
    },
  }));
}
const { GeneralSettings } = await import("./GeneralSettings");
const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: en } } });

function render(platform: string, cleanup: boolean): string {
  os = platform;
  stored.post_process_enabled = cleanup;
  activationProps.length = 0;
  audioFeedbackEnabled = true;
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <GeneralSettings />
    </I18nextProvider>,
  );
}

// The rows between the "Shortcuts" title and the next group title.
function shortcutsGroup(html: string): string[] {
  const start = html.indexOf(">Shortcuts</h2>");
  assert.ok(start >= 0, "Shortcuts group title");
  const next = html.indexOf("<h2", start);
  const group = html.slice(start, next < 0 ? undefined : next);
  return [...group.matchAll(/data-row="([^"]+)"/g)].map((m) => m[1]);
}

describe("GeneralSettings shortcuts", () => {
  it("general_shortcuts_follow_r3_order", () => {
    assert.deepEqual(shortcutsGroup(render("windows", true)), [
      "shortcut:transcribe",
      "shortcut:transcribe_with_post_process",
      "activation",
      "shortcut:cancel",
      "shortcut:read_aloud",
    ]);
    assert.deepEqual(shortcutsGroup(render("windows", false)), [
      "shortcut:transcribe",
      "activation",
      "shortcut:cancel",
      "shortcut:read_aloud",
    ]);
    const linux = shortcutsGroup(render("linux", true));
    assert.ok(!linux.includes("shortcut:cancel"));
    assert.deepEqual(linux, [
      "shortcut:transcribe",
      "shortcut:transcribe_with_post_process",
      "activation",
      "shortcut:read_aloud",
    ]);
  });

  it("activation_is_labelled_for_dictation", () => {
    render("windows", true);
    assert.equal(activationProps.length, 1);
    assert.equal(activationProps[0].title, "Activation");
    assert.equal(activationProps[0].description, "For dictation shortcuts");
    assert.equal(activationProps[0].descriptionMode, "inline");
  });

  it("dependent_sound_rows_say_why_they_are_off", () => {
    const reason = "Not used when audio feedback is off.";
    render("windows", true);
    assert.equal(markerProps.OutputDeviceSelector.disabled, false);
    assert.equal(markerProps.VolumeSlider.disabled, false);
    audioFeedbackEnabled = false;
    renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <GeneralSettings />
      </I18nextProvider>,
    );
    for (const name of ["OutputDeviceSelector", "VolumeSlider"]) {
      assert.equal(markerProps[name].disabled, true, name);
      assert.equal(markerProps[name].disabledReason, reason, name);
    }
  });
});
