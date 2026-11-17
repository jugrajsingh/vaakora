import { useTranslation } from "react-i18next";
import type { Section, TtsModelInfo } from "@/bindings";
import { Dropdown } from "@/components/ui/Dropdown";
import { Switch } from "@/components/ui/Switch";
import type { Filters, SourceFilter } from "./filter";
import { kindLabel, modelName, originLabel } from "./labels";

const ANY = "";
const KINDS: Section[] = ["symbol", "extension", "term", "acronym"];
const SOURCES: SourceFilter[] = ["builtin", "owner", "changed"];

/** The Voice, Kind and Source pickers and the Only problems switch. */
export function VocabularyFilters({
  filters,
  models,
  setFilters,
}: {
  filters: Filters;
  models: readonly TtsModelInfo[];
  setFilters: (filters: Filters) => void;
}) {
  const { t } = useTranslation();
  const any = (label: string) => ({
    value: ANY,
    label: `${label}: ${t("tts.vocabulary.filters.all")}`,
  });
  const sourceLabel = (source: SourceFilter) =>
    source === "changed"
      ? t("tts.vocabulary.filters.changed")
      : originLabel(t, source);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Dropdown
        tone="neutral"
        selectedValue={filters.voice ?? ANY}
        options={[
          any(t("tts.vocabulary.filters.voice")),
          ...models.map((model) => ({
            value: model.id,
            label: modelName(models, model.id),
          })),
        ]}
        onSelect={(voice) => setFilters({ ...filters, voice: voice || null })}
      />
      <Dropdown
        tone="neutral"
        selectedValue={filters.kind ?? ANY}
        options={[
          any(t("tts.vocabulary.filters.kind")),
          ...KINDS.map((kind) => ({ value: kind, label: kindLabel(t, kind) })),
        ]}
        onSelect={(kind) =>
          setFilters({ ...filters, kind: (kind || null) as Section | null })
        }
      />
      <Dropdown
        tone="neutral"
        selectedValue={filters.source ?? ANY}
        options={[
          any(t("tts.vocabulary.filters.source")),
          ...SOURCES.map((source) => ({
            value: source,
            label: sourceLabel(source),
          })),
        ]}
        onSelect={(source) =>
          setFilters({
            ...filters,
            source: (source || null) as SourceFilter | null,
          })
        }
      />
      <label className="flex items-center gap-2 text-sm">
        <Switch
          checked={filters.onlyProblems}
          onChange={(onlyProblems) => setFilters({ ...filters, onlyProblems })}
        />
        {t("tts.vocabulary.filters.onlyProblems")}
      </label>
    </div>
  );
}
