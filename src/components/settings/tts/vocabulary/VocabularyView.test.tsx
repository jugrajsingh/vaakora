import assert from "node:assert/strict";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import de from "../../../../i18n/locales/de/translation.json";
import en from "../../../../i18n/locales/en/translation.json";
import type { Edit, EntryRow, VocabularyTable } from "@/bindings";
import type { SaveResult } from "./actions";
import {
  deletePlan,
  entryEdits,
  resetPlan,
  type EntryDraft,
} from "./entryPlan";
import { NO_FILTERS, type Filters } from "./filter";
import type { AcronymStyles } from "./AcronymStyles";
import type { CorrectionBox } from "./CorrectionBox";
import type { CorrectionStart } from "./CorrectionStart";
import type { EntryDialog } from "./EntryDialog";
import type { FilterChip } from "@/components/shared/FilterChip";
import type { VocabularyTableProps } from "./VocabularyTable";
import type {
  Correction,
  EntryOpen,
  VocabularyActions,
} from "./VocabularyView";
import { models, row } from "./fixtures";
import { groupRows } from "./groups";
const {
  mock,
  describe,
  it,
}: {
  mock: { module: (name: string, factory: () => unknown) => void };
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => Promise<void> | void) => void;
} = createRequire(import.meta.url)("bun:test");

// The view's children record their props as they render, so the test can call them.
let tableProps: VocabularyTableProps | undefined;
let dialogProps: Parameters<typeof EntryDialog>[0] | undefined;
let boxProps: Parameters<typeof CorrectionBox>[0] | undefined;
let startProps: Parameters<typeof CorrectionStart>[0] | undefined;
let styleProps: Parameters<typeof AcronymStyles>[0] | undefined;
const buttons: Parameters<typeof import("@/components/ui/Button").Button>[0][] =
  [];
const chips: Parameters<typeof FilterChip>[0][] = [];
mock.module("./VocabularyTable", () => ({
  VocabularyTable: (props: VocabularyTableProps) => {
    tableProps = props;
    return <i data-marker="table" />;
  },
}));
mock.module("./EntryDialog", () => ({
  EntryDialog: (props: Parameters<typeof EntryDialog>[0]) => {
    dialogProps = props;
    return null;
  },
}));
mock.module("./CorrectionBox", () => ({
  CorrectionBox: (props: Parameters<typeof CorrectionBox>[0]) => {
    boxProps = props;
    return null;
  },
}));
mock.module("./CorrectionStart", () => ({
  CorrectionStart: (props: Parameters<typeof CorrectionStart>[0]) => {
    startProps = props;
    return null;
  },
}));
mock.module("./AcronymStyles", () => ({
  AcronymStyles: (props: Parameters<typeof AcronymStyles>[0]) => {
    styleProps = props;
    return <i data-marker="acronyms" />;
  },
}));
const { Button: RealButton } = await import("@/components/ui/Button");
mock.module("@/components/ui/Button", () => ({
  Button: (props: Parameters<typeof RealButton>[0]) => {
    buttons.push(props);
    return RealButton(props);
  },
}));
const { FilterChip: RealChip } = await import("@/components/shared/FilterChip");
mock.module("@/components/shared/FilterChip", () => ({
  FilterChip: (props: Parameters<typeof RealChip>[0]) => {
    chips.push(props);
    return RealChip(props);
  },
}));
const { VocabularyFilters } = await import("./VocabularyFilters");
const { VocabularyView, dialogOutcome, entryDialogKey } = await import(
  "./VocabularyView"
);
const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: en } } });

const owner = row("owner", "extension", "md", { spoken: "M D" });
const IDS = models.map((model) => model.id);
type Call = [string, ...unknown[]];
type Editing = EntryOpen | null;
type SetEditing = Editing | ((current: Editing) => Editing);
/** What a recorded `setEditing` call leaves when the open dialog is `current`. */
const settle = (next: SetEditing, current: Editing) =>
  typeof next === "function" ? next(current) : next;

