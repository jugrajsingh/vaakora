import assert from "node:assert/strict";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import en from "../../../i18n/locales/en/translation.json";
import type { LLMPrompt } from "@/bindings";
import type { EditorDialogProps } from "@/components/shared/EditorDialog";
const {
  mock,
  describe,
  it,
}: {
  mock: { module: (name: string, factory: () => unknown) => void };
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => void | Promise<void>) => void;
} = createRequire(import.meta.url)("bun:test");

// The dialog host is replaced by a recorder that renders its parts inline.
let dialog: EditorDialogProps | undefined;
const recorded = () => dialog;
mock.module("@/components/shared/EditorDialog", () => ({
  EditorDialog: (props: EditorDialogProps) => {
    dialog = props;
    return (
      <div data-dialog="">
        <h2>{props.title}</h2>
        {props.notice && <p data-notice="">{props.notice}</p>}
        {props.children}
      </div>
    );
  },
}));
// State setters record what they are given, so a test can see the notice a failed outcome sets.
const stateSets: unknown[] = [];
const realReact = await import("react");
const realUseState = realReact.useState;
mock.module("react", () => ({
  ...realReact,
  useState: <S,>(initial: S | (() => S)) => {
    const [value, set] = realUseState(initial);
    return [
      value,
      (next: React.SetStateAction<S>) => {
        stateSets.push(next);
        set(next);
      },
    ];
  },
}));
const { PromptDialog, promptDirty, promptReady, settlePrompt } = await import(
  "./PromptDialog"
);
const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: en } } });

const tidy: LLMPrompt = { id: "p1", name: "Tidy", prompt: "Fix the text." };
const calls: string[] = [];

function render(
  prompt: LLMPrompt | null,
  options: {
    canDelete?: boolean;
    save?: (name: string, text: string) => Promise<boolean>;
    remove?: () => Promise<boolean>;
  } = {},
) {
  dialog = undefined;
  calls.length = 0;
  stateSets.length = 0;
  const html = renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <PromptDialog
        prompt={prompt}
        canDelete={options.canDelete ?? true}
        save={
          options.save ??
          (async (name, text) => {
            calls.push(`save:${name}|${text}`);
            return true;
          })
        }
        remove={
          options.remove ??
          (async () => {
            calls.push("remove");
            return true;
          })
        }
        close={() => calls.push("close")}
      />
    </I18nextProvider>,
  );
  const seen = recorded();
  assert.ok(seen, "the prompt dialog renders on the editor dialog");
  return { html, dialog: seen };
}
/** The form the dialog puts in its body. */
function formOf(props: EditorDialogProps) {
  const form = props.children;
  assert.ok(
    React.isValidElement(form) && form.type === "form",
    "the body is one form",
  );
  return form as React.ReactElement<{
    id: string;
    onSubmit: (event: { preventDefault: () => void }) => void;
  }>;
}
const submit = (props: EditorDialogProps) =>
  formOf(props).props.onSubmit({ preventDefault: () => {} });
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("PromptDialog", () => {
  it("new_prompt_has_no_delete", () => {
    const { html, dialog: seen } = render(null);
    assert.equal(seen.title, "New prompt");
    assert.deepEqual(seen.removals ?? [], []);
    assert.equal(seen.dirty, false);
    assert.ok(!html.includes("Delete"));
    assert.ok(html.includes('placeholder="Enter prompt name"'));
    assert.ok(html.includes("Write the instructions to run after"));
    assert.ok(html.includes("<code>${output}</code>"));
  });

  it("edit_deletes_inline_and_keeps_the_last_prompt", async () => {
    const { html, dialog: seen } = render(tidy);
    assert.equal(seen.title, "Edit Tidy");
    assert.equal(seen.removals?.length, 1);
    const removal = seen.removals?.[0];
    assert.equal(removal?.id, "delete");
    assert.equal(removal?.label, "Delete");
    assert.equal(
      removal?.message,
      "Delete Tidy? Dictations already cleaned up with it are not changed.",
    );
    assert.equal(removal?.action, "Delete prompt");
    assert.equal(removal?.disabledReason, undefined);
    assert.ok(!html.includes("Delete"), "the dialog body has no delete button");
    assert.deepEqual(calls, [], "rendering deletes nothing");
    await removal?.apply();
    assert.deepEqual(calls, ["remove", "close"]);

    const last = render(tidy, { canDelete: false }).dialog.removals?.[0];
    assert.equal(last?.disabledReason, "Keep at least one prompt.");
    assert.equal(last?.id, "delete");
  });

  it("save_is_off_until_name_and_instructions", () => {
    const off = (prompt: LLMPrompt | null) =>
      render(prompt).dialog.save.disabled;
    assert.equal(off(null), true);
    assert.equal(off({ ...tidy, name: "  " }), true);
    assert.equal(off({ ...tidy, prompt: "\n " }), true);
    assert.equal(off(tidy), false);
    const { dialog: seen } = render(tidy);
    assert.equal(seen.save.label, "Save");
    assert.equal(seen.save.form, formOf(seen).props.id);
    assert.equal(promptReady("", "x"), false);
    assert.equal(promptReady("x", " "), false);
    assert.equal(promptReady(" x ", " y "), true);
  });

  it("unchanged_prompt_is_not_dirty", () => {
    assert.equal(render(tidy).dialog.dirty, false);
    assert.equal(promptDirty(tidy, "Tidy", "Fix the text."), false);
    assert.equal(promptDirty(tidy, " Tidy ", "Fix the text.\n"), false);
    assert.equal(promptDirty(tidy, "Tidy 2", "Fix the text."), true);
    assert.equal(
      promptDirty(tidy, "Tidy", "Fix the text, then shorten."),
      true,
    );
    assert.equal(promptDirty(null, "", ""), false);
    assert.equal(promptDirty(null, "  ", "\n"), false);
    assert.equal(promptDirty(null, "A", ""), true);
  });

  it("save_sends_the_trimmed_values_and_closes", async () => {
    const { dialog: seen } = render({
      ...tidy,
      name: " Tidy ",
      prompt: "Fix the text.\n",
    });
    submit(seen);
    await settled();
    assert.deepEqual(calls, ["save:Tidy|Fix the text.", "close"]);
  });

  it("failed_save_keeps_the_dialog_with_its_notice", async () => {
    const saved = render(tidy, {
      save: async () => {
        calls.push("save");
        return false;
      },
    });
    submit(saved.dialog);
    await settled();
    assert.deepEqual(calls, ["save"], "a refused save does not close");
    assert.ok(
      stateSets.includes("The prompt could not be saved."),
      "the notice is set",
    );

    const removed = render(tidy, {
      remove: async () => {
        calls.push("remove");
        return false;
      },
    });
    await removed.dialog.removals?.[0].apply();
    assert.deepEqual(calls, ["remove"], "a refused delete does not close");
    assert.ok(stateSets.includes("The prompt could not be saved."));
  });

  it("an_outcome_reaches_only_a_dialog_that_is_still_open", async () => {
    const seen: string[] = [];
    const on = (live: boolean) => ({
      live: () => live,
      done: () => seen.push("done"),
      failed: () => seen.push("failed"),
    });
    await settlePrompt(async () => true, on(true));
    await settlePrompt(async () => false, on(true));
    await settlePrompt(async () => Promise.reject(new Error("x")), on(true));
    assert.deepEqual(seen, ["done", "failed", "failed"]);
    await settlePrompt(async () => true, on(false));
    await settlePrompt(async () => false, on(false));
    assert.equal(seen.length, 3, "a closed dialog is not touched");
  });
});
