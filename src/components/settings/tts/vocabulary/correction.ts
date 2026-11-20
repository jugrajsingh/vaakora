import type { TFunction } from "i18next";
import type {
  CorrectionRequest,
  Derivation,
  DerivedRule,
  SaveError,
  TermMatch,
  VocabularyTable,
  VoiceText,
} from "@/bindings";
import { saveFailure, type Failure } from "./actions";

/** Where a correction applies. The owner is asked every time, so nothing is chosen at first. */
export type Scope =
  | { kind: "unset" }
  | { kind: "all" }
  | { kind: "model"; id: string };

/** The voice model id of a chosen scope, `null` for all voices. */
export const scopeModel = (scope: Scope) =>
  scope.kind === "model" ? scope.id : null;

/** What the owner has entered in the correction box. */
export interface CorrectionState {
  shouldSay: string;
  scope: Scope;
  /** Save the exact-text rule instead of the derived one. */
  exact: boolean;
  matching: TermMatch;
  caseSensitive: boolean;
  /** The voices a "save only for voices that passed" was asked for; a retry after a conflict repeats it. */
  passed: readonly string[] | null;
}

export const initialCorrection = (spokenAs: string): CorrectionState => ({
  shouldSay: spokenAs,
  scope: { kind: "unset" },
  exact: false,
  matching: "whole",
  caseSensitive: true,
  passed: null,
});

/** Whether the correction holds a change a close would lose. */
export function correctionDirty(state: CorrectionState, spokenAs: string) {
  const start = initialCorrection(spokenAs);
  return (
    state.shouldSay !== start.shouldSay ||
    state.scope.kind !== start.scope.kind ||
    scopeModel(state.scope) !== scopeModel(start.scope) ||
    state.exact !== start.exact ||
    state.matching !== start.matching ||
    state.caseSensitive !== start.caseSensitive ||
    state.passed !== start.passed
  );
}

/** The result of deriving a rule: shown while pending, as a rule, or as an inline reason. */
export type Derived =
  | { status: "pending" }
  | { status: "ready"; derivation: Derivation }
  | { status: "error"; key: string; detail?: string };

const DERIVE = "tts.vocabulary.derive";
const DERIVE_KEYS = ["unchanged", "severalWords", "notExplained"].map(
  (name) => `${DERIVE}.${name}`,
);
const INVALID = `${DERIVE}.invalid:`;

/** Derive errors arrive as translation keys, `invalid` followed by the reason. */
export function deriveFailure(
  message: string,
): Extract<Derived, { status: "error" }> {
  if (message.startsWith(INVALID)) {
    return {
      status: "error",
      key: `${DERIVE}.invalid`,
      detail: message.slice(INVALID.length),
    };
  }
  return {
    status: "error",
    key: DERIVE_KEYS.includes(message) ? message : "tts.errors.generic",
  };
}

/**
 * The words are derived and checked against the voice the rule is saved for, so a rule for one
 * voice is verified there; for all voices the selected voice reads.
 */
export function correctionRequest(
  written: string,
  readingModel: string,
  state: CorrectionState,
): CorrectionRequest {
  return {
    written,
    should_say: state.shouldSay,
    reading_model: scopeModel(state.scope) ?? readingModel,
    scope: scopeModel(state.scope),
    matching: [state.matching, state.caseSensitive],
  };
}

/** The rule that will be saved: the exact-text one when asked for and different from the rule. */
export const chosenRule = (derivation: Derivation, exact: boolean) =>
  exact && derivation.exact ? derivation.exact : derivation.rule;

/** A term with nothing to say: the matched text is not spoken. */
const isSkip = (rule: DerivedRule) =>
  rule.entry.section === "term" && rule.rule.say === null;

/**
 * Save needs a rule the rules accept for the scope the owner chose. A rule derived for another
 * scope (the owner just changed it) is not the one shown, so it cannot be saved. An empty text
 * is saved only as a skip.
 */
export function canSave(state: CorrectionState, derived: Derived) {
  return (
    derived.status === "ready" &&
    state.scope.kind !== "unset" &&
    derived.derivation.rule.entry.model === scopeModel(state.scope) &&
    (state.shouldSay.trim() !== "" || isSkip(derived.derivation.rule))
  );
}

