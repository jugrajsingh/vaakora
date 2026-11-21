import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import ar from "../../i18n/locales/ar/translation.json";
import en from "../../i18n/locales/en/translation.json";
import { endNudgeClass, fillTowards } from "@/lib/utils/rangeFill";
import { AudioPlayer } from "./AudioPlayer";
import { Button } from "./Button";
import { PathDisplay } from "./PathDisplay";
import { Slider } from "./Slider";
const {
  describe,
  it,
}: {
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => Promise<void> | void) => void;
} = createRequire(import.meta.url)("bun:test");

const VARIANTS = [
  "primary",
  "primary-soft",
  "secondary",
  "outline",
  "warning",
  "danger",
  "danger-ghost",
  "ghost",
] as const;

async function instance(lng: "en" | "ar") {
  const i18n = i18next.createInstance();
  await i18n.init({
    lng,
    resources: { en: { translation: en }, ar: { translation: ar } },
  });
  return i18n;
}

function slider(i18n: Awaited<ReturnType<typeof instance>>): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <Slider
        value={0.25}
        min={0}
        max={1}
        onChange={() => {}}
        label="Volume"
        description="How loud"
      />
    </I18nextProvider>,
  );
}

describe("upstream ui controls", () => {
  it("every_button_variant_shows_a_focus_ring", () => {
    for (const variant of VARIANTS) {
      const html = renderToStaticMarkup(
        <Button variant={variant}>{variant}</Button>,
      );
      const classes = /<button[^>]*class="([^"]*)"/.exec(html)?.[1] ?? "";
      const list = classes.split(/\s+/);
      assert.ok(list.includes("focus-visible:ring-2"), variant);
      assert.ok(list.includes("focus-visible:ring-logo-primary"), variant);
      assert.ok(!list.some((c) => c.startsWith("focus:ring")), variant);
    }
  });

  it("range_fill_follows_direction", async () => {
    assert.equal(fillTowards("rtl"), "left");
    assert.equal(fillTowards("ltr"), "right");
    assert.ok(
      slider(await instance("en")).includes("linear-gradient(to right"),
    );
    assert.ok(slider(await instance("ar")).includes("linear-gradient(to left"));
    const audio = readFileSync(
      new URL("./AudioPlayer.tsx", import.meta.url),
      "utf8",
    );
    assert.ok(!audio.includes("linear-gradient(to right"));
    assert.ok(audio.includes("fillTowards("));
  });

  it("audio_end_nudge_points_toward_the_end_in_both_directions", () => {
    const rtl = endNudgeClass("rtl").split(/\s+/);
    const ltr = endNudgeClass("ltr").split(/\s+/);
    assert.deepEqual(rtl, [
      "[&::-webkit-slider-thumb]:-translate-x-0.5",
      "[&::-moz-range-thumb]:-translate-x-0.5",
    ]);
    assert.deepEqual(ltr, [
      "[&::-webkit-slider-thumb]:translate-x-0.5",
      "[&::-moz-range-thumb]:translate-x-0.5",
    ]);
    const audio = readFileSync(
      new URL("./AudioPlayer.tsx", import.meta.url),
      "utf8",
    );
    assert.ok(
      audio.includes('progressPercent >= 99.5 ? endNudgeClass(direction) : ""'),
    );
  });

  it("range_inputs_show_the_keyboard_focus_ring", async () => {
    const i18n = await instance("en");
    const inputs = [
      ["Slider", slider(i18n)],
      [
        "AudioPlayer",
        renderToStaticMarkup(
          <I18nextProvider i18n={i18n}>
            <AudioPlayer src="clip.wav" />
          </I18nextProvider>,
        ),
      ],
    ];
    for (const [name, html] of inputs) {
      const tag = /<input[^>]*type="range"[^>]*>/.exec(html)?.[0] ?? "";
      const classes = (/class="([^"]*)"/.exec(tag)?.[1] ?? "").split(/\s+/);
      assert.ok(classes.includes("focus-visible:ring-2"), name);
      assert.ok(classes.includes("focus-visible:ring-logo-primary"), name);
      assert.ok(!classes.some((c) => c.startsWith("focus:ring")), name);
    }
  });

  it("paths_render_left_to_right", async () => {
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={await instance("en")}>
        <PathDisplay path="/home/u/.local/share/x" onOpen={() => {}} />
      </I18nextProvider>,
    );
    assert.ok(
      /<div[^>]*dir="ltr"[^>]*>\/home\/u\/\.local\/share\/x<\/div>/.test(html),
      html,
    );
    const vocabulary = readFileSync(
      new URL("../settings/tts/vocabulary/VocabularyView.tsx", import.meta.url),
      "utf8",
    );
    assert.ok(/<p dir="ltr"[^>]*>\s*\{table\.path\}\s*<\/p>/.test(vocabulary));
  });
});
