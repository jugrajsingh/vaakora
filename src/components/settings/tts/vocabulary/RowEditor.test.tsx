import assert from "node:assert/strict";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import en from "../../../../i18n/locales/en/translation.json";
import type { EntryRow } from "@/bindings";
import { RowEditor, revealEditor } from "./RowEditor";
import { models, row } from "./fixtures";
const {
  describe,
  it,
}: {
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => void) => void;
} = createRequire(import.meta.url)("bun:test");
const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: en } } });

const render = (
  initial: EntryRow | null,
  members: readonly EntryRow[] = initial ? [initial] : [],
) =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <RowEditor
        initial={initial}
        members={members}
        models={models}
        styles={[]}
        submit={() => {}}
        cancel={() => {}}
      />
    </I18nextProvider>,
  );

describe("RowEditor", () => {
  it("reveal_scrolls_and_focuses_the_first_field", () => {
    const scrolled: unknown[] = [];
    const focused: string[] = [];
    const queried: string[] = [];
    const input = { focus: () => focused.push("input") };
    revealEditor({
      scrollIntoView: (arg?: boolean | ScrollIntoViewOptions) =>
        scrolled.push(arg),
      querySelector: ((selector: string) => {
        queried.push(selector);
        return input;
      }) as HTMLElement["querySelector"],
    });
    assert.deepEqual(scrolled, [{ block: "nearest" }]);
    assert.deepEqual(queried, ["input"]);
    assert.deepEqual(focused, ["input"]);
  });
  it("opens a new entry as a term with Save off until it is filled in", () => {
    const html = render(null);
    assert.ok(html.includes("Add entry"));
    assert.ok(html.includes("Skip") && html.includes("Case sensitive"));
    assert.match(html, /<button[^>]*disabled=""[^>]*>Save<\/button>/);
    assert.ok(html.includes("All voices"));
  });
  it("asks for no spoken text on an acronym and offers no term options", () => {
    const html = render(row("owner", "acronym", "Cli"));
    assert.ok(!html.includes('aria-label="Spoken"'));
    assert.ok(!html.includes("Skip") && !html.includes("Case sensitive"));
    assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>Save<\/button>/);
  });
  it("checks an entry for all voices with Play all and one voice with Listen", () => {
    const all = render(
      row("owner", "term", "kubectl", { spoken: "cube control" }),
    );
    assert.match(all, /<button[^>]*>Play all<\/button>/);
    const one = render(
      row("owner", "term", "kubectl", {
        spoken: "cube control",
        model: "pocket-en",
      }),
    );
    assert.match(one, /<button[^>]*>Listen<\/button>/);
    assert.doesNotMatch(one, />Play all</);
    assert.match(
      render(null),
      /<button[^>]*disabled=""[^>]*>Play all<\/button>/,
    );
  });
  it("shows the row's own spoken text and voice model when editing", () => {
    const html = render(
      row("owner", "term", "kubectl", {
        spoken: "cube control",
        model: "pocket-en",
      }),
    );
    assert.ok(html.includes("Edit entry"));
    assert.ok(html.includes('value="kubectl"'));
    assert.ok(html.includes('value="cube control"'));
    assert.ok(html.includes("Pocket TTS"));
  });
  it("edits a row shown from several voices without a scope field and checks them all", () => {
    const pocket = row("owner", "term", "kubectl", {
      spoken: "cube control",
      model: "pocket-en",
    });
    const supertonic = row("owner", "term", "kubectl", {
      spoken: "cube control",
      model: "supertonic-3",
    });
    const html = render(pocket, [pocket, supertonic]);
    assert.ok(!html.includes("Applies to"));
    assert.match(html, /<button[^>]*>Play all<\/button>/);
    assert.ok(html.includes('value="cube control"'));
    assert.ok(render(pocket).includes("Applies to"));
  });
});
