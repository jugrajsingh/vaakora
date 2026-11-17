import type { Section } from "@/bindings";
import type { RowGroup } from "./groups";

/** Built-in rows, your rows, or built-in entries you overrode, switched off or shadowed. */
export type SourceFilter = "builtin" | "owner" | "changed";

export interface Filters {
  query: string;
  /** A voice model id: rows that apply to it. */
  voice: string | null;
  kind: Section | null;
  source: SourceFilter | null;
  onlyProblems: boolean;
}

export const NO_FILTERS: Filters = {
  query: "",
  voice: null,
  kind: null,
  source: null,
  onlyProblems: false,
};

const reaches = (group: RowGroup, voice: string) =>
  group.all ? !group.except.includes(voice) : group.models.includes(voice);

const fromSource = (group: RowGroup, source: SourceFilter) =>
  source === "changed" ? group.changed : group.origin === source;

/** The groups that pass every filter; a query matches written or spoken text, ignoring case. */
export function filterGroups(
  groups: readonly RowGroup[],
  filters: Filters,
): RowGroup[] {
  const needle = filters.query.trim().toLowerCase();
  return groups.filter(
    (group) =>
      (!needle ||
        [
          group.written,
          group.spoken,
          ...group.defaults.map((fallback) => fallback.spoken),
        ].some((text) => text.toLowerCase().includes(needle))) &&
      (filters.voice === null || reaches(group, filters.voice)) &&
      (filters.kind === null || group.section === filters.kind) &&
      (filters.source === null || fromSource(group, filters.source)) &&
      (!filters.onlyProblems || group.problems.length > 0),
  );
}
