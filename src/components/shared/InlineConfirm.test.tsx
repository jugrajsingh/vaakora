import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import en from "../../i18n/locales/en/translation.json";
const {
  mock,
  describe,
  it,
}: {
  mock: { module: (name: string, factory: () => unknown) => void };
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => Promise<void> | void) => void;
} = createRequire(import.meta.url)("bun:test");

const { Button: RealButton } = await import("@/components/ui/Button");
type ButtonProps = Parameters<typeof RealButton>[0];
const buttons: ButtonProps[] = [];
mock.module("@/components/ui/Button", () => ({
  Button: (props: ButtonProps) => {
    buttons.push(props);
    return RealButton(props);
  },
}));
const {
  CONTROL_TARGETS,
  InlineConfirm,
  confirmKey,
  createPendingConfirm,
  refocusRow,
  refocusStep,
  returnTarget,
  rowToRefocus,
  useRowConfirm,
} = await import("./InlineConfirm");
type Recount<T> = import("./InlineConfirm").Recount<T>;
type FocusRoot = import("./InlineConfirm").FocusRoot;
const asRoot = (fake: unknown) => fake as FocusRoot;
const { ClearHistoryView, createClearFlow } = await import("./ClearHistory");
type ClearState<T> = import("./ClearHistory").ClearState<T>;
const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: en } } });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function render(calls: string[]) {
  buttons.length = 0;
  const html = renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <InlineConfirm
        message="Delete 3 stored reads now?"
        action="Delete reads"
        onCancel={() => calls.push("cancel")}
        onConfirm={() => calls.push("confirm")}
      />
    </I18nextProvider>,
  );
  return { html, cancel: buttons[0], confirm: buttons[1] };
}

