import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import en from "../../i18n/locales/en/translation.json";
import { SettingContainer } from "./SettingContainer";
import { Slider } from "./Slider";
const {
  describe,
  it,
}: {
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => void) => void;
} = createRequire(import.meta.url)("bun:test");
const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: en } } });

const MODES = ["inline", "tooltip"] as const;
const LAYOUTS = ["horizontal", "stacked"] as const;

function render(
  description: string,
  descriptionMode: (typeof MODES)[number],
  layout: (typeof LAYOUTS)[number],
): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <SettingContainer
        title="Row"
        description={description}
        descriptionMode={descriptionMode}
        layout={layout}
        grouped
      >
        <i data-control="" />
      </SettingContainer>
    </I18nextProvider>,
  );
}

describe("SettingContainer", () => {
  it("empty_description_renders_no_paragraph_or_tooltip", () => {
    for (const mode of MODES) {
      for (const layout of LAYOUTS) {
        const html = render("", mode, layout);
        const where = `${mode} ${layout}`;
        assert.ok(html.includes(">Row</h3>"), where);
        assert.ok(html.includes("data-control"), where);
        assert.ok(!/<p[ >]/.test(html), where);
        assert.ok(!html.includes("More information"), where);
      }
    }
  });

  it("a_description_still_renders_its_paragraph_or_tooltip", () => {
    for (const layout of LAYOUTS) {
      const inline = render("Help text", "inline", layout);
      assert.ok(inline.includes(">Help text</p>"), layout);
      const tooltip = render("Help text", "tooltip", layout);
      assert.ok(tooltip.includes("More information"), layout);
    }
  });

  it("inline_reason_keeps_a_gap", () => {
    for (const grouped of [true, false]) {
      const html = renderToStaticMarkup(
        <I18nextProvider i18n={i18n}>
          <Slider
            value={1}
            onChange={() => {}}
            min={0}
            max={1}
            label="Volume"
            description="Not used when audio feedback is off."
            descriptionMode="inline"
            grouped={grouped}
            disabled
          />
        </I18nextProvider>,
      );
      const row = html.match(/^<div class="([^"]*)"/);
      assert.ok(row, "the row container");
      assert.ok(
        row[1].split(" ").some((token) => /^gap-([3-9]|\d\d)$/.test(token)),
        `grouped ${grouped}, row classes: ${row[1]}`,
      );
      const reason = html.match(
        /<div class="([^"]*)"><h3[^>]*>Volume<\/h3><p[^>]*>Not used when audio feedback is off\.<\/p>/,
      );
      assert.ok(reason, "the reason sits under the title in one block");
      assert.ok(reason[1].split(" ").includes("min-w-0"), reason[1]);
    }
  });
});
