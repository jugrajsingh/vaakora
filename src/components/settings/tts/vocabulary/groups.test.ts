import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { Edit, EntryRow } from "@/bindings";
import { row } from "./fixtures";
import { filterGroups, NO_FILTERS, type Filters } from "./filter";
import {
  groupRows,
  switchPlan,
  switchPlanFor,
  voiceChangePlan,
  voiceOptions,
  voicesPlan,
  type RowGroup,
  type VoiceTarget,
} from "./groups";
const {
  describe,
  it,
}: {
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => void) => void;
} = createRequire(import.meta.url)("bun:test");

const CATALOG = ["phonon", "pocket-en", "supertonic-3", "indic-hi", "indic-pa"];
const group = (rows: EntryRow[]) => groupRows(rows, CATALOG);
const only = (rows: EntryRow[]) => {
  const groups = group(rows);
  assert.equal(groups.length, 1, JSON.stringify(groups.map((g) => g.key)));
  return groups[0];
};
const voicesOf = (g: RowGroup) => ({ all: g.all, models: g.models });

const llm = (model: string, patch: Partial<EntryRow> = {}) =>
  row("builtin", "acronym", "LLM", { model, ...patch });
const term = (
  origin: "owner" | "builtin",
  model: string | null,
  spoken: string,
  patch: Partial<EntryRow> = {},
) => row(origin, "term", "kubectl", { model, spoken, ...patch });

