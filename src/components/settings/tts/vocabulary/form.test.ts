import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  checkText,
  formComplete,
  formSubmission,
  initialForm,
  membersModels,
  membersSubmission,
  scopeChoices,
} from "./form";
import { models, row } from "./fixtures";
const {
  describe,
  it,
}: {
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => void) => void;
} = createRequire(import.meta.url)("bun:test");

describe("entry form", () => {
  it("starts a new entry as a whole-word term for all voices", () => {
    const form = initialForm(null);
    assert.equal(form.section, "term");
    assert.equal(form.matching, "whole");
    assert.equal(form.model, null);
    assert.equal(formComplete(form), false);
  });
  it("loads a term row with its match options", () => {
    const form = initialForm(
      row("owner", "term", "kubectl", {
        spoken: "cube control",
        matching: { term: { matching: "anywhere", case: false } },
        model: "pocket-en",
      }),
    );
    assert.equal(form.matching, "anywhere");
    assert.equal(form.caseSensitive, false);
    assert.equal(form.model, "pocket-en");
  });
  it("a skipped term and an acronym need no spoken text", () => {
    const skip = { ...initialForm(null), written: "ABC-123", skip: true };
    assert.equal(formComplete(skip), true);
    const acronym = {
      ...initialForm(null),
      written: "CLI",
      section: "acronym" as const,
    };
    assert.equal(formComplete(acronym), true);
    assert.equal(formComplete({ ...skip, skip: false }), false);
  });
  it("builds a term rule with match options, or a skip", () => {
    const form = {
      ...initialForm(null),
      written: " kubectl ",
      spoken: " cube control ",
    };
    assert.deepEqual(formSubmission(form, null), {
      entry: { section: "term", model: null, key: "kubectl" },
      rule: { say: "cube control", matching: "whole", case: true },
      previous: null,
    });
    assert.equal(formSubmission({ ...form, skip: true }, null).rule.say, null);
  });
  it("builds a plain say for an extension", () => {
    const form = {
      ...initialForm(null),
      section: "extension" as const,
      written: "md",
      spoken: "M D",
    };
    assert.deepEqual(formSubmission(form, null).rule, {
      say: "M D",
      matching: null,
      case: null,
    });
  });
  it("renames an owner row but never replaces a built-in key", () => {
    const owner = row("owner", "extension", "md", { spoken: "M D" });
    const builtin = row("builtin", "extension", "md", { spoken: "markdown" });
    assert.deepEqual(
      formSubmission(initialForm(owner), owner).previous,
      owner.id.entry,
    );
    assert.equal(formSubmission(initialForm(builtin), builtin).previous, null);
  });
  it("offers downloaded models and the row's own model", () => {
    assert.deepEqual(scopeChoices(models, null), ["pocket-en"]);
    assert.deepEqual(scopeChoices(models, "supertonic-3"), [
      "pocket-en",
      "supertonic-3",
    ]);
    assert.deepEqual(scopeChoices(models, "phonon-x"), [
      "pocket-en",
      "phonon-x",
    ]);
  });
});

describe("checkText", () => {
  it("checks the spoken text, an acronym's letters and nothing for a skip", () => {
    const form = initialForm(null);
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
  it("saves an edited row at every member's voice, replacing each owner member's key", () => {
    const pocket = row("owner", "term", "kubectl", {
      spoken: "cube control",
      model: "pocket-en",
    });
    const supertonic = row("builtin", "term", "kubectl", {
      spoken: "cube control",
      model: "supertonic-3",
    });
    const form = {
      ...initialForm(pocket),
      written: "kubectl2",
      spoken: "cube two",
    };
    assert.deepEqual(membersSubmission(form, [pocket, supertonic]), {
      entries: [
        { section: "term", model: "pocket-en", key: "kubectl2" },
        { section: "term", model: "supertonic-3", key: "kubectl2" },
      ],
      rule: { say: "cube two", matching: "whole", case: true },
      previous: [pocket.id.entry, null],
    });
  });
  it("checks the voices the members name, or every downloaded voice for an all-voices member", () => {
    const named = [
      row("owner", "term", "k", { model: "supertonic-3" }),
      row("owner", "term", "k", { model: "pocket-en" }),
      row("owner", "term", "k", { model: "pocket-en" }),
    ];
    assert.deepEqual(membersModels(named, models), [
      "supertonic-3",
      "pocket-en",
    ]);
    assert.deepEqual(
      membersModels([...named, row("owner", "term", "k")], models),
      ["pocket-en"],
    );
  });
});
