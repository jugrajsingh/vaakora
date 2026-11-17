import { useTranslation } from "react-i18next";
import type { TtsModelInfo } from "@/bindings";
import type { RowGroup, VoiceOption } from "./groups";
import { modelName } from "./labels";

const ALL = "all";
const CHIP = "inline-block border rounded-full px-2 text-xs";

/**
 * The voices a row reads for, as chips, and a picker to add or remove one. An option that no
 * safe edit can make is shown but off.
 */
export function VoiceChips({
  group,
  models,
  options,
  readOnly,
  change,
}: {
  group: RowGroup;
  models: readonly TtsModelInfo[];
  options: readonly VoiceOption[];
  readOnly: boolean;
  /** The voice to add or remove; `null` is all voices. */
  change: (voice: string | null) => void;
}) {
  const { t } = useTranslation();
  const name = (voice: string | null) =>
    voice === null ? t("tts.vocabulary.voices.all") : modelName(models, voice);
  return (
    <div className="flex flex-wrap items-center gap-1">
      {group.all ? (
        <>
          <span className={`${CHIP} border-logo-primary text-logo-primary`}>
            {t("tts.vocabulary.voices.all")}
          </span>
          {group.except.length > 0 && (
            <span className="text-xs text-ink-3">
              {t("tts.vocabulary.voices.except", {
                names: group.except.map(name).join(", "),
              })}
            </span>
          )}
        </>
      ) : (
        group.models.map((model) => (
          <span key={model} className={`${CHIP} border-line`}>
            {name(model)}
          </span>
        ))
      )}
      {!readOnly && options.some((option) => option.enabled) && (
        <details className="relative">
          <summary
            className={`${CHIP} border-dashed border-line cursor-pointer list-none text-ink-3`}
          >
            {t("tts.vocabulary.voices.add")}
          </summary>
          <div className="absolute start-0 z-50 mt-1 min-w-48 bg-background border border-line rounded-lg shadow-lg p-1">
            {options.map((option) => (
              <button
                key={option.voice ?? ALL}
                type="button"
                className="flex w-full gap-2 rounded-md px-2 py-1 text-sm text-start hover:bg-wash disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={!option.enabled}
                aria-pressed={option.selected}
                onClick={() => change(option.voice)}
              >
                <span className="w-3">{option.selected ? "\u2713" : ""}</span>
                {name(option.voice)}
              </button>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
