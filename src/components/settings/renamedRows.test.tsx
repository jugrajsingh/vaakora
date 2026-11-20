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
mock.module("@/bindings", () => ({ commands: {} }));
mock.module("@/hooks/useSettings", () => ({
  useSettings: () => ({
    settings: { debug_mode: false },
    getSetting: () => undefined,
    updateSetting: async () => {},
    isUpdating: () => false,
  }),
}));
const { ModelUnloadTimeoutSetting } = await import("./ModelUnloadTimeout");
const { AccelerationSelector } = await import("./AccelerationSelector");
const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: en } } });

function render(row: React.ReactElement): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>{row}</I18nextProvider>,
  );
}

describe("renamed rows", () => {
  it("renamed_rows_take_their_title", () => {
    const renamed = render(<ModelUnloadTimeoutSetting title="X" />);
    assert.ok(renamed.includes(">X</h3>"), "title X");
    assert.ok(!renamed.includes("Unload Model"));
    assert.ok(render(<ModelUnloadTimeoutSetting />).includes("Unload Model"));

    const accelerator = render(<AccelerationSelector title="Y" />);
    assert.ok(accelerator.includes(">Y</h3>"), "title Y");
    assert.ok(!accelerator.includes("Hardware Acceleration"));
    assert.ok(
      render(<AccelerationSelector />).includes("Hardware Acceleration"),
    );
  });
});