describe("groupRows", () => {
  it("shows an acronym on three voices as one row listing the voices in catalog order", () => {
    const g = only([llm("supertonic-3"), llm("phonon"), llm("pocket-en")]);
    assert.deepEqual(voicesOf(g), {
      all: false,
      models: ["phonon", "pocket-en", "supertonic-3"],
    });
    assert.equal(g.members.length, 3);
    assert.equal(g.written, "LLM");
  });

  it("shows / as three rows because Hindi and Punjabi say it differently", () => {
    const groups = group([
      row("builtin", "symbol", "/", { spoken: "slash" }),
      row("builtin", "symbol", "/", { spoken: "स्लैश", model: "indic-hi" }),
      row("builtin", "symbol", "/", { spoken: "ਸਲੈਸ਼", model: "indic-pa" }),
    ]);
    assert.equal(groups.length, 3);
    const byWords = Object.fromEntries(groups.map((g) => [g.spoken, g]));
    assert.deepEqual(voicesOf(byWords["slash"]), { all: true, models: [] });
    assert.deepEqual(byWords["slash"].except, ["indic-hi", "indic-pa"]);
    assert.deepEqual(voicesOf(byWords["स्लैश"]), {
      all: false,
      models: ["indic-hi"],
    });
    assert.deepEqual(voicesOf(byWords["ਸਲੈਸ਼"]), {
      all: false,
      models: ["indic-pa"],
    });
  });

  it("merges the owner's entry and the built-in it overrides into one row with the default", () => {
    const builtin = row("builtin", "extension", "md", {
      spoken: "markdown",
      problems: [{ shadowed: { by: row("owner", "extension", "md").id } }],
    });
    const mine = row("owner", "extension", "md", {
      spoken: "M D",
      replaces_builtin: true,
    });
    const g = only([builtin, mine]);
    assert.equal(g.origin, "owner");
    assert.equal(g.spoken, "M D");
    assert.deepEqual(g.defaults, [
      { spoken: "markdown", skip: false, models: [null] },
    ]);
    assert.deepEqual(g.overriding, [mine]);
    assert.deepEqual(g.members, [mine]);
    assert.deepEqual(g.replaced, [builtin]);
    assert.deepEqual(g.problems, []);
    assert.equal(g.changed, true);
  });

  it("keeps a built-in row shadowed from another scope as its own row with the warning", () => {
    const shadowed = { shadowed: { by: row("owner", "extension", "md").id } };
    const groups = group([
      row("owner", "extension", "md", { spoken: "M D" }),
      row("builtin", "extension", "md", {
        spoken: "markdown",
        model: "pocket-en",
        problems: [shadowed],
      }),
    ]);
    assert.equal(groups.length, 2);
    const builtin = groups.find((g) => g.origin === "builtin");
    assert.deepEqual(builtin?.problems, [shadowed]);
    assert.equal(builtin?.changed, true);
    assert.deepEqual(groups.find((g) => g.origin === "owner")?.defaults, []);
  });

  it("never merges rows that differ in kind, words, match options, source or switch", () => {
    const separate = (a: EntryRow, b: EntryRow) =>
      assert.equal(group([a, b]).length, 2);
    const base = () => term("owner", "pocket-en", "cube control");
    separate(base(), term("owner", "supertonic-3", "cube control kay"));
    separate(
      base(),
      term("owner", "supertonic-3", "cube control", {
        matching: { term: { matching: "whole", case: false } },
      }),
    );
    separate(
      base(),
      term("owner", "supertonic-3", "cube control", {
        matching: { term: { matching: "anywhere", case: true } },
      }),
    );
    separate(base(), term("builtin", "supertonic-3", "cube control"));
    separate(
      base(),
      term("owner", "supertonic-3", "cube control", { enabled: false }),
    );
    separate(
      base(),
      term("owner", "supertonic-3", "cube control", { skip: true }),
    );
    separate(
      base(),
      row("owner", "symbol", "kubectl", {
        model: "supertonic-3",
        spoken: "cube control",
      }),
    );
  });

  it("shows owner rows that read the same as one row even when only some override a built-in", () => {
    const pocket = row("owner", "extension", "md", {
      model: "pocket-en",
      spoken: "M D",
      replaces_builtin: true,
    });
    const supertonic = row("owner", "extension", "md", {
      model: "supertonic-3",
      spoken: "M D",
    });
    const g = only([
      row("builtin", "extension", "md", {
        model: "pocket-en",
        spoken: "markdown",
      }),
      pocket,
      supertonic,
    ]);
    assert.deepEqual(g.models, ["pocket-en", "supertonic-3"]);
    assert.deepEqual(g.members, [pocket, supertonic]);
    assert.deepEqual(g.overriding, [pocket]);
    assert.deepEqual(g.defaults, [
      { spoken: "markdown", skip: false, models: ["pocket-en"] },
    ]);
    assert.equal(g.changed, true);
  });

  it("lists each different built-in default with the voices it belongs to", () => {
    const rows = [
      ["pocket-en", "markdown"],
      ["supertonic-3", "mark down"],
      ["phonon", "markdown"],
    ].flatMap(([model, spoken]) => [
      row("builtin", "extension", "md", { model, spoken }),
      row("owner", "extension", "md", {
        model,
        spoken: "M D",
        replaces_builtin: true,
      }),
    ]);
    const g = only(rows);
    assert.deepEqual(g.defaults, [
      { spoken: "markdown", skip: false, models: ["phonon", "pocket-en"] },
      { spoken: "mark down", skip: false, models: ["supertonic-3"] },
    ]);
    assert.equal(g.overriding.length, 3);
  });

  it("merges owner rows on several voices that replace the same default", () => {
    const rows = ["pocket-en", "supertonic-3"].flatMap((model) => [
      row("builtin", "extension", "md", { model, spoken: "markdown" }),
      row("owner", "extension", "md", {
        model,
        spoken: "M D",
        replaces_builtin: true,
      }),
    ]);
    const g = only(rows);
    assert.deepEqual(g.models, ["pocket-en", "supertonic-3"]);
    assert.equal(g.members.length, 2);
    assert.equal(g.replaced.length, 2);
    assert.deepEqual(g.defaults, [
      {
        spoken: "markdown",
        skip: false,
        models: ["pocket-en", "supertonic-3"],
      },
    ]);
  });

  it("lists each problem once", () => {
    const g = only([
      llm("phonon", { enabled: false, problems: ["disabled"] }),
      llm("pocket-en", { enabled: false, problems: ["disabled"] }),
    ]);
    assert.deepEqual(g.problems, ["disabled"]);
  });

  it("names the voices an owner row of the same entry takes away from a built-in all-voices row", () => {
    const groups = group([
      row("builtin", "symbol", "/", { spoken: "slash" }),
      row("owner", "symbol", "/", { spoken: "slant", model: "pocket-en" }),
    ]);
    assert.deepEqual(groups.find((g) => g.origin === "builtin")?.except, [
      "pocket-en",
    ]);
  });

  it("does not take a voice from an all-voices row when its own row is switched off or lower priority", () => {
    const off = group([
      row("builtin", "symbol", "/", { spoken: "slash" }),
      row("builtin", "symbol", "/", {
        spoken: "x",
        model: "pocket-en",
        enabled: false,
      }),
    ]);
    assert.deepEqual(off.find((g) => g.spoken === "slash")?.except, []);
    const lower = group([
      row("owner", "symbol", "/", { spoken: "slash" }),
      row("builtin", "symbol", "/", { spoken: "x", model: "pocket-en" }),
    ]);
    assert.deepEqual(lower.find((g) => g.origin === "owner")?.except, []);
  });

  it("sorts by written text, owner before built-in, all voices before one voice", () => {
    const groups = group([
      row("builtin", "extension", "log", { spoken: "log" }),
      row("builtin", "extension", "Json", {
        spoken: "jason",
        model: "pocket-en",
      }),
      row("owner", "extension", "json", { spoken: "J S" }),
      row("builtin", "extension", "json", { spoken: "jason" }),
    ]);
    assert.deepEqual(
      groups.map((g) => [g.written, g.origin, g.all]),
      [
        ["json", "owner", true],
        ["json", "builtin", true],
        ["Json", "builtin", false],
        ["log", "builtin", true],
      ],
    );
  });
});

