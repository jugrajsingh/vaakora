import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type {
  Edit,
  EntryRow,
  ListenText,
  SaveError,
  VocabularyTable,
} from "@/bindings";
import { createVocabularyActions, visibleFailures } from "./actions";
import { deletePlan, entryEdits, resetPlan } from "./entryPlan";
import { row } from "./fixtures";
import { groupRows } from "./groups";
const {
  describe,
  it,
}: {
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => Promise<void> | void) => void;
} = createRequire(import.meta.url)("bun:test");

const owner = row("owner", "extension", "md", { spoken: "M D" });
const CATALOG = ["phonon", "pocket-en", "supertonic-3"];
/** Switches the owner row off, as a planned edit made against `base`. */
const flip = (
  actions: ReturnType<typeof createVocabularyActions>,
  base: string,
) =>
  actions.applyPlan(
    () => [{ kind: "set_enabled", id: owner.id, enabled: false }],
    base,
  );
const table = (
  revision: string,
  rows: EntryRow[] = [owner],
): VocabularyTable => ({
  revision,
  path: "tts-vocabulary.json",
  file_error: null,
  rows,
  acronym_styles: [],
});
const keyOf = (rows: EntryRow[], pick: (written: string) => boolean) => {
  const found = groupRows(rows, CATALOG).find((g) => pick(g.written));
  assert.ok(found);
  return found.key;
};

function setup(
  options: {
    results?: (VocabularyTable | SaveError)[];
    failListen?: Error;
    failSpeak?: Error;
    deferSecondLoad?: boolean;
    /** The revisions loads return in order; `load-<n>` after them. */
    revisions?: string[];
    /** The load with this number fails. */
    failLoad?: number;
    /** The rows every load returns. */
    rows?: EntryRow[];
  } = {},
) {
  const saves: { revision: string; edits: Edit[] }[] = [];
  const errors: [string | null, string?][] = [];
  const tables: string[] = [];
  const listens: [ListenText, string | null][] = [];
  const previewListeners: ((message: string) => void)[] = [];
  const stopped: string[] = [];
  const events: string[] = [];
  let releaseLoad: () => void = () => {};
  let loads = 0;
  const results = options.results ?? [];
  const actions = createVocabularyActions({
    load: async () => {
      const n = ++loads;
      if (n === 2 && options.deferSecondLoad) {
        await new Promise<void>((resolve) => {
          releaseLoad = resolve;
        });
      }
      if (n === options.failLoad) throw new Error("tts.errors.localIo");
      return table(options.revisions?.[n - 1] ?? `load-${n}`, options.rows);
    },
    save: async (revision, edits) => {
      saves.push({ revision, edits });
      return results.shift() ?? table(`saved-${saves.length}`, options.rows);
    },
    listen: async (text, model) => {
      listens.push([text, model]);
      if (options.failListen) throw options.failListen;
    },
    speak: async (written, model) => {
      if (options.failSpeak) throw options.failSpeak;
      return `${written} on ${model}`;
    },
    setTable: (next) => {
      tables.push(next.revision);
      events.push(`setTable:${next.revision}`);
    },
    setError: (...args) => {
      errors.push(args);
      events.push(`setError:${args[0]}`);
    },
    onPreviewError: async (listener) => {
      previewListeners.push(listener);
      return () => stopped.push("stopped");
    },
  });
  return {
    actions,
    saves,
    errors,
    tables,
    listens,
    events,
    releaseLoad: () => releaseLoad(),
    stopped,
    emitPreviewError: (message: string) =>
      previewListeners.forEach((listener) => listener(message)),
    loads: () => loads,
  };
}

/** Deletes the group whose written text is `written`, as the dialog's Delete does. */
const deleteGroup = (
  actions: ReturnType<typeof createVocabularyActions>,
  rows: EntryRow[],
  written: string,
  base: string,
) => {
  const key = keyOf(rows, (found) => found === written);
  const group = groupRows(rows, CATALOG).find((found) => found.key === key);
  const opened = group?.members.map((member) => member.id.entry.model) ?? [];
  return actions.saveEntry(
    (latest) => deletePlan(latest.rows, CATALOG, key, opened),
    base,
  );
};
/** Resets the group whose written text is `written`, as the dialog's Reset does. */
const resetGroup = (
  actions: ReturnType<typeof createVocabularyActions>,
  rows: EntryRow[],
  written: string,
  base: string,
) => {
  const key = keyOf(rows, (found) => found === written);
  const group = groupRows(rows, CATALOG).find((found) => found.key === key);
  const opened = group?.members.map((member) => member.id.entry.model) ?? [];
  return actions.saveEntry(
    (latest) => resetPlan(latest.rows, CATALOG, key, opened),
    base,
  );
};
const builtinMd = row("builtin", "extension", "md", { spoken: "markdown" });
const overriding = row("owner", "extension", "md", {
  spoken: "M D",
  replaces_builtin: true,
});

