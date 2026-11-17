import assert from "node:assert/strict";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import en from "../../../../i18n/locales/en/translation.json";
import type { EntryRow } from "@/bindings";
import { returnTarget } from "@/components/shared/InlineConfirm";
import { VocabularyTable } from "./VocabularyTable";
import { models, row } from "./fixtures";
import { groupRows, voiceOptions } from "./groups";
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
const render = (
  rows: EntryRow[],
  readOnly = false,
  resetting: string | null = null,
  editLocked = false,
) => {
  const groups = groupRows(rows, ids);
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <VocabularyTable
        groups={groups}
        models={models}
        readOnly={readOnly}
        editLocked={editLocked}
        voiceOptions={(group) => voiceOptions(group, groups, ids)}
        changeVoice={() => {}}
        toggle={() => {}}
        edit={() => {}}
        listen={() => {}}
        remove={() => {}}
        reset={() => {}}
        resetting={resetting}
        confirmReset={() => {}}
        cancelReset={() => {}}
      />
    </I18nextProvider>,
  );
};
/** The markup of every row whose written text is `key`. */
const entries = (html: string, key: string) =>
  html
    .split("<tbody")
    .filter((part) => part.includes(`break-all">${key}</td>`));
/** The markup of the one row whose written text is `key`. */
const entry = (html: string, key: string) => {
  const found = entries(html, key);
  assert.equal(found.length, 1, `one row for ${key}`);
  return found[0];
};
const button = (html: string, label: string) =>
  html.match(new RegExp(`<button[^>]*>${label}</button>`))?.[0];

/** A row's buttons in order, each knowing whether a closed `<details>` hides it. */
const rowButtons = (html: string) => {
  const found: {
    label: string;
    disabled: boolean;
    closest: (selector: string) => unknown;
  }[] = [];
  const closed: boolean[] = [];
  for (const match of html.matchAll(/<(\/?)(details|button)\b([^>]*)>/g)) {
    const [tag, end, name, attrs] = match;
    if (name === "details") {
      if (end) closed.pop();
      else closed.push(!/\sopen(=|\s|$)/.test(attrs));
      continue;
    }
    if (end) continue;
    const hidden = closed.includes(true);
    found.push({
      label: html
        .slice((match.index ?? 0) + tag.length)
        .split("</button>")[0]
        .replace(/<[^>]*>/g, ""),
      disabled: /\sdisabled=""/.test(attrs),
      closest: (selector) =>
        hidden && selector === "details:not([open])" ? {} : null,
    });
  }
  return found;
};

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
  it("edit_is_disabled_when_locked", () => {
    const rows = [builtin, mine, mdDefault];
    const open = render(rows);
    for (const key of ["json", "md"]) {
      assert.doesNotMatch(
        button(entry(open, key), "Edit") ?? "",
        /disabled=""/,
      );
    }
    const locked = render(rows, false, null, true);
    for (const key of ["json", "md"]) {
      const edit = button(entry(locked, key), "Edit");
      assert.ok(edit, `${key} row has Edit`);
      assert.match(edit, /disabled=""/);
    }
  });
  it("disables Delete on a built-in row and enables it on an owner row", () => {
    const html = render([builtin, mine, mdDefault]);
    assert.match(button(entry(html, "json"), "Delete") ?? "", /disabled=""/);
    const ownerDelete = button(entry(html, "md"), "Delete");
    assert.ok(ownerDelete, "owner row has Delete");
    assert.doesNotMatch(ownerDelete, /disabled=""/);
  });
  it("shows your entry and the built-in it overrides as one row with Reset to default", () => {
    const html = render([builtin, mine, mdDefault]);
    const md = entry(html, "md");
    assert.ok(md.includes("M D") && md.includes("Yours"));
    assert.ok(md.includes("default: <s>markdown</s>"));
    assert.ok(button(md, "Reset to default"));
    assert.ok(!html.includes("Replaced by your entry"));
    assert.equal(button(entry(html, "json"), "Reset to default"), undefined);
    assert.ok(!entry(html, "json").includes("default:"));
  });
  it("reset_asks_in_a_row_below", () => {
    const yours = row("owner", "extension", ".md", {
      spoken: "M D",
      replaces_builtin: true,
    });
    const builtinMd = row("builtin", "extension", ".md", {
      spoken: "markdown",
      problems: [{ shadowed: { by: yours.id } }],
    });
    const rows = [builtin, yours, builtinMd];
    const [key] = groupRows([yours], ids).map((group) => group.key);
    const html = render(rows, false, key);
    const md = entry(html, ".md");
    const [first, second] = md.split("</tr>");
    assert.ok(button(first, "Reset to default"), "the row keeps its buttons");
    assert.match(
      second,
      /^<tr><td col[sS]pan="7"[^>]*>.*Reset \.md to the built-in reading\? Your entry is deleted\./u,
    );
    assert.ok(!entry(html, "json").includes("built-in reading"));
    assert.ok(!render(rows).includes("built-in reading"));
  });
  it("cancel_returns_focus_to_a_visible_row_action", () => {
    const md = entry(render([builtin, mine, mdDefault]), "md");
    const buttons = rowButtons(md);
    assert.ok(
      buttons[0].closest("details:not([open])"),
      `the closed Voices picker comes first: ${buttons[0].label}`,
    );
    assert.equal(returnTarget(buttons)?.label, "Edit");
  });
  it("shows Reset to default only on a row that overrides a built-in", () => {
    const html = render([
      row("owner", "term", "kubectl", { spoken: "cube control" }),
    ]);
    assert.equal(button(entry(html, "kubectl"), "Reset to default"), undefined);
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
    assert.ok(!llm.includes("All voices</span>"));
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
    assert.ok(shared?.includes("All voices"));
    assert.ok(shared?.includes("except Pocket TTS, Supertonic 3"));
    assert.ok(slash.some((part) => part.includes("slash hi")));
    assert.ok(slash.some((part) => part.includes("slash pa")));
  });
  it("shows kind and match without an origin column", () => {
    const html = render([
      builtin,
      row("owner", "term", "kubectl", { spoken: "cube control" }),
    ]);
    const json = entry(html, "json");
    assert.ok(json.includes("Extension"));
    assert.ok(json.includes("End of a file name"));
    assert.ok(!json.includes("Built-in") && !json.includes("Yours"));
    const term = entry(html, "kubectl");
    assert.ok(term.includes("Yours") && term.includes("Whole word"));
    assert.ok(term.includes("Case sensitive"));
    assert.ok(!html.includes(">Origin<"));
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
    assert.match(button(part, "Reset to default") ?? "", /disabled=""/);
    assert.match(
      part.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0] ?? "",
      /disabled=""/,
    );
    const listen = button(part, "Listen");
    assert.ok(listen, "row has Listen");
    assert.doesNotMatch(listen, /disabled=""/);
  });
  it("offers a Voices picker marking the row's voices, and none when the file has an error", () => {
    const pocket = row("owner", "term", "kubectl", {
      spoken: "cube control",
      model: "pocket-en",
    });
    const picker = entry(render([pocket]), "kubectl");
    assert.ok(picker.includes("<summary"));
    assert.match(
      picker,
      /aria-pressed="true"[^>]*><span[^>]*>\u2713<\/span>Pocket TTS/,
    );
    assert.match(
      picker,
      /aria-pressed="false"[^>]*><span[^>]*><\/span>Supertonic 3/,
    );
    assert.ok(!entry(render([pocket], true), "kubectl").includes("<summary"));
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
    assert.ok(button(md, "Reset to default"));
  });
});