function render(options: {
  language?: typeof i18n;
  revision: string;
  editing?: EntryOpen | null;
  correction?: Correction | "starting" | null;
  saveResult?: SaveResult;
  rows?: EntryRow[];
  filters?: Filters;
  fileError?: string;
  path?: string;
  failure?: { key: string; message?: string };
}) {
  const calls: Call[] = [];
  const editings: SetEditing[] = [];
  const corrections: (Correction | "starting" | null)[] = [];
  const filterChanges: Filters[] = [];
  const pending: Promise<SaveResult>[] = [];
  const actions: VocabularyActions = {
    applyPlan: (plan, base) => calls.push(["applyPlan", plan, base]),
    saveEntry: (plan, base) => {
      calls.push(["saveEntry", plan, base]);
      const result = Promise.resolve<SaveResult>(
        options.saveResult ?? { status: "saved" },
      );
      pending.push(result);
      return result;
    },
    listen: (target) => calls.push(["listen", target]),
    setAcronymStyle: (model, style, base) =>
      calls.push(["setAcronymStyle", model, style, base]),
    speak: async (written, model) => {
      calls.push(["speak", written, model]);
      return `said ${written}`;
    },
    adopt: (saved) => calls.push(["adopt", saved.revision]),
  };
  const table: VocabularyTable = {
    revision: options.revision,
    path: options.path ?? "tts-vocabulary.json",
    file_error: options.fileError ?? null,
    rows: options.rows ?? [owner],
    acronym_styles: [
      { model: "pocket-en", owner: "capitals", effective: "capitals" },
    ],
  };
  tableProps = undefined;
  dialogProps = undefined;
  boxProps = undefined;
  startProps = undefined;
  styleProps = undefined;
  buttons.length = 0;
  chips.length = 0;
  const html = renderToStaticMarkup(
    <I18nextProvider i18n={options.language ?? i18n}>
      <VocabularyView
        table={table}
        models={models}
        failure={options.failure ?? null}
        filters={options.filters ?? NO_FILTERS}
        setFilters={(next) => filterChanges.push(next)}
        editing={options.editing ?? null}
        setEditing={(next) => editings.push(next)}
        correction={options.correction ?? null}
        setCorrection={(next) => corrections.push(next)}
        readingModel="pocket-en"
        actions={actions}
        reload={() => calls.push(["reload"])}
        openFolder={() => calls.push(["openFolder"])}
      />
    </I18nextProvider>,
  );
  const settled = async () => {
    await Promise.all(pending);
    await new Promise((resolve) => setTimeout(resolve));
  };
  return { calls, editings, corrections, filterChanges, html, settled };
}

const latest = (rows: EntryRow[]): VocabularyTable => ({
  revision: "rev-latest",
  path: "tts-vocabulary.json",
  file_error: null,
  rows,
  acronym_styles: [],
});
const groupOf = (rows: EntryRow[]) => {
  const [group] = groupRows(rows, IDS);
  return group;
};
const draft: EntryDraft = {
  section: "extension",
  written: "md",
  rule: { say: "em dee", matching: null, case: null },
  scopes: [null],
  opened: [null],
};
const opened = (rows: EntryRow[] = [owner], base = "rev-open"): EntryOpen => ({
  group: groupOf(rows),
  base,
  notice: null,
});
type Planned = [string, (latest: VocabularyTable) => unknown, string];

