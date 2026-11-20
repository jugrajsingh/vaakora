import assert from "node:assert/strict";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import en from "../../../../i18n/locales/en/translation.json";
import type { EntryRow, VocabularyTable, VoiceCheck } from "@/bindings";
import type { EditorDialogProps } from "@/components/shared/EditorDialog";
import { createVocabularyActions, type Failure } from "./actions";
import { entryEdits, type EntryDraft } from "./entryPlan";
import { entryDraft, type EntryForm } from "./form";
import { models, row } from "./fixtures";
import { groupRows } from "./groups";
const {
  mock,
  describe,
  it,
}: {
  mock: { module: (name: string, factory: () => unknown) => void };
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => void) => void;
} = createRequire(import.meta.url)("bun:test");

// The dialog host is replaced by a recorder that renders its parts inline.
let dialog: EditorDialogProps | undefined;
const recorded = () => dialog;
mock.module("@/components/shared/EditorDialog", () => ({
  EditorDialog: (props: EditorDialogProps) => {
    dialog = props;
    return (
      <div data-dialog="">
        <h2>{props.title}</h2>
        <div data-context="">{props.context}</div>
        {props.notice && <p data-notice="">{props.notice}</p>}
        {props.children}
        <div data-actions="">{props.actions}</div>
      </div>
    );
  },
}));
// The voice check reports `checkResults`; Buttons and state setters record what they are given.
let checkResults: VoiceCheck[] | null = null;
const realPanel = await import("./VoiceCheckPanel");
mock.module("./VoiceCheckPanel", () => ({
  ...realPanel,
  useVoiceCheck: () => ({
    results: checkResults,
    checking: false,
    error: null,
    playing: null,
    playAndCheck: () => {},
  }),
  VoiceCheckPanel: () => null,
}));
type ButtonProps = Parameters<
  typeof import("@/components/ui/Button").Button
>[0];
const buttons: ButtonProps[] = [];
const { Button: RealButton } = await import("@/components/ui/Button");
mock.module("@/components/ui/Button", () => ({
  Button: (props: ButtonProps) => {
    buttons.push(props);
    return RealButton(props);
  },
}));
const stateSets: unknown[] = [];
const realReact = await import("react");
const realUseState = realReact.useState;
mock.module("react", () => ({
  ...realReact,
  useState: <S,>(initial: S | (() => S)) => {
    const [value, set] = realUseState(initial);
    return [
      value,
      (next: React.SetStateAction<S>) => {
        stateSets.push(next);
        set(next);
      },
    ];
  },
}));
const { EntryDialog, refusalLine } = await import("./EntryDialog");
const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: en } } });

const IDS = models.map((model) => model.id);
const calls: string[] = [];

function render(
  rows: EntryRow[],
  pick: ((written: string) => boolean) | null,
  options: {
    notice?: Failure | null;
    fileError?: string | null;
    /** The rows the dialog opened on, when the table has changed since. */
    opened?: EntryRow[];
    save?: (draft: EntryDraft) => void;
  } = {},
) {
  const group =
    pick === null
      ? null
      : groupRows(options.opened ?? rows, IDS).find((found) =>
          pick(found.written),
        );
  assert.notEqual(group, undefined, "the picked group exists");
  dialog = undefined;
  calls.length = 0;
  buttons.length = 0;
  stateSets.length = 0;
  const html = renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <EntryDialog
        group={group ?? null}
        rows={rows}
        modelIds={IDS}
        models={models}
        styles={[]}
        notice={options.notice ?? null}
        fileError={options.fileError ?? null}
        busy={false}
        save={options.save ?? (() => calls.push("save"))}
        remove={() => calls.push("remove")}
        reset={() => calls.push("reset")}
        close={() => calls.push("close")}
      />
    </I18nextProvider>,
  );
  const seen = recorded();
  assert.ok(seen, "the entry dialog renders on the editor dialog");
  return { html, dialog: seen };
}
const any = () => true;
const checkbox = (html: string, label: string) =>
  html.match(
    new RegExp(`<label[^>]*><input[^>]*type="checkbox"[^>]*/>${label}</label>`),
  )?.[0];

const mine = row("owner", "extension", "md", {
  spoken: "M D",
  replaces_builtin: true,
});
const mdDefault = row("builtin", "extension", "md", {
  spoken: "markdown",
  problems: [{ shadowed: { by: mine.id } }],
});
const json = row("builtin", "extension", "json", { spoken: "jason" });

