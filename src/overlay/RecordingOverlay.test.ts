import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";

const { describe, it } = createRequire(import.meta.url)("bun:test");

const css = readFileSync(
  new URL("./RecordingOverlay.css", import.meta.url),
  "utf8",
);
const tsx = readFileSync(
  new URL("./RecordingOverlay.tsx", import.meta.url),
  "utf8",
);
const en = JSON.parse(
  readFileSync(
    new URL("../i18n/locales/en/translation.json", import.meta.url),
    "utf8",
  ),
) as { overlay: Record<string, string> };

// The declarations of the rule whose selector is exactly `selector`.
const rule = (selector: string): string => {
  const start = css.indexOf(`\n${selector} {`);
  assert.notEqual(start, -1, `rule ${selector} exists`);
  return css
    .slice(start, css.indexOf("}", start))
    .replace(/\/\*[\s\S]*?\*\//g, "");
};

describe("recording overlay", () => {
  it("live_text_is_upright", () => {
    assert.doesNotMatch(rule(".stext-cap"), /font-style:\s*italic/);
    assert.doesNotMatch(rule(".stext-scroll"), /font-style:\s*italic/);
    assert.match(
      rule(".stext-cap"),
      /mask-image:\s*linear-gradient\(to bottom, transparent 0, #000 12px\)/,
    );
  });

  it("live_text_viewport_is_two_whole_lines_and_padding_is_outside", () => {
    const cap = rule(".stext-cap");
    const scroll = rule(".stext-scroll");
    const fontSize = Number(cap.match(/font-size:\s*(\d+)px/)?.[1]);
    const lineHeight = Number(cap.match(/line-height:\s*([\d.]+)/)?.[1]);
    const padTop = Number(cap.match(/padding-top:\s*(\d+)px/)?.[1]);
    assert.ok(fontSize > 0 && lineHeight > 0 && padTop > 0);
    const textH = css.match(
      /--ov-cap-text-h:\s*calc\(2 \* (\d+)px \* ([\d.]+)\)/,
    );
    assert.ok(textH, "--ov-cap-text-h is two line boxes");
    assert.equal(
      2 * Number(textH[1]) * Number(textH[2]),
      2 * fontSize * lineHeight,
    );
    const total = css.match(
      /--ov-cap-max-h:\s*calc\((\d+)px \+ 2 \* (\d+)px \* ([\d.]+)\)/,
    );
    assert.ok(total, "--ov-cap-max-h is padding plus two line boxes");
    assert.equal(Number(total[1]), padTop);
    assert.equal(Number(total[2]) * Number(total[3]), fontSize * lineHeight);
    assert.match(scroll, /max-height:\s*min\(var\(--ov-cap-text-h\)/);
    assert.match(scroll, /overflow-y:\s*auto/);
    assert.doesNotMatch(
      scroll,
      /padding/,
      "padding stays outside the scroller",
    );
    assert.doesNotMatch(cap, /overflow/, "the padded frame does not scroll");
    assert.match(
      css,
      /\.ov-stage\.top \.stext-cap \{[^}]*padding-bottom:\s*12px/,
      "top placement keeps its padding on the frame",
    );
  });

  it("live_text_scroller_is_inside_the_padded_frame", () => {
    assert.match(
      tsx,
      /className=\{`stext-cap [^`]*`\}\s*>\s*<div\s+className="stext-scroll"\s+ref=\{capRef\}\s+onScroll=\{handleStreamScroll\}/,
    );
  });

  it("tentative_words_are_tinted", () => {
    assert.match(rule(".stext-cap .tentative"), /color:\s*var\(--s-muted\)/);
  });

  it("cancel_target_is_28px_and_named", () => {
    const sx = rule(".sx");
    assert.match(sx, /width:\s*28px/);
    assert.match(sx, /height:\s*28px/);
    assert.doesNotMatch(tsx, /aria-label="cancel"/);
    assert.match(tsx, /aria-label=\{t\("overlay\.cancel"\)\}/);
    assert.match(tsx, /title=\{t\("overlay\.cancel"\)\}/);
    assert.equal(en.overlay.cancel, "Cancel dictation");
  });

  it("reduced_motion_block_exists", () => {
    const start = css.indexOf("@media (prefers-reduced-motion: reduce)");
    assert.notEqual(start, -1, "reduced-motion block exists");
    const block = css.slice(start);
    for (const selector of [
      ".scard",
      ".scaret",
      ".sdot.ready",
      ".swave.arming i",
    ]) {
      const at = block.indexOf(selector);
      assert.notEqual(at, -1, `${selector} is in the block`);
      assert.match(
        block.slice(at, block.indexOf("}", at)),
        /animation:\s*none/,
        `${selector} stops animating`,
      );
    }
    assert.doesNotMatch(block, /\.swave i\s*[,{]/, "level meter keeps moving");
  });

  it("overlay_words_have_no_dots", () => {
    assert.deepEqual(Object.keys(en.overlay).sort(), [
      "cancel",
      "loadingModel",
      "processing",
      "transcribing",
    ]);
    for (const [key, value] of Object.entries(en.overlay)) {
      assert.match(value, /^[^.…]+$/, `overlay.${key} has no dots`);
    }
    assert.equal(en.overlay.processing, "Cleaning up");
    const locales = new URL("../i18n/locales/", import.meta.url);
    for (const locale of readdirSync(locales)) {
      const { overlay } = JSON.parse(
        readFileSync(new URL(`${locale}/translation.json`, locales), "utf8"),
      ) as { overlay: Record<string, string> };
      for (const [key, value] of Object.entries(overlay)) {
        assert.match(value, /^[^.…]+$/, `${locale} overlay.${key} has no dots`);
      }
    }
  });
});
