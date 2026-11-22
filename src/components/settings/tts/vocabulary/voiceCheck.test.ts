import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import type { AcronymStyleRow, VoiceCheck, VoiceText } from "@/bindings";
import { models } from "./fixtures";
import {
  checkedModels,
  createVoiceCheck,
  passedModels,
  saveOptions,
  voiceTexts,
  type VoiceCheckState,
} from "./voiceCheck";
const {
  describe,
  it,
}: {
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => Promise<void> | void) => void;
} = createRequire(import.meta.url)("bun:test");

const heard = (model_id: string): VoiceCheck => ({
  model_id,
  outcome: { kind: "heard_right", heard: "README dot M D" },
});
const missed = (model_id: string): VoiceCheck => ({
  model_id,
  outcome: { kind: "missed", heard: "readme dot markdown" },
});
const failed = (model_id: string): VoiceCheck => ({
  model_id,
  outcome: { kind: "failed", error: "tts.errors.notDownloaded" },
});

describe("saveOptions", () => {
  it("saves plainly when every voice heard right", () => {
    assert.deepEqual(
      saveOptions([heard("pocket-en"), heard("supertonic-3")], null),
      ["save"],
    );
  });
  it("offers the three choices when a voice missed a rule for all voices", () => {
    assert.deepEqual(
      saveOptions([heard("pocket-en"), missed("supertonic-3")], null),
      ["save_all_anyway", "save_passed_only", "pick_one"],
    );
  });
  it("saves plainly for one chosen voice, even when it missed", () => {
    assert.deepEqual(saveOptions([missed("pocket-en")], "pocket-en"), ["save"]);
  });
  it("offers no passed-only save when no voice passed", () => {
    assert.deepEqual(
      saveOptions([missed("pocket-en"), failed("supertonic-3")], null),
      ["save_all_anyway", "pick_one"],
    );
  });
  it("saves plainly before any check ran", () => {
    assert.deepEqual(saveOptions([], null), ["save"]);
  });
});

describe("passedModels", () => {
  it("lists only the voices that heard right", () => {
    assert.deepEqual(
      passedModels([
        missed("kokoro-82m-int8"),
        heard("pocket-en"),
        failed("phonon"),
        heard("supertonic-3"),
      ]),
      ["pocket-en", "supertonic-3"],
    );
  });
});

describe("checkedModels", () => {
  it("checks every downloaded voice for all voices and only the chosen one otherwise", () => {
    assert.deepEqual(checkedModels(null, models), ["pocket-en"]);
    assert.deepEqual(checkedModels("supertonic-3", models), ["supertonic-3"]);
  });
});

const styles: AcronymStyleRow[] = [
  { model: null, owner: null, effective: "spaced" },
  { model: "pocket-en", owner: "capitals", effective: "capitals" },
  { model: "supertonic-3", owner: null, effective: "spaced" },
];

describe("voiceTexts", () => {
  it("says an acronym in each voice's own style, upper-cased", () => {
    assert.deepEqual(
      voiceTexts(["pocket-en", "supertonic-3"], "C L I", "Cli", styles),
      [
        { model_id: "pocket-en", spoken: "CLI" },
        { model_id: "supertonic-3", spoken: "C L I" },
      ],
    );
  });
  it("falls back to the all-voices style for a voice without its own row", () => {
    const capitals: AcronymStyleRow[] = [
      { model: null, owner: "capitals", effective: "capitals" },
    ];
    assert.deepEqual(
      voiceTexts(["kokoro-82m-int8"], "Z F S", "zfs", capitals),
      [{ model_id: "kokoro-82m-int8", spoken: "ZFS" }],
    );
  });
  it("gives every voice the same words when the rule is not an acronym", () => {
    assert.deepEqual(
      voiceTexts(["pocket-en", "supertonic-3"], "cube control", null, styles),
      [
        { model_id: "pocket-en", spoken: "cube control" },
        { model_id: "supertonic-3", spoken: "cube control" },
      ],
    );
  });
});