/** Who the rule reaches, in words. */
export function reachLabel(t: TFunction, rule: DerivedRule) {
  const reach = rule.reach;
  switch (reach.kind) {
    case "extension":
      return t("tts.correction.reach.extension", {
        extension: `.${reach.extension}`,
      });
    case "acronym":
      return t("tts.correction.reach.acronym", { acronym: reach.acronym });
    case "term":
      return t("tts.correction.reach.term", { term: reach.term });
    case "symbol":
      return t("tts.correction.reach.symbol", { symbol: reach.symbol });
    case "exact_text":
      return t("tts.correction.reach.exact", { text: reach.text });
  }
}

/** The rule and its reach: `.md -> "dot M D" · affects every .md file`. */
export function savesAs(rule: DerivedRule, t: TFunction) {
  const key = rule.entry.key;
  return t("tts.correction.savesAsFormat", {
    written: rule.entry.section === "extension" ? `.${key}` : key,
    spoken: isSkip(rule) ? t("tts.vocabulary.skipped") : rule.preview,
    reach: reachLabel(t, rule),
  });
}

/**
 * What the correction box does with the voices' prepared words after a change: clear them (no
 * voice to check, or no rule), keep them while a new derivation is pending so a running check
 * keeps its target, or prepare them again for the resolved rule.
 */
export function voicesAfter(
  derived: Derived,
  hasTarget: boolean,
): "clear" | "keep" | "prepare" {
  if (!hasTarget || derived.status === "error") return "clear";
  return derived.status === "pending" ? "keep" : "prepare";
}

export interface CorrectionDependencies {
  load: () => Promise<VocabularyTable>;
  derive: (request: CorrectionRequest) => Promise<Derivation>;
  listen: (spoken: string, model: string | null) => Promise<void>;
  /** What each model says for the written text once the rule is saved. */
  voices: (
    written: string,
    rule: DerivedRule,
    models: string[],
  ) => Promise<VoiceText[]>;
  saveRules: (
    revision: string,
    rules: DerivedRule[],
  ) => Promise<VocabularyTable | SaveError>;
}

export type SaveOutcome =
  | { saved: true; table: VocabularyTable }
  | { saved: false; failure: Failure; reload: boolean };

const messageOf = (reason: unknown) =>
  reason instanceof Error ? reason.message : "";

export function createCorrectionActions(deps: CorrectionDependencies) {
  /** Saves exactly `rules`. A file changed on disk asks the box to reload; nothing is retried. */
  const saveRules = async (
    revision: string,
    rules: DerivedRule[],
  ): Promise<SaveOutcome> => {
    try {
      const result = await deps.saveRules(revision, rules);
      return "kind" in result ? failed(result) : { saved: true, table: result };
    } catch (reason) {
      return {
        saved: false,
        failure: { key: keyOfError(messageOf(reason)) },
        reload: false,
      };
    }
  };
  const savePassed = (
    revision: string,
    rule: DerivedRule,
    passed: readonly string[],
  ): Promise<SaveOutcome> =>
    saveRules(
      revision,
      passed.map((id) => ({ ...rule, entry: { ...rule.entry, model: id } })),
    );
  return {
    load: () => deps.load(),
    derive: async (request: CorrectionRequest): Promise<Derived> => {
      try {
        return {
          status: "ready",
          derivation: await deps.derive(request),
        };
      } catch (reason) {
        return deriveFailure(messageOf(reason));
      }
    },
    /** Listen to the corrected words with one voice (`null`: the selected one). */
    listen: (spoken: string, model: string | null) =>
      deps.listen(spoken, model),
    /** The words Play all plays and the check hears for the rule, per model, as the backend reads them. */
    voices: (
      written: string,
      rule: DerivedRule,
      models: string[],
    ): Promise<VoiceText[]> => deps.voices(written, rule, models),
    /** Saves the rule shown. */
    save: (revision: string, rule: DerivedRule) => saveRules(revision, [rule]),
    /** The save the dialog asks for: the rule shown, or the same rule for the voices that passed. */
    submit: (
      revision: string,
      rule: DerivedRule,
      passed: readonly string[] | null,
    ): Promise<SaveOutcome> =>
      passed === null
        ? saveRules(revision, [rule])
        : savePassed(revision, rule, passed),
    /**
     * Saves the checked rule only for the voices that passed the check: the same rule scoped to
     * each of them, in one save.
     */
    savePassed,
  };
}

