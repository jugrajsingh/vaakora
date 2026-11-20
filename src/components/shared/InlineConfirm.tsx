import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/Button";

export interface InlineConfirmProps {
  message: string;
  action: string;
  /** The Cancel button's label; defaults to the common Cancel. */
  cancel?: string;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Escape cancels the confirmation; every other key is left alone. */
export function confirmKey(key: string, onCancel: () => void): void {
  if (key === "Escape") onCancel();
}

/** Replaces a pressed control: what goes and what stays, Cancel (focused) and a red action. */
export function InlineConfirm({
  message,
  action,
  cancel,
  onCancel,
  onConfirm,
}: InlineConfirmProps): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div
      role="group"
      aria-label={message}
      className="flex flex-wrap items-center gap-2"
      onKeyDown={(event) =>
        confirmKey(event.key, () => {
          event.stopPropagation();
          onCancel();
        })
      }
    >
      <span className="text-sm text-text">{message}</span>
      <Button
        variant="secondary"
        size="sm"
        autoFocus
        className="focus-visible:ring-2 focus-visible:ring-logo-primary"
        onClick={onCancel}
      >
        {cancel ?? t("common.cancel")}
      </Button>
      <Button variant="danger" size="sm" onClick={onConfirm}>
        {action}
      </Button>
    </div>
  );
}

/**
 * What a recount decides about the asked change: apply it, drop it, or ask again with a new
 * change. A new change is shown as the pending question; a host that renders one of its own
 * values as terminal (for example a count of nothing) shows it without a red action.
 */
export type Recount<T> = "apply" | "drop" | T;

/**
 * Holds one change waiting for its confirmation. `confirm` applies the last asked change once
 * and clears it before applying, so a second press or a press after Cancel does nothing. With
 * `recount`, `confirm` first asks it about the asked change (a throw drops it) and applies
 * nothing when the question was cancelled, asked again or pruned during the recount; a second
 * `confirm` during the recount does nothing. `prune` drops the question when `present` says
 * what it asked about is gone.
 */
export function createPendingConfirm<T>(deps: {
  show: (pending: T | null) => void;
  apply: (pending: T) => Promise<void> | void;
  present?: (pending: T) => boolean;
  recount?: (pending: T) => Promise<Recount<T>>;
}): {
  ask(pending: T): void;
  cancel(): void;
  confirm(): Promise<void>;
  prune(): void;
} {
  let pending: T | null = null;
  let generation = 0;
  let counting = false;
  const set = (next: T | null) => {
    generation += 1;
    pending = next;
    deps.show(next);
  };
  return {
    ask: set,
    cancel: () => set(null),
    confirm: async () => {
      if (pending === null || counting) return;
      const change = pending;
      if (deps.recount) {
        const asked = generation;
        counting = true;
        let outcome: Recount<T>;
        try {
          outcome = await deps.recount(change);
        } catch {
          outcome = "drop";
        } finally {
          counting = false;
        }
        if (generation !== asked) return;
        if (outcome === "drop") return set(null);
        if (outcome !== "apply") return set(outcome);
      }
      set(null);
      await deps.apply(change);
    },
    prune: () => {
      if (pending !== null && deps.present && !deps.present(pending)) set(null);
    },
  };
}

/** The row to give focus back to: the closed one, unless another row's question just opened. */
export function rowToRefocus(
  closed: string | null,
  next: string | null,
): string | null {
  return closed !== null && next === null ? closed : null;
}

/** The first enabled button that a closed `<details>` does not hide. */
export function returnTarget<
  T extends { disabled: boolean; closest(selector: string): unknown },
>(buttons: Iterable<T>): T | undefined {
  for (const button of buttons) {
    if (!button.disabled && !button.closest("details:not([open])"))
      return button;
  }
  return undefined;
}

export interface RowConfirm<K> {
  /** The key whose question is shown, or null. */
  asking: K | null;
  ask(key: K): void;
  cancel(): void;
  confirm(): void;
}

/**
 * A list host's delete question: `ask` shows it for a key, `confirm` applies that key once,
 * `prune` runs after every render and drops it when `present` says the row is gone, and focus
 * goes back to the closed row's first enabled button. Put `rowsRef` on the element that holds
 * the rows (or is the row); each row carries `data-confirm-row={key}`.
 */
export function useRowConfirm<
  K extends string | number,
  E extends HTMLElement = HTMLDivElement,
>(deps: {
  apply: (key: K) => Promise<void> | void;
  present?: (key: K) => boolean;
}): RowConfirm<K> & { rowsRef: React.RefObject<E> } {
  const [asking, setAsking] = useState<K | null>(null);
  const latest = useRef(deps);
  latest.current = deps;
  const pending = useMemo(
    () =>
      createPendingConfirm<K>({
        show: setAsking,
        apply: (key) => latest.current.apply(key),
        present: (key) => latest.current.present?.(key) ?? true,
      }),
    [],
  );
  useEffect(() => pending.prune());
  useEffect(() => pending.cancel, [pending]);
  const rowsRef = useRef<E>(null);
  const previous = useRef(asking);
  useEffect(() => {
    const key = rowToRefocus(
      previous.current === null ? null : String(previous.current),
      asking === null ? null : String(asking),
    );
    previous.current = asking;
    if (key === null || !rowsRef.current) return;
    const row = [
      rowsRef.current,
      ...rowsRef.current.querySelectorAll<HTMLElement>("[data-confirm-row]"),
    ].find((element) => element.dataset.confirmRow === key);
    if (row) returnTarget(row.querySelectorAll("button"))?.focus();
  }, [asking]);
  return {
    asking,
    ask: pending.ask,
    cancel: pending.cancel,
    confirm: () => void pending.confirm(),
    rowsRef,
  };
}
