import { useTranslation } from "react-i18next";
import type { TtsModelInfo } from "@/bindings";
import type { RowGroup } from "./groups";
import { modelName } from "./labels";

const CHIP = "inline-block border rounded-full px-2 text-xs";

/** The models a row applies to, as read-only chips; Applies to in the entry dialog changes them. */
export function VoiceChips({
  group,
  models,
}: {
  group: RowGroup;
  models: readonly TtsModelInfo[];
}) {
  const { t } = useTranslation();
  const name = (voice: string) => modelName(models, voice);
  return (
    <div className="flex flex-wrap items-center gap-1">
      {group.all ? (
        <>
          <span className={`${CHIP} border-line-strong bg-sel text-sel-ink`}>
            {t("tts.vocabulary.models.all")}
          </span>
          {group.except.length > 0 && (
            <span className="text-xs text-ink-3">
              {t("tts.vocabulary.models.except", {
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
    </div>
  );
}
