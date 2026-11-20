import type {
  Edit,
  EntryRow,
  Matching,
  Origin,
  Problem,
  Rule,
  Section,
} from "@/bindings";

/** What a built-in row reads when your entry overrides it, and the voices (`null`: all) it is for. */
export interface Fallback {
  spoken: string;
  skip: boolean;
  models: (string | null)[];
}

/**
 * One row of the Vocabulary table: table rows of one source that read the same (written text,
 * kind, words, match options and switch), shown once with the voices they reach.
 */
export interface RowGroup {
  key: string;
  /** Identifies the reading: everything but the switch. */
  reading: string;
  origin: Origin;
  section: Section;
  written: string;
  spoken: string;
  skip: boolean;
  matching: Matching;
  enabled: boolean;
  /** The rows this group edits. */
  members: EntryRow[];
  /** Built-in rows the members override at the same scope. */
  replaced: EntryRow[];
  /** The members that override a built-in row: the ones Reset to default acts on. */
  overriding: EntryRow[];
  /** What the overridden built-in rows read, shown as "default: ..."; empty when none is. */
  defaults: Fallback[];
  /** A member applies to all voices. */
  all: boolean;
  /** The voices named by the members, in catalog order. */
  models: string[];
  /** Voices an all-voices row does not reach because another enabled row reads them itself. */
  except: string[];
  problems: Problem[];
  /** A built-in row switched off or shadowed by you, or your entry overriding a built-in. */
  changed: boolean;
}

/** All models, or an explicit list of voice models. */
export type VoiceTarget = { all: true } | { models: string[] };

const scopeId = (row: EntryRow) =>
  JSON.stringify([row.id.entry.section, row.id.entry.model, row.id.entry.key]);

const unique = <T>(items: readonly T[]) => [...new Set(items)];

const rank = (origin: Origin) => (origin === "owner" ? 1 : 0);

function byCatalog(modelIds: readonly string[]) {
  const at = (id: string) => {
    const index = modelIds.indexOf(id);
    return index === -1 ? modelIds.length : index;
  };
  return (a: string, b: string) => at(a) - at(b) || a.localeCompare(b);
}

/** The groups of `rows`; `modelIds` are the catalog's voice models in display order. */
export function groupRows(
  rows: readonly EntryRow[],
  modelIds: readonly string[],
): RowGroup[] {
  const owned = new Map<string, EntryRow>();
  for (const candidate of rows) {
    if (candidate.id.origin === "owner" && candidate.replaces_builtin) {
      owned.set(scopeId(candidate), candidate);
    }
  }
  const overridden = new Map<EntryRow, EntryRow>();
  const standing: EntryRow[] = [];
  for (const candidate of rows) {
    const by =
      candidate.id.origin === "builtin" ? owned.get(scopeId(candidate)) : null;
    if (by) overridden.set(candidate, by);
    else standing.push(candidate);
  }
  const defaultOf = new Map<EntryRow, EntryRow>();
  for (const [builtin, by] of overridden) defaultOf.set(by, builtin);

  const sortModels = byCatalog(modelIds);
  const buckets = new Map<string, RowGroup>();
  for (const member of standing) {
    const reading = JSON.stringify([
      member.id.origin,
      member.id.entry.section,
      member.id.entry.key,
      member.spoken,
      member.skip,
      member.matching,
    ]);
    const key = JSON.stringify([reading, member.enabled]);
    const found = buckets.get(key);
    if (found) {
      found.members.push(member);
      continue;
    }
    buckets.set(key, {
      key,
      reading,
      origin: member.id.origin,
      section: member.id.entry.section,
      written: member.id.entry.key,
      spoken: member.spoken,
      skip: member.skip,
      matching: member.matching,
      enabled: member.enabled,
      members: [member],
      replaced: [],
      overriding: [],
      defaults: [],
      all: false,
      models: [],
      except: [],
      problems: [],
      changed: false,
    });
  }
  const groups = [...buckets.values()];
  for (const group of groups) {
    for (const member of group.members) {
      const replaced = defaultOf.get(member);
      if (!replaced) continue;
      group.overriding.push(member);
      group.replaced.push(replaced);
      const existing = group.defaults.find(
        (found) =>
          found.spoken === replaced.spoken && found.skip === replaced.skip,
      );
      if (existing) existing.models.push(member.id.entry.model);
      else {
        group.defaults.push({
          spoken: replaced.spoken,
          skip: replaced.skip,
          models: [member.id.entry.model],
        });
      }
    }
    group.all = group.members.some((member) => member.id.entry.model === null);
    for (const fallback of group.defaults) {
      fallback.models.sort((a, b) =>
        a === null || b === null
          ? Number(b === null) - Number(a === null)
          : sortModels(a, b),
      );
    }
    group.models = unique(
      group.members.flatMap((member) => member.id.entry.model ?? []),
    ).sort(sortModels);
    const problems = group.members.flatMap((member) => member.problems);
    group.problems = [
      ...new Map(problems.map((p) => [JSON.stringify(p), p])).values(),
    ];
    group.changed =
      group.origin === "owner"
        ? group.overriding.length > 0
        : !group.enabled ||
          group.problems.some(
            (problem) =>
              typeof problem !== "string" &&
              "shadowed" in problem &&
              problem.shadowed.by.origin === "owner",
          );
  }
  for (const group of groups) {
    if (!group.all) continue;
    group.except = unique(
      groups
        .filter(
          (other) =>
            other !== group &&
            other.enabled &&
            other.section === group.section &&
            other.written === group.written &&
            rank(other.origin) >= rank(group.origin),
        )
        .flatMap((other) => other.models),
    )
      .filter((id) => modelIds.includes(id))
      .sort(sortModels);
  }
  return groups.sort(
    (a, b) =>
      a.written.toLowerCase().localeCompare(b.written.toLowerCase()) ||
      rank(b.origin) - rank(a.origin) ||
      Number(b.all) - Number(a.all) ||
      a.models.join().localeCompare(b.models.join()) ||
      a.key.localeCompare(b.key),
  );
}

