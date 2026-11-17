import { useTranslation } from "react-i18next";
import type { AcronymStyle, AcronymStyleRow, TtsModelInfo } from "@/bindings";
import { Dropdown } from "@/components/ui/Dropdown";
import { modelName } from "./labels";

export const ACRONYM_STYLES: AcronymStyle[] = ["spaced", "capitals"];
const INHERIT = "";

/** How each downloaded voice is given an acronym: spaced letters or written capitals; collapsed until opened. */
export function AcronymStyles({
  styles,
  models,
  readOnly,
  set,
}: {
  styles: readonly AcronymStyleRow[];
  models: readonly TtsModelInfo[];
  readOnly: boolean;
  set: (model: string | null, style: AcronymStyle | null) => void;
}) {
  const { t } = useTranslation();
  const shown = styles.filter(
    (row) =>
      row.model === null ||
      models.some((model) => model.id === row.model && model.downloaded),
  );
  const options = (own: boolean) => [
    ...(own
      ? [{ value: INHERIT, label: t("tts.correction.style.inherit") }]
      : []),
    ...ACRONYM_STYLES.map((style) => ({
      value: style,
      label: t(`tts.correction.style.${style}`),
    })),
  ];
  return (
    <details className="bg-background border border-line rounded-lg p-4">
      <summary className="text-sm font-medium cursor-pointer">
        {t("tts.correction.acronymStyle")}
      </summary>
      <div className="grid mt-2 grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
        {shown.map((row) => (
          <div key={row.model ?? "all"} className="flex items-center gap-2">
            <span className="text-sm flex-grow">
              {row.model === null
                ? t("tts.vocabulary.voices.all")
                : modelName(models, row.model)}
            </span>
            <Dropdown
              disabled={readOnly}
              options={options(row.model !== null)}
              selectedValue={
                row.model === null ? row.effective : (row.owner ?? INHERIT)
              }
              onSelect={(value) =>
                set(
                  row.model,
                  value === INHERIT ? null : (value as AcronymStyle),
                )
              }
            />
          </div>
        ))}
      </div>
    </details>
  );
}
