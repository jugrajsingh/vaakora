import assert from "node:assert/strict";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import en from "../../../../i18n/locales/en/translation.json";
import type {
  Edit,
  EntryKey,
  EntryRow,
  Rule,
  VocabularyTable,
} from "@/bindings";
import { NO_FILTERS, type Filters } from "./filter";
import type { AcronymStyles } from "./AcronymStyles";
import type { CorrectionBox } from "./CorrectionBox";
import type { CorrectionStart } from "./CorrectionStart";
import type { RowEditor } from "./RowEditor";
import type { VocabularyTableProps } from "./VocabularyTable";
import type { Correction, Draft, VocabularyActions } from "./VocabularyView";
import { models, row } from "./fixtures";
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
let editorProps: Parameters<typeof RowEditor>[0] | undefined;
let boxProps: Parameters<typeof CorrectionBox>[0] | undefined;
let startProps: Parameters<typeof CorrectionStart>[0] | undefined;
let styleProps: Parameters<typeof AcronymStyles>[0] | undefined;
const buttons: Parameters<typeof import("@/components/ui/Button").Button>[0][] =
  [];
mock.module("./VocabularyTable", () => ({
  VocabularyTable: (props: VocabularyTableProps) => {
    tableProps = props;
    return null;
  },
}));
mock.module("./RowEditor", () => ({
  RowEditor: (props: Parameters<typeof RowEditor>[0]) => {
    editorProps = props;
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
    return null;
  },
}));
const { Button: RealButton } = await import("@/components/ui/Button");
mock.module("@/components/ui/Button", () => ({
  Button: (props: Parameters<typeof RealButton>[0]) => {
    buttons.push(props);
    return RealButton(props);
  },
}));
const { VocabularyView, resetOffered } = await import("./VocabularyView");
const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: en } } });

const owner = row("owner", "extension", "md", { spoken: "M D" });
type Call = [string, ...unknown[]];

function render(options: {
  revision: string;
  draft?: Draft | null;
  correction?: Correction | "starting" | null;
  putResult?: boolean;
  rows?: EntryRow[];
  filters?: Filters;
}) {
  const calls: Call[] = [];
  const drafts: (Draft | null)[] = [];
  const corrections: (Correction | "starting" | null)[] = [];
  const filterChanges: Filters[] = [];
  const actions: VocabularyActions = {
    reset: (target, base) => calls.push(["reset", target, base]),
    remove: (target, base) => calls.push(["remove", target, base]),
    applyPlan: (plan, base) => calls.push(["applyPlan", plan, base]),
    listen: (target) => calls.push(["listen", target]),
    setAcronymStyle: (model, style, base) =>
      calls.push(["setAcronymStyle", model, style, base]),
    speak: async (written, model) => {
      calls.push(["speak", written, model]);
      return `said ${written}`;
    },
    adopt: (saved) => calls.push(["adopt", saved.revision]),
    put: async (entries: readonly EntryKey[], rule: Rule, previous, base) => {
      calls.push(["put", entries, rule, previous, base]);
      return options.putResult ?? true;
    },
  };
  const table: VocabularyTable = {
    revision: options.revision,
    path: "tts-vocabulary.json",
    file_error: null,
    rows: options.rows ?? [owner],
    acronym_styles: [
      { model: "pocket-en", owner: "capitals", effective: "capitals" },
    ],
  };
  tableProps = undefined;
  editorProps = undefined;
  boxProps = undefined;
  startProps = undefined;
  styleProps = undefined;
  buttons.length = 0;
  const html = renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <VocabularyView
        table={table}
        models={models}
        failure={null}
        filters={options.filters ?? NO_FILTERS}
        setFilters={(next) => filterChanges.push(next)}
        draft={options.draft ?? null}
        setDraft={(next) => drafts.push(next)}
        correction={options.correction ?? null}
        setCorrection={(next) => corrections.push(next)}
        readingModel="pocket-en"
        actions={actions}
      />
    </I18nextProvider>,
  );
  return { calls, drafts, corrections, filterChanges, html };
}

const rule: Rule = { say: "M D", matching: null, case: null };
const entry: EntryKey = owner.id.entry;