describe("EntryDialog", () => {
  it("opens a new entry as a term with Save off until it is filled in", () => {
    const { html, dialog } = render([], null);
    assert.equal(dialog.title, "Add entry");
    assert.ok(html.includes("Skip") && html.includes("Case sensitive"));
    assert.equal(dialog.save.disabled, true);
    assert.equal(dialog.save.label, "Save");
    assert.ok(checkbox(html, "All models")?.includes('checked=""'));
    assert.deepEqual(dialog.removals ?? [], [], "Add entry removes nothing");
    assert.equal(dialog.context, undefined);
  });
  it("asks for no spoken text on an acronym and offers no term options", () => {
    const { html, dialog } = render([row("owner", "acronym", "Cli")], any);
    assert.ok(!html.includes('aria-label="Spoken"'));
    assert.ok(!html.includes("Skip") && !html.includes("Case sensitive"));
    assert.equal(dialog.save.disabled, false);
  });
  it("checks an entry for all models with Play all and one model with Listen", () => {
    const all = render(
      [row("owner", "term", "kubectl", { spoken: "cube control" })],
      any,
    ).html;
    assert.match(all, /<button[^>]*>Play all<\/button>/);
    const one = render(
      [
        row("owner", "term", "kubectl", {
          spoken: "cube control",
          model: "pocket-en",
        }),
      ],
      any,
    ).html;
    assert.match(one, /<button[^>]*>Listen<\/button>/);
    assert.doesNotMatch(one, />Play all</);
    assert.match(
      render([], null).html,
      /<button[^>]*disabled=""[^>]*>Play all<\/button>/,
    );
  });
  it("shows the row's own spoken text and models when editing", () => {
    const { html } = render(
      [
        row("owner", "term", "kubectl", {
          spoken: "cube control",
          model: "pocket-en",
        }),
      ],
      any,
    );
    assert.ok(html.includes('value="kubectl"'));
    assert.ok(html.includes('value="cube control"'));
    assert.ok(checkbox(html, "Pocket TTS")?.includes('checked=""'));
    assert.ok(!checkbox(html, "All models")?.includes('checked=""'));
  });
  it("edits a row shown from several models with one Applies to list that checks them all", () => {
    const kubectl = (model: string) =>
      row("owner", "term", "kubectl", { spoken: "cube control", model });
    const { html } = render(
      [kubectl("pocket-en"), kubectl("supertonic-3")],
      any,
    );
    assert.equal(html.split("Applies to").length, 2, "one Applies to list");
    assert.ok(checkbox(html, "Pocket TTS")?.includes('checked=""'));
    assert.ok(checkbox(html, "Supertonic 3")?.includes('checked=""'));
    assert.match(html, /<button[^>]*>Play all<\/button>/);
    assert.ok(html.includes('value="cube control"'));
  });
  it("title_and_context_name_the_entry_and_its_default", () => {
    const { html, dialog } = render([mine, mdDefault], any);
    assert.equal(dialog.title, "Edit md");
    assert.ok(html.includes("md, now spoken as M D."));
    assert.ok(
      html.includes("Your entry overrides the built-in reading markdown."),
    );
    const plain = render([json], any).html;
    assert.ok(plain.includes("json, now spoken as jason."));
    assert.ok(!plain.includes("overrides the built-in"));
    const skipped = render(
      [row("owner", "term", "ABC-123", { skip: true })],
      any,
    ).html;
    assert.ok(skipped.includes("ABC-123, now spoken as (skipped)."));
  });
  it("builtin_delete_is_disabled_with_its_reason", () => {
    const builtin = render([json], any).dialog;
    const off = builtin.removals?.find((removal) => removal.id === "delete");
    assert.ok(off, "a built-in entry shows Delete");
    assert.equal(
      off.disabledReason,
      "Built-in entries can be switched off, not deleted.",
    );
    const yours = render([mine, mdDefault], any).dialog;
    const remove = yours.removals?.find((removal) => removal.id === "delete");
    assert.ok(remove);
    assert.equal(remove.disabledReason, undefined);
    assert.equal(remove.label, "Delete");
    assert.equal(remove.message, "Delete md? Your other entries are kept.");
    assert.equal(remove.action, "Delete entry");
    void remove.apply();
    assert.deepEqual(calls, ["remove"]);
  });
  it("reset_is_offered_only_over_a_builtin", () => {
    const over = render([mine, mdDefault], any).dialog;
    const reset = over.removals?.find((removal) => removal.id === "reset");
    assert.ok(reset, "your entry over a built-in offers Reset to default");
    assert.equal(reset.label, "Reset to default");
    assert.equal(
      reset.message,
      "Reset md to the built-in reading? Your entry is deleted.",
    );
    assert.equal(reset.action, "Reset to default");
    void reset.apply();
    assert.deepEqual(calls, ["reset"]);
    for (const rows of [[json], [row("owner", "term", "kubectl")]]) {
      const ids = render(rows, any).dialog.removals?.map((r) => r.id);
      assert.deepEqual(ids, ["delete"]);
    }
  });
  it("applies_to_keeps_absent_model_scopes", () => {
    const { html } = render(
      [row("owner", "term", "kubectl", { spoken: "x", model: "gone-model" })],
      any,
    );
    const gone = checkbox(html, "gone-model");
    assert.ok(gone, "the absent model is listed");
    assert.ok(gone.includes('checked=""'));
    assert.ok(checkbox(html, "Pocket TTS"));
    assert.equal(checkbox(html, "Supertonic 3"), undefined, "not downloaded");
  });
  it("unchanged_form_is_not_dirty", () => {
    assert.equal(render([mine, mdDefault], any).dialog.dirty, false);
    assert.equal(render([], null).dialog.dirty, false);
  });
  it("a_refused_plan_disables_save_with_one_line_per_reason", () => {
    assert.equal(refusalLine("empty"), null);
    assert.equal(refusalLine("gone"), "tts.vocabulary.dialog.refused");
    assert.equal(refusalLine("taken"), "tts.vocabulary.dialog.scopeRefused");
    assert.equal(
      refusalLine("builtin-scope"),
      "tts.vocabulary.dialog.scopeRefused",
    );
    const gone = render([json], any, { opened: [mine, mdDefault] });
    assert.equal(gone.dialog.save.disabled, true);
    assert.ok(
      gone.html.includes(
        "The vocabulary changed and this entry can no longer be saved as it is.",
      ),
    );
    const open = render([mine, mdDefault], any);
    assert.equal(open.dialog.save.disabled, false);
    assert.ok(!open.html.includes("can no longer be saved"));
  });
  it("file_error_disables_save_with_its_notice", () => {
    const { dialog } = render([mine, mdDefault], any, {
      fileError: "bad json",
    });
    assert.equal(dialog.save.disabled, true);
    assert.equal(
      dialog.notice,
      "Your vocabulary file has an error, so it cannot be edited here: bad json",
    );
  });
  it("shows_the_hosts_notice", () => {
    const { dialog } = render([mine, mdDefault], any, {
      notice: { key: "tts.vocabulary.dialog.conflict" },
    });
    assert.equal(
      dialog.notice,
      "The vocabulary file changed on disk and was reloaded. Check the entry, then Save again.",
    );
  });
  it("save_passed_only_keeps_the_passed_models_in_the_form_for_a_retry", async () => {
    const kubectl = row("owner", "term", "kubectl", { spoken: "cube control" });
    const drafts: EntryDraft[] = [];
    checkResults = [
      { model_id: "pocket-en", outcome: { kind: "heard_right" } },
      { model_id: "supertonic-3", outcome: { kind: "missed", heard: "wrong" } },
    ] as VoiceCheck[];
    render([kubectl], any, { save: (draft) => drafts.push(draft) });
    checkResults = null;
    const passedOnly = buttons.find(
      (button) => button.children === "Save only for models that passed",
    );
    assert.ok(
      passedOnly,
      "a miss for all models offers Save only for models that passed",
    );
    passedOnly.onClick?.({} as never);
    assert.deepEqual(
      drafts.map((draft) => draft.scopes),
      [["pocket-en"]],
    );
    const forms = stateSets.filter(
      (set): set is EntryForm =>
        typeof set === "object" && set !== null && "scopes" in set,
    );
    const form = forms[forms.length - 1];
    assert.ok(form, "the passed-only action sets the form");
    assert.deepEqual(
      form.scopes,
      ["pocket-en"],
      "the form holds what was saved",
    );

    // A changed file, then a save: the retry from the form keeps the passed models.
    const requests: (string | null)[][] = [];
    const table = (revision: string): VocabularyTable => ({
      revision,
      path: "tts-vocabulary.json",
      file_error: null,
      rows: [kubectl],
      acronym_styles: [],
    });
    let loads = 0;
    const actions = createVocabularyActions({
      load: async () => table(`rev-${++loads}`),
      save: async (_revision, edits) => {
        requests.push(
          edits.flatMap((edit) =>
            edit.kind === "put" ? [edit.entry.model] : [],
          ),
        );
        return requests.length === 1 ? { kind: "changed" } : table("saved");
      },
      listen: async () => {},
      speak: async () => "",
      setTable: () => {},
      setError: () => {},
      onPreviewError: async () => () => {},
    });
    await actions.load();
    const key = groupRows([kubectl], IDS)[0].key;
    const send = (draft: EntryDraft, base: string) =>
      actions.saveEntry(
        (latest) => entryEdits(latest.rows, IDS, key, draft),
        base,
      );
    const first = await send(drafts[0], "rev-1");
    assert.deepEqual(first, { status: "conflict", revision: "rev-2" });
    assert.deepEqual(await send(entryDraft(form, [null]), "rev-2"), {
      status: "saved",
    });
    assert.deepEqual(requests, [["pocket-en"], ["pocket-en"]]);
  });
});