describe("VocabularyView", () => {
  it("the view is as wide as the page column, never max-w-5xl", () => {
    const { html } = render({ revision: "rev-render" });
    assert.match(html, /^<section class="w-full max-w-3xl min-w-0 space-y-4"/);
    assert.ok(!html.includes("max-w-5xl"));
  });
  it("a row's Listen plays the group's first member", () => {
    const { calls } = render({ revision: "rev-render" });
    assert.ok(tableProps);
    tableProps.listen(tableProps.groups[0]);
    assert.deepEqual(calls, [["listen", owner]]);
  });
  it("a switch is planned from the latest rows and saved with the rendered table's revision", () => {
    const { calls } = render({ revision: "rev-render" });
    assert.ok(tableProps);
    tableProps.toggle(tableProps.groups[0]);
    assert.equal(calls.length, 1);
    const [name, plan, base] = calls[0] as [
      string,
      (latest: VocabularyTable) => Edit[] | null,
      string,
    ];
    assert.deepEqual([name, base], ["applyPlan", "rev-render"]);
    assert.deepEqual(plan(latest([owner])), [
      { kind: "set_enabled", id: owner.id, enabled: false },
    ]);
    assert.equal(plan(latest([])), null);
  });
  it("edit_and_add_open_the_dialog_on_the_rendered_revision", () => {
    const { editings } = render({ revision: "rev-render" });
    assert.ok(tableProps);
    tableProps.edit(tableProps.groups[0]);
    assert.equal(buttons.length, 2, "Correct a reading and Add entry");
    buttons[1].onClick?.({} as never);
    assert.deepEqual(editings, [
      { group: groupOf([owner]), base: "rev-render", notice: null },
      { group: null, base: "rev-render", notice: null },
    ]);
  });
  it("saved_closes_the_dialog", async () => {
    const open = opened();
    const { calls, editings, settled } = render({
      revision: "rev-now",
      editing: open,
    });
    assert.ok(dialogProps);
    dialogProps.save(draft);
    await settled();
    assert.equal(calls.length, 1);
    const [name, plan, base] = calls[0] as Planned;
    assert.deepEqual([name, base], ["saveEntry", "rev-open"]);
    assert.deepEqual(
      plan(latest([owner])),
      entryEdits([owner], IDS, open.group?.key ?? null, draft),
    );
    assert.equal(editings.length, 1);
    assert.equal(settle(editings[0], open), null);
  });
  it("save_conflict_keeps_the_dialog_on_the_reloaded_revision", async () => {
    const open = opened();
    const { editings, settled } = render({
      revision: "rev-now",
      editing: open,
      saveResult: { status: "conflict", revision: "rev-2" },
    });
    assert.ok(dialogProps);
    dialogProps.save(draft);
    await settled();
    assert.equal(editings.length, 1);
    assert.deepEqual(settle(editings[0], open), {
      group: open.group,
      base: "rev-2",
      notice: { key: "tts.vocabulary.dialog.conflict" },
    });
  });
  it("an_outcome_reaches_only_the_dialog_still_open", async () => {
    const open = opened();
    const { editings, settled } = render({
      revision: "rev-now",
      editing: open,
      saveResult: { status: "conflict", revision: "rev-2" },
    });
    assert.ok(dialogProps);
    dialogProps.save(draft);
    await settled();
    const other = opened([row("owner", "term", "kubectl")]);
    assert.equal(settle(editings[0], null), null, "closed meanwhile");
    assert.equal(settle(editings[0], other), other, "another dialog opened");
  });
  it("delete_from_the_dialog_uses_the_dialog_revision", async () => {
    const pocket = row("owner", "term", "kubectl", { model: "pocket-en" });
    const supertonic = row("owner", "term", "kubectl", {
      model: "supertonic-3",
    });
    const rows = [pocket, supertonic];
    const open = opened(rows);
    const { calls, editings, settled } = render({
      revision: "rev-now",
      rows,
      editing: open,
    });
    assert.ok(dialogProps && open.group);
    dialogProps.remove();
    await settled();
    const [name, plan, base] = calls[0] as Planned;
    assert.deepEqual([name, base], ["saveEntry", "rev-open"]);
    const key = open.group.key;
    const scopes = ["pocket-en", "supertonic-3"];
    assert.deepEqual(plan(latest(rows)), deletePlan(rows, IDS, key, scopes));
    assert.deepEqual(plan(latest(rows)), [
      { kind: "delete", entry: pocket.id.entry },
      { kind: "delete", entry: supertonic.id.entry },
    ]);
    assert.equal(settle(editings[0], open), null);
  });
  it("reset_from_the_dialog_uses_the_dialog_revision", async () => {
    const builtin = row("builtin", "extension", "md", { spoken: "markdown" });
    const overriding = row("owner", "extension", "md", {
      spoken: "M D",
      replaces_builtin: true,
    });
    const rows = [builtin, overriding];
    const open = opened(rows);
    const { calls, settled } = render({
      revision: "rev-now",
      rows,
      editing: open,
    });
    assert.ok(dialogProps && open.group);
    dialogProps.reset();
    await settled();
    const [name, plan, base] = calls[0] as Planned;
    assert.deepEqual([name, base], ["saveEntry", "rev-open"]);
    assert.deepEqual(
      plan(latest(rows)),
      resetPlan(rows, IDS, open.group.key, [null]),
    );
    assert.deepEqual(plan(latest(rows)), [
      { kind: "reset", entry: overriding.id.entry },
    ]);
  });
  it("dialog_outcome_maps_each_result", () => {
    const open = opened();
    assert.equal(dialogOutcome(open, { status: "saved" }), null);
    assert.deepEqual(
      dialogOutcome(open, { status: "conflict", revision: "rev-2" }),
      {
        ...open,
        base: "rev-2",
        notice: { key: "tts.vocabulary.dialog.conflict" },
      },
    );
    assert.deepEqual(
      dialogOutcome(open, { status: "refused", reason: "taken" }),
      {
        ...open,
        notice: { key: "tts.vocabulary.dialog.refused" },
      },
    );
    const failure = { key: "tts.vocabulary.errors.io", message: "disk full" };
    assert.deepEqual(dialogOutcome(open, { status: "failed", failure }), {
      ...open,
      notice: failure,
    });
  });
  it("entry_dialog_key_survives_a_conflict", () => {
    const open = opened();
    const rebased = dialogOutcome(open, {
      status: "conflict",
      revision: "rev-2",
    });
    assert.ok(rebased);
    assert.equal(entryDialogKey(rebased), entryDialogKey(open));
    assert.equal(entryDialogKey(open), open.group?.key);
    assert.equal(
      entryDialogKey({ group: null, base: "a", notice: null }),
      "new",
    );
  });
  it("the dialog plays and checks acronyms with the table's acronym styles", () => {
    render({
      revision: "rev-now",
      editing: { group: null, base: "rev-open", notice: null },
    });
    assert.ok(dialogProps);
    assert.deepEqual(dialogProps.styles, [
      { model: "pocket-en", owner: "capitals", effective: "capitals" },
    ]);
    assert.equal(dialogProps.group, null);
    assert.equal(dialogProps.fileError, null);
  });
  it("the dialog of a grouped row gets every row of the group", () => {
    const pocket = row("owner", "term", "kubectl", { model: "pocket-en" });
    const supertonic = row("owner", "term", "kubectl", {
      model: "supertonic-3",
    });
    const rows = [pocket, supertonic];
    const { editings } = render({ revision: "rev-render", rows });
    assert.ok(tableProps);
    tableProps.edit(tableProps.groups[0]);
    const open = settle(editings[0], null);
    assert.deepEqual(open?.group?.members, [pocket, supertonic]);
    render({ revision: "rev-render", rows, editing: open });
    assert.deepEqual(dialogProps?.rows, rows);
    assert.deepEqual(dialogProps?.group?.members, [pocket, supertonic]);
  });
  it("Correct a reading opens the text prompt and is off while another editor is open", () => {
    const { corrections } = render({ revision: "rev-render" });
    buttons[0].onClick?.({} as never);
    assert.deepEqual(corrections, ["starting"]);
    render({ revision: "rev-render", correction: "starting" });
    assert.ok(buttons.every((button) => button.disabled));
  });
  it("the prompt reads the text with the selected voice and opens the box with it", async () => {
    const { calls, corrections } = render({
      revision: "rev-render",
      correction: "starting",
    });
    assert.ok(startProps);
    assert.equal(await startProps.speak("README.md"), "said README.md");
    startProps.open("README.md", "said README.md");
    assert.deepEqual(calls, [["speak", "README.md", "pocket-en"]]);
    assert.deepEqual(corrections, [
      { written: "README.md", spokenAs: "said README.md" },
    ]);
  });
  it("the box gets the selected voice and hands its saved table to the actions", () => {
    const { calls, corrections } = render({
      revision: "rev-render",
      correction: { written: "README.md", spokenAs: "README dot markdown" },
    });
    assert.ok(boxProps);
    assert.equal(boxProps.written, "README.md");
    assert.equal(boxProps.readingModel, "pocket-en");
    boxProps.onSaved({
      revision: "rev-box",
      path: "tts-vocabulary.json",
      file_error: null,
      rows: [],
      acronym_styles: [],
    });
    boxProps.onClose();
    assert.deepEqual(calls, [["adopt", "rev-box"]]);
    assert.deepEqual(corrections, [null]);
  });
  it("an acronym style is saved with the revision of the rendered table", () => {
    const { calls } = render({ revision: "rev-render" });
    assert.ok(styleProps);
    styleProps.set("pocket-en", "capitals");
    assert.deepEqual(calls, [
      ["setAcronymStyle", "pocket-en", "capitals", "rev-render"],
    ]);
  });
  it("shows the table's rows grouped and filtered", () => {
    const builtin = row("builtin", "extension", "json", { spoken: "jason" });
    const rows = ["pocket-en", "supertonic-3"].map((model) =>
      row("builtin", "acronym", "LLM", { model }),
    );
    render({ revision: "rev-render", rows: [owner, builtin, ...rows] });
    assert.ok(tableProps);
    assert.deepEqual(
      tableProps.groups.map((group) => group.written),
      ["json", "LLM", "md"],
    );
    assert.equal(tableProps.groups[1].members.length, 2);
    render({
      revision: "rev-render",
      rows: [owner, builtin, ...rows],
      filters: { ...NO_FILTERS, source: "owner" },
    });
    assert.deepEqual(
      tableProps?.groups.map((group) => group.written),
      ["md"],
    );
  });
});

