import assert from "node:assert/strict";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import en from "../i18n/locales/en/translation.json";
import type { DataImportReport } from "@/bindings";
import { i18nInterpolation } from "@/lib/brand";
import { formatBytes } from "@/lib/utils/format";
import { DataImportCardView } from "./DataImportCard";
const {
  describe,
  it,
}: {
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => Promise<void> | void) => void;
} = createRequire(import.meta.url)("bun:test");

const i18n = i18next.createInstance();
await i18n.init({
  lng: "en",
  resources: { en: { translation: en } },
  interpolation: i18nInterpolation,
});

const FROM = "/home/owner/.local/share/old.app";
const TO = "/home/owner/.local/share/new.app";

const copied: DataImportReport = {
  status: "copied",
  items: ["settings_store.json", "history.db", "models"],
  bytesTotal: 2_480_000_000,
  from: FROM,
  to: TO,
  error: null,
  skipped: [],
  dismissed: false,
};

const failed: DataImportReport = {
  ...copied,
  status: "failed",
  items: [],
  bytesTotal: 0,
  error: `${FROM}/models/tts/v/y.onnx: Permission denied (os error 13)`,
};

function render(report: DataImportReport, startsAtLogin = false): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <DataImportCardView
        report={report}
        startsAtLogin={startsAtLogin}
        onStartAtLogin={() => undefined}
        onDismiss={() => undefined}
      />
    </I18nextProvider>,
  );
}

/** Text content with tags removed and entities decoded. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

describe("DataImportCard", () => {
  it("card_shows_sizes_and_source", () => {
    const html = render(copied);
    assert.match(html, /^<div role="status"/);
    const size = formatBytes(copied.bytesTotal);
    assert.ok(size, "a formatted size");
    assert.ok(text(html).includes(size), `${size} in ${text(html)}`);
    assert.ok(text(html).includes(FROM), "the source path");
    assert.ok(
      text(html).includes(en.dataImport.shared),
      "the shared-blocks sentence",
    );
    assert.ok(text(html).includes(en.dataImport.copiedTitle));
  });

  it("card_names_the_old_autostart", () => {
    assert.equal(
      en.dataImport.oldAutostart,
      "If the app that used this folder still starts when you log in, turn that off there, so only one app answers your shortcuts.",
    );
    assert.ok(text(render(copied)).includes(en.dataImport.oldAutostart));
  });

  it("card_offers_start_at_login_until_it_is_on", () => {
    assert.ok(text(render(copied, false)).includes("Start at login"));
    assert.ok(!text(render(copied, true)).includes("Start at login"));
    assert.ok(!text(render(failed, false)).includes("Start at login"));
  });

  it("failed_card_says_nothing_changed_and_how_to_retry", () => {
    const body = text(render(failed));
    assert.ok(body.includes(en.dataImport.failedTitle));
    assert.ok(body.includes(failed.error as string), "names the error");
    assert.ok(body.includes("was not changed"), body);
    assert.ok(body.includes(`delete ${TO}`), body);
    assert.ok(body.includes("quit Vaakora"), body);
    assert.ok(!body.includes(en.dataImport.copiedTitle));
  });

  it("card_has_no_brand_word_of_the_old_app", () => {
    for (const html of [render(copied), render(copied, true), render(failed)]) {
      assert.ok(!/handy/i.test(html), html);
    }
    for (const value of Object.values(en.dataImport)) {
      assert.ok(!/handy/i.test(value), value);
    }
  });

  it("every_button_has_the_focus_ring", () => {
    const buttons = render(copied).match(/<button[^>]*>/g) ?? [];
    assert.equal(buttons.length, 2, "Start at login and OK");
    for (const button of buttons) {
      assert.ok(button.includes("focus-visible:ring-2"), button);
      assert.ok(button.includes("focus-visible:ring-logo-primary"), button);
      assert.ok(button.includes("focus:outline-none"), button);
    }
  });
});
