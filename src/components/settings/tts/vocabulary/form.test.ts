import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { EntryRow } from "@/bindings";
import { entryEdits } from "./entryPlan";
import {
  appliesToChoices,
  checkText,
  entryDraft,
  formComplete,
  initialForm,
} from "./form";
import { models, row } from "./fixtures";
import { groupRows } from "./groups";
const {
  describe,
  it,
}: {
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => void) => void;
} = createRequire(import.meta.url)("bun:test");

const IDS = models.map((model) => model.id);
const only = (rows: EntryRow[]) => {
  const groups = groupRows(rows, IDS);
  assert.equal(groups.length, 1);
  return groups[0];
};

describe("entry form", () => {
  it("starts a new entry as a whole-word term for all voices", () => {
    const form = initialForm(null, IDS);
    assert.equal(form.section, "term");
    assert.equal(form.matching, "whole");
    assert.equal(form.caseSensitive, true);
    assert.deepEqual(form.scopes, [null]);
    assert.equal(formComplete(form), false);
  });
  it("initial_form_reads_the_group_and_its_scopes", () => {
    const kubectl = (model: string) =>
      row("owner", "term", "kubectl", {
        spoken: "cube control",
        matching: { term: { matching: "anywhere", case: false } },
        model,
      });
    const form = initialForm(
      only([kubectl("gone-model"), kubectl("pocket-en")]),
      IDS,
    );
    assert.deepEqual(form, {
      written: "kubectl",
      section: "term",
      spoken: "cube control",
      skip: false,
      matching: "anywhere",
      caseSensitive: false,
      scopes: ["pocket-en", "gone-model"],
    });
  });
  it("a skipped term and an acronym need no spoken text", () => {
    const skip = { ...initialForm(null, IDS), written: "ABC-123", skip: true };
    assert.equal(formComplete(skip), true);
    const acronym = {
      ...initialForm(null, IDS),
      written: "CLI",
      section: "acronym" as const,
    };
    assert.equal(formComplete(acronym), true);
    assert.equal(formComplete({ ...skip, skip: false }), false);
  });
  it("entry_draft_carries_reading_and_scopes", () => {
    const form = {
      ...initialForm(null, IDS),
      written: " kubectl ",
      spoken: " cube control ",
      scopes: ["pocket-en", "gone-model"],
    };
    assert.deepEqual(entryDraft(form, ["pocket-en"]), {
      section: "term",
      written: "kubectl",
      rule: { say: "cube control", matching: "whole", case: true },
      scopes: ["pocket-en", "gone-model"],
      opened: ["pocket-en"],
    });
    assert.equal(entryDraft({ ...form, skip: true }, []).rule.say, null);
    const extension = {
      ...initialForm(null, IDS),
      section: "extension" as const,
      written: "md",
      spoken: "M D",
    };
    assert.deepEqual(entryDraft(extension, []).rule, {
      say: "M D",
      matching: null,
      case: null,
    });
    const acronym = { ...extension, section: "acronym" as const, spoken: "x" };
    assert.equal(entryDraft(acronym, []).rule.say, null);
  });
  it("entry_draft_renames_your_entry_but_never_replaces_a_built_in_key", () => {
    const owner = row("owner", "extension", "md", { spoken: "M D" });
    const builtin = row("builtin", "extension", "md", { spoken: "markdown" });
    const save = (target: EntryRow) => {
      const group = only([target]);
      const form = { ...initialForm(group, IDS), spoken: "em dee" };
      return entryEdits(
        [target],
        IDS,
        group.key,
        entryDraft(form, form.scopes),
      );
    };
    const rule = { say: "em dee", matching: null, case: null };
    const entry = { section: "extension" as const, model: null, key: "md" };
    assert.deepEqual(save(owner), [
      { kind: "put", entry, rule, previous: owner.id.entry },
    ]);
    assert.deepEqual(save(builtin), [
      { kind: "put", entry, rule, previous: null },
    ]);
  });
  it("applies_to_choices_add_absent_scopes", () => {
    assert.deepEqual(appliesToChoices(models, []), ["pocket-en"]);
    assert.deepEqual(appliesToChoices(models, [null]), ["pocket-en"]);
    assert.deepEqual(
      appliesToChoices(models, ["supertonic-3", "pocket-en", "gone-model"]),
      ["pocket-en", "supertonic-3", "gone-model"],
    );
  });
});

describe("checkText", () => {
  it("checks the spoken text, an acronym's letters and nothing for a skip", () => {
    const form = initialForm(null, IDS);
    assert.equal(
      checkText({ ...form, spoken: " cube control " }),
      "cube control",
    );
    assert.equal(
      checkText({ ...form, section: "acronym", written: "ZFS", spoken: "" }),
      "Z F S",
    );
    assert.equal(checkText({ ...form, skip: true, spoken: "x" }), "");
  });
});
