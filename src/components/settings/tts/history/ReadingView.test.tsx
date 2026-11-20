import assert from "node:assert/strict";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import en from "../../../../i18n/locales/en/translation.json";
import type { Token, TokenSelection } from "./alignment";
import { ReadingView } from "./ReadingView";
const {
  describe,
  it,
}: {
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => void) => void;
} = createRequire(import.meta.url)("bun:test");
const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: en } } });

const span = { source_start: 0, source_end: 0, spoken_start: 0, spoken_end: 0 };
const token = (written: string, spoken: string): Token => ({
  written,
  spoken,
  changed: written !== spoken,
  chunk: 0,
  span,
});
const TOKENS = [
  token("Open", "Open"),
  token("README.md", "README dot markdown"),
  token("ABC-123", ""),
];

const render = (selection: TokenSelection | null) =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <ReadingView tokens={TOKENS} selection={selection} onSelect={() => {}} />
    </I18nextProvider>,
  );
/** The markup of the one token whose written word is `written`. */
const tokenMarkup = (html: string, written: string) => {
  const found = html
    .split('role="button"')
    .find((part) => part.includes(`>${written}</span>`));
  assert.ok(found, `token ${written} is rendered`);
  return found;
};

describe("ReadingView", () => {
  it("shows what was said directly under each written word", () => {
    const html = tokenMarkup(render(null), "README.md");
    assert.match(
      html,
      />README\.md<\/span><span[^>]*>README dot markdown<\/span>/,
    );
  });
  it("tints a changed word and leaves an unchanged one plain", () => {
    const html = render(null);
    assert.match(tokenMarkup(html, "README.md"), /data-changed="true"/);
    assert.match(tokenMarkup(html, "README.md"), /bg-warning-wash/);
    assert.match(tokenMarkup(html, "Open"), /data-changed="false"/);
    assert.doesNotMatch(tokenMarkup(html, "Open"), /bg-warning-wash/);
  });
  it("marks a changed word without colour alone", () => {
    const html = render(null);
    const changed = tokenMarkup(html, "README.md");
    const [written, spoken] = [
      changed.match(/<span class="([^"]*)">README\.md<\/span>/)?.[1],
      changed.match(/<span class="([^"]*)">README dot markdown<\/span>/)?.[1],
    ];
    assert.ok(written && spoken, "both lines of the changed token");
    assert.ok(written.split(/\s+/).includes("border-b-2"));
    assert.ok(written.split(/\s+/).includes("border-warning"));
    assert.ok(spoken.split(/\s+/).includes("underline"));
    assert.ok(spoken.split(/\s+/).includes("underline-offset-2"));
    const plain = tokenMarkup(html, "Open");
    assert.doesNotMatch(plain, /border-warning|underline/);
  });
  it("lets a long token wrap inside the column", () => {
    const html = render(null);
    for (const word of ["Open", "README.md"]) {
      const markup = tokenMarkup(html, word);
      const lines = [...markup.matchAll(/<span class="([^"]*)">/g)].map(
        (match) => match[1].split(/\s+/),
      );
      const owned = lines.filter((classes) =>
        classes.some((name) => name === "text-sm" || name === "text-xs"),
      );
      assert.equal(owned.length, 2, `two lines of ${word}`);
      for (const classes of owned) {
        assert.ok(classes.includes("max-w-full"), classes.join(" "));
        assert.ok(
          classes.includes("[overflow-wrap:anywhere]"),
          classes.join(" "),
        );
      }
    }
  });
  it("marks a skipped word", () => {
    const html = tokenMarkup(render(null), "ABC-123");
    assert.match(html, /line-through/);
    assert.match(html, /\(skipped\)/);
  });
  it("highlights exactly the selected tokens", () => {
    const html = render({ start: 1, end: 1 });
    assert.match(tokenMarkup(html, "README.md"), /aria-pressed="true"/);
    assert.match(tokenMarkup(html, "Open"), /aria-pressed="false"/);
    assert.match(tokenMarkup(html, "ABC-123"), /aria-pressed="false"/);
  });
});
