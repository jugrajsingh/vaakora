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
import { row } from "./fixtures";
import { groupRows, voiceChangePlan } from "./groups";
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
const table = (revision: string): VocabularyTable => ({
  revision,
  path: "tts-vocabulary.json",
  file_error: null,
  rows: [owner],
  acronym_styles: [],
});

function setup(
  options: {
    confirm?: boolean | Promise<boolean>;
    onConfirm?: (row: EntryRow) => void;
    results?: (VocabularyTable | SaveError)[];
    failListen?: Error;
    failSpeak?: Error;
    deferSecondLoad?: boolean;
  } = {},
) {
  const saves: { revision: string; edits: Edit[] }[] = [];
  const errors: [string | null, string?][] = [];
  const tables: string[] = [];
  const listens: [ListenText, string | null][] = [];
  const discards: string[] = [];
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
      return table(`load-${n}`);
    },
    save: async (revision, edits) => {
      saves.push({ revision, edits });
      return results.shift() ?? table(`saved-${saves.length}`);
    },
    listen: async (text, model) => {
      listens.push([text, model]);
      if (options.failListen) throw options.failListen;
    },
    speak: async (written, model) => {
      if (options.failSpeak) throw options.failSpeak;
      return `${written} on ${model}`;
    },
    confirmDelete: async (target) => {
      options.onConfirm?.(target);
      return options.confirm ?? true;
    },
    setTable: (next) => {
      tables.push(next.revision);
      events.push(`setTable:${next.revision}`);
    },
    setError: (...args) => errors.push(args),
    discard: () => {
      discards.push("discard");
      events.push("discard");
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
    discards,
    events,
    releaseLoad: () => releaseLoad(),
    stopped,
    emitPreviewError: (message: string) =>
      previewListeners.forEach((listener) => listener(message)),
    loads: () => loads,
  };
}

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
    const { actions, saves } = setup();
    await actions.load();
    await Promise.all([
      flip(actions, "load-1"),
      actions.reset([owner], "load-1"),
    ]);
    assert.deepEqual(
      saves.map((save) => save.revision),
      ["load-1", "saved-1"],
    );
  });
  it("remove deletes the owner entry after confirmation", async () => {
    const { actions, saves } = setup();
    await actions.load();
    await actions.remove([owner], "load-1");
    assert.deepEqual(saves[0].edits, [
      { kind: "delete", entry: owner.id.entry },
    ]);
  });
  it("remove sends nothing when the owner declines", async () => {
    const { actions, saves } = setup({ confirm: false });
    await actions.load();
    assert.equal(await actions.remove([owner], "load-1"), false);
    assert.deepEqual(saves, []);
  });
  it("remove never deletes a built-in row", async () => {
    const { actions, saves } = setup();
    await actions.load();
    await actions.remove([row("builtin", "extension", "json")], "load-1");
    assert.deepEqual(saves, []);
  });
  it("reset sends reset for the row's entry", async () => {
    const { actions, saves } = setup();
    await actions.load();
    await actions.reset([owner], "load-1");
    assert.deepEqual(saves[0].edits, [
      { kind: "reset", entry: owner.id.entry },
    ]);
  });
  it("put sends the entry, rule and previous key and reports it finished", async () => {
    const { actions, saves, tables } = setup();
    await actions.load();
    const rule = { say: "M D", matching: null, case: null };
    assert.equal(await actions.put([owner.id.entry], rule, [], "load-1"), true);
    assert.deepEqual(saves[0].edits, [
      { kind: "put", entry: owner.id.entry, rule, previous: null },
    ]);
    assert.equal(tables[tables.length - 1], "saved-1");
  });
  it("put saves one rule for several voices in one save, renaming only the first", async () => {
    const { actions, saves } = setup();
    await actions.load();
    const rule = { say: "M D", matching: null, case: null };
    const pocket = { ...owner.id.entry, model: "pocket-en" };
    const supertonic = { ...owner.id.entry, model: "supertonic-3" };
    assert.equal(
      await actions.put([pocket, supertonic], rule, [owner.id.entry], "load-1"),
      true,
    );
    assert.equal(saves.length, 1);
    assert.deepEqual(saves[0].edits, [
      { kind: "put", entry: pocket, rule, previous: owner.id.entry },
      { kind: "put", entry: supertonic, rule, previous: null },
    ]);
  });
  it("remove deletes every owner row of a grouped row after one confirmation", async () => {
    const confirmed: string[] = [];
    const { actions, saves } = setup({
      onConfirm: (row) => confirmed.push(row.id.entry.key),
    });
    const pocket = row("owner", "term", "kubectl", { model: "pocket-en" });
    const phonon = row("owner", "term", "kubectl", { model: "phonon" });
    await actions.load();
    await actions.remove([pocket, phonon], "load-1");
    assert.deepEqual(confirmed, ["kubectl"]);
    assert.deepEqual(saves[0].edits, [
      { kind: "delete", entry: pocket.id.entry },
      { kind: "delete", entry: phonon.id.entry },
    ]);
  });
  it("reset puts back the built-in default of every row of a grouped row in one save", async () => {
    const { actions, saves } = setup();
    await actions.load();
    const pocket = row("owner", "extension", "md", { model: "pocket-en" });
    const phonon = row("owner", "extension", "md", { model: "phonon" });
    await actions.reset([pocket, phonon], "load-1");
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
  it("a second voice change queued behind a first that takes the same voice is refused, keeping the first entry", async () => {
    const kubectl = (model: string, spoken: string) =>
      row("owner", "term", "kubectl", { model, spoken });
    let store = [
      kubectl("pocket-en", "cube control"),
      kubectl("phonon", "kube control"),
    ];
    const saved: Edit[][] = [];
    const errors: (string | null)[] = [];
    let release: () => void = () => {};
    const firstSave = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tableOf = (revision: string): VocabularyTable => ({
      revision,
      path: "tts-vocabulary.json",
      file_error: null,
      rows: store,
      acronym_styles: [],
    });
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
      confirmDelete: async () => true,
      setTable: () => {},
      setError: (key) => errors.push(key),
      discard: () => {},
      onPreviewError: async () => () => {},
    });
    await actions.load();
    const keyOf = (spoken: string) => {
      const found = groupRows(store, CATALOG).find((g) => g.spoken === spoken);
      assert.ok(found, spoken);
      return found.key;
    };
    const cube = keyOf("cube control");
    const kube = keyOf("kube control");
    const addSupertonic = (groupKey: string) =>
      actions.applyPlan(
        (latest) =>
          voiceChangePlan(
            latest.rows,
            CATALOG,
            groupKey,
            "supertonic-3",
            false,
          ),
        "load-1",
      );
    const first = addSupertonic(cube);
    const second = addSupertonic(kube);
    release();
    assert.deepEqual(await Promise.all([first, second]), [true, false]);
    assert.equal(saved.length, 1);
    const at = (model: string) =>
      store.find((r) => r.id.entry.model === model)?.spoken;
    assert.equal(at("supertonic-3"), "cube control");
    assert.equal(at("phonon"), "kube control");
    assert.equal(
      errors[errors.length - 1],
      "tts.vocabulary.errors.voicesChanged",
    );
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
  it("an invalid edit keeps the editor open with the reason", async () => {
    const { actions, errors } = setup({
      results: [{ kind: "invalid_edit", message: "no spaces" }],
    });
    await actions.load();
    errors.length = 0;
    const rule = { say: "x", matching: null, case: null };
    assert.equal(
      await actions.put([owner.id.entry], rule, [], "load-1"),
      false,
    );
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
  it("a second put queued behind a conflict is dropped, not saved on the reloaded revision", async () => {
    const { actions, saves, errors } = setup({
      results: [{ kind: "changed" }],
    });
    await actions.load();
    errors.length = 0;
    const first = { say: "first", matching: null, case: null };
    const second = { say: "second", matching: null, case: null };
    await Promise.all([
      actions.put([owner.id.entry], first, [], "load-1"),
      actions.put([owner.id.entry], second, [], "load-1"),
    ]);
    assert.equal(saves.length, 1);
    assert.deepEqual(errors, [["tts.vocabulary.errors.changed"]]);
  });
  it("a delete confirmed after a conflict is dropped", async () => {
    let answer: (yes: boolean) => void = () => {};
    const { actions, saves } = setup({
      confirm: new Promise<boolean>((resolve) => {
        answer = resolve;
      }),
      results: [{ kind: "changed" }],
    });
    await actions.load();
    const removing = actions.remove([owner], "load-1");
    await flip(actions, "load-1");
    answer(true);
    assert.equal(await removing, false);
    assert.equal(saves.length, 1);
  });
  it("a conflict discards the open draft", async () => {
    const { actions, discards } = setup({ results: [{ kind: "changed" }] });
    await actions.load();
    discards.length = 0;
    await flip(actions, "load-1");
    assert.equal(discards.length, 1);
  });
  it("a file with an error discards the open draft", async () => {
    const { actions, discards } = setup({
      results: [{ kind: "file_invalid", message: "bad json" }],
    });
    await actions.load();
    discards.length = 0;
    await flip(actions, "load-1");
    assert.equal(discards.length, 1);
  });
  it("a saved edit and an invalid edit keep the open draft", async () => {
    const { actions, discards } = setup({
      results: [{ kind: "invalid_edit", message: "no spaces" }],
    });
    await actions.load();
    discards.length = 0;
    await flip(actions, "load-1");
    await flip(actions, "load-1");
    assert.equal(discards.length, 0);
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
    let answer: (yes: boolean) => void = () => {};
    const { actions, saves, errors, releaseLoad } = setup({
      confirm: new Promise<boolean>((resolve) => {
        answer = resolve;
      }),
      results: [{ kind: "changed" }],
      deferSecondLoad: true,
    });
    await actions.load();
    errors.length = 0;
    const first = flip(actions, "load-1");
    await new Promise((resolve) => setTimeout(resolve));
    const removing = actions.remove([owner], "load-1");
    const second = flip(actions, "load-1");
    releaseLoad();
    answer(true);
    await Promise.all([first, removing, second]);
    assert.equal(saves.length, 1);
    assert.deepEqual(errors, [["tts.vocabulary.errors.changed"]]);
  });
  it("an edit based on a revision this table never had is dropped", async () => {
    const { actions, saves } = setup();
    await actions.load();
    assert.equal(await flip(actions, "load-0"), false);
    assert.deepEqual(saves, []);
  });
  it("an edit based on a revision an earlier save returned is saved with the latest", async () => {
    const { actions, saves } = setup();
    await actions.load();
    await flip(actions, "load-1");
    await actions.reset([owner], "saved-1");
    assert.deepEqual(
      saves.map((save) => save.revision),
      ["load-1", "saved-1"],
    );
  });
  it("the draft is discarded after the reloaded table is shown", async () => {
    const { actions, events } = setup({ results: [{ kind: "changed" }] });
    await actions.load();
    events.length = 0;
    await flip(actions, "load-1");
    assert.deepEqual(events, ["setTable:load-2", "discard"]);
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