const button = (label: string) =>
  buttons.find((props) => props.children === label);
const sectionOrder = (html: string, ...markers: string[]) =>
  markers.map((marker) => html.indexOf(marker));
const inOrder = (positions: number[]) =>
  positions.every((at, index) => at >= 0 && at > (positions[index - 1] ?? -1));

describe("VocabularyView, toolbar and states", () => {
  it("toolbar_is_search_then_correct_then_add", () => {
    const { html } = render({ revision: "rev-render" });
    const toolbar = html.match(/<div class="([^"]*\bsticky\b[^"]*)"/);
    assert.ok(toolbar, "a sticky toolbar");
    for (const token of ["top-0", "z-10", "bg-background"]) {
      assert.ok(toolbar[1].split(" ").includes(token), token);
    }
    assert.ok(!html.includes("-top-4"));
    assert.ok(
      inOrder(
        sectionOrder(
          html,
          "sticky",
          'type="search"',
          ">Correct a reading</button>",
          ">Add entry</button>",
          "Model: All",
          'data-marker="table"',
        ),
      ),
      "search, Correct a reading, Add entry, filters, then the list",
    );
    assert.equal(button("Correct a reading")?.variant, "secondary");
    assert.equal(button("Add entry")?.variant, undefined);
    assert.deepEqual(
      buttons.map((props) => props.children),
      ["Correct a reading", "Add entry"],
    );
  });
  it("toolbar_fits_in_german", async () => {
    const german = i18next.createInstance();
    await german.init({ lng: "de", resources: { de: { translation: de } } });
    const { html } = render({ revision: "rev-render", language: german });
    assert.match(html, /placeholder="Einträge suchen"/);
    assert.deepEqual(
      buttons.map((props) => props.children),
      ["Aussprache korrigieren", "Eintrag hinzufügen"],
    );
    for (const props of buttons) {
      assert.ok(
        props.className?.split(" ").includes("whitespace-nowrap"),
        `${props.children} keeps one line`,
      );
    }
    const toolbar = html.match(
      /<div class="flex ([^"]*)"><input [^>]*type="search"[^>]*>/,
    );
    assert.ok(toolbar, "the toolbar row holds the search field first");
    assert.ok(toolbar[1].split(" ").includes("flex-wrap"), toolbar[1]);
    const input = toolbar[0].slice(toolbar[0].indexOf("<input"));
    const field = /class="([^"]*)"/.exec(input)?.[1] ?? "";
    assert.ok(field.split(" ").includes("min-w-0"), field);
  });
  it("filters_offer_model_kind_source_and_a_problems_chip", () => {
    const { html, filterChanges } = render({ revision: "rev-render" });
    for (const label of ["Model: All", "Kind: All", "Source: All"]) {
      assert.ok(html.includes(label), label);
    }
    assert.ok(!html.includes("Voice: All") && !html.includes("Only problems"));
    assert.match(
      html,
      /<button type="button" aria-pressed="false"[^>]*>Problems<\/button>/,
    );
    assert.equal(chips.length, 1);
    chips[0].onToggle();
    assert.deepEqual(filterChanges, [{ ...NO_FILTERS, onlyProblems: true }]);
    const on = render({
      revision: "rev-render",
      filters: { ...NO_FILTERS, onlyProblems: true },
    });
    assert.match(on.html, /aria-pressed="true"[^>]*>Problems<\/button>/);
  });
  it("filters_fit_one_line_at_the_528_px_content_width", () => {
    // The Dropdown trigger has min-w-[200px]; a toolbar wrapper must override it and fix its width.
    const CONTENT = 528;
    const GAP = 8; // gap-2 is 7.5 px at the 15 px root; 8 is the safe figure
    const CHIP = 100; // the Problems chip: 16 px padding plus the longest locale label
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <VocabularyFilters
          filters={NO_FILTERS}
          models={models}
          setFilters={() => {}}
        />
      </I18nextProvider>,
    );
    const wrappers = [...html.matchAll(/<div class="relative ([^"]*)"/g)].map(
      (match) =>
        match[1].replace(/&amp;/g, "&").replace(/&gt;/g, ">").split(" "),
    );
    assert.equal(wrappers.length, 3, "Model, Kind and Source");
    const widths = wrappers.map((classes) => {
      const fixed = classes
        .map((token) => token.match(/^w-\[(\d+)px\]$/)?.[1])
        .find(Boolean);
      const trigger = classes.includes("[&>button]:min-w-0") ? 0 : 200;
      return Math.max(Number(fixed ?? 0), trigger);
    });
    assert.ok(
      widths.every((width) => width > 0 && width < 200),
      `${widths}`,
    );
    const total =
      widths.reduce((sum, width) => sum + width, 0) + 3 * GAP + CHIP;
    assert.ok(total <= CONTENT, `${widths} + gaps + chip = ${total} px`);
  });
  it("filter_empty_names_the_query_and_clears", () => {
    const { html, filterChanges } = render({
      revision: "rev-render",
      filters: { ...NO_FILTERS, query: " zzz " },
    });
    assert.ok(html.includes("Nothing matches &quot;zzz&quot;."), html);
    assert.ok(!html.includes('data-marker="table"'));
    const clear = button("Clear filters");
    assert.ok(clear, "Clear filters button");
    clear.onClick?.({} as never);
    assert.equal(filterChanges.length, 1);
    assert.equal(filterChanges[0], NO_FILTERS);
    const byFilter = render({
      revision: "rev-render",
      filters: { ...NO_FILTERS, source: "builtin" },
    });
    assert.ok(byFilter.html.includes("Nothing matches these filters."));
  });
  it("invalid_file_shows_path_reason_and_turns_editing_off", () => {
    const reason = "trailing comma at line 4 column 1";
    const path = "/data/tts-vocabulary.json";
    const { html, calls } = render({
      revision: "rev-render",
      fileError: reason,
      path,
      failure: { key: "tts.vocabulary.errors.io", message: "disk full" },
    });
    assert.equal(html.split(reason).length, 2, "the reason shows once");
    assert.match(
      html,
      new RegExp(
        `<p dir="ltr" class="[^"]*font-mono[^"]*break-all[^"]*text-ink-2[^"]*">${path}</p>`,
      ),
    );
    assert.ok(html.includes("Built-in readings are used until it is fixed."));
    assert.ok(html.includes("disk full"), "another failure still shows");
    button("Reload")?.onClick?.({} as never);
    button("Open folder")?.onClick?.({} as never);
    assert.deepEqual(calls, [["reload"], ["openFolder"]]);
    assert.equal(button("Correct a reading")?.disabled, true);
    assert.equal(button("Add entry")?.disabled, true);
    assert.ok(tableProps);
    assert.equal(tableProps.readOnly, true);
    assert.equal(styleProps?.readOnly, true);
    tableProps.listen(tableProps.groups[0]);
    assert.deepEqual(calls[2], ["listen", owner]);
    const healthy = render({ revision: "rev-render" });
    assert.ok(!healthy.html.includes("Built-in readings are used"));
    assert.equal(tableProps?.readOnly, false);
  });
  it("acronym_section_follows_the_list", () => {
    const { html } = render({ revision: "rev-render" });
    assert.ok(
      inOrder(
        sectionOrder(html, 'data-marker="table"', 'data-marker="acronyms"'),
      ),
    );
    const empty = render({
      revision: "rev-render",
      filters: { ...NO_FILTERS, query: "zzz" },
    }).html;
    assert.ok(
      inOrder(sectionOrder(empty, "Clear filters", 'data-marker="acronyms"')),
      "after the empty state too",
    );
  });
  it("the old voice terms are gone from the English file", () => {
    const vocabulary = en.tts.vocabulary as unknown as Record<string, unknown>;
    assert.ok(!("voices" in vocabulary));
    assert.ok(
      !("onlyProblems" in (vocabulary.filters as Record<string, unknown>)),
    );
  });
});
