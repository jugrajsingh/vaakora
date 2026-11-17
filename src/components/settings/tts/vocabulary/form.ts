import type {
  EntryKey,
  EntryRow,
  Rule,
  Section,
  TermMatch,
  TtsModelInfo,
} from "@/bindings";

export interface EntryForm {
  written: string;
  section: Section;
  spoken: string;
  skip: boolean;
  matching: TermMatch;
  caseSensitive: boolean;
  model: string | null;
}

export const SECTIONS: Section[] = ["symbol", "extension", "term", "acronym"];
/** The two match choices the editor offers; a row's own other choice stays listed. */
export const EDITOR_MATCHES: TermMatch[] = ["whole", "anywhere"];

export function initialForm(row: EntryRow | null): EntryForm {
  const term =
    row && typeof row.matching !== "string" ? row.matching.term : null;
  return {
    written: row?.id.entry.key ?? "",
    section: row?.id.entry.section ?? "term",
    spoken: row?.spoken ?? "",
    skip: row?.skip ?? false,
    matching: term?.matching ?? "whole",
    caseSensitive: term?.case ?? true,
    model: row?.id.entry.model ?? null,
  };
}

/** What the owner still has to fill in before the entry can be saved. */
export function formComplete(form: EntryForm) {
  if (!form.written.trim()) return false;
  if (form.section === "acronym") return true;
  if (form.section === "term" && form.skip) return true;
  return form.spoken.trim() !== "";
}

/** The edit's entry, rule and previous key; only an owner row's key is replaced by a rename. */
export function formSubmission(form: EntryForm, initial: EntryRow | null) {
  const entry: EntryKey = {
    section: form.section,
    model: form.model,
    key: form.written.trim(),
  };
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
  const previous = initial?.id.origin === "owner" ? initial.id.entry : null;
  return { entry, rule, previous };
}

/**
 * An edit of a row shown from several table rows: the rule goes to every member's scope and
 * each owner member's old key is replaced. The scope field is not used.
 */
export function membersSubmission(
  form: EntryForm,
  members: readonly EntryRow[],
) {
  const { entry, rule } = formSubmission(form, null);
  return {
    entries: members.map((member) => ({
      ...entry,
      model: member.id.entry.model,
    })),
    rule,
    previous: members.map((member) =>
      member.id.origin === "owner" ? member.id.entry : null,
    ),
  };
}

/** The voices a check covers for rows that show as one: every downloaded voice, or the named ones. */
export function membersModels(
  members: readonly EntryRow[],
  models: readonly TtsModelInfo[],
) {
  if (members.some((member) => member.id.entry.model === null)) {
    return models.filter((model) => model.downloaded).map((model) => model.id);
  }
  return [...new Set(members.flatMap((member) => member.id.entry.model ?? []))];
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

/** All voices, every downloaded model, and the row's own model even when it is not downloaded. */
export function scopeChoices(
  models: readonly TtsModelInfo[],
  current: string | null,
) {
  const ids = models
    .filter((model) => model.downloaded || model.id === current)
    .map((model) => model.id);
  return current !== null && !ids.includes(current) ? [...ids, current] : ids;
}