describe("vocabulary actions", () => {
  it("toggle sends set_enabled with the loaded revision", async () => {
    const { actions, saves } = setup();
    await actions.load();
    await flip(actions, "load-1");
    assert.deepEqual(saves, [
      {
        revision: "load-1",
        edits: [{ kind: "set_enabled", id: owner.id, enabled: false }],
      },
    ]);
  });
  it("two edits based on one table are saved with the revision each follows", async () => {
    const rows = [builtinMd, overriding];
    const { actions, saves } = setup({ rows });
    await actions.load();
    await Promise.all([
      flip(actions, "load-1"),
      resetGroup(actions, rows, "md", "load-1"),
    ]);
    assert.deepEqual(
      saves.map((save) => save.revision),
      ["load-1", "saved-1"],
    );
  });
  it("remove_deletes_owner_rows_without_asking", async () => {
    const { actions, saves, events } = setup();
    await actions.load();
    events.length = 0;
    assert.deepEqual(await deleteGroup(actions, [owner], "md", "load-1"), {
      status: "saved",
    });
    assert.deepEqual(saves[0].edits, [
      { kind: "delete", entry: owner.id.entry },
    ]);
    assert.deepEqual(events, ["setTable:saved-1", "setError:null"]);
  });
  it("remove_refuses_a_builtin_row", async () => {
    const json = row("builtin", "extension", "json");
    const { actions, saves } = setup({ rows: [json] });
    await actions.load();
    assert.deepEqual(await deleteGroup(actions, [json], "json", "load-1"), {
      status: "refused",
      reason: "gone",
    });
    assert.deepEqual(saves, []);
  });
  it("reset sends reset for the row's entry", async () => {
    const rows = [builtinMd, overriding];
    const { actions, saves } = setup({ rows });
    await actions.load();
    await resetGroup(actions, rows, "md", "load-1");
    assert.deepEqual(saves[0].edits, [
      { kind: "reset", entry: overriding.id.entry },
    ]);
  });
  it("a new entry is saved at each checked scope in one save", async () => {
    const { actions, saves, tables } = setup();
    await actions.load();
    const rule = {
      say: "cube control",
      matching: "whole" as const,
      case: true,
    };
    const draft = {
      section: "term" as const,
      written: "kubectl",
      rule,
      scopes: ["pocket-en", "supertonic-3"],
      opened: [],
    };
    assert.deepEqual(
      await actions.saveEntry(
        (latest) => entryEdits(latest.rows, CATALOG, null, draft),
        "load-1",
      ),
      { status: "saved" },
    );
    const entry = (model: string) => ({
      section: "term",
      model,
      key: "kubectl",
    });
    assert.equal(saves.length, 1);
    assert.deepEqual(saves[0].edits, [
      { kind: "put", entry: entry("pocket-en"), rule, previous: null },
      { kind: "put", entry: entry("supertonic-3"), rule, previous: null },
    ]);
    assert.equal(tables[tables.length - 1], "saved-1");
  });
  it("remove deletes every owner row of a grouped row in one save", async () => {
    const pocket = row("owner", "term", "kubectl", { model: "pocket-en" });
    const phonon = row("owner", "term", "kubectl", { model: "phonon" });
    const rows = [pocket, phonon];
    const { actions, saves } = setup({ rows });
    await actions.load();
    await deleteGroup(actions, rows, "kubectl", "load-1");
    assert.equal(saves.length, 1);
    assert.deepEqual(saves[0].edits, [
      { kind: "delete", entry: pocket.id.entry },
      { kind: "delete", entry: phonon.id.entry },
    ]);
  });
  it("reset puts back the built-in default of every row of a grouped row in one save", async () => {
    const at = (origin: "owner" | "builtin", model: string) =>
      row(origin, "extension", "md", {
        model,
        spoken: origin === "owner" ? "M D" : "markdown",
        replaces_builtin: origin === "owner",
      });
    const pocket = at("owner", "pocket-en");
    const phonon = at("owner", "phonon");
    const rows = [at("builtin", "pocket-en"), at("builtin", "phonon")];
    rows.push(pocket, phonon);
    const { actions, saves } = setup({ rows });
    await actions.load();
    await resetGroup(actions, rows, "md", "load-1");
    assert.equal(saves.length, 1);
    assert.deepEqual(saves[0].edits, [
      { kind: "reset", entry: pocket.id.entry },
      { kind: "reset", entry: phonon.id.entry },
    ]);
  });
  it("applyPlan saves the plan's edits with the revision it was made against, queued like any edit", async () => {
    const { actions, saves } = setup();
    await actions.load();
    const edits: Edit[] = [{ kind: "delete", entry: owner.id.entry }];
    const seen: string[] = [];
    await Promise.all(
      ["load-1", "load-1"].map((base) =>
        actions.applyPlan((latest) => {
          seen.push(latest.revision);
          return edits;
        }, base),
      ),
    );
    assert.deepEqual(
      saves.map((save) => [save.revision, save.edits]),
      [
        ["load-1", edits],
        ["saved-1", edits],
      ],
    );
    assert.deepEqual(seen, ["load-1", "saved-1"]);
  });
  it("applyPlan made against a replaced table is dropped without planning", async () => {
    const { actions, saves } = setup({ results: [{ kind: "changed" }] });
    await actions.load();
    await flip(actions, "load-1");
    let planned = 0;
    assert.equal(
      await actions.applyPlan(() => {
        planned += 1;
        return [{ kind: "delete", entry: owner.id.entry }];
      }, "load-1"),
      false,
    );
    assert.equal(planned, 0);
    assert.equal(saves.length, 1);
  });
  it("applyPlan saves nothing and says so when the plan no longer applies", async () => {
    const { actions, saves, errors } = setup();
    await actions.load();
    errors.length = 0;
    assert.equal(await actions.applyPlan(() => null, "load-1"), false);
    assert.deepEqual(saves, []);
    assert.deepEqual(errors, [["tts.vocabulary.errors.voicesChanged"]]);
  });
  it("a second entry save queued behind a first that takes the same model is refused, keeping the first entry", async () => {
    const kubectl = (model: string, spoken: string) =>
      row("owner", "term", "kubectl", { model, spoken });
    let store = [
      kubectl("pocket-en", "cube control"),
      kubectl("phonon", "kube control"),
    ];
    const saved: Edit[][] = [];
    let release: () => void = () => {};
    const firstSave = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tableOf = (revision: string) => table(revision, store);
    const actions = createVocabularyActions({
      load: async () => tableOf("load-1"),
      save: async (_revision, edits) => {
        saved.push(edits);
        if (saved.length === 1) await firstSave;
        for (const edit of edits) {
          if (edit.kind !== "put") throw new Error("unexpected edit");
          const { model, key } = edit.entry;
          store = [
            ...store.filter(
              (r) => r.id.entry.model !== model || r.id.entry.key !== key,
            ),
            kubectl(model ?? "", edit.rule.say ?? ""),
          ];
        }
        return tableOf(`saved-${saved.length}`);
      },
      listen: async () => {},
      speak: async () => "",
      setTable: () => {},
      setError: () => {},
      onPreviewError: async () => () => {},
    });
    await actions.load();
    const addSupertonic = (spoken: string, model: string) => {
      const key = groupRows(store, CATALOG).find(
        (g) => g.spoken === spoken,
      )?.key;
      assert.ok(key, spoken);
      const draft = {
        section: "term" as const,
        written: "kubectl",
        rule: { say: spoken, matching: "whole" as const, case: true },
        scopes: [model, "supertonic-3"],
        opened: [model],
      };
      return actions.saveEntry(
        (latest) => entryEdits(latest.rows, CATALOG, key, draft),
        "load-1",
      );
    };
    const first = addSupertonic("cube control", "pocket-en");
    const second = addSupertonic("kube control", "phonon");
    release();
    assert.deepEqual(await Promise.all([first, second]), [
      { status: "saved" },
      { status: "refused", reason: "taken" },
    ]);
    assert.equal(saved.length, 1);
    const at = (model: string) =>
      store.find((r) => r.id.entry.model === model)?.spoken;
    assert.equal(at("supertonic-3"), "cube control");
    assert.equal(at("phonon"), "kube control");
  });
  it("conflict_reloads_and_reports", async () => {
    const { actions, errors, loads, tables } = setup({
      results: [{ kind: "changed" }],
    });
    await actions.load();
    errors.length = 0;
    const done = await flip(actions, "load-1");
    assert.equal(done, true);
    assert.equal(loads(), 2);
    assert.equal(tables[tables.length - 1], "load-2");
    assert.deepEqual(errors, [["tts.vocabulary.errors.changed"]]);
  });
  it("a file with an error reloads and reports its message", async () => {
    const { actions, errors, loads } = setup({
      results: [{ kind: "file_invalid", message: "bad json" }],
    });
    await actions.load();
    errors.length = 0;
    assert.equal(await flip(actions, "load-1"), false);
    assert.equal(loads(), 2);
    assert.deepEqual(errors, [
      ["tts.vocabulary.errors.fileInvalid", "bad json"],
    ]);
  });
  it("an invalid edit reports the reason on the tab", async () => {
    const { actions, errors } = setup({
      results: [{ kind: "invalid_edit", message: "no spaces" }],
    });
    await actions.load();
    errors.length = 0;
    assert.equal(await flip(actions, "load-1"), false);
    assert.deepEqual(errors, [
      ["tts.vocabulary.errors.invalidEdit", "no spaces"],
    ]);
  });
  it("listen reads the row's sample for its own scope", async () => {
    const { actions, listens } = setup();
    const pocket = row("owner", "term", "kubectl", {
      model: "pocket-en",
      sample: "run kubectl",
    });
    await actions.listen(pocket);
    assert.deepEqual(listens, [[{ written: "run kubectl" }, "pocket-en"]]);
  });
  it("listen reports a backend error key", async () => {
    const { actions, errors } = setup({
      failListen: new Error("tts.errors.notDownloaded"),
    });
    await actions.listen(owner);
    assert.deepEqual(errors, [["tts.errors.notDownloaded"]]);
  });
  it("a second entry save queued behind a conflict reports the conflict and writes nothing", async () => {
    const { actions, saves, errors } = setup({
      results: [{ kind: "changed" }],
    });
    await actions.load();
    errors.length = 0;
    const edits = (say: string): Edit[] => [
      {
        kind: "put",
        entry: owner.id.entry,
        rule: { say, matching: null, case: null },
        previous: owner.id.entry,
      },
    ];
    assert.deepEqual(
      await Promise.all([
        actions.saveEntry(() => edits("first"), "load-1"),
        actions.saveEntry(() => edits("second"), "load-1"),
      ]),
      [
        { status: "conflict", revision: "load-2" },
        { status: "conflict", revision: "load-2" },
      ],
    );
    assert.equal(saves.length, 1);
    assert.deepEqual(errors, []);
  });
  it("a delete queued behind a conflict is a conflict and deletes nothing", async () => {
    const { actions, saves } = setup({ results: [{ kind: "changed" }] });
    await actions.load();
    const flipping = flip(actions, "load-1");
    const removing = deleteGroup(actions, [owner], "md", "load-1");
    await flipping;
    assert.deepEqual(await removing, {
      status: "conflict",
      revision: "load-2",
    });
    assert.equal(saves.length, 1);
  });
  it("a_conflict_leaves_the_dialog_to_its_host", async () => {
    const { actions, events } = setup({ results: [{ kind: "changed" }] });
    await actions.load();
    events.length = 0;
    assert.deepEqual(await deleteGroup(actions, [owner], "md", "load-1"), {
      status: "conflict",
      revision: "load-2",
    });
    assert.deepEqual(
      events,
      ["setTable:load-2"],
      "the reload only replaces the table",
    );
  });
  it("a preview error after Listen is shown on the tab", async () => {
    const { actions, errors, emitPreviewError } = setup();
    actions.watch();
    await new Promise((resolve) => setTimeout(resolve));
    await actions.listen(owner);
    errors.length = 0;
    emitPreviewError("tts.errors.audio");
    emitPreviewError("device exploded");
    assert.deepEqual(errors, [["tts.errors.audio"], ["tts.errors.generic"]]);
  });
  it("stopping the watch unsubscribes from preview errors", async () => {
    const { actions, stopped } = setup();
    const stop = actions.watch();
    await new Promise((resolve) => setTimeout(resolve));
    stop();
    assert.equal(stopped.length, 1);
  });
  it("stopping the watch before it subscribes unsubscribes once it does", async () => {
    const { actions, stopped } = setup();
    actions.watch()();
    await new Promise((resolve) => setTimeout(resolve));
    assert.equal(stopped.length, 1);
  });
  it("a broken file is always listed first, with the last failure after it", () => {
    const changed = { key: "tts.vocabulary.errors.changed" };
    assert.deepEqual(visibleFailures(null, null), []);
    assert.deepEqual(visibleFailures(null, changed), [changed]);
    assert.deepEqual(visibleFailures("bad json", changed), [
      { key: "tts.vocabulary.errors.fileInvalid", message: "bad json" },
      changed,
    ]);
  });
  it("a file error is listed once even when the failure says the same", () => {
    const same = { key: "tts.vocabulary.errors.fileInvalid", message: "old" };
    assert.deepEqual(visibleFailures("new", same), [
      { key: "tts.vocabulary.errors.fileInvalid", message: "new" },
    ]);
  });
  it("edits asked on the old table are dropped when a pending reload resolves", async () => {
    const { actions, saves, errors, releaseLoad } = setup({
      results: [{ kind: "changed" }],
      deferSecondLoad: true,
    });
    await actions.load();
    errors.length = 0;
    const first = flip(actions, "load-1");
    await new Promise((resolve) => setTimeout(resolve));
    const removing = deleteGroup(actions, [owner], "md", "load-1");
    const second = flip(actions, "load-1");
    releaseLoad();
    const [, removed, flipped] = await Promise.all([first, removing, second]);
    assert.deepEqual(removed, { status: "conflict", revision: "load-2" });
    assert.equal(flipped, false);
    assert.equal(saves.length, 1);
    assert.deepEqual(errors, [["tts.vocabulary.errors.changed"]]);
  });
  it("an edit based on a revision this table never had is dropped", async () => {
    const { actions, saves } = setup();
    await actions.load();
    assert.equal(await flip(actions, "load-0"), false);
    assert.deepEqual(await deleteGroup(actions, [owner], "md", "load-0"), {
      status: "conflict",
      revision: "load-1",
    });
    assert.deepEqual(saves, []);
  });
  it("an edit based on a revision an earlier save returned is saved with the latest", async () => {
    const rows = [builtinMd, overriding];
    const { actions, saves } = setup({ rows });
    await actions.load();
    await flip(actions, "load-1");
    assert.deepEqual(await resetGroup(actions, rows, "md", "saved-1"), {
      status: "saved",
    });
    assert.deepEqual(
      saves.map((save) => save.revision),
      ["load-1", "saved-1"],
    );
  });
  it("sets and clears an acronym style with the loaded revision", async () => {
    const { actions, saves } = setup();
    await actions.load();
    await actions.setAcronymStyle("pocket-en", "capitals", "load-1");
    await actions.setAcronymStyle(null, null, "saved-1");
    assert.deepEqual(saves, [
      {
        revision: "load-1",
        edits: [
          { kind: "set_acronym_style", model: "pocket-en", style: "capitals" },
        ],
      },
      {
        revision: "saved-1",
        edits: [{ kind: "set_acronym_style", model: null, style: null }],
      },
    ]);
  });
  it("a table the correction box saved becomes the one edits are based on", async () => {
    const { actions, saves, tables, errors } = setup();
    await actions.load();
    actions.adopt(table("box-1"));
    assert.deepEqual(tables, ["load-1", "box-1"]);
    assert.deepEqual(errors[errors.length - 1], [null]);
    assert.equal(await flip(actions, "load-1"), false);
    await flip(actions, "box-1");
    assert.deepEqual(
      saves.map((save) => save.revision),
      ["box-1"],
    );
  });
  it("speak returns the spoken text and shows a failure on the tab", async () => {
    const ok = setup();
    assert.equal(
      await ok.actions.speak("a.md", "pocket-en"),
      "a.md on pocket-en",
    );
    const bad = setup({ failSpeak: new Error("tts.errors.text") });
    assert.equal(await bad.actions.speak("a.md", "pocket-en"), null);
    assert.deepEqual(bad.errors, [["tts.errors.text"]]);
  });
});

