import assert from "node:assert/strict";
import { createRequire } from "node:module";
import i18next from "i18next";
import en from "../../../../i18n/locales/en/translation.json";
import type {
  VoiceCheck,
  Derivation,
  DerivedRule,
  SaveError,
  VocabularyTable,
} from "@/bindings";
import {
  applyCapture,
  canSave,
  chosenRule,
  correctionRequest,
  createCapture,
  createCorrectionActions,
  deriveFailure,
  initialCorrection,
  savesAs,
  type CaptureDependencies,
  type CorrectionDependencies,
  type CorrectionState,
  type Derived,
  voicesAfter,
} from "./correction";
import { createVoiceCheck } from "./voiceCheck";
const {
  describe,
  it,
}: {
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => Promise<void> | void) => void;
} = createRequire(import.meta.url)("bun:test");
const i18n = i18next.createInstance();
await i18n.init({
  lng: "en",
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
});
const t = i18n.t.bind(i18n);

const rule = (
  section: "extension" | "term" | "acronym",
  key: string,
  say: string | null,
  reach: DerivedRule["reach"],
  preview = say ?? "",
): DerivedRule => ({
  entry: { section, model: null, key },
  rule: { say, matching: null, case: null },
  reach,
  preview,
});
const extension = rule(
  "extension",
  "md",
  "M D",
  {
    kind: "extension",
    extension: "md",
  },
  "dot M D",
);
/** An acronym as the core derives it: no spoken value, the preview is its spelled key. */
const acronym = rule(
  "acronym",
  "ZFS",
  null,
  { kind: "acronym", acronym: "ZFS" },
  "Z F S",
);
const exactText = rule("term", "README.md", "README dot M D", {
  kind: "exact_text",
  text: "README.md",
});
const derivation: Derivation = {
  spoken_before: "README dot markdown",
  rule: extension,
  exact: exactText,
  spoken_after: "README dot M D",
};
const ready: Derived = { status: "ready", derivation };
const chosen: CorrectionState = {
  ...initialCorrection("README dot M D"),
  scope: { kind: "all" },
};

describe("savesAs", () => {
  it("names the rule and its reach", () => {
    assert.equal(
      savesAs(extension, t),
      '.md -> "dot M D" · affects every .md file',
    );
    assert.equal(
      savesAs(exactText, t),
      'README.md -> "README dot M D" · only README.md',
    );
  });

  it("shows an acronym as its spelled preview, not as a skip", () => {
    assert.equal(
      savesAs(acronym, t),
      'ZFS -> "Z F S" · affects the acronym ZFS wherever it appears',
    );
  });

  it("shows a skip as skipped", () => {
    const skip = rule("term", "ABC-123", null, {
      kind: "exact_text",
      text: "ABC-123",
    });
    assert.equal(savesAs(skip, t), 'ABC-123 -> "(skipped)" · only ABC-123');
  });
});

describe("canSave", () => {
  it("is false while the scope is unset", () => {
    const unset = initialCorrection("README dot M D");
    assert.equal(canSave(unset, ready), false);
    assert.equal(canSave(chosen, ready), true);
    const forPocket: Derived = {
      status: "ready",
      derivation: {
        ...derivation,
        rule: {
          ...extension,
          entry: { ...extension.entry, model: "pocket-en" },
        },
      },
    };
    assert.equal(
      canSave(
        { ...chosen, scope: { kind: "model", id: "pocket-en" } },
        forPocket,
      ),
      true,
    );
  });

  it("is false while the rule shown was derived for another scope", () => {
    assert.equal(
      canSave({ ...chosen, scope: { kind: "model", id: "pocket-en" } }, ready),
      false,
    );
  });

  it("is false while a derive error is shown or the rule is pending", () => {
    assert.equal(
      canSave(chosen, {
        status: "error",
        key: "tts.vocabulary.derive.unchanged",
      }),
      false,
    );
    assert.equal(canSave(chosen, { status: "pending" }), false);
  });

  it("is false when nothing is left to say and the rule is not a skip", () => {
    assert.equal(canSave({ ...chosen, shouldSay: "  " }, ready), false);
    assert.equal(
      canSave({ ...chosen, shouldSay: "" }, { status: "pending" }),
      false,
    );
  });

  it("saves a valid skip with an empty text once a scope is chosen", () => {
    const skip: Derived = {
      status: "ready",
      derivation: {
        spoken_before: "ABC-123",
        rule: rule("term", "ABC-123", null, {
          kind: "exact_text",
          text: "ABC-123",
        }),
        exact: null,
        spoken_after: "",
      },
    };
    assert.equal(canSave({ ...chosen, shouldSay: "" }, skip), true);
    assert.equal(
      canSave({ ...initialCorrection(""), shouldSay: "" }, skip),
      false,
    );
  });
});