const voice = (model_id: string, spoken: string): VoiceText => ({
  model_id,
  spoken,
});

function harness() {
  const calls: unknown[][] = [];
  const pending: ((results: VoiceCheck[]) => void)[] = [];
  const states: VoiceCheckState[] = [];
  const check = createVoiceCheck({
    play: async (voices) => {
      calls.push(["play", voices]);
    },
    check: (voices) => {
      calls.push(["check", voices]);
      return new Promise((resolve) => pending.push(resolve));
    },
    update: (state) => states.push(state),
  });
  const last = () => states[states.length - 1];
  return { calls, pending, check, last };
}

describe("createVoiceCheck", () => {
  it("plays and checks the voices it targets", async () => {
    const { calls, pending, check, last } = harness();
    const voices = [voice("pocket-en", "CLI"), voice("supertonic-3", "C L I")];
    check.target(voices, "whole:true");
    const running = check.playAndCheck();
    assert.deepEqual(calls, [
      ["play", voices],
      ["check", voices],
    ]);
    assert.equal(last().checking, true);
    pending[0]([heard("pocket-en"), missed("supertonic-3")]);
    await running;
    assert.deepEqual(last(), {
      results: [heard("pocket-en"), missed("supertonic-3")],
      checking: false,
      error: null,
    });
  });
  it("checks again, without playing, when a match option changes after a check", async () => {
    const { calls, pending, check } = harness();
    const voices = [voice("pocket-en", "cube control")];
    check.target(voices, "whole:true");
    const first = check.playAndCheck();
    pending[0]([heard("pocket-en")]);
    await first;
    calls.length = 0;
    check.target(voices, "anywhere:true");
    assert.deepEqual(calls, [["check", voices]]);
    check.target(voices, "anywhere:true");
    assert.equal(calls.length, 1, "an unchanged option does not check again");
  });
  it("does not check on a match option change before any check ran", () => {
    const { calls, check } = harness();
    check.target([voice("pocket-en", "x")], "whole:true");
    check.target([voice("pocket-en", "x")], "anywhere:false");
    assert.deepEqual(calls, []);
  });
  it("drops a result checked for older words", async () => {
    const { pending, check, last } = harness();
    check.target([voice("pocket-en", "old")], "whole:true");
    const running = check.playAndCheck();
    check.target([voice("pocket-en", "new")], "whole:true");
    assert.deepEqual(last(), { results: null, checking: false, error: null });
    pending[0]([heard("pocket-en")]);
    await running;
    assert.deepEqual(last(), { results: null, checking: false, error: null });
  });
  it("shows a refused check as its error key", async () => {
    const states: VoiceCheckState[] = [];
    const check = createVoiceCheck({
      play: async () => {},
      check: async () => {
        throw new Error("tts.vocabulary.check.dictating");
      },
      update: (state) => states.push(state),
    });
    check.target([voice("pocket-en", "x")], "whole:true");
    await check.playAndCheck();
    assert.deepEqual(states[states.length - 1], {
      results: null,
      checking: false,
      error: "tts.vocabulary.check.dictating",
    });
  });
});

describe("the entry editor's play", () => {
  it("plays the words typed in the editor, not a list sample", async () => {
    const plays: VoiceText[][] = [];
    const check = createVoiceCheck({
      play: async (voices) => {
        plays.push(voices);
      },
      check: async () => [],
      update: () => {},
    });
    check.target(voiceTexts(["pocket-en"], "underscore", null, []), "whole");
    await check.playAndCheck();
    assert.deepEqual(plays, [
      [{ model_id: "pocket-en", spoken: "underscore" }],
    ]);
  });
  it("only the list reads a row's sample, to play it and to show it", () => {
    const folder = new URL("./", import.meta.url);
    const readers = readdirSync(folder)
      .sort()
      .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
      .filter((name) =>
        /\.sample\b/.test(readFileSync(new URL(name, folder), "utf8")),
      );
    assert.deepEqual(readers, ["VocabularyTable.tsx", "actions.ts"]);
  });
});
