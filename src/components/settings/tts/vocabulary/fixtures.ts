import type { EntryRow, Origin, Section, TtsModelInfo } from "@/bindings";

export function row(
  origin: Origin,
  section: Section,
  key: string,
  patch: Partial<EntryRow> & { model?: string | null } = {},
): EntryRow {
  const { model = null, ...rest } = patch;
  return {
    id: { origin, entry: { section, model, key } },
    spoken: "",
    skip: false,
    matching:
      section === "term"
        ? { term: { matching: "whole", case: true } }
        : section === "acronym"
          ? "acronym"
          : section,
    enabled: true,
    replaces_builtin: false,
    sample: key,
    problems: [],
    ...rest,
  };
}

export const models = [
  { id: "pocket-en", display_name: "Pocket TTS", downloaded: true },
  { id: "supertonic-3", display_name: "Supertonic 3", downloaded: false },
] as TtsModelInfo[];
