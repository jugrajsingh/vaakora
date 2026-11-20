import type { Edit, EntryRow, Rule, Section } from "@/bindings";
import {
  groupRows,
  ruleOf,
  scopesOf,
  voicesPlan,
  type RowGroup,
} from "./groups";

/** What the entry dialog saves. A scope is a voice model, or `null` for all models. */
export interface EntryDraft {
  section: Section;
  /** Trimmed. */
  written: string;
  rule: Rule;
  /** The checked scopes. */
  scopes: readonly (string | null)[];
  /** The entry's scopes when the dialog opened; empty for Add entry. */
  opened: readonly (string | null)[];
}

/**
 * Why a save plans nothing: no scope is checked, the entry is gone, another entry of yours holds
 * a checked scope, or no switch makes the built-in scope change.
 */
export type EntryRefusal = "empty" | "gone" | "taken" | "builtin-scope";

/** The edits of one save, or why there are none. */
export type EntryPlan = Edit[] | EntryRefusal;

type Scope = string | null;

/** Checking all models clears the models; checking a model clears all models. */
export function toggleScope(scopes: readonly Scope[], scope: Scope): Scope[] {
  if (scopes.includes(scope)) return scopes.filter((found) => found !== scope);
  if (scope === null) return [null];
  return [...scopes.filter((found) => found !== null), scope];
}

/** The key the file stores for `written`, as the backend normalises it. */
const storedKey = (section: Section, written: string) =>
  section === "extension" ? written.replace(/^\./, "").toLowerCase() : written;

const sameRule = (a: Rule, b: Rule) =>
  a.say === b.say && a.matching === b.matching && a.case === b.case;

const sameScopes = (a: readonly Scope[], b: readonly Scope[]) =>
  a.length === b.length && a.every((scope) => b.includes(scope));

const putAt = (
  draft: EntryDraft,
  scope: Scope,
  previous: EntryRow | undefined,
): Edit => ({
  kind: "put",
  entry: { section: draft.section, model: scope, key: draft.written },
  rule: draft.rule,
  previous: previous?.id.entry ?? null,
});

/**
 * The edits that save `draft` for the group with `key` (`null`: Add entry), planned against the
 * latest `rows`. A put never lands on an entry of yours outside the edited group, and a scope is
 * deleted or switched off only when it was open in the dialog and is now unchecked.
 */
export function entryEdits(
  rows: readonly EntryRow[],
  modelIds: readonly string[],
  key: string | null,
  draft: EntryDraft,
): EntryPlan {
  if (draft.scopes.length === 0) return "empty";
  const groups = groupRows(rows, modelIds);
  const group = key === null ? null : groups.find((found) => found.key === key);
  if (group === undefined) return "gone";
  const written = storedKey(draft.section, draft.written);
  const members: readonly EntryRow[] = group?.members ?? [];
  const taken = rows.some(
    (other) =>
      other.id.origin === "owner" &&
      !members.includes(other) &&
      other.id.entry.section === draft.section &&
      other.id.entry.key === written &&
      draft.scopes.includes(other.id.entry.model),
  );
  if (taken) return "taken";
  if (group === null) {
    return draft.scopes.map((scope) => putAt(draft, scope, undefined));
  }
  const current = scopesOf(group, modelIds);
  const target = [
    ...draft.scopes,
    ...current.filter(
      (scope) => !draft.opened.includes(scope) && !draft.scopes.includes(scope),
    ),
  ];
  const sameReading =
    draft.section === group.section &&
    written === group.written &&
    sameRule(draft.rule, ruleOf(group));
  if (sameReading && sameScopes(target, current)) return [];
  if (group.origin === "owner") return ownerEdits(group, draft);
  if (!sameReading) {
    return draft.scopes.map((scope) => putAt(draft, scope, undefined));
  }
  return (
    voicesPlan(
      group,
      target.includes(null)
        ? { all: true }
        : { models: target.filter((scope) => scope !== null) },
      groups,
      modelIds,
    ) ?? "builtin-scope"
  );
}

/** Your entry: a put per checked scope, renaming its member, then a delete per unchecked one. */
function ownerEdits(group: RowGroup, draft: EntryDraft): Edit[] {
  const memberAt = (scope: Scope) =>
    group.members.find((member) => member.id.entry.model === scope);
  return [
    ...draft.scopes.map((scope) => putAt(draft, scope, memberAt(scope))),
    ...openedMembers(group.members, draft.opened)
      .filter((member) => !draft.scopes.includes(member.id.entry.model))
      .map((member): Edit => ({ kind: "delete", entry: member.id.entry })),
  ];
}

const openedMembers = (rows: readonly EntryRow[], opened: readonly Scope[]) =>
  rows.filter((member) => opened.includes(member.id.entry.model));

/** One edit of `kind` per row `pick` gives from the group with `key`, at the opened scopes. */
function scopedPlan(
  rows: readonly EntryRow[],
  modelIds: readonly string[],
  key: string,
  opened: readonly Scope[],
  kind: "delete" | "reset",
  pick: (group: RowGroup) => readonly EntryRow[],
): EntryPlan {
  const group = groupRows(rows, modelIds).find((found) => found.key === key);
  const chosen = group ? openedMembers(pick(group), opened) : [];
  if (chosen.length === 0) return "gone";
  return chosen.map((member): Edit => ({ kind, entry: member.id.entry }));
}

/** Deletes the entries of yours in the group with `key` at the scopes the dialog opened with. */
export const deletePlan = (
  rows: readonly EntryRow[],
  modelIds: readonly string[],
  key: string,
  opened: readonly Scope[],
) =>
  scopedPlan(rows, modelIds, key, opened, "delete", (group) =>
    group.origin === "owner" ? group.members : [],
  );

/** Resets the group's entries that override a built-in, at the scopes the dialog opened with. */
export const resetPlan = (
  rows: readonly EntryRow[],
  modelIds: readonly string[],
  key: string,
  opened: readonly Scope[],
) =>
  scopedPlan(rows, modelIds, key, opened, "reset", (group) => group.overriding);