describe("chosenRule", () => {
  it("sends the exact rule when exact text is chosen", () => {
    assert.equal(chosenRule(derivation, false), extension);
    assert.equal(chosenRule(derivation, true), exactText);
  });

  it("keeps the rule when there is no separate exact one", () => {
    assert.equal(chosenRule({ ...derivation, exact: null }, true), extension);
  });
});

describe("correctionRequest", () => {
  it("carries the scope and the match options", () => {
    const request = correctionRequest("README.md", "pocket-en", {
      ...chosen,
      scope: { kind: "model", id: "supertonic-3" },
      matching: "anywhere",
      caseSensitive: false,
    });
    assert.deepEqual(request, {
      written: "README.md",
      should_say: "README dot M D",
      reading_model: "supertonic-3",
      scope: "supertonic-3",
      matching: ["anywhere", false],
    });
  });

  it("derives and verifies against the chosen voice, not the one that read the text", () => {
    const one = correctionRequest("README.md", "pocket-en", {
      ...chosen,
      scope: { kind: "model", id: "supertonic-3" },
    });
    assert.equal(one.reading_model, "supertonic-3");
  });

  it("reads with the selected voice for all voices", () => {
    const all = correctionRequest("README.md", "pocket-en", chosen);
    assert.equal(all.scope, null);
    assert.equal(all.reading_model, "pocket-en");
  });
});

describe("voicesAfter", () => {
  it("clears the voices without a target or with a derive error", () => {
    assert.equal(voicesAfter(ready, false), "clear");
    assert.equal(
      voicesAfter(
        { status: "error", key: "tts.vocabulary.derive.unchanged" },
        true,
      ),
      "clear",
    );
  });
  it("keeps the voices while a new derivation is pending", () => {
    assert.equal(voicesAfter({ status: "pending" }, true), "keep");
  });
  it("prepares the voices for a resolved derivation", () => {
    assert.equal(voicesAfter(ready, true), "prepare");
  });
});

describe("a match-option change in the correction box", () => {
  it("keeps the check's result through the new derivation", async () => {
    const pocket = [{ model_id: "pocket-en", spoken: "use cube control now." }];
    const pending: ((results: VoiceCheck[]) => void)[] = [];
    let shown: VoiceCheck[] | null = null;
    const check = createVoiceCheck({
      play: async () => {},
      check: () => new Promise((resolve) => pending.push(resolve)),
      update: (state) => {
        shown = state.results;
      },
    });
    const heard: VoiceCheck[] = [
      {
        model_id: "pocket-en",
        outcome: { kind: "heard_right", heard: "use cube control now" },
      },
    ];
    check.target(pocket, "whole:true");
    const first = check.playAndCheck();
    pending[0](heard);
    await first;
    // The match option changes: the derivation goes pending and the box decides the voices.
    const during =
      voicesAfter({ status: "pending" }, true) === "keep" ? pocket : [];
    check.target(during, "anywhere:true");
    assert.equal(pending.length, 2, "the check runs again for the new option");
    pending[1](heard);
    await new Promise((resolve) => setTimeout(resolve));
    assert.deepEqual(shown, heard);
    // The derivation resolves and the same words are prepared again.
    check.target(
      [{ model_id: "pocket-en", spoken: "use cube control now." }],
      "anywhere:true",
    );
    assert.deepEqual(shown, heard, "identical words keep the result");
  });
});

describe("deriveFailure", () => {
  it("maps the backend's keys and the invalid reason", () => {
    assert.deepEqual(deriveFailure("tts.vocabulary.derive.severalWords"), {
      status: "error",
      key: "tts.vocabulary.derive.severalWords",
    });
    assert.deepEqual(
      deriveFailure(
        "tts.vocabulary.derive.invalid:the reading cannot hold '/'",
      ),
      {
        status: "error",
        key: "tts.vocabulary.derive.invalid",
        detail: "the reading cannot hold '/'",
      },
    );
    assert.equal(
      (deriveFailure("boom") as { key: string }).key,
      "tts.errors.generic",
    );
  });
});

