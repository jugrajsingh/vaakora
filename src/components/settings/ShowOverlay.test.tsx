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

const stored: Record<string, string> = {};
mock.module("@/hooks/useSettings", () => ({
  useSettings: () => ({
    getSetting: (key: string) => stored[key],
    updateSetting: async () => {},
    isUpdating: () => false,
  }),
}));
const rows: { title: string; selectedValue: string | null }[] = [];
mock.module("@/components/ui/SettingContainer", () => ({
  SettingContainer: ({
    title,
    children,
  }: {
    title: string;
    children: React.ReactElement<{ selectedValue: string | null }>;
  }) => {
    rows.push({ title, selectedValue: children.props.selectedValue });
    return null;
  },
}));
const { ShowOverlay } = await import("./ShowOverlay");
const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: en } } });

function positionRow(style: string, position: string) {
  stored.overlay_style = style;
  stored.overlay_position = position;
  rows.length = 0;
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <ShowOverlay />
    </I18nextProvider>,
  );
  return rows.find((row) => row.title === "Floating window position");
}

describe("ShowOverlay", () => {
  it("shows the floating window position with every overlay style", () => {
    for (const style of ["none", "minimal", "live"]) {
      assert.deepEqual(
        positionRow(style, "top"),
        { title: "Floating window position", selectedValue: "top" },
        `position row with overlay style ${style}`,
      );
    }
  });

  it("reads a legacy none position as bottom", () => {
    assert.equal(positionRow("none", "none")?.selectedValue, "bottom");
  });
});