describe("saveEntry", () => {
  const edits: Edit[] = [{ kind: "delete", entry: owner.id.entry }];

  it("conflict_returns_the_reloaded_revision", async () => {
    const { actions, errors, tables } = setup({
      revisions: ["rev-1", "rev-2"],
      results: [{ kind: "changed" }],
    });
    await actions.load();
    errors.length = 0;
    assert.deepEqual(await actions.saveEntry(() => edits, "rev-1"), {
      status: "conflict",
      revision: "rev-2",
    });
    assert.equal(tables[tables.length - 1], "rev-2");
    assert.deepEqual(errors, []);
  });
  it("a_save_based_on_a_replaced_table_is_a_conflict_not_a_drop", async () => {
    const { actions, saves } = setup({ revisions: ["rev-0", "rev-2"] });
    await actions.load();
    await actions.load();
    let planned = 0;
    const result = await actions.saveEntry(() => {
      planned += 1;
      return edits;
    }, "rev-0");
    assert.deepEqual(result, { status: "conflict", revision: "rev-2" });
    assert.equal(planned, 0);
    assert.deepEqual(saves, []);
  });
  it("the_save_after_a_conflict_uses_the_reloaded_revision", async () => {
    const { actions, saves } = setup({
      revisions: ["rev-1", "rev-2"],
      results: [{ kind: "changed" }],
    });
    await actions.load();
    const first = await actions.saveEntry(() => edits, "rev-1");
    assert.equal(first.status, "conflict");
    const seen: string[] = [];
    const second = await actions.saveEntry(
      (latest) => {
        seen.push(latest.revision);
        return edits;
      },
      first.status === "conflict" ? first.revision : "",
    );
    assert.deepEqual(second, { status: "saved" });
    assert.deepEqual(seen, ["rev-2"]);
    assert.deepEqual(
      saves.map((save) => save.revision),
      ["rev-1", "rev-2"],
    );
  });
  it("a_plan_that_no_longer_applies_is_refused", async () => {
    const { actions, saves, errors } = setup();
    await actions.load();
    errors.length = 0;
    assert.deepEqual(await actions.saveEntry(() => "gone", "load-1"), {
      status: "refused",
      reason: "gone",
    });
    assert.deepEqual(saves, []);
    assert.deepEqual(errors, []);
  });
  it("a_failed_save_reports_its_failure", async () => {
    const { actions, errors } = setup({
      results: [{ kind: "invalid_edit", message: "no spaces" }],
    });
    await actions.load();
    errors.length = 0;
    assert.deepEqual(await actions.saveEntry(() => edits, "load-1"), {
      status: "failed",
      failure: {
        key: "tts.vocabulary.errors.invalidEdit",
        message: "no spaces",
      },
    });
    assert.deepEqual(errors, []);
  });
  it("an_empty_plan_is_saved_without_writing", async () => {
    const { actions, saves } = setup();
    await actions.load();
    assert.deepEqual(await actions.saveEntry(() => [], "load-1"), {
      status: "saved",
    });
    assert.deepEqual(saves, []);
  });
  it("a_saved_plan_shows_the_saved_table", async () => {
    const { actions, saves, tables } = setup();
    await actions.load();
    assert.deepEqual(await actions.saveEntry(() => edits, "load-1"), {
      status: "saved",
    });
    assert.deepEqual(saves, [{ revision: "load-1", edits }]);
    assert.equal(tables[tables.length - 1], "saved-1");
  });
  it("a_conflict_whose_reload_fails_reports_the_reload_failure", async () => {
    const { actions, errors } = setup({
      results: [{ kind: "changed" }],
      failLoad: 2,
    });
    await actions.load();
    errors.length = 0;
    assert.deepEqual(await actions.saveEntry(() => edits, "load-1"), {
      status: "failed",
      failure: { key: "tts.errors.localIo" },
    });
    assert.deepEqual(errors, [["tts.errors.localIo"]]);
  });
  it("a_save_before_any_table_fails", async () => {
    const { actions, saves } = setup();
    assert.deepEqual(await actions.saveEntry(() => edits, "load-1"), {
      status: "failed",
      failure: { key: "tts.errors.generic" },
    });
    assert.deepEqual(saves, []);
  });
});
