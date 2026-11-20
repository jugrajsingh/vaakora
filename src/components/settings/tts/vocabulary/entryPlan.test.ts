import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { Edit, EntryRow, Rule } from "@/bindings";
import {
  deletePlan,
  entryEdits,
  resetPlan,
  toggleScope,
  type EntryDraft,
} from "./entryPlan";
import { models, row } from "./fixtures";
import { groupRows, voicesPlan, type RowGroup } from "./groups";
const {
  describe,
  it,
}: {
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => void) => void;
} = createRequire(import.meta.url)("bun:test");

const IDS = models.map((model) => model.id);
const say = (spoken: string): Rule => ({
  say: spoken,
  matching: "whole",
  case: true,
});
const plain = (spoken: string | null): Rule => ({
  say: spoken,
  matching: null,
  case: null,
});
const kubectl = (
  model: string | null,
  spoken = "kube control",
  patch: Partial<EntryRow> = {},
) => row("owner", "term", "kubectl", { model, spoken, ...patch });
const draft = (patch: Partial<EntryDraft> = {}): EntryDraft => ({
  section: "term",
  written: "kubectl",
  rule: say("kube control"),
  scopes: [null],
  opened: [],
  ...patch,
});
const put = (
  model: string | null,
  rule: Rule,
  previous: EntryRow | null = null,
  key = "kubectl",
): Edit => ({
  kind: "put",
  entry: { section: "term", model, key },
  rule,
  previous: previous?.id.entry ?? null,
});
const keyOf = (rows: EntryRow[], pick: (group: RowGroup) => boolean) => {
  const found = groupRows(rows, IDS).find(pick);
  assert.ok(found, JSON.stringify(rows.map((r) => r.id)));
  return found.key;
};
const ofOrigin = (origin: "owner" | "builtin") => (group: RowGroup) =>
  group.origin === origin;

describe("toggleScope", () => {
  it("toggle_scope_keeps_all_models_exclusive", () => {
    assert.deepEqual(toggleScope([null], "pocket-en"), ["pocket-en"]);
    assert.deepEqual(toggleScope(["pocket-en"], null), [null]);
    assert.deepEqual(toggleScope(["pocket-en", "kokoro"], "kokoro"), [
      "pocket-en",
    ]);
    assert.deepEqual(toggleScope(["pocket-en"], "kokoro"), [
      "pocket-en",
      "kokoro",
    ]);
    assert.deepEqual(toggleScope([null], null), []);
  });
});

