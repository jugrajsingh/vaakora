import type { Rule, Section, TermMatch, TtsModelInfo } from "@/bindings";
import type { EntryDraft } from "./entryPlan";
import { scopesOf, type RowGroup } from "./groups";

type Scope = string | null;

export interface EntryForm {
  written: string;
  section: Section;
  spoken: string;
  skip: boolean;
  matching: TermMatch;
  caseSensitive: boolean;
  /** The checked Applies to choices; `null` is all models. */
  scopes: Scope[];
}

export const SECTIONS: Section[] = ["symbol", "extension", "term", "acronym"];
/** The two match choices the editor offers; a row's own other choice stays listed. */
export const EDITOR_MATCHES: TermMatch[] = ["whole", "anywhere"];

/** A new entry is a whole-word, case-sensitive term for all models; a group is read as it is. */
export function initialForm(
  group: RowGroup | null,
  modelIds: readonly string[],
): EntryForm {
  const term =
    group && typeof group.matching !== "string" ? group.matching.term : null;
  return {
    written: group?.written ?? "",
    section: group?.section ?? "term",
    spoken: group?.spoken ?? "",
    skip: group?.skip ?? false,
    matching: term?.matching ?? "whole",
    caseSensitive: term?.case ?? true,
    scopes: group ? scopesOf(group, modelIds) : [null],
  };
}

/** What the owner still has to fill in before the entry can be saved. */
export function formComplete(form: EntryForm) {
  if (!form.written.trim()) return false;
  if (form.section === "acronym") return true;
  if (form.section === "term" && form.skip) return true;
  return form.spoken.trim() !== "";
}

/** The draft a save plans from; `opened` is the entry's scopes when the dialog opened. */
export function entryDraft(
  form: EntryForm,
  opened: readonly Scope[],
): EntryDraft {
  const spoken = form.spoken.trim();
  const rule: Rule =
    form.section === "term"
      ? {
          say: form.skip ? null : spoken,
          matching: form.matching,
          case: form.caseSensitive,
        }
      : {
          say: form.section === "acronym" ? null : spoken,
          matching: null,
          case: null,
        };
  return {
    section: form.section,
    written: form.written.trim(),
    rule,
    scopes: form.scopes,
    opened,
  };
}

/**
 * The words the voice check has each voice say for the entry: its spoken text, an acronym's
 * letters one by one, nothing for a skip.
 */
export function checkText(form: EntryForm) {
  if (form.section === "acronym") return [...form.written.trim()].join(" ");
  if (form.section === "term" && form.skip) return "";
  return form.spoken.trim();
}

/** The models Applies to lists: every downloaded one, then each model in `scopes` that is not. */
export function appliesToChoices(
  models: readonly TtsModelInfo[],
  scopes: readonly Scope[],
): string[] {
  const ids = models
    .filter((model) => model.downloaded)
    .map((model) => model.id);
  const absent = scopes.filter(
    (scope): scope is string => scope !== null && !ids.includes(scope),
  );
  return [...ids, ...new Set(absent)];
}
