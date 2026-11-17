import type {
  AcronymStyleRow,
  TtsModelInfo,
  VoiceCheck,
  VoiceText,
} from "@/bindings";

/** How the owner can save after a check: plainly, or one of the choices a miss offers. */
export type SaveOption =
  | "save"
  | "save_all_anyway"
  | "save_passed_only"
  | "pick_one";

/** The models whose round trip heard the words right. */
export function passedModels(results: readonly VoiceCheck[]): string[] {
  return results
    .filter((result) => result.outcome.kind === "heard_right")
    .map((result) => result.model_id);
}

/**
 * The save choices for a check's results. A rule for all voices with a miss offers saving anyway,
 * saving only for the voices that passed (when one did), or picking one voice; anything else saves
 * as it is. The check never blocks a save.
 */
export function saveOptions(
  results: readonly VoiceCheck[],
  scope: string | null,
): SaveOption[] {
  const passed = passedModels(results);
  if (scope !== null || passed.length === results.length) return ["save"];
  return passed.length > 0
    ? ["save_all_anyway", "save_passed_only", "pick_one"]
    : ["save_all_anyway", "pick_one"];
}

/** The voices a check covers: the chosen one, or every downloaded voice for all voices. */
export function checkedModels(
  scope: string | null,
  models: readonly TtsModelInfo[],
): string[] {
  if (scope !== null) return [scope];
  return models.filter((model) => model.downloaded).map((model) => model.id);
}

/**
 * What each voice is asked to say. An acronym is said the way that voice reads acronyms, its
 * effective style from the Vocabulary tab: written capitals ("CLI") or spaced letters ("C L I");
 * anything else is `spoken` on every voice.
 */
export function voiceTexts(
  models: readonly string[],
  spoken: string,
  acronym: string | null,
  styles: readonly AcronymStyleRow[],
): VoiceText[] {
  const styleOf = (model: string) =>
    (
      styles.find((row) => row.model === model) ??
      styles.find((row) => row.model === null)
    )?.effective ?? "spaced";
  return models.map((model_id) => ({
    model_id,
    spoken:
      acronym === null
        ? spoken
        : styleOf(model_id) === "capitals"
          ? acronym.toUpperCase()
          : [...acronym].map((letter) => letter.toUpperCase()).join(" "),
  }));
}

/** What the check shows: its results, whether one is running, and a failure to start it. */
export interface VoiceCheckState {
  results: VoiceCheck[] | null;
  checking: boolean;
  error: string | null;
}

export interface VoiceCheckDependencies {
  play: (voices: VoiceText[]) => Promise<void>;
  check: (voices: VoiceText[]) => Promise<VoiceCheck[]>;
  update: (state: VoiceCheckState) => void;
}

/**
 * Runs the check across voices. `target` names the words per voice and the match options; new
 * words or voices drop the results and any check still running, and a new match option checks
 * again once a check has run. `playAndCheck` plays every voice and checks them alongside.
 */
export function createVoiceCheck(deps: VoiceCheckDependencies) {
  let voices: VoiceText[] = [];
  let words = "";
  let matchKey = "";
  let checked = false;
  let run = 0;
  let state: VoiceCheckState = { results: null, checking: false, error: null };
  const set = (change: Partial<VoiceCheckState>) => {
    state = { ...state, ...change };
    deps.update(state);
  };
  const check = async () => {
    const mine = ++run;
    checked = true;
    set({ checking: true, error: null });
    try {
      const results = await deps.check(voices);
      if (mine === run) set({ results, checking: false });
    } catch (reason) {
      if (mine === run) set({ error: errorKey(reason), checking: false });
    }
  };
  return {
    target: (next: readonly VoiceText[], matching: string) => {
      const nextWords = JSON.stringify(next);
      if (nextWords !== words) {
        words = nextWords;
        voices = [...next];
        matchKey = matching;
        checked = false;
        run += 1;
        set({ results: null, checking: false, error: null });
        return;
      }
      if (matching === matchKey) return;
      matchKey = matching;
      if (checked) void check();
    },
    playAndCheck: () => {
      set({ error: null });
      deps.play(voices).catch((reason) => set({ error: errorKey(reason) }));
      return check();
    },
  };
}

/** Backend failures arrive as `tts.*` keys; anything else is the generic failure. */
function errorKey(reason: unknown) {
  const message = reason instanceof Error ? reason.message : "";
  return message.startsWith("tts.") ? message : "tts.errors.generic";
}
