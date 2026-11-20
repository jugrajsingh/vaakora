import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { SettingContainer } from "./SettingContainer";
const {
  describe,
  it,
}: {
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => void) => void;
} = createRequire(import.meta.url)("bun:test");

const MODES = ["inline", "tooltip"] as const;
const LAYOUTS = ["horizontal", "stacked"] as const;

function render(
  description: string,
  descriptionMode: (typeof MODES)[number],
  layout: (typeof LAYOUTS)[number],
): string {
  return renderToStaticMarkup(
    <SettingContainer
      title="Row"
      description={description}
      descriptionMode={descriptionMode}
      layout={layout}
      grouped
    >
      <i data-control="" />
    </SettingContainer>,
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
});