const table = (revision: string): VocabularyTable => ({
  revision,
  path: "tts-vocabulary.json",
  file_error: null,
  rows: [],
  acronym_styles: [],
});

function dependencies(
  results: {
    rules?: VocabularyTable | SaveError;
  } = {},
  overrides: Partial<CorrectionDependencies> = {},
) {
  const calls: unknown[][] = [];
  const deps: CorrectionDependencies = {
    load: async () => table("r0"),
    derive: async (request) => {
      calls.push(["derive", request]);
      return derivation;
    },
    listen: async (spoken, model) => {
      calls.push(["listen", spoken, model]);
    },
    voices: async (written, rule, models) => {
      calls.push(["voices", written, rule, models]);
      return models.map((model_id) => ({
        model_id,
        spoken: model_id === "pocket-en" ? "use ZFS now." : "use Z F S now.",
      }));
    },
    saveRules: async (revision, rules) => {
      calls.push(["saveRules", revision, rules]);
      return results.rules ?? table("r1");
    },
    ...overrides,
  };
  return { calls, actions: createCorrectionActions(deps) };
}

describe("the correction actions", () => {
  it("saves exactly the rule shown, at the loaded revision", async () => {
    const { calls, actions } = dependencies();
    const outcome = await actions.save("r0", exactText);
    assert.deepEqual(calls, [["saveRules", "r0", [exactText]]]);
    assert.deepEqual(outcome, { saved: true, table: table("r1") });
  });

  it("asks for a reload when the file changed", async () => {
    const { calls, actions } = dependencies({ rules: { kind: "changed" } });
    const outcome = await actions.save("r0", extension);
    assert.deepEqual(outcome, {
      saved: false,
      failure: { key: "tts.vocabulary.errors.changed" },
      reload: true,
    });
    assert.equal(calls.length, 1);
  });

  it("reports an invalid edit without a reload", async () => {
    const { actions } = dependencies({
      rules: { kind: "invalid_edit", message: "bad" },
    });
    assert.deepEqual(await actions.save("r0", extension), {
      saved: false,
      failure: { key: "tts.vocabulary.errors.invalidEdit", message: "bad" },
      reload: false,
    });
  });

  it("saves only for the passed voices: the checked rule rescoped to each, in one save, never re-derived", async () => {
    const { calls, actions } = dependencies(
      {},
      {
        derive: async (request) => {
          calls.push(["derive", request]);
          return derivation;
        },
      },
    );
    const outcome = await actions.savePassed("r0", acronym, [
      "pocket-en",
      "supertonic-3",
    ]);
    const rescoped = (model: string): DerivedRule => ({
      ...acronym,
      entry: { ...acronym.entry, model },
    });
    assert.deepEqual(calls, [
      ["saveRules", "r0", [rescoped("pocket-en"), rescoped("supertonic-3")]],
    ]);
    assert.ok(
      calls.every(([name]) => name !== "derive"),
      "derive never called",
    );
    assert.deepEqual(outcome, { saved: true, table: table("r1") });
  });

  it("the words each voice says come from the command unchanged and reach play and check", async () => {
    const { calls, actions } = dependencies();
    const voices = await actions.voices("use ZFS now", acronym, [
      "pocket-en",
      "supertonic-3",
    ]);
    assert.deepEqual(calls, [
      ["voices", "use ZFS now", acronym, ["pocket-en", "supertonic-3"]],
    ]);
    const sent: unknown[][] = [];
    const check = createVoiceCheck({
      play: async (targets) => {
        sent.push(["play", targets]);
      },
      check: async (targets) => {
        sent.push(["check", targets]);
        return [];
      },
      update: () => {},
    });
    check.target(voices, "whole:true");
    await check.playAndCheck();
    const expected = [
      { model_id: "pocket-en", spoken: "use ZFS now." },
      { model_id: "supertonic-3", spoken: "use Z F S now." },
    ];
    assert.deepEqual(sent, [
      ["play", expected],
      ["check", expected],
    ]);
  });

  it("turns a rejected derive into the reason shown inline", async () => {
    const { actions } = dependencies(
      {},
      {
        derive: async () => {
          throw new Error("tts.vocabulary.derive.unchanged");
        },
      },
    );
    assert.deepEqual(
      await actions.derive(correctionRequest("a", "pocket-en", chosen)),
      { status: "error", key: "tts.vocabulary.derive.unchanged" },
    );
  });
});

