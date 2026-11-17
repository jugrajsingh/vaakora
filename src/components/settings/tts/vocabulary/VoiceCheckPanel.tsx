import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  commands,
  events,
  type CheckOutcome,
  type TtsModelInfo,
  type VoiceText,
} from "@/bindings";
import { modelName } from "./labels";
import { createVoiceCheck, type VoiceCheckState } from "./voiceCheck";

const errorKey = (reason: unknown) => {
  const message = reason instanceof Error ? reason.message : "";
  return message.startsWith("tts.") ? message : "tts.errors.generic";
};

/** The check across voices: results, progress, the model playing, and the action to start it. */
export interface VoiceCheckRun extends VoiceCheckState {
  playing: string | null;
  /** Plays each voice's words in turn and runs the round trip on each alongside. */
  playAndCheck: () => void;
}

/** Runs the voice check for `voices` (see `createVoiceCheck`); `matching` names the match options. */
export function useVoiceCheck(
  voices: readonly VoiceText[],
  matching: string,
): VoiceCheckRun {
  const [state, setState] = useState<VoiceCheckState>({
    results: null,
    checking: false,
    error: null,
  });
  const [playing, setPlaying] = useState<string | null>(null);
  const controller = useMemo(
    () =>
      createVoiceCheck({
        play: async (targets) => {
          const result = await commands.playTtsVoices(targets);
          if (result.status === "error") throw new Error(result.error);
        },
        check: async (targets) => {
          const result = await commands.checkTtsVoices(targets);
          if (result.status === "error") throw new Error(result.error);
          return result.data;
        },
        update: setState,
      }),
    [],
  );
  const target = JSON.stringify(voices);
  useEffect(() => {
    controller.target(JSON.parse(target) as VoiceText[], matching);
  }, [controller, target, matching]);

  useEffect(() => {
    let open = true;
    let stop: (() => void) | undefined;
    void events.ttsVoicePlaying
      .listen(({ payload }) => setPlaying(payload.model_id))
      .then((unlisten) => {
        if (open) stop = unlisten;
        else unlisten();
      });
    return () => {
      open = false;
      stop?.();
    };
  }, []);

  return {
    ...state,
    playing,
    playAndCheck: () => void controller.playAndCheck(),
  };
}

function outcomeLabel(t: TFunction, outcome: CheckOutcome) {
  switch (outcome.kind) {
    case "heard_right":
      return t("tts.vocabulary.check.heardRight");
    case "missed":
      return t("tts.vocabulary.check.missed", { heard: outcome.heard });
    case "failed":
      return t("tts.vocabulary.check.failed", {
        error: t(errorKey(new Error(outcome.error))),
      });
  }
}

/** What the check found, voice by voice, and which voice is playing. Advisory only. */
export function VoiceCheckPanel({
  run,
  models,
}: {
  run: VoiceCheckRun;
  models: readonly TtsModelInfo[];
}) {
  const { t } = useTranslation();
  const { results, checking, playing, error } = run;
  if (!results && !checking && !playing && !error) return null;
  return (
    <div className="space-y-1 text-sm" aria-live="polite">
      <span className="block text-xs font-medium text-ink-3">
        {t("tts.vocabulary.check.title")}
      </span>
      {playing && (
        <p>
          {t("tts.vocabulary.check.playing", {
            model: modelName(models, playing),
          })}
        </p>
      )}
      {checking && (
        <p className="text-ink-3">{t("tts.vocabulary.check.checking")}</p>
      )}
      {error && (
        <p role="alert" className="text-error">
          {t(error)}
        </p>
      )}
      {results && (
        <ul className="space-y-0.5">
          {results.map((result) => (
            <li key={result.model_id}>
              {t("tts.vocabulary.check.row", {
                model: modelName(models, result.model_id),
                outcome: outcomeLabel(t, result.outcome),
              })}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
