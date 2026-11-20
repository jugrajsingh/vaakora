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
mock.module("@/hooks/useSettings", () => ({
  useSettings: () => ({
    getSetting: () => undefined,
    updateSetting: async () => {},
    resetSetting: async () => {},
    isUpdating: () => false,
    isLoading: false,
    outputDevices: [],
    refreshOutputDevices: async () => {},
  }),
}));
const { OutputDeviceSelector } = await import("./OutputDeviceSelector");
const { VolumeSlider } = await import("./VolumeSlider");
const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: en } } });

const REASON = "Not used when audio feedback is off.";

function render(row: React.ReactElement): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>{row}</I18nextProvider>,
  );
}

describe("dependent sound rows", () => {
  it("disabled_rows_show_their_reason", () => {
    assert.ok(
      render(
        <OutputDeviceSelector disabled={true} disabledReason={REASON} />,
      ).includes(REASON),
      "output device reason",
    );
    assert.ok(
      render(<VolumeSlider disabled={true} disabledReason={REASON} />).includes(
        REASON,
      ),
      "volume reason",
    );
  });

  it("enabled_rows_show_no_reason", () => {
    assert.ok(
      !render(
        <OutputDeviceSelector disabled={false} disabledReason={REASON} />,
      ).includes(REASON),
    );
    assert.ok(
      !render(
        <VolumeSlider disabled={false} disabledReason={REASON} />,
      ).includes(REASON),
    );
  });
});