describe("correction microphone", () => {
  const capture = (overrides: Partial<CaptureDependencies> = {}) => {
    const calls: unknown[][] = [];
    const deps: CaptureDependencies = {
      start: async () => {
        calls.push(["start"]);
      },
      stop: async () => {
        calls.push(["stop"]);
        return "README dot M D";
      },
      cancel: async () => {
        calls.push(["cancel"]);
      },
      update: (state) => calls.push(["update", state]),
      heard: (words) => calls.push(["heard", words]),
      fail: (key) => calls.push(["fail", key]),
      ...overrides,
    };
    return { calls, microphone: createCapture(deps) };
  };

  it("keeps Should say when nothing was heard and replaces it otherwise", () => {
    assert.equal(
      applyCapture("README dot markdown", ""),
      "README dot markdown",
    );
    assert.equal(
      applyCapture("README dot markdown", "  "),
      "README dot markdown",
    );
    assert.equal(
      applyCapture("README dot markdown", "README dot M D"),
      "README dot M D",
    );
  });

  it("records on the first press and hands the raw words over on the second", async () => {
    const { calls, microphone } = capture();
    await microphone.press();
    await microphone.press();
    assert.deepEqual(calls, [
      ["start"],
      ["update", "recording"],
      ["fail", null],
      ["update", "transcribing"],
      ["stop"],
      ["heard", "README dot M D"],
      ["update", "idle"],
    ]);
  });

  it("shows a refused start and stays off", async () => {
    const { calls, microphone } = capture({
      start: async () => {
        throw new Error("tts.correction.microphone.busy");
      },
    });
    await microphone.press();
    assert.deepEqual(calls, [["fail", "tts.correction.microphone.busy"]]);
  });

  it("leaves Should say as it was when the capture was stopped by a dictation", async () => {
    const { calls, microphone } = capture({
      stop: async () => {
        throw new Error("tts.correction.microphone.stopped");
      },
    });
    await microphone.press();
    await microphone.press();
    assert.ok(calls.every(([name]) => name !== "heard"));
    assert.deepEqual(calls.slice(-2), [
      ["fail", "tts.correction.microphone.stopped"],
      ["update", "idle"],
    ]);
  });

  it("ignores a press while speech-to-text runs", async () => {
    let finish: (words: string) => void = () => {};
    const { calls, microphone } = capture({
      stop: () =>
        new Promise<string>((resolve) => {
          calls.push(["stop"]);
          finish = resolve;
        }),
    });
    await microphone.press();
    const stopping = microphone.press();
    await microphone.press();
    finish("G P U");
    await stopping;
    assert.equal(calls.filter(([name]) => name === "stop").length, 1);
    assert.deepEqual(calls[calls.length - 2], ["heard", "G P U"]);
  });

  it("closing while recording cancels the recording", async () => {
    const { calls, microphone } = capture();
    await microphone.press();
    microphone.close();
    assert.deepEqual(calls[calls.length - 1], ["cancel"]);
  });

  it("closing during a start cancels the recording once it starts", async () => {
    let started: () => void = () => {};
    const { calls, microphone } = capture({
      start: () =>
        new Promise<void>((resolve) => {
          calls.push(["start"]);
          started = resolve;
        }),
    });
    const starting = microphone.press();
    microphone.close();
    started();
    await starting;
    assert.deepEqual(calls, [["start"], ["cancel"]]);
  });

  it("closing while speech-to-text runs lets it finish and drops the words", async () => {
    let finish: (words: string) => void = () => {};
    const { calls, microphone } = capture({
      stop: () =>
        new Promise<string>((resolve) => {
          calls.push(["stop"]);
          finish = resolve;
        }),
    });
    await microphone.press();
    const stopping = microphone.press();
    microphone.close();
    finish("G P U");
    await stopping;
    assert.ok(calls.every(([name]) => name !== "cancel" && name !== "heard"));
  });
});