describe("filterGroups", () => {
  const md = row("owner", "extension", "md", {
    spoken: "M D",
    replaces_builtin: true,
  });
  const mdDefault = row("builtin", "extension", "md", { spoken: "markdown" });
  const json = row("builtin", "extension", "json", { spoken: "jason" });
  const gpu = row("builtin", "acronym", "GPU", {
    model: "pocket-en",
    enabled: false,
    problems: ["disabled"],
  });
  const slash = row("builtin", "symbol", "/", { spoken: "slash" });
  const slashHi = row("builtin", "symbol", "/", {
    spoken: "स्लैश",
    model: "indic-hi",
  });
  const mine = row("owner", "term", "kubectl", {
    spoken: "cube control",
    model: "supertonic-3",
  });
  const groups = group([md, mdDefault, json, gpu, slash, slashHi, mine]);
  const found = (filters: Partial<Filters>) =>
    filterGroups(groups, { ...NO_FILTERS, ...filters }).map(
      (g) => `${g.written}:${g.spoken}`,
    );

  it("keeps every group without filters", () => {
    assert.equal(found({}).length, groups.length);
  });
  it("searches written and spoken text, ignoring case, and the default a row overrides", () => {
    assert.deepEqual(found({ query: "JAS" }), ["json:jason"]);
    assert.deepEqual(found({ query: "kube" }), ["kubectl:cube control"]);
    assert.deepEqual(found({ query: " m d " }), ["md:M D"]);
    assert.deepEqual(found({ query: "markdown" }), ["md:M D"]);
    assert.deepEqual(found({ query: "zzz" }), []);
  });
  it("filters by voice: an all-voices row except the voices it skips, or the listed voices", () => {
    assert.deepEqual(found({ voice: "indic-hi" }).sort(), [
      "/:स्लैश",
      "json:jason",
      "md:M D",
    ]);
    assert.deepEqual(found({ voice: "pocket-en" }).sort(), [
      "/:slash",
      "GPU:",
      "json:jason",
      "md:M D",
    ]);
    assert.deepEqual(found({ voice: "supertonic-3" }).sort(), [
      "/:slash",
      "json:jason",
      "kubectl:cube control",
      "md:M D",
    ]);
  });
  it("filters by kind", () => {
    assert.deepEqual(found({ kind: "acronym" }), ["GPU:"]);
    assert.deepEqual(found({ kind: "term" }), ["kubectl:cube control"]);
  });
  it("filters by source: built-in, yours, and built-in entries you changed", () => {
    assert.deepEqual(found({ source: "owner" }).sort(), [
      "kubectl:cube control",
      "md:M D",
    ]);
    assert.deepEqual(found({ source: "builtin" }).sort(), [
      "/:slash",
      "/:स्लैश",
      "GPU:",
      "json:jason",
    ]);
    assert.deepEqual(found({ source: "changed" }).sort(), ["GPU:", "md:M D"]);
  });
  it("shows only rows with a problem on request", () => {
    assert.deepEqual(found({ onlyProblems: true }), ["GPU:"]);
  });
  it("combines the filters", () => {
    assert.deepEqual(found({ source: "builtin", voice: "pocket-en" }).sort(), [
      "/:slash",
      "GPU:",
      "json:jason",
    ]);
    assert.deepEqual(found({ source: "builtin", kind: "term" }), []);
  });
});

