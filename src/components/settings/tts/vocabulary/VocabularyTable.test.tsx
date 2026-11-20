import assert from "node:assert/strict";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import en from "../../../../i18n/locales/en/translation.json";
import type { EntryRow } from "@/bindings";
import { VocabularyTable } from "./VocabularyTable";
import { VoiceChips } from "./VoiceChips";
import { models, row } from "./fixtures";
import { groupRows } from "./groups";
const {
  describe,
  it,
}: {
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => void) => void;
} = createRequire(import.meta.url)("bun:test");
const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: en } } });

const ids = ["pocket-en", "supertonic-3", "phonon-x"];
const render = (rows: EntryRow[], readOnly = false) =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <VocabularyTable
        groups={groupRows(rows, ids)}
        models={models}
        readOnly={readOnly}
        toggle={() => {}}
        edit={() => {}}
        listen={() => {}}
      />
    </I18nextProvider>,
  );
/** The markup of every row whose written text is `key`. */
const entries = (html: string, key: string) =>
  html.split("<li").filter((part) => part.includes(`break-all">${key}</span>`));
/** The markup of the one row whose written text is `key`. */
const entry = (html: string, key: string) => {
  const found = entries(html, key);
  assert.equal(found.length, 1, `one row for ${key}`);
  return found[0];
};
const button = (html: string, label: string) =>
  html.match(new RegExp(`<button[^>]*>${label}</button>`))?.[0];

const builtin = row("builtin", "extension", "json", { spoken: "jason" });
const mine = row("owner", "extension", "md", {
  spoken: "M D",
  replaces_builtin: true,
});
const mdDefault = row("builtin", "extension", "md", {
  spoken: "markdown",
  problems: [{ shadowed: { by: mine.id } }],
});

