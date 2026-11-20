import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";

import { listeningStatusKey, stagePlacement } from "./placement";

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
      /\.ov-stage\.top \.stext-cap \{[^}]*padding-bottom:\s*\d+px/,
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

  it("stage_follows_every_cell", () => {
    const cells: [string, string, string][] = [
      ["top_left", "top", "left"],
      ["top", "top", "center"],
      ["top_right", "top", "right"],
      ["center_left", "bottom", "left"],
      ["center", "bottom", "center"],
      ["center_right", "bottom", "right"],
      ["bottom_left", "bottom", "left"],
      ["bottom", "bottom", "center"],
      ["bottom_right", "bottom", "right"],
    ];
    for (const [wire, edge, column] of cells) {
      assert.deepEqual(stagePlacement(wire), { edge, column }, wire);
    }
    for (const unknown of ["none", "", "top_middle", undefined, null]) {
      assert.deepEqual(
        stagePlacement(unknown),
        { edge: "bottom", column: "center" },
        `${String(unknown)} falls back to bottom centre`,
      );
    }
    assert.match(
      rule(".ov-stage.col-left .scard"),
      /margin-right:\s*auto/,
      "left column pins the card to the physical left",
    );
    assert.match(
      rule(".ov-stage.col-right .scard"),
      /margin-left:\s*auto/,
      "right column pins the card to the physical right",
    );
    for (const selector of [
      ".ov-stage.col-left .scard",
      ".ov-stage.col-right .scard",
    ]) {
      assert.doesNotMatch(
        rule(selector),
        /start|end|inline/,
        `${selector} uses physical margins only`,
      );
    }
    assert.match(
      rule(".ov-stage"),
      /justify-content:\s*center/,
      "the centre column keeps justify-content",
    );
  });

  it("stage_class_carries_edge_and_column_in_both_forms", () => {
    const stage =
      /className=\{`ov-stage \$\{placement\.edge\} col-\$\{placement\.column\}/g;
    assert.equal(tsx.match(stage)?.length, 2, "Live and Minimal both use it");
    assert.match(
      tsx,
      /setPlacement\(\s*stagePlacement\(settings\.data\.overlay_position\)/,
      "each show reads the stored cell",
    );
    assert.doesNotMatch(tsx, /overlay-position-changed/, "no position event");
  });

  it("state_has_an_accessible_name", () => {
    assert.equal(listeningStatusKey(false), "overlay.starting");
    assert.equal(listeningStatusKey(true), "overlay.recording");
    assert.equal(en.overlay.starting, "Starting microphone");
    assert.equal(en.overlay.recording, "Recording");
    assert.match(
      tsx,
      /<span className="ssr" role="status">\s*\{t\(listeningStatusKey\(captureReady\)\)\}\s*<\/span>/,
      "the listening row names its state",
    );
    assert.match(
      tsx,
      /<span className="swork-label" role="status">\s*\{label\}\s*<\/span>/,
      "the working label is a status",
    );
    const ssr = rule(".ssr");
    assert.match(ssr, /position:\s*absolute/);
    assert.match(ssr, /width:\s*1px/);
    assert.match(ssr, /clip:\s*rect\(0,? 0,? 0,? 0\)/);
    const locales = new URL("../i18n/locales/", import.meta.url);
    for (const locale of readdirSync(locales)) {
      const { overlay } = JSON.parse(
        readFileSync(new URL(`${locale}/translation.json`, locales), "utf8"),
      ) as { overlay: Record<string, string> };
      for (const key of ["starting", "recording"]) {
        assert.ok(overlay[key]?.trim(), `${locale} overlay.${key} is set`);
      }
    }
  });

  it("top_fade_covers_padding_only", () => {
    const px = (block: string, property: string) =>
      Number(block.match(new RegExp(`${property}:\\s*(\\d+)px`))?.[1]);
    const base = rule(".stext-cap");
    const top = rule(".ov-stage.top .stext-cap");
    const pad = px(top, "padding-top");
    assert.ok(pad > 0, "top placement keeps padding above the first line");
    assert.equal(
      pad + px(top, "padding-bottom"),
      px(base, "padding-top") + px(base, "padding-bottom"),
      "the cap keeps its padding total, so two whole lines still fit",
    );
    const fade = rule(".ov-stage.top .stext-cap.overflowing");
    const stop = Number(fade.match(/mask-image:[^;]*#000 (\d+)px/)?.[1]);
    assert.ok(stop > 0 && stop <= pad, `fade ends inside the ${pad}px padding`);
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
      ".sspinner",
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
      "recording",
      "starting",
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

  it("read_aloud_notices_are_translated", () => {
    const keys = [
      "readAloudBusyPastingTitle",
      "readAloudBusyPasting",
      "readAloudUnavailableTitle",
      "readAloudClipboardUnreadableTitle",
    ] as const;
    const locales = new URL("../i18n/locales/", import.meta.url);
    const errorsOf = (locale: string) =>
      (
        JSON.parse(
          readFileSync(new URL(`${locale}/translation.json`, locales), "utf8"),
        ) as { errors: Record<string, string> }
      ).errors;
    const english = errorsOf("en");
    assert.equal(
      english.readAloudBusyPastingTitle,
      "Read aloud is busy pasting",
    );
    assert.equal(english.readAloudUnavailableTitle, "Read aloud unavailable");
    assert.equal(
      english.readAloudClipboardUnreadableTitle,
      "Clipboard not readable",
    );
    const others = readdirSync(locales).filter((locale) => locale !== "en");
    assert.equal(others.length, 25);
    for (const locale of others) {
      const errors = errorsOf(locale);
      for (const key of keys)
        assert.notEqual(
          errors[key],
          english[key],
          `${locale} errors.${key} is still English`,
        );
    }
  });
});