type Section = EntryRow["id"]["entry"]["section"];
const rule = (say: string | null, matching: "whole" | null = null) => ({
  say,
  matching,
  case: matching === null ? null : true,
});
const key = (section: Section, model: string | null, k: string) => ({
  section,
  model,
  key: k,
});
const put = (model: string | null, say: string, k = "kubectl"): Edit => ({
  kind: "put",
  entry: key("term", model, k),
  rule: rule(say, "whole"),
  previous: null,
});
const del = (model: string | null, k = "kubectl"): Edit => ({
  kind: "delete",
  entry: key("term", model, k),
});
const plan = (
  rows: EntryRow[],
  target: VoiceTarget,
  pick: (groups: RowGroup[]) => RowGroup = (groups) => groups[0],
) => {
  const groups = group(rows);
  return voicesPlan(pick(groups), target, groups, CATALOG);
};
const reading = (spoken: string) => (groups: RowGroup[]) => {
  const found = groups.find((g) => g.spoken === spoken);
  assert.ok(found, spoken);
  return found;
};

describe("voicesPlan, owner entries", () => {
  const two = () => [
    term("owner", "pocket-en", "cube control"),
    term("owner", "supertonic-3", "cube control"),
  ];

  it("adds a voice as an entry in that voice's section with the same rule", () => {
    assert.deepEqual(
      plan(two(), { models: ["pocket-en", "supertonic-3", "phonon"] }),
      [put("phonon", "cube control")],
    );
  });
  it("removes a voice by deleting its entry", () => {
    assert.deepEqual(plan(two(), { models: ["pocket-en"] }), [
      del("supertonic-3"),
    ]);
  });
  it("replaces one voice with another in one plan", () => {
    assert.deepEqual(plan(two(), { models: ["pocket-en", "phonon"] }), [
      put("phonon", "cube control"),
      del("supertonic-3"),
    ]);
  });
  it("writes a skip, a symbol and an acronym with their own rules", () => {
    assert.deepEqual(
      plan([term("owner", "pocket-en", "", { skip: true })], {
        models: ["pocket-en", "phonon"],
      }),
      [
        {
          kind: "put",
          entry: key("term", "phonon", "kubectl"),
          rule: { say: null, matching: "whole", case: true },
          previous: null,
        },
      ],
    );
    assert.deepEqual(
      plan(
        [row("owner", "symbol", "/", { model: "pocket-en", spoken: "slash" })],
        { models: ["pocket-en", "phonon"] },
      ),
      [
        {
          kind: "put",
          entry: key("symbol", "phonon", "/"),
          rule: { say: "slash", matching: null, case: null },
          previous: null,
        },
      ],
    );
    assert.deepEqual(
      plan([row("owner", "acronym", "GPU", { model: "pocket-en" })], {
        models: ["pocket-en", "phonon"],
      }),
      [
        {
          kind: "put",
          entry: key("acronym", "phonon", "GPU"),
          rule: { say: null, matching: null, case: null },
          previous: null,
        },
      ],
    );
  });
  it("narrows an all-voices entry by listing every other voice and dropping the top-level entry", () => {
    assert.deepEqual(
      plan([term("owner", null, "cube control")], {
        models: ["phonon", "supertonic-3", "indic-hi", "indic-pa"],
      }),
      [
        put("phonon", "cube control"),
        put("supertonic-3", "cube control"),
        put("indic-hi", "cube control"),
        put("indic-pa", "cube control"),
        del(null),
      ],
    );
  });
  it("widens a list of voices to all voices with one top-level entry", () => {
    assert.deepEqual(plan(two(), { all: true }), [
      put(null, "cube control"),
      del("pocket-en"),
      del("supertonic-3"),
    ]);
  });
  it("refuses an empty voice list so no owner entry is lost", () => {
    assert.equal(plan(two(), { models: [] }), null);
  });
  it("refuses a switched-off row", () => {
    assert.equal(
      plan([term("owner", "pocket-en", "cube control", { enabled: false })], {
        models: ["pocket-en", "phonon"],
      }),
      null,
    );
  });
  it("refuses to overwrite another owner reading of the same entry", () => {
    assert.equal(
      plan(
        [
          term("owner", "pocket-en", "cube control"),
          term("owner", "phonon", "kube control"),
        ],
        { models: ["pocket-en", "phonon"] },
        reading("cube control"),
      ),
      null,
    );
    assert.equal(
      plan(
        [
          term("owner", "pocket-en", "cube control"),
          term("owner", null, "kube control"),
        ],
        { all: true },
        reading("cube control"),
      ),
      null,
    );
  });
  it("lets an explicit voice be added beside an all-voices reading of the same entry", () => {
    assert.deepEqual(
      plan(
        [
          term("owner", null, "kube control"),
          term("owner", "pocket-en", "cube control"),
        ],
        { models: ["pocket-en", "phonon"] },
        reading("cube control"),
      ),
      [put("phonon", "cube control")],
    );
  });
});

