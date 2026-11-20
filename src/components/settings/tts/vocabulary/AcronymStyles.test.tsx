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
    assert.match(html, /<summary[^>]*>Acronym style per model<\/summary>/);
    assert.ok(html.includes("All models") && html.includes("Pocket TTS"));
  });
});