describe("VocabularyView", () => {
  it("edit_locked_while_a_draft_or_correction_is_open", () => {
    render({ revision: "rev-render" });
    assert.equal(tableProps?.editLocked, false);
    render({
      revision: "rev-render",
      draft: { initial: owner, members: [owner], base: "rev-render" },
    });
    assert.equal(tableProps?.editLocked, true, "a draft is open");
    render({ revision: "rev-render", correction: "starting" });
    assert.equal(tableProps?.editLocked, true, "the correction prompt");
    render({
      revision: "rev-render",
      correction: { written: "README.md", spokenAs: "README dot markdown" },
    });
    assert.equal(tableProps?.editLocked, true, "an open correction");
  });
  it("the view is as wide as the page column, never max-w-5xl", () => {
    const { html } = render({ revision: "rev-render" });
    assert.match(html, /^<section class="[^"]*\bmax-w-3xl\b/);
    assert.ok(!html.includes("max-w-5xl"));
  });
  it("passes the rendered table's revision with reset and remove, and resets only the rows that override a built-in", () => {
    const builtin = row("builtin", "extension", "md", { spoken: "markdown" });
    const overriding = row("owner", "extension", "md", {
      spoken: "M D",
      replaces_builtin: true,
    });
    const plain = row("owner", "extension", "md", {
      model: "pocket-en",
      spoken: "M D",
    });
    const { calls } = render({
      revision: "rev-render",
      rows: [builtin, overriding, plain],
    });
    assert.ok(tableProps);
    const [target] = tableProps.groups;
    tableProps.reset(target);
    tableProps.confirmReset();
    tableProps.remove(target);
    tableProps.listen(target);
    assert.deepEqual(calls, [
      ["reset", [overriding], "rev-render"],
      ["remove", [overriding, plain], "rev-render"],
      ["listen", overriding],
    ]);
  });
  it("reset_waits_for_confirmation", () => {
    const overriding = row("owner", "extension", "md", {
      spoken: "M D",
      replaces_builtin: true,
    });
    const builtin = row("builtin", "extension", "md", { spoken: "markdown" });
    const { calls } = render({
      revision: "rev-render",
      rows: [builtin, overriding],
    });
    assert.ok(tableProps);
    assert.equal(tableProps.resetting, null);
    const [group] = tableProps.groups;
    tableProps.reset(group);
    assert.deepEqual(calls, [], "Reset only asks");
    tableProps.confirmReset();
    tableProps.confirmReset();
    assert.deepEqual(calls, [["reset", group.overriding, "rev-render"]]);
    tableProps.reset(group);
    tableProps.cancelReset();
    tableProps.confirmReset();
    assert.equal(calls.length, 1, "nothing resets after Cancel");
  });
  it("reset_question_drops_when_the_row_stops_offering_reset", () => {
    const overriding = row("owner", "extension", "md", {
      spoken: "M D",
      replaces_builtin: true,
    });
    const builtin = row("builtin", "extension", "md", { spoken: "markdown" });
    const plain = row("owner", "term", "kubectl", { spoken: "cube control" });
    render({ revision: "rev-render", rows: [builtin, overriding, plain] });
    assert.ok(tableProps);
    const shown = tableProps.groups;
    const md = shown.find((group) => group.written === "md");
    const kubectl = shown.find((group) => group.written === "kubectl");
    assert.ok(md && kubectl);
    assert.equal(resetOffered(shown, false, md.key), true);
    assert.equal(resetOffered(shown, true, md.key), false, "file error");
    assert.equal(resetOffered(shown, false, kubectl.key), false);
    assert.equal(resetOffered([kubectl], false, md.key), false, "filtered");
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
    const latest = (rows: EntryRow[]): VocabularyTable => ({
      revision: "rev-latest",
      path: "tts-vocabulary.json",
      file_error: null,
      rows,
      acronym_styles: [],
    });
    assert.deepEqual(plan(latest([owner])), [
      { kind: "set_enabled", id: owner.id, enabled: false },
    ]);
    assert.equal(plan(latest([])), null);
  });
  it("opens a draft on Edit and Add with the rendered table's revision", () => {
    const { drafts } = render({ revision: "rev-render" });
    assert.ok(tableProps);
    tableProps.edit(tableProps.groups[0]);
    assert.equal(buttons.length, 2, "Add correction and Add entry");
    buttons[1].onClick?.({} as never);
    assert.deepEqual(drafts, [
      { initial: owner, members: [owner], base: "rev-render" },
      { initial: null, members: [], base: "rev-render" },
    ]);
  });
  it("Save sends the revision captured when the draft opened, then closes it", async () => {
    const { calls, drafts } = render({
      revision: "rev-now",
      draft: { initial: owner, members: [owner], base: "rev-open" },
    });
    assert.ok(editorProps);
    editorProps.submit([entry], rule, []);
    await new Promise((resolve) => setTimeout(resolve));
    assert.deepEqual(calls, [["put", [entry], rule, [], "rev-open"]]);
    assert.deepEqual(drafts, [null]);
  });
  it("the editor plays and checks acronyms with the table's acronym styles", () => {
    render({
      revision: "rev-now",
      draft: { initial: null, members: [], base: "rev-open" },
    });
    assert.ok(editorProps);
    assert.deepEqual(editorProps.styles, [
      { model: "pocket-en", owner: "capitals", effective: "capitals" },
    ]);
  });
  it("Save keeps the draft open when the edit is not finished", async () => {
    const { calls, drafts } = render({
      revision: "rev-now",
      draft: { initial: null, members: [], base: "rev-open" },
      putResult: false,
    });
    assert.ok(editorProps);
    editorProps.submit([entry], rule, []);
    await new Promise((resolve) => setTimeout(resolve));
    assert.equal(calls.length, 1);
    assert.deepEqual(drafts, []);
  });
  it("Add correction opens the text prompt and is off while another editor is open", () => {
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
  it("a Voices change is planned from the latest rows, refusing a voice another reading took meanwhile", () => {
    const kubectl = (model: string, spoken: string) =>
      row("owner", "term", "kubectl", { spoken, model });
    const pocket = kubectl("pocket-en", "cube control");
    const { calls } = render({
      revision: "rev-render",
      rows: [pocket, kubectl("phonon", "kube control")],
    });
    assert.ok(tableProps);
    const group = tableProps.groups.find((g) => g.spoken === "cube control");
    assert.ok(group);
    tableProps.changeVoice(group, "supertonic-3");
    assert.equal(calls.length, 1);
    const [name, plan, base] = calls[0] as [
      string,
      (latest: VocabularyTable) => Edit[] | null,
      string,
    ];
    assert.deepEqual([name, base], ["applyPlan", "rev-render"]);
    const latest = (rows: EntryRow[]): VocabularyTable => ({
      revision: "rev-latest",
      path: "tts-vocabulary.json",
      file_error: null,
      rows,
      acronym_styles: [],
    });
    const edits: Edit[] = [
      {
        kind: "put",
        entry: { section: "term", model: "supertonic-3", key: "kubectl" },
        rule: { say: "cube control", matching: "whole", case: true },
        previous: null,
      },
    ];
    assert.deepEqual(
      plan(latest([pocket, kubectl("phonon", "kube control")])),
      edits,
    );
    assert.equal(
      plan(
        latest([
          pocket,
          kubectl("phonon", "kube control"),
          kubectl("supertonic-3", "kube control"),
        ]),
      ),
      null,
    );
  });
  it("a Voices change no safe edit makes saves nothing", () => {
    const { calls } = render({
      revision: "rev-render",
      rows: [row("owner", "term", "kubectl", { model: "pocket-en" })],
    });
    assert.ok(tableProps);
    tableProps.changeVoice(tableProps.groups[0], "pocket-en");
    assert.deepEqual(calls, []);
  });
  it("the editor of a grouped row gets every row of the group", () => {
    const pocket = row("owner", "term", "kubectl", { model: "pocket-en" });
    const supertonic = row("owner", "term", "kubectl", {
      model: "supertonic-3",
    });
    const { drafts } = render({
      revision: "rev-render",
      rows: [pocket, supertonic],
    });
    assert.ok(tableProps);
    tableProps.edit(tableProps.groups[0]);
    assert.deepEqual(drafts, [
      {
        initial: pocket,
        members: [pocket, supertonic],
        base: "rev-render",
      },
    ]);
  });
});