describe("voicesPlan, built-in entries", () => {
  const three = () =>
    ["phonon", "pocket-en", "supertonic-3"].map((m) => llm(m));

  it("removes a voice with that voice's switch", () => {
    const rows = three();
    assert.deepEqual(plan(rows, { models: ["phonon", "supertonic-3"] }), [
      { kind: "set_enabled", id: rows[1].id, enabled: false },
    ]);
  });
  it("adds a voice back by removing its switch", () => {
    const rows = [
      llm("phonon"),
      llm("pocket-en", { enabled: false, problems: ["disabled"] }),
    ];
    assert.deepEqual(plan(rows, { models: ["phonon", "pocket-en"] }), [
      { kind: "set_enabled", id: rows[1].id, enabled: true },
    ]);
  });
  it("refuses a voice that has no built-in row to switch on", () => {
    assert.equal(
      plan([llm("phonon")], { models: ["phonon", "pocket-en"] }),
      null,
    );
  });
  it("refuses an all-voices built-in row, whose voices cannot be switched one by one", () => {
    const rows = [row("builtin", "symbol", "/", { spoken: "slash" })];
    assert.equal(plan(rows, { models: ["phonon"] }), null);
    assert.equal(plan(rows, { all: true }), null);
  });
  it("refuses to switch off the last voice and never offers all voices", () => {
    assert.equal(plan([llm("phonon")], { models: [] }), null);
    assert.equal(plan(three(), { all: true }), null);
  });
  it("does not add a voice from a switched-off row that reads differently", () => {
    assert.equal(
      plan(
        [
          row("builtin", "symbol", "/", { model: "phonon", spoken: "slash" }),
          row("builtin", "symbol", "/", {
            model: "pocket-en",
            spoken: "slant",
            enabled: false,
          }),
        ],
        { models: ["phonon", "pocket-en"] },
        reading("slash"),
      ),
      null,
    );
  });
});

