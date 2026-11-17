export const MAX_LIMIT = 1000;

/** A limit the owner typed: a whole number from 0 to 1000, or `null`. */
export function parseLimit(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value <= MAX_LIMIT ? value : null;
}

/**
 * The limit field: typing only edits a draft, and the draft is committed on blur or Enter, so a
 * half-typed number never prunes the history. An invalid or unchanged draft is dropped.
 */
export function createLimitField(deps: {
  current: () => number;
  update: (limit: number) => void;
  show: (draft: string | null) => void;
}) {
  let draft: string | null = null;
  const set = (next: string | null) => {
    draft = next;
    deps.show(next);
  };
  const commit = () => {
    const value = draft === null ? null : parseLimit(draft);
    if (value !== null && value !== deps.current()) deps.update(value);
    set(null);
  };
  return {
    type: set,
    commit,
    key: (name: string) => {
      if (name === "Enter") commit();
    },
  };
}