/** The rule that writes a group's reading back as an owner entry. */
export function ruleOf(group: RowGroup): Rule {
  const { matching } = group;
  if (typeof matching !== "string") {
    return {
      say: group.skip ? null : group.spoken,
      matching: matching.term.matching,
      case: matching.term.case,
    };
  }
  return {
    say: group.section === "acronym" ? null : group.spoken,
    matching: null,
    case: null,
  };
}

const entryAt = (group: RowGroup, model: string | null) => ({
  section: group.section,
  model,
  key: group.written,
});

/** Members in the order a plan writes them: all voices first, then catalog order. */
export const scopesOf = (group: RowGroup, modelIds: readonly string[]) => {
  const sortModels = byCatalog(modelIds);
  return [
    ...(group.all ? [null] : []),
    ...group.models.slice().sort(sortModels),
  ];
};

/**
 * The owner-file edits that make `group` read for exactly `target`, in one save; `null` when no
 * safe edit does. Your own entry gains a voice as an entry in that voice's section and loses one
 * by deleting it (an all-voices entry is rewritten as a list); a built-in row gains a voice by
 * removing that voice's switch and loses one with a switch. An edit never leaves the row with no
 * voice, never replaces another owner entry, and never touches a switched-off row.
 */
export function voicesPlan(
  group: RowGroup,
  target: VoiceTarget,
  groups: readonly RowGroup[],
  modelIds: readonly string[],
): Edit[] | null {
  if (!group.enabled) return null;
  const next: (string | null)[] = "all" in target ? [null] : target.models;
  if (next.length === 0) return null;
  const current = scopesOf(group, modelIds);
  const added = next.filter((scope) => !current.includes(scope));
  const removed = current.filter((scope) => !next.includes(scope));
  if (group.origin === "owner") {
    const taken = groups
      .filter(
        (other) =>
          other !== group &&
          other.origin === "owner" &&
          other.section === group.section &&
          other.written === group.written,
      )
      .flatMap((other) => scopesOf(other, modelIds));
    if (added.some((scope) => taken.includes(scope))) return null;
    const rule = ruleOf(group);
    return [
      ...added.map(
        (scope): Edit => ({
          kind: "put",
          entry: entryAt(group, scope),
          rule,
          previous: null,
        }),
      ),
      ...removed.map(
        (scope): Edit => ({ kind: "delete", entry: entryAt(group, scope) }),
      ),
    ];
  }
  if (group.all || "all" in target) return null;
  const switches = (rows: readonly EntryRow[], enabled: boolean) =>
    rows.map(
      (member): Edit => ({ kind: "set_enabled", id: member.id, enabled }),
    );
  const twins = groups
    .filter(
      (other) =>
        other !== group && !other.enabled && other.reading === group.reading,
    )
    .flatMap((other) => other.members);
  const switchedOn = added.map((scope) =>
    twins.find((member) => member.id.entry.model === scope),
  );
  if (switchedOn.some((member) => member === undefined)) return null;
  return [
    ...switches(switchedOn as EntryRow[], true),
    ...switches(
      group.members.filter((member) => removed.includes(member.id.entry.model)),
      false,
    ),
  ];
}

/**
 * The edits that switch `group` off, or back on when it is off, in one save. A built-in row for
 * all voices is switched off by a top-level switch that also turns off the same built-in entry in
 * every voice's section, so each other built-in reading of that entry the row does not list is
 * first saved as your own entry (your entries are not reached by built-in switches); those
 * voices keep reading as they did. Switching back on only removes the switch.
 */
export function switchPlan(
  group: RowGroup,
  groups: readonly RowGroup[],
): Edit[] {
  const enabled = !group.enabled;
  const switches = group.members.map(
    (member): Edit => ({ kind: "set_enabled", id: member.id, enabled }),
  );
  if (
    enabled ||
    group.origin !== "builtin" ||
    !group.members.some((member) => member.id.entry.model === null)
  ) {
    return switches;
  }
  const kept = group.except.flatMap((voice) =>
    groups
      .filter(
        (other) =>
          other !== group &&
          other.origin === "builtin" &&
          other.enabled &&
          other.section === group.section &&
          other.written === group.written &&
          other.models.includes(voice),
      )
      .map(
        (other): Edit => ({
          kind: "put",
          entry: entryAt(other, voice),
          rule: ruleOf(other),
          previous: null,
        }),
      ),
  );
  return [...kept, ...switches];
}

/** `switchPlan` for the group with `key` among the groups of the latest `rows`; `null` when gone. */
export function switchPlanFor(
  rows: readonly EntryRow[],
  modelIds: readonly string[],
  key: string,
): Edit[] | null {
  const groups = groupRows(rows, modelIds);
  const group = groups.find((found) => found.key === key);
  return group ? switchPlan(group, groups) : null;
}