describe("entryEdits", () => {
  it("new_entry_puts_one_entry_per_scope", () => {
    const rule = say("kube control");
    assert.deepEqual(entryEdits([], IDS, null, draft({ scopes: [null] })), [
      put(null, rule),
    ]);
    assert.deepEqual(
      entryEdits([], IDS, null, draft({ scopes: ["pocket-en", "kokoro"] })),
      [put("pocket-en", rule), put("kokoro", rule)],
    );
  });
  it("new_entry_refuses_a_scope_your_entry_holds", () => {
    const rows = [kubectl("pocket-en", "cube control")];
    assert.equal(
      entryEdits(
        rows,
        IDS,
        null,
        draft({ scopes: ["supertonic-3", "pocket-en"] }),
      ),
      "taken",
    );
    assert.deepEqual(
      entryEdits(rows, IDS, null, draft({ scopes: ["supertonic-3"] })),
      [put("supertonic-3", say("kube control"))],
    );
    const md = [row("owner", "extension", "md", { spoken: "M D" })];
    assert.equal(
      entryEdits(
        md,
        IDS,
        null,
        draft({ section: "extension", written: ".MD", rule: plain("mark") }),
      ),
      "taken",
    );
  });
  it("owner_edit_moves_scopes_and_renames_in_place", () => {
    const pocket = kubectl("pocket-en");
    const kokoro = kubectl("kokoro");
    const rows = [pocket, kokoro];
    const rule = say("kube control");
    assert.deepEqual(
      entryEdits(
        rows,
        IDS,
        keyOf(rows, ofOrigin("owner")),
        draft({
          written: "kubectl2",
          scopes: ["pocket-en", "supertonic-3"],
          opened: ["pocket-en", "kokoro"],
        }),
      ),
      [
        put("pocket-en", rule, pocket, "kubectl2"),
        put("supertonic-3", rule, null, "kubectl2"),
        { kind: "delete", entry: kokoro.id.entry },
      ],
    );
  });
  it("owner_edit_refuses_a_scope_another_owner_entry_holds", () => {
    const rows = [
      kubectl("pocket-en", "kube control"),
      kubectl("supertonic-3", "cube control"),
    ];
    assert.equal(
      entryEdits(
        rows,
        IDS,
        keyOf(rows, (group) => group.spoken === "kube control"),
        draft({
          scopes: ["pocket-en", "supertonic-3"],
          opened: ["pocket-en"],
        }),
      ),
      "taken",
    );
  });
  it("a_scope_added_on_disk_after_open_is_kept", () => {
    const pocket = kubectl("pocket-en");
    const kokoro = kubectl("kokoro");
    const rows = [pocket, kokoro, kubectl("supertonic-3")];
    const key = keyOf(rows, ofOrigin("owner"));
    const opened = ["pocket-en", "kokoro"];
    assert.deepEqual(
      entryEdits(rows, IDS, key, draft({ scopes: ["pocket-en"], opened })),
      [
        put("pocket-en", say("kube control"), pocket),
        { kind: "delete", entry: kokoro.id.entry },
      ],
    );
    assert.deepEqual(
      entryEdits(rows, IDS, key, draft({ scopes: opened, opened })),
      [],
    );
    const llm = ["pocket-en", "supertonic-3", "kokoro"].map((model) =>
      row("builtin", "acronym", "LLM", { model }),
    );
    assert.deepEqual(
      entryEdits(
        llm,
        IDS,
        keyOf(llm, ofOrigin("builtin")),
        draft({
          section: "acronym",
          written: "LLM",
          rule: plain(null),
          scopes: ["pocket-en"],
          opened: ["pocket-en", "supertonic-3"],
        }),
      ),
      [{ kind: "set_enabled", id: llm[1].id, enabled: false }],
    );
  });
  it("unchanged_entry_saves_nothing", () => {
    const rows = [kubectl("pocket-en"), kubectl("kokoro")];
    assert.deepEqual(
      entryEdits(
        rows,
        IDS,
        keyOf(rows, ofOrigin("owner")),
        draft({
          scopes: ["kokoro", "pocket-en"],
          opened: ["pocket-en", "kokoro"],
        }),
      ),
      [],
    );
    const llm = [row("builtin", "acronym", "LLM", { model: "pocket-en" })];
    assert.deepEqual(
      entryEdits(
        llm,
        IDS,
        keyOf(llm, ofOrigin("builtin")),
        draft({
          section: "acronym",
          written: "LLM",
          rule: plain(null),
          scopes: ["pocket-en"],
          opened: ["pocket-en"],
        }),
      ),
      [],
    );
  });
  it("builtin_scope_change_uses_the_switch_plan", () => {
    const rows = ["pocket-en", "supertonic-3"].map((model) =>
      row("builtin", "acronym", "LLM", { model }),
    );
    const groups = groupRows(rows, IDS);
    const planned = entryEdits(
      rows,
      IDS,
      groups[0].key,
      draft({
        section: "acronym",
        written: "LLM",
        rule: plain(null),
        scopes: ["pocket-en"],
        opened: ["pocket-en", "supertonic-3"],
      }),
    );
    assert.deepEqual(
      planned,
      voicesPlan(groups[0], { models: ["pocket-en"] }, groups, IDS),
    );
    assert.deepEqual(planned, [
      { kind: "set_enabled", id: rows[1].id, enabled: false },
    ]);
  });
  it("builtin_scope_change_no_switch_can_make_is_refused", () => {
    const rows = [row("builtin", "symbol", "/", { spoken: "slash" })];
    assert.equal(
      entryEdits(
        rows,
        IDS,
        keyOf(rows, ofOrigin("builtin")),
        draft({
          section: "symbol",
          written: "/",
          rule: plain("slash"),
          scopes: ["pocket-en"],
          opened: [null],
        }),
      ),
      "builtin-scope",
    );
  });
  it("builtin_reading_change_saves_your_entry_at_each_scope", () => {
    const rows = ["pocket-en", "supertonic-3"].map((model) =>
      row("builtin", "symbol", "/", { model, spoken: "slash" }),
    );
    const symbol = (model: string): Edit => ({
      kind: "put",
      entry: { section: "symbol", model, key: "/" },
      rule: plain("stroke"),
      previous: null,
    });
    const edit = (scopes: string[]) =>
      entryEdits(
        rows,
        IDS,
        keyOf(rows, ofOrigin("builtin")),
        draft({
          section: "symbol",
          written: "/",
          rule: plain("stroke"),
          scopes,
          opened: ["pocket-en", "supertonic-3"],
        }),
      );
    assert.deepEqual(edit(["pocket-en", "supertonic-3"]), [
      symbol("pocket-en"),
      symbol("supertonic-3"),
    ]);
    assert.deepEqual(edit(["pocket-en"]), [symbol("pocket-en")]);
  });
  it("builtin_reading_change_refuses_a_scope_your_entry_holds", () => {
    const rows = [
      row("builtin", "term", "kubectl", {
        model: "pocket-en",
        spoken: "kubectl",
      }),
      kubectl("supertonic-3", "cube control"),
    ];
    const edit = (scopes: string[]) =>
      entryEdits(
        rows,
        IDS,
        keyOf(rows, ofOrigin("builtin")),
        draft({ scopes, opened: ["pocket-en"] }),
      );
    assert.equal(edit(["pocket-en", "supertonic-3"]), "taken");
    assert.deepEqual(edit(["pocket-en"]), [
      put("pocket-en", say("kube control")),
    ]);
  });
  it("gone_entry_and_empty_scopes_are_refused", () => {
    const rows = [kubectl("pocket-en")];
    assert.equal(
      entryEdits(rows, IDS, "no such row", draft({ scopes: ["pocket-en"] })),
      "gone",
    );
    assert.equal(
      entryEdits(
        rows,
        IDS,
        keyOf(rows, ofOrigin("owner")),
        draft({ scopes: [], opened: ["pocket-en"] }),
      ),
      "empty",
    );
    assert.equal(entryEdits(rows, IDS, null, draft({ scopes: [] })), "empty");
  });
});

