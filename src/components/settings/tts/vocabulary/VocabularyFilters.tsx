import { useTranslation } from "react-i18next";
import type { Section, TtsModelInfo } from "@/bindings";
import { FilterChip } from "@/components/shared/FilterChip";
import { Dropdown } from "@/components/ui/Dropdown";
import type { Filters, SourceFilter } from "./filter";
import { kindLabel, modelName, originLabel } from "./labels";

const ANY = "";
const KINDS: Section[] = ["symbol", "extension", "term", "acronym"];
const SOURCES: SourceFilter[] = ["builtin", "owner", "changed"];
/** Fixed 132 px wrapper; the arbitrary variant replaces the trigger's 200 px minimum so three fit 528 px. */
const PICKER = "w-[132px] shrink-0 [&>button]:min-w-0";
const MENU = "start-0 min-w-40";

/** The Model, Kind and Source pickers and the Problems chip. */
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
        className={PICKER}
        menuClassName={MENU}
        selectedValue={filters.voice ?? ANY}
        options={[
          any(t("tts.vocabulary.filters.model")),
          ...models.map((model) => ({
            value: model.id,
            label: modelName(models, model.id),
          })),
        ]}
        onSelect={(voice) => setFilters({ ...filters, voice: voice || null })}
      />
      <Dropdown
        tone="neutral"
        className={PICKER}
        menuClassName={MENU}
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
        className={PICKER}
        menuClassName={MENU}
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
      <FilterChip
        pressed={filters.onlyProblems}
        onToggle={() =>
          setFilters({ ...filters, onlyProblems: !filters.onlyProblems })
        }
      >
        {t("tts.vocabulary.filters.problems")}
      </FilterChip>
    </div>
  );
}
