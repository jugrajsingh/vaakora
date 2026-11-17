import React, { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/Button";

export interface InlineConfirmProps {
  message: string;
  action: string;
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
        {t("common.cancel")}
      </Button>
      <Button variant="danger" size="sm" onClick={onConfirm}>
        {action}
      </Button>
    </div>
  );
}

/**
 * Holds one change waiting for its confirmation. `confirm` applies the last asked change once
 * and clears it before applying, so a second press or a press after Cancel does nothing.
 */
export function createPendingConfirm<T>(deps: {
  show: (pending: T | null) => void;
  apply: (pending: T) => Promise<void> | void;
}): { ask(pending: T): void; cancel(): void; confirm(): Promise<void> } {
  let pending: T | null = null;
  const set = (next: T | null) => {
    pending = next;
    deps.show(next);
  };
  return {
    ask: set,
    cancel: () => set(null),
    confirm: async () => {
      if (pending === null) return;
      const change = pending;
      set(null);
      await deps.apply(change);
    },
  };
}

/**
 * A row's question: `ask` shows it, `confirm` applies the asked key once, and `prune` drops it
 * when `present` says the asked row is gone.
 */
export function createRowConfirm<K>(deps: {
  show: (key: K | null) => void;
  present: (key: K) => boolean;
  apply: (key: K) => Promise<void> | void;
}): { ask(key: K): void; confirm(): void; cancel(): void; prune(): void } {
  let asked: K | null = null;
  const pending = createPendingConfirm<K>({
    show: (key) => {
      asked = key;
      deps.show(key);
    },
    apply: deps.apply,
  });
  return {
    ask: pending.ask,
    confirm: () => void pending.confirm(),
    cancel: pending.cancel,
    prune: () => {
      if (asked !== null && !deps.present(asked)) pending.cancel();
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

/**
 * Returns focus to the row a confirmation closed on: when `asking` goes from a key to null, focuses
 * the `returnTarget` of the element marked `data-confirm-row` with that key, if it is still shown.
 */
export function useFocusReturn<T extends HTMLElement>(asking: string | null) {
  const container = useRef<T>(null);
  const previous = useRef(asking);
  useEffect(() => {
    const key = rowToRefocus(previous.current, asking);
    previous.current = asking;
    if (key === null || !container.current) return;
    const row = [
      container.current,
      ...container.current.querySelectorAll<HTMLElement>("[data-confirm-row]"),
    ].find((element) => element.dataset.confirmRow === key);
    if (row) returnTarget(row.querySelectorAll("button"))?.focus();
  }, [asking]);
  return container;
}
