import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/Button";
import { InlineConfirm, createPendingConfirm } from "./InlineConfirm";

export type ClearState<T> =
  | { kind: "idle" }
  | { kind: "counting" }
  | { kind: "nothing" }
  | { kind: "asking"; counted: T }
  | { kind: "clearing" };

export interface ClearDeps<T> {
  /** The current count, or `null` after the host showed why it could not count. */
  count: () => Promise<T | null>;
  empty: (counted: T) => boolean;
  same: (asked: T, fresh: T) => boolean;
  clear: () => Promise<void>;
  show: (state: ClearState<T>) => void;
}

/**
 * Clear history as a question with counts: `press` counts and asks, `confirm` counts again and
 * clears only when the fresh count is the asked one (a changed count asks again, nothing left
 * says so), and `cancel` drops the question and any count still running.
 */
export function createClearFlow<T>(deps: ClearDeps<T>): {
  press(): Promise<void>;
  confirm(): Promise<void>;
  cancel(): void;
} {
  let state: ClearState<T> = { kind: "idle" };
  let presses = 0;
  const show = (next: ClearState<T>) => {
    state = next;
    deps.show(next);
  };
  const question = createPendingConfirm<T>({
    show: (counted) =>
      show(
        counted === null
          ? { kind: "idle" }
          : deps.empty(counted)
            ? { kind: "nothing" }
            : { kind: "asking", counted },
      ),
    apply: async () => {
      show({ kind: "clearing" });
      try {
        await deps.clear();
      } finally {
        show({ kind: "idle" });
      }
    },
    recount: async (asked) => {
      const fresh = await deps.count();
      if (fresh === null) return "drop";
      if (deps.empty(fresh)) return fresh;
      return deps.same(asked, fresh) ? "apply" : fresh;
    },
  });
  return {
    press: async () => {
      if (state.kind !== "idle" && state.kind !== "nothing") return;
      presses += 1;
      const pressed = presses;
      show({ kind: "counting" });
      const counted = await deps.count().catch(() => null);
      if (pressed !== presses) return;
      if (counted === null) question.cancel();
      else question.ask(counted);
    },
    confirm: async () => {
      if (state.kind === "asking") await question.confirm();
    },
    cancel: () => {
      presses += 1;
      question.cancel();
    },
  };
}

export function ClearHistoryView<T>({
  state,
  disabled,
  refocus,
  message,
  nothing,
  press,
  confirm,
  cancel,
}: {
  state: ClearState<T>;
  disabled: boolean;
  /** Focuses the button when it shows again after Cancel. */
  refocus: boolean;
  message: (counted: T) => string;
  nothing: string;
  press: () => void;
  confirm: () => void;
  cancel: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  if (state.kind === "asking") {
    return (
      <div className="basis-full">
        <InlineConfirm
          key={JSON.stringify(state.counted)}
          message={message(state.counted)}
          action={t("history.clear.action")}
          onCancel={cancel}
          onConfirm={confirm}
        />
      </div>
    );
  }
  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        className="shrink-0"
        autoFocus={refocus}
        disabled={
          disabled || state.kind === "counting" || state.kind === "clearing"
        }
        onClick={press}
      >
        {t("history.clear.action")}
      </Button>
      {state.kind === "nothing" && (
        <div className="basis-full">
          <span role="status" className="text-xs text-ink-2">
            {nothing}
          </span>
        </div>
      )}
    </>
  );
}

/** A history toolbar's Clear history: one flow per mount, cancelled when the page goes. */
export function ClearHistory<T>({
  disabled,
  message,
  nothing,
  ...deps
}: Omit<ClearDeps<T>, "show"> & {
  disabled: boolean;
  message: (counted: T) => string;
  nothing: string;
}): React.JSX.Element {
  const [state, setState] = useState<ClearState<T>>({ kind: "idle" });
  const [refocus, setRefocus] = useState(false);
  const latest = useRef(deps);
  latest.current = deps;
  const flow = useMemo(
    () =>
      createClearFlow<T>({
        count: () => latest.current.count(),
        empty: (counted) => latest.current.empty(counted),
        same: (asked, fresh) => latest.current.same(asked, fresh),
        clear: () => latest.current.clear(),
        show: setState,
      }),
    [],
  );
  useEffect(() => flow.cancel, [flow]);
  return (
    <ClearHistoryView
      state={state}
      disabled={disabled}
      refocus={refocus}
      message={message}
      nothing={nothing}
      press={() => {
        setRefocus(false);
        void flow.press();
      }}
      confirm={() => void flow.confirm()}
      cancel={() => {
        setRefocus(true);
        flow.cancel();
      }}
    />
  );
}