describe("voiceOptions", () => {
  const flags = (g: RowGroup, groups: RowGroup[]) =>
    voiceOptions(g, groups, CATALOG).map((o) => [
      o.voice,
      o.selected,
      o.enabled,
    ]);

  it("lists all voices and every catalog voice with whether it is in the row and can change", () => {
    const groups = group([
      term("owner", "pocket-en", "cube control"),
      term("owner", "supertonic-3", "cube control"),
    ]);
    assert.deepEqual(flags(groups[0], groups), [
      [null, false, true],
      ["phonon", false, true],
      ["pocket-en", true, true],
      ["supertonic-3", true, true],
      ["indic-hi", false, true],
      ["indic-pa", false, true],
    ]);
  });
  it("keeps the last voice fixed", () => {
    const lone = group([term("owner", "pocket-en", "cube control")]);
    assert.deepEqual(
      flags(lone[0], lone).filter(([, selected]) => selected),
      [["pocket-en", true, false]],
    );
  });
  it("fixes every voice of an all-voices built-in row", () => {
    const groups = group([
      row("builtin", "symbol", "/", { spoken: "slash" }),
      row("builtin", "symbol", "/", { spoken: "x", model: "indic-hi" }),
    ]);
    const shared = groups.find((g) => g.all);
    assert.ok(shared);
    const options = voiceOptions(shared, groups, CATALOG);
    assert.ok(options.every((o) => !o.enabled));
    assert.equal(options.find((o) => o.voice === "indic-hi")?.selected, false);
    assert.equal(options.find((o) => o.voice === "pocket-en")?.selected, true);
  });
  it("lets an owner all-voices row drop a voice except those with their own reading", () => {
    const groups = group([
      term("owner", null, "kube control"),
      term("owner", "indic-hi", "cube control"),
    ]);
    assert.deepEqual(flags(reading("kube control")(groups), groups), [
      [null, true, false],
      ["phonon", true, true],
      ["pocket-en", true, true],
      ["supertonic-3", true, true],
      ["indic-hi", false, false],
      ["indic-pa", true, true],
    ]);
  });
});

