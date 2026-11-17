import assert from "node:assert/strict";
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
  InlineConfirm,
  confirmKey,
  createPendingConfirm,
  createRowConfirm,
  returnTarget,
  rowToRefocus,
} = await import("./InlineConfirm");
const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: en } } });

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
  it("row_confirm_drops_the_question_when_its_row_is_gone", () => {
    const shown: (string | null)[] = [];
    const applied: string[] = [];
    let rows = ["A", "B"];
    const question = createRowConfirm<string>({
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
    question.confirm();
    assert.deepEqual(shown, ["A", null]);
    assert.deepEqual(applied, [], "nothing is deleted after the row went");
    question.ask("B");
    question.confirm();
    question.confirm();
    assert.deepEqual(applied, ["B"]);
  });
});