describe("deletePlan and resetPlan", () => {
  const md = (origin: "owner" | "builtin", model: string | null) =>
    row(origin, "extension", "md", {
      model,
      spoken: origin === "owner" ? "M D" : "markdown",
      replaces_builtin: origin === "owner" && model !== "kokoro",
    });
  const rows = [
    md("builtin", null),
    md("builtin", "pocket-en"),
    md("builtin", "supertonic-3"),
    md("owner", "pocket-en"),
    md("owner", "supertonic-3"),
    md("owner", "kokoro"),
  ];
  const yours = keyOf(rows, ofOrigin("owner"));
  const opened = ["pocket-en", "kokoro"];

  it("delete_plan_deletes_only_the_opened_entries_of_yours", () => {
    assert.deepEqual(deletePlan(rows, IDS, yours, opened), [
      { kind: "delete", entry: rows[3].id.entry },
      { kind: "delete", entry: rows[5].id.entry },
    ]);
    assert.equal(deletePlan(rows, IDS, "no such row", opened), "gone");
    assert.equal(
      deletePlan(rows, IDS, keyOf(rows, ofOrigin("builtin")), [null]),
      "gone",
    );
  });
  it("reset_plan_resets_only_the_opened_overrides", () => {
    assert.deepEqual(resetPlan(rows, IDS, yours, opened), [
      { kind: "reset", entry: rows[3].id.entry },
    ]);
    assert.equal(resetPlan(rows, IDS, yours, ["kokoro"]), "gone");
    assert.equal(resetPlan(rows, IDS, "no such row", opened), "gone");
  });
});