describe("switchPlan", () => {
  const SLASH = [
    row("builtin", "symbol", "/", { spoken: "slash" }),
    row("builtin", "symbol", "/", { spoken: "स्लैश", model: "indic-hi" }),
    row("builtin", "symbol", "/", { spoken: "ਸਲੈਸ਼", model: "indic-pa" }),
  ];
  const slashRule = (say: string) => ({ say, matching: null, case: null });
  const symbolPut = (model: string, say: string): Edit => ({
    kind: "put",
    entry: key("symbol", model, "/"),
    rule: slashRule(say),
    previous: null,
  });
  const plan = (rows: EntryRow[], spoken: string) => {
    const groups = group(rows);
    const target = groups.find((g) => g.spoken === spoken);
    assert.ok(target, spoken);
    return switchPlan(target, groups);
  };

  it("switches off every row of a group with its own switch", () => {
    const rows = ["phonon", "pocket-en"].map((m) => llm(m));
    assert.deepEqual(plan(rows, ""), [
      { kind: "set_enabled", id: rows[0].id, enabled: false },
      { kind: "set_enabled", id: rows[1].id, enabled: false },
    ]);
  });
  it("switches a switched-off group back on", () => {
    const rows = ["phonon", "pocket-en"].map((m) =>
      llm(m, { enabled: false, problems: ["disabled"] }),
    );
    assert.deepEqual(plan(rows, ""), [
      { kind: "set_enabled", id: rows[0].id, enabled: true },
      { kind: "set_enabled", id: rows[1].id, enabled: true },
    ]);
  });
  it("keeps the readings a built-in all-voices switch would also take away by saving them as your own", () => {
    assert.deepEqual(plan(SLASH, "slash"), [
      symbolPut("indic-hi", "स्लैश"),
      symbolPut("indic-pa", "ਸਲੈਸ਼"),
      { kind: "set_enabled", id: SLASH[0].id, enabled: false },
    ]);
  });
  it("switching the shared row back on only removes the switch", () => {
    const off = [
      { ...SLASH[0], enabled: false },
      SLASH[1],
      SLASH[2],
      row("owner", "symbol", "/", { spoken: "स्लैश", model: "indic-hi" }),
      row("owner", "symbol", "/", { spoken: "ਸਲੈਸ਼", model: "indic-pa" }),
    ];
    assert.deepEqual(plan(off, "slash"), [
      { kind: "set_enabled", id: SLASH[0].id, enabled: true },
    ]);
  });
  it("does not copy a reading you already replaced, a switched-off one or an owner row's", () => {
    const rows = [
      SLASH[0],
      row("builtin", "symbol", "/", { spoken: "स्लैश", model: "indic-hi" }),
      row("owner", "symbol", "/", {
        spoken: "my hindi",
        model: "indic-hi",
        replaces_builtin: true,
      }),
      row("builtin", "symbol", "/", {
        spoken: "ਸਲੈਸ਼",
        model: "indic-pa",
        enabled: false,
      }),
      row("owner", "symbol", "/", { spoken: "mine", model: "pocket-en" }),
    ];
    assert.deepEqual(plan(rows, "slash"), [
      { kind: "set_enabled", id: SLASH[0].id, enabled: false },
    ]);
  });
  it("copies nothing for your own all-voices row, whose switch reaches that scope only", () => {
    const mine = row("owner", "symbol", "/", { spoken: "slash" });
    assert.deepEqual(
      plan(
        [mine, row("owner", "symbol", "/", { spoken: "x", model: "indic-hi" })],
        "slash",
      ),
      [{ kind: "set_enabled", id: mine.id, enabled: false }],
    );
  });
});

describe("voiceChangePlan and switchPlan on the latest rows", () => {
  const pocket = term("owner", "pocket-en", "cube control");
  const phonon = term("owner", "phonon", "kube control");
  const keyOf = (rows: EntryRow[], spoken: string) => {
    const found = group(rows).find((g) => g.spoken === spoken);
    assert.ok(found, spoken);
    return found.key;
  };

  it("plans the voice change against the rows it is given", () => {
    const rows = [pocket, phonon];
    const cube = keyOf(rows, "cube control");
    assert.deepEqual(
      voiceChangePlan(rows, CATALOG, cube, "supertonic-3", false),
      [put("supertonic-3", "cube control")],
    );
  });
  it("refuses a voice change whose voice another reading took since it was offered", () => {
    const cube = keyOf([pocket, phonon], "cube control");
    const latest = [
      pocket,
      phonon,
      term("owner", "supertonic-3", "kube control"),
    ];
    assert.equal(
      voiceChangePlan(latest, CATALOG, cube, "supertonic-3", false),
      null,
    );
  });
  it("refuses a voice change when the row is gone or the voice changed side meanwhile", () => {
    const rows = [pocket, phonon];
    const cube = keyOf(rows, "cube control");
    assert.equal(
      voiceChangePlan([phonon], CATALOG, cube, "phonon", false),
      null,
    );
    const withSuper = [
      term("owner", "pocket-en", "cube control"),
      term("owner", "supertonic-3", "cube control"),
    ];
    assert.equal(
      voiceChangePlan(withSuper, CATALOG, cube, "supertonic-3", false),
      null,
    );
  });
  it("plans a switch against the latest rows and refuses one for a row that is gone", () => {
    const rows = [pocket, phonon];
    const cube = keyOf(rows, "cube control");
    assert.deepEqual(switchPlanFor(rows, CATALOG, cube), [
      { kind: "set_enabled", id: pocket.id, enabled: false },
    ]);
    assert.equal(switchPlanFor([phonon], CATALOG, cube), null);
  });
});