describe("VocabularyTable", () => {
  it("a_row_offers_its_switch_edit_and_listen_only", () => {
    const html = render([builtin, mine, mdDefault]);
    for (const key of ["json", "md"]) {
      const part = entry(html, key);
      const labels = [...part.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map(
        (match) => match[1],
      );
      assert.deepEqual(labels, ["Listen", "Edit"], key);
      assert.match(part, /<input[^>]*type="checkbox"/, `${key} has its switch`);
      assert.ok(!part.includes("<details"), `${key} has no Voices picker`);
      assert.ok(!part.includes("<summary"), key);
    }
  });
  it("shows your entry and the built-in it overrides as one row", () => {
    const html = render([builtin, mine, mdDefault]);
    const md = entry(html, "md");
    assert.ok(md.includes("M D") && md.includes("Yours"));
    assert.ok(md.includes("default: <s>markdown</s>"));
    assert.ok(!html.includes("Replaced by your entry"));
    assert.ok(!entry(html, "json").includes("default:"));
  });
  it("shows a skipped term as (skipped)", () => {
    const html = render([row("owner", "term", "ABC-123", { skip: true })]);
    assert.ok(entry(html, "ABC-123").includes("(skipped)"));
  });
  it("lists an acronym on three voices once with each voice as a chip", () => {
    const html = render(
      ["pocket-en", "supertonic-3", "phonon-x"].map((model) =>
        row("builtin", "acronym", "LLM", { model }),
      ),
    );
    const llm = entry(html, "LLM");
    for (const name of ["Pocket TTS", "Supertonic 3", "phonon-x"]) {
      assert.ok(llm.includes(`>${name}</span>`), name);
    }
    assert.ok(!llm.includes("All models</span>"));
  });
  it("shows / as three rows because two voices say it differently", () => {
    const html = render([
      row("builtin", "symbol", "/", { spoken: "slash" }),
      row("builtin", "symbol", "/", { spoken: "slash hi", model: "pocket-en" }),
      row("builtin", "symbol", "/", {
        spoken: "slash pa",
        model: "supertonic-3",
      }),
    ]);
    const slash = entries(html, "/");
    assert.equal(slash.length, 3);
    const shared = slash.find((part) => part.includes(">slash<"));
    assert.ok(shared?.includes("All models"));
    assert.ok(shared?.includes("except Pocket TTS, Supertonic 3"));
    assert.ok(slash.some((part) => part.includes("slash hi")));
    assert.ok(slash.some((part) => part.includes("slash pa")));
  });
  it("shows kind and match joined on one line and the origin on the first", () => {
    const html = render([
      builtin,
      row("owner", "term", "kubectl", { spoken: "cube control" }),
    ]);
    const json = entry(html, "json");
    assert.ok(json.includes("Extension · End of a file name"));
    assert.match(json, /<span class="[^"]*text-ink-2[^"]*">Built-in<\/span>/);
    assert.ok(!json.includes("Yours"));
    const term = entry(html, "kubectl");
    assert.ok(term.includes("Yours"));
    assert.ok(term.includes("Term · Whole word · Case sensitive"));
    assert.ok(!html.includes(">Origin<"));
  });
  it("rows_are_two_lines_at_every_width", () => {
    const html = render([builtin, mine, mdDefault]);
    assert.ok(!html.includes("<table"), "no table");
    assert.ok(!html.includes("overflow-x-auto"), "no horizontal scroll");
    assert.match(html, /^<ul[^>]*>/);
    assert.equal(html.split("<li").length - 1, 2, "one li per group");
    const part = entry(html, "md");
    const at = (needle: string) => part.indexOf(needle);
    const order = [
      '<input type="checkbox"',
      'break-all">md</span>',
      "M D",
      "Yours",
      ">Listen</button>",
      "default: <s>markdown</s>",
      "Extension · End of a file name",
      ">All models</span>",
    ].map(at);
    assert.ok(
      order.every((position, index) => position > (order[index - 1] ?? -1)),
      `row order ${JSON.stringify(order)}`,
    );
    assert.ok(order[0] >= 0, "the switch is first");
    assert.ok(!part.includes("<td") && !part.includes("<tr"));
  });
  it("scope_chips_are_read_only", () => {
    const html = render(
      ["pocket-en", "supertonic-3"].map((model) =>
        row("owner", "term", "kubectl", { model }),
      ),
    );
    const chips = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <VoiceChips
          group={
            groupRows(
              ["pocket-en", "supertonic-3"].map((model) =>
                row("owner", "term", "kubectl", { model }),
              ),
              ids,
            )[0]
          }
          models={models}
        />
      </I18nextProvider>,
    );
    for (const markup of [html, chips]) {
      assert.ok(!markup.includes("<details"), "no picker");
      assert.ok(!markup.includes("<summary"), "no picker summary");
    }
    assert.ok(!chips.includes("<button") && !chips.includes("<input"));
    assert.ok(chips.includes(">Pocket TTS</span>"));
    assert.ok(chips.includes(">Supertonic 3</span>"));
  });
  it("yours_with_its_struck_default", () => {
    const html = render([mine, mdDefault]);
    const md = entry(html, "md");
    assert.match(md, /<span class="[^"]*text-logo-primary[^"]*">Yours<\/span>/);
    assert.ok(md.includes("default: <s>markdown</s>"));
    assert.ok(!md.includes("Built-in"));
  });
  it("problem_line_uses_the_warning_colour", () => {
    // Regression guard: the warning colour held before the list markup, so this is green at base.
    const html = render([
      row("builtin", "symbol", "/", {
        spoken: "slash",
        problems: [
          {
            shadowed: {
              by: row("owner", "symbol", "/", { model: "pocket-en" }).id,
            },
          },
        ],
      }),
    ]);
    assert.match(
      html,
      /class="[^"]*\btext-warning\b[^"]*"[^>]*>(<p[^>]*>)?Never applies: a higher-priority entry always wins/,
    );
  });
  it("explains a shadowed entry, a never-applying entry and a switched-off one", () => {
    const html = render([
      row("builtin", "symbol", "/", {
        spoken: "slash",
        problems: [
          {
            shadowed: {
              by: row("owner", "symbol", "/", { model: "pocket-en" }).id,
            },
          },
        ],
      }),
      row("owner", "term", "two words", {
        spoken: "x",
        problems: [{ unreachable: { reason: "contains_space" } }, "disabled"],
      }),
    ]);
    assert.ok(
      entry(html, "/").includes(
        "Never applies: a higher-priority entry always wins",
      ),
    );
    const unreachable = entry(html, "two words");
    assert.ok(unreachable.includes("Never applies: "));
    assert.ok(unreachable.includes("Switched off"));
  });
  it("turns every change off when the file has an error but keeps Listen", () => {
    const html = render([mine, mdDefault], true);
    const part = entry(html, "md");
    assert.match(button(part, "Edit") ?? "", /disabled=""/);
    assert.match(
      part.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0] ?? "",
      /disabled=""/,
    );
    const listen = button(part, "Listen");
    assert.ok(listen, "row has Listen");
    assert.doesNotMatch(listen, /disabled=""/);
  });
  it("shows one row for owner readings that match and names the voices each default belongs to", () => {
    const html = render([
      row("builtin", "extension", "md", {
        model: "pocket-en",
        spoken: "markdown",
      }),
      row("owner", "extension", "md", {
        model: "pocket-en",
        spoken: "M D",
        replaces_builtin: true,
      }),
      row("owner", "extension", "md", {
        model: "supertonic-3",
        spoken: "M D",
      }),
    ]);
    const md = entry(html, "md");
    assert.ok(
      md.includes(">Pocket TTS</span>") && md.includes(">Supertonic 3</span>"),
    );
    assert.ok(md.includes("default for Pocket TTS: <s>markdown</s>"));
  });
});