describe("InlineConfirm", () => {
  it("renders_sentence_cancel_then_red_action", () => {
    const { html, cancel, confirm } = render([]);
    assert.match(html, /role="group"/);
    assert.match(html, /aria-label="Delete 3 stored reads now\?"/);
    const sentence = html.indexOf(">Delete 3 stored reads now?<");
    const cancelAt = html.indexOf(">Cancel<");
    const actionAt = html.indexOf(">Delete reads<");
    assert.ok(sentence >= 0 && sentence < cancelAt && cancelAt < actionAt);
    assert.equal(buttons.length, 2);
    assert.equal(cancel.variant, "secondary");
    assert.equal(cancel.size, "sm");
    assert.equal(cancel.autoFocus, true);
    assert.match(
      cancel.className ?? "",
      /focus-visible:ring-2 focus-visible:ring-logo-primary/,
    );
    assert.equal(confirm.variant, "danger");
    assert.equal(confirm.size, "sm");
  });
  it("cancel_and_confirm_call_their_handlers", () => {
    const calls: string[] = [];
    const { cancel, confirm } = render(calls);
    cancel.onClick?.({} as React.MouseEvent<HTMLButtonElement>);
    assert.deepEqual(calls, ["cancel"]);
    confirm.onClick?.({} as React.MouseEvent<HTMLButtonElement>);
    assert.deepEqual(calls, ["cancel", "confirm"]);
  });
  it("cancel_label_overrides_cancel", () => {
    buttons.length = 0;
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <InlineConfirm
          message="Discard your changes?"
          action="Discard"
          cancel="Keep editing"
          onCancel={() => {}}
          onConfirm={() => {}}
        />
      </I18nextProvider>,
    );
    assert.equal(buttons[0].children, "Keep editing");
    assert.equal(buttons[1].children, "Discard");
    assert.ok(!html.includes(">Cancel<"));
    assert.equal(render([]).cancel.children, "Cancel");
  });
  it("escape_cancels_other_keys_do_not", () => {
    const calls: string[] = [];
    for (const key of ["Enter", " ", "Tab", "a"]) {
      confirmKey(key, () => calls.push(key));
    }
    assert.equal(calls.length, 0);
    confirmKey("Escape", () => calls.push("Escape"));
    assert.deepEqual(calls, ["Escape"]);
  });
  it("confirm_runs_once_and_never_after_cancel", async () => {
    const shown: (number | null)[] = [];
    const applied: number[] = [];
    const pending = createPendingConfirm<number>({
      show: (value) => shown.push(value),
      apply: (value) => {
        applied.push(value);
      },
    });
    pending.ask(1);
    await Promise.all([pending.confirm(), pending.confirm()]);
    assert.deepEqual(applied, [1]);
    pending.ask(2);
    pending.cancel();
    await pending.confirm();
    assert.deepEqual(applied, [1]);
    assert.deepEqual(shown, [1, null, 2, null]);
  });
  it("focus_returns_only_when_no_question_follows", () => {
    assert.equal(rowToRefocus("A", null), "A");
    assert.equal(rowToRefocus("A", "B"), null, "B's question keeps its focus");
    assert.equal(rowToRefocus("A", "A"), null);
    assert.equal(rowToRefocus(null, "A"), null);
    assert.equal(rowToRefocus(null, null), null);
  });
  it("return_target_skips_disabled_and_hidden_buttons", () => {
    const button = (name: string, disabled: boolean, hidden: boolean) => ({
      name,
      disabled,
      closest: (selector: string) =>
        hidden && selector === "details:not([open])" ? {} : null,
    });
    const row = [
      button("Copy", true, false),
      button("Pocket TTS", false, true),
      button("Edit", false, false),
      button("Listen", false, false),
    ];
    assert.equal(returnTarget(row)?.name, "Edit");
    assert.equal(returnTarget([button("Hidden", false, true)]), undefined);
  });
  it("refocus_row_returns_to_the_replaced_control", () => {
    const focused: string[] = [];
    const target = (name: string, tag: string, disabled = false) => ({
      name,
      tag,
      disabled,
      closest: () => null,
      focus: () => focused.push(name),
    });
    const rowOf = (key: string, targets: ReturnType<typeof target>[]) => ({
      dataset: { confirmRow: key },
      querySelectorAll: (selector: string) =>
        targets.filter((item) =>
          selector.split(", ").includes(item.tag),
        ) as Iterable<ReturnType<typeof target>>,
    });
    const limit = rowOf("limit", [
      target("Save", "button", true),
      target("Number", "input"),
    ]);
    const retention = rowOf("retention", [target("Keep", "button")]);
    const root = {
      ...rowOf("", []),
      querySelectorAll: (selector: string) =>
        selector === "[data-confirm-row]"
          ? [limit, retention]
          : ([] as Iterable<ReturnType<typeof target>>),
    };
    const run = (
      previous: string | null,
      asking: string | null,
      selector: string,
    ) => {
      focused.length = 0;
      refocusRow(previous, asking, asRoot(root), selector);
      return [...focused];
    };
    assert.deepEqual(run("limit", null, CONTROL_TARGETS), ["Number"]);
    assert.deepEqual(run("limit", "retention", CONTROL_TARGETS), []);
    assert.deepEqual(run(null, null, CONTROL_TARGETS), []);
    assert.deepEqual(run("limit", null, "button"), [], "the input is skipped");
    assert.deepEqual(run("retention", null, "button"), ["Keep"]);
    confirmCase();
  });
  /** After Confirm the control remounts disabled until the saved change is applied. */
  function confirmCase() {
    let disabled = true;
    const focused: string[] = [];
    const number = {
      get disabled() {
        return disabled;
      },
      closest: () => null,
      focus: () => focused.push("Number"),
    };
    const row = {
      dataset: { confirmRow: "limit" },
      querySelectorAll: () => [number] as Iterable<typeof number>,
    };
    const root = {
      dataset: {},
      querySelectorAll: () => [row] as Iterable<typeof row>,
    };
    const step = (owed: string | null, previous: string | null, free = true) =>
      refocusStep(owed, previous, null, free, asRoot(root), CONTROL_TARGETS);
    const owed = step(null, "limit");
    assert.equal(
      owed,
      "limit",
      "the remounted control is disabled: still owed",
    );
    assert.deepEqual(focused, []);
    assert.equal(
      step(owed, null),
      "limit",
      "still disabled on the next render",
    );
    disabled = false;
    assert.equal(
      step(owed, null, false),
      null,
      "focus moved elsewhere: dropped",
    );
    assert.deepEqual(focused, []);
    assert.equal(
      step(owed, null),
      null,
      "enabled again: focused, no longer owed",
    );
    assert.deepEqual(focused, ["Number"]);
    assert.equal(
      refocusStep(
        "limit",
        null,
        "retention",
        true,
        asRoot(root),
        CONTROL_TARGETS,
      ),
      null,
      "another question opening cancels the debt",
    );
    assert.equal(step(null, null), null);
    assert.deepEqual(focused, ["Number"]);
    const empty = { dataset: {}, querySelectorAll: () => [] };
    assert.equal(
      refocusStep("limit", null, null, true, asRoot(empty), CONTROL_TARGETS),
      null,
      "a row that is gone is no longer owed",
    );
  }
  it("pending_prunes_a_question_whose_row_is_gone", async () => {
    const shown: (string | null)[] = [];
    const applied: string[] = [];
    let rows = ["A", "B"];
    const question = createPendingConfirm<string>({
      show: (key) => shown.push(key),
      present: (key) => rows.includes(key),
      apply: (key) => {
        applied.push(key);
      },
    });
    question.ask("A");
    question.prune();
    assert.deepEqual(shown, ["A"], "a shown row keeps its question");
    rows = ["B"];
    question.prune();
    await question.confirm();
    assert.deepEqual(shown, ["A", null]);
    assert.deepEqual(applied, [], "nothing is deleted after the row went");
    question.ask("B");
    await Promise.all([question.confirm(), question.confirm()]);
    assert.deepEqual(applied, ["B"]);
  });
  it("prune_without_present_keeps_the_question", async () => {
    const applied: number[] = [];
    const question = createPendingConfirm<number>({
      show: () => {},
      apply: (value) => {
        applied.push(value);
      },
    });
    question.ask(1);
    question.prune();
    await question.confirm();
    assert.deepEqual(applied, [1]);
  });
  it("recount_apply_applies_once", async () => {
    const shown: ({ n: number } | null)[] = [];
    const applied: { n: number }[] = [];
    const answer = deferred<Recount<{ n: number }>>();
    const asked = { n: 1 };
    const pending = createPendingConfirm<{ n: number }>({
      show: (value) => shown.push(value),
      apply: (value) => {
        applied.push(value);
      },
      recount: () => answer.promise,
    });
    pending.ask(asked);
    const done = pending.confirm();
    assert.deepEqual(applied, [], "nothing applies before the recount lands");
    answer.resolve("apply");
    await done;
    assert.deepEqual(applied, [asked]);
    assert.equal(applied[0], asked);
    assert.deepEqual(shown, [asked, null]);
  });
  it("recount_change_reasks_and_applies_nothing", async () => {
    const shown: ({ n: number } | null)[] = [];
    const applied: { n: number }[] = [];
    const answers: Recount<{ n: number }>[] = [{ n: 2 }, "apply"];
    const asks: { n: number }[] = [];
    const pending = createPendingConfirm<{ n: number }>({
      show: (value) => shown.push(value),
      apply: (value) => {
        applied.push(value);
      },
      recount: async (value) => {
        asks.push(value);
        return answers.shift() ?? "drop";
      },
    });
    pending.ask({ n: 1 });
    await pending.confirm();
    assert.deepEqual(
      shown[shown.length - 1],
      { n: 2 },
      "the new count is asked",
    );
    assert.deepEqual(applied, []);
    await pending.confirm();
    assert.deepEqual(asks, [{ n: 1 }, { n: 2 }], "the re-ask is recounted too");
    assert.deepEqual(applied, [{ n: 2 }]);
    assert.equal(shown[shown.length - 1], null);
  });
  it("recount_drop_closes", async () => {
    for (const outcome of ["drop", "throw"] as const) {
      const shown: (number | null)[] = [];
      const applied: number[] = [];
      const pending = createPendingConfirm<number>({
        show: (value) => shown.push(value),
        apply: (value) => {
          applied.push(value);
        },
        recount:
          outcome === "drop"
            ? async () => "drop"
            : () => Promise.reject(new Error("list unreadable")),
      });
      pending.ask(1);
      await pending.confirm();
      assert.deepEqual(shown, [1, null], outcome);
      assert.deepEqual(applied, [], outcome);
      await pending.confirm();
      assert.deepEqual(applied, [], `${outcome}: the question is gone`);
    }
  });
  it("cancel_during_recount_applies_nothing", async () => {
    const shown: (number | null)[] = [];
    const applied: number[] = [];
    const answer = deferred<Recount<number>>();
    const pending = createPendingConfirm<number>({
      show: (value) => shown.push(value),
      apply: (value) => {
        applied.push(value);
      },
      recount: () => answer.promise,
    });
    pending.ask(1);
    const done = pending.confirm();
    pending.cancel();
    answer.resolve("apply");
    await done;
    assert.deepEqual(applied, []);
    assert.deepEqual(shown, [1, null]);
    const replaced = deferred<Recount<number>>();
    const appliedAgain: number[] = [];
    const second = createPendingConfirm<number>({
      show: () => {},
      apply: (value) => {
        appliedAgain.push(value);
      },
      recount: () => replaced.promise,
    });
    second.ask(1);
    const late = second.confirm();
    second.ask(1);
    replaced.resolve("apply");
    await late;
    assert.deepEqual(
      appliedAgain,
      [],
      "a question asked again is a new question",
    );
  });
  it("confirm_twice_during_recount_recounts_once", async () => {
    const applied: number[] = [];
    let recounts = 0;
    const answer = deferred<Recount<number>>();
    const pending = createPendingConfirm<number>({
      show: () => {},
      apply: (value) => {
        applied.push(value);
      },
      recount: () => {
        recounts += 1;
        return answer.promise;
      },
    });
    pending.ask(1);
    const first = pending.confirm();
    const second = pending.confirm();
    answer.resolve("apply");
    await Promise.all([first, second]);
    assert.equal(recounts, 1);
    assert.deepEqual(applied, [1]);
  });
  it("unmount_cancel_during_recount_applies_nothing", async () => {
    const shown: (number | null)[] = [];
    const applied: number[] = [];
    const answer = deferred<Recount<number>>();
    const pending = createPendingConfirm<number>({
      show: (value) => shown.push(value),
      apply: (value) => {
        applied.push(value);
      },
      recount: () => answer.promise,
    });
    pending.ask(5);
    const done = pending.confirm();
    pending.cancel();
    answer.resolve("apply");
    await done;
    assert.deepEqual(
      applied,
      [],
      "a host that unmounted cancelled its question",
    );
    assert.deepEqual(shown, [5, null]);
  });
  it("use_row_confirm_cancels_its_question_on_unmount", () => {
    const source = readFileSync(
      new URL("./InlineConfirm.tsx", import.meta.url),
      "utf8",
    );
    const hook = source.slice(source.indexOf("export function useRowConfirm"));
    assert.match(
      hook,
      /useEffect\(\(\) => pending\.cancel, \[pending\]\)/,
      "useRowConfirm registers pending.cancel as an effect cleanup",
    );
  });
  it("use_row_confirm_applies_the_asked_key_once", () => {
    const applied: string[] = [];
    const firstRender: (string | null)[] = [];
    let current: ReturnType<typeof useRowConfirm<string>> | undefined;
    function Probe() {
      current = useRowConfirm<string>({
        apply: (key) => {
          applied.push(key);
        },
      });
      if (firstRender.length === 0) firstRender.push(current.asking);
      return null;
    }
    renderToStaticMarkup(<Probe />);
    assert.deepEqual(firstRender, [null], "no question before ask");
    assert.ok(current);
    current.ask("A");
    current.confirm();
    current.confirm();
    assert.deepEqual(applied, ["A"]);
    current.ask("B");
    current.cancel();
    current.confirm();
    assert.deepEqual(applied, ["A"], "nothing applies after Cancel");
  });
});

