import assert from "node:assert/strict";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import en from "../../../../i18n/locales/en/translation.json";
import { AcronymStyles } from "./AcronymStyles";
import { models } from "./fixtures";
const {
  describe,
  it,
}: {
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => void) => void;
} = createRequire(import.meta.url)("bun:test");
const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: en } } });

describe("AcronymStyles", () => {
  it("is a collapsed section titled per model with the same controls inside", () => {
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <AcronymStyles
          styles={[
            { model: null, owner: null, effective: "spaced" },
            { model: "pocket-en", owner: null, effective: "spaced" },
          ]}
          models={models}
          readOnly={false}
          set={() => {}}
        />
      </I18nextProvider>,
    );
    assert.match(html, /^<details(?![^>]*\bopen\b)[^>]*>/);
    assert.match(html, /<summary[^>]*>Acronym style per model<svg/);
    assert.ok(html.includes("All models") && html.includes("Pocket TTS"));
  });

  it("summary_uses_the_shared_chevron", () => {
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <AcronymStyles
          styles={[{ model: null, owner: null, effective: "spaced" }]}
          models={models}
          readOnly={false}
          set={() => {}}
        />
      </I18nextProvider>,
    );
    const summary = /<summary([^>]*)>(.*?)<\/summary>/.exec(html);
    assert.ok(summary, html);
    const classes = (/class="([^"]*)"/.exec(summary[1])?.[1] ?? "").split(
      /\s+/,
    );
    for (const wanted of [
      "list-none",
      "[&amp;::-webkit-details-marker]:hidden",
      "focus:outline-none",
      "focus-visible:ring-2",
      "focus-visible:ring-logo-primary",
    ]) {
      assert.ok(classes.includes(wanted), `${wanted} in ${classes.join(" ")}`);
    }
    assert.match(summary[2], /<svg[^>]*aria-hidden="true"[^>]*>/);
    assert.match(html, /^<details[^>]*class="[^"]*\bgroup\b/);
  });
});