/** What a save press needs: the loaded table, the rule shown, and the state that rule was derived for. */
export interface SaveAsk {
  table: VocabularyTable | null;
  rule: DerivedRule | null;
  state: CorrectionState;
  derived: Derived;
}

/**
 * Every save of the dialog goes through here: nothing is written unless `canSave` accepts the
 * state, so a form submitted by Enter cannot save for a scope the owner has not chosen.
 */
export async function attemptSave(
  actions: Pick<ReturnType<typeof createCorrectionActions>, "submit">,
  { table, rule, state, derived }: SaveAsk,
  passed: readonly string[] | null,
): Promise<SaveOutcome | null> {
  if (!table || !rule || !canSave(state, derived)) return null;
  return actions.submit(table.revision, rule, passed);
}

/**
 * The text prompt's Next: the box opens only if the prompt is still the open dialog when the
 * voice answers, so a prompt the owner discarded cannot reopen its text over a newer dialog.
 */
export async function settleNext(
  speak: (written: string) => Promise<string | null>,
  written: string,
  on: {
    live: () => boolean;
    open: (written: string, spokenAs: string) => void;
  },
): Promise<void> {
  const spoken = await speak(written);
  if (spoken !== null && on.live()) on.open(written, spoken);
}

/**
 * A finished save reaches the dialog that asked for it only if that dialog is still open. The
 * written table is shared with the host either way, since the file did change.
 */
export function settleSave(
  outcome: SaveOutcome,
  on: {
    live: () => boolean;
    saved: (table: VocabularyTable) => void;
    close: () => void;
    failed: (outcome: Extract<SaveOutcome, { saved: false }>) => void;
  },
): void {
  if (outcome.saved) {
    on.saved(outcome.table);
    if (on.live()) on.close();
    return;
  }
  if (on.live()) on.failed(outcome);
}

/** The dialog's line for a failed save: a file changed on disk is the dialog conflict line. */
export function correctionNotice(
  outcome: Extract<SaveOutcome, { saved: false }>,
): Failure {
  return outcome.failure.key === "tts.vocabulary.errors.changed"
    ? { key: "tts.vocabulary.dialog.conflict" }
    : outcome.failure;
}

const keyOfError = (message: string) =>
  message.startsWith("tts.errors.") ? message : "tts.errors.generic";

const failed = (error: SaveError): SaveOutcome => ({
  saved: false,
  failure: saveFailure(error),
  reload: error.kind === "changed" || error.kind === "file_invalid",
});

/** Replaces "Should say" with what the microphone heard; nothing heard keeps the field. */
export const applyCapture = (field: string, heard: string) =>
  heard.trim() === "" ? field : heard;

/** The correction microphone: off, recording, or waiting for speech-to-text. */
export type CaptureState = "idle" | "recording" | "transcribing";

export interface CaptureDependencies {
  start: () => Promise<void>;
  /** Stops recording and resolves with the words heard, raw. */
  stop: () => Promise<string>;
  cancel: () => Promise<void>;
  update: (state: CaptureState) => void;
  /** The words heard, for "Should say". */
  heard: (words: string) => void;
  /** A refusal or failure as a translation key; `null` clears the last one. */
  fail: (key: string | null) => void;
}

/** The microphone button: press to record, press again to fill "Should say"; close on unmount. */
export function createCapture(deps: CaptureDependencies) {
  let state: CaptureState = "idle";
  let pending = false;
  let closed = false;
  const set = (next: CaptureState) => {
    state = next;
    if (!closed) deps.update(next);
  };
  const report = (reason: unknown) => {
    if (!closed) deps.fail(keyOfCapture(messageOf(reason)));
  };
  return {
    press: async () => {
      if (pending || state === "transcribing") return;
      pending = true;
      let stopping = false;
      try {
        if (state === "idle") {
          await deps.start();
          if (closed) {
            await deps.cancel();
            return;
          }
          set("recording");
          deps.fail(null);
        } else {
          stopping = true;
          set("transcribing");
          const words = await deps.stop();
          if (!closed) deps.heard(words);
        }
      } catch (reason) {
        report(reason);
      } finally {
        if (stopping) set("idle");
        pending = false;
      }
    },
    /** The box closes: a recording is cancelled, a transcription finishes and its words are dropped. */
    close: () => {
      closed = true;
      if (state === "recording") void deps.cancel().catch(() => {});
    },
  };
}

const keyOfCapture = (message: string) =>
  message.startsWith("tts.") ? message : "tts.errors.generic";