type Counted = { n: number; newest: number };

/** A clear flow whose counts finish only when the test resolves them. */
function clearHarness() {
  const shown: ClearState<Counted>[] = [];
  const counts: ReturnType<typeof deferred<Counted | null>>[] = [];
  const clears: ClearState<Counted>[] = [];
  const flow = createClearFlow<Counted>({
    count: () => {
      const answer = deferred<Counted | null>();
      counts.push(answer);
      return answer.promise;
    },
    empty: (counted) => counted.n === 0,
    same: (asked, fresh) =>
      asked.n === fresh.n && asked.newest === fresh.newest,
    clear: async () => {
      clears.push(shown[shown.length - 1]);
    },
    show: (state) => shown.push(state),
  });
  const last = () => shown[shown.length - 1];
  /** Starts `run`, answers the count it asked for with `counted`, and waits for it. */
  const answered = async (
    run: () => Promise<void>,
    counted: Counted | null,
  ) => {
    const done = run();
    counts[counts.length - 1].resolve(counted);
    await done;
  };
  return { shown, counts, clears, flow, last, answered };
}

describe("ClearHistory", () => {
  it("clear_flow_asks_with_the_count", async () => {
    const { counts, flow, last } = clearHarness();
    const pressed = flow.press();
    assert.deepEqual(last(), { kind: "counting" });
    await flow.press();
    assert.equal(counts.length, 1, "a press while counting does nothing");
    counts[0].resolve({ n: 3, newest: 9 });
    await pressed;
    assert.deepEqual(last(), { kind: "asking", counted: { n: 3, newest: 9 } });
  });
  it("clear_flow_recounts_before_clearing", async () => {
    const { counts, clears, flow, last, answered } = clearHarness();
    await answered(flow.press, { n: 3, newest: 9 });
    const confirmed = flow.confirm();
    assert.equal(clears.length, 0, "nothing is cleared before the recount");
    await flow.confirm();
    assert.equal(counts.length, 2, "a second press during the recount");
    counts[1].resolve({ n: 3, newest: 9 });
    await confirmed;
    assert.deepEqual(clears, [{ kind: "clearing" }], "cleared once, shown");
    assert.deepEqual(last(), { kind: "idle" });

    await answered(flow.press, { n: 3, newest: 12 });
    await answered(flow.confirm, { n: 4, newest: 13 });
    assert.deepEqual(last(), { kind: "asking", counted: { n: 4, newest: 13 } });
    assert.equal(clears.length, 1, "a changed count asks again");
    await answered(flow.confirm, { n: 4, newest: 14 });
    assert.deepEqual(
      last(),
      { kind: "asking", counted: { n: 4, newest: 14 } },
      "one entry added and the oldest pruned: same count, newer entry",
    );
    assert.equal(clears.length, 1, "the steady-state change asks again");
    await answered(flow.confirm, { n: 4, newest: 14 });
    assert.equal(
      clears.length,
      2,
      "the re-asked count is cleared once confirmed",
    );
  });
  it("clear_flow_nothing_and_failure", async () => {
    const { counts, clears, flow, last, answered } = clearHarness();
    await answered(flow.press, { n: 0, newest: 4 });
    assert.deepEqual(last(), { kind: "nothing" });
    const stray = flow.confirm();
    assert.equal(counts.length, 1, "a confirm on nothing counts nothing");
    await stray;
    await answered(flow.press, null);
    assert.deepEqual(last(), { kind: "idle" }, "a failed count closes");
    await answered(flow.press, { n: 2, newest: 5 });
    await answered(flow.confirm, { n: 0, newest: 5 });
    assert.deepEqual(last(), { kind: "nothing" });
    await answered(flow.press, { n: 2, newest: 6 });
    await answered(flow.confirm, null);
    assert.deepEqual(last(), { kind: "idle" }, "a failed recount drops");
    assert.equal(clears.length, 0);
  });
  it("clear_flow_cancel_during_recount_applies_nothing", async () => {
    const { counts, clears, flow, last, answered } = clearHarness();
    await answered(flow.press, { n: 3, newest: 9 });
    const confirmed = flow.confirm();
    flow.cancel();
    counts[1].resolve({ n: 3, newest: 9 });
    await confirmed;
    assert.equal(clears.length, 0, "a cancelled question clears nothing");
    assert.deepEqual(last(), { kind: "idle" });
    const pressed = flow.press();
    flow.cancel();
    counts[2].resolve({ n: 3, newest: 9 });
    await pressed;
    assert.deepEqual(
      last(),
      { kind: "idle" },
      "a cancelled press asks nothing",
    );
    await flow.confirm();
    assert.equal(counts.length, 3);
    assert.equal(clears.length, 0);
  });
  it("clear_history_renders_the_question_in_place", () => {
    const view = (state: ClearState<Counted>, refocus = false) => {
      buttons.length = 0;
      return renderToStaticMarkup(
        <I18nextProvider i18n={i18n}>
          <ClearHistoryView<Counted>
            state={state}
            disabled={false}
            refocus={refocus}
            message={(counted) => `Delete ${counted.n} entries?`}
            nothing={i18n.t("history.clear.nothing")}
            press={() => {}}
            confirm={() => {}}
            cancel={() => {}}
          />
        </I18nextProvider>,
      );
    };
    const asking = view({ kind: "asking", counted: { n: 3, newest: 9 } });
    assert.equal(asking.match(/class="basis-full"/g)?.length, 1);
    assert.match(asking, /^<div class="basis-full"><div role="group"/);
    assert.match(asking, /Delete 3 entries\?/);
    assert.deepEqual(
      buttons.map((button) => [button.variant, button.children]),
      [
        ["secondary", "Cancel"],
        ["danger", "Clear history"],
      ],
      "only the question: Cancel and the red Clear history",
    );
    const nothing = view({ kind: "nothing" });
    assert.match(
      nothing,
      /<div class="basis-full"><span role="status" class="text-xs text-ink-2">Nothing to clear\.<\/span><\/div>/,
      "F16: Nothing to clear has its own flex line",
    );
    assert.equal(buttons.length, 1, "no red action on nothing");
    assert.equal(buttons[0].variant, "secondary");
    assert.equal(buttons[0].size, "sm");
    assert.equal(buttons[0].className, "shrink-0");
    assert.equal(buttons[0].children, "Clear history");
    assert.equal(buttons[0].disabled, false);
    for (const kind of ["counting", "clearing"] as const) {
      view({ kind });
      assert.equal(buttons[0].disabled, true, kind);
    }
    view({ kind: "idle" });
    assert.equal(buttons[0].autoFocus, false);
    view({ kind: "idle" }, true);
    assert.equal(buttons[0].autoFocus, true, "Cancel returns focus to it");
  });
  it("clear_history_disabled_with_reason_when_empty", () => {
    const view = (
      state: ClearState<Counted>,
      disabled: boolean,
      empty?: boolean,
    ) => {
      buttons.length = 0;
      return renderToStaticMarkup(
        <I18nextProvider i18n={i18n}>
          <ClearHistoryView<Counted>
            state={state}
            disabled={disabled}
            listEmpty={empty}
            refocus={false}
            message={(counted) => `Delete ${counted.n} entries?`}
            nothing={i18n.t("history.clear.nothing")}
            press={() => {}}
            confirm={() => {}}
            cancel={() => {}}
          />
        </I18nextProvider>,
      );
    };
    const status =
      /<span role="status" class="text-xs text-ink-2">Nothing to clear\.<\/span>/g;
    const empty = view({ kind: "idle" }, true, true);
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0].disabled, true);
    assert.equal(empty.match(status)?.length, 1, "the reason shows once");
    assert.match(empty, /<div class="basis-full"><span role="status"/);
    assert.equal(
      view({ kind: "nothing" }, true, true).match(status)?.length,
      1,
      "the counted-nothing line and the empty reason are one line",
    );
    assert.equal(view({ kind: "idle" }, true).match(status), null);
    assert.equal(view({ kind: "idle" }, true, false).match(status), null);
    assert.equal(
      view({ kind: "idle" }, false, true).match(status),
      null,
      "the reason shows only while the button is off",
    );
    assert.equal(buttons[0].disabled, false);
  });
  it("clear_history_cancels_its_flow_on_unmount", () => {
    const source = readFileSync(
      new URL("./ClearHistory.tsx", import.meta.url),
      "utf8",
    );
    const host = source.slice(source.indexOf("export function ClearHistory<"));
    assert.match(host, /useEffect\(\(\) => flow\.cancel, \[flow\]\)/);
  });
});
