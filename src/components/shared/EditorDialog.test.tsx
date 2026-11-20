import assert from "node:assert/strict";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import en from "../../i18n/locales/en/translation.json";
import type { EditorDialogProps, Question, Removal } from "./EditorDialog";
const {
  mock,
  describe,
  it,
}: {
  mock: { module: (name: string, factory: () => unknown) => void };
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => Promise<void> | void) => void;
} = createRequire(import.meta.url)("bun:test");

type DialogProps = Parameters<
  typeof import("@/components/ui/Dialog").Dialog
>[0];
type ButtonProps = Parameters<
  typeof import("@/components/ui/Button").Button
>[0];

const { Button: RealButton } = await import("@/components/ui/Button");
const buttons: ButtonProps[] = [];
mock.module("@/components/ui/Button", () => ({
  Button: (props: ButtonProps) => {
    buttons.push(props);
    return RealButton(props);
  },
}));

let dialog: DialogProps | undefined;
mock.module("@/components/ui/Dialog", () => ({
  Dialog: (props: DialogProps) => {
    dialog = props;
    return (
      <div data-dialog="">
        <h2>{props.title}</h2>
        <p data-description="">{props.description}</p>
        {props.children}
        <footer>{props.footer}</footer>
      </div>
    );
  },
}));

const real = await import("@/components/shared/InlineConfirm");
type Deps = Parameters<typeof real.useRowConfirm<Question>>[0];
const rowsRef = { current: null };
const confirm = {
  asking: null as Question | null,
  asks: [] as Question[],
  cancels: 0,
  deps: undefined as Deps | undefined,
};
mock.module("@/components/shared/InlineConfirm", () => ({
  ...real,
  useRowConfirm: (deps: Deps) => {
    confirm.deps = deps;
    return {
      asking: confirm.asking,
      ask: (key: Question) => confirm.asks.push(key),
      cancel: () => {
        confirm.cancels += 1;
      },
      confirm: () => {},
      rowsRef,
    };
  },
}));
const { EditorDialog } = await import("./EditorDialog");
const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: en } } });

const Body = () => <p data-body="" />;
function render(
  props: Partial<EditorDialogProps> = {},
  asking: Question | null = null,
) {
  buttons.length = 0;
  dialog = undefined;
  confirm.asking = asking;
  confirm.asks.length = 0;
  confirm.cancels = 0;
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <EditorDialog
        title="Edit entry"
        dirty={false}
        onClose={() => {}}
        save={{ label: "Save", disabled: false, form: "entry-form" }}
        {...props}
      >
        <Body />
      </EditorDialog>
    </I18nextProvider>,
  );
}
const labels = () => buttons.map((button) => String(button.children));
const button = (label: string): ButtonProps => {
  const found = buttons.find((candidate) => candidate.children === label);
  assert.ok(found, `no "${label}" button in ${labels().join(", ")}`);
  return found;
};
const closing = (list: string[]) => () => {
  list.push("close");
};
const click = (props: ButtonProps) =>
  props.onClick?.({} as React.MouseEvent<HTMLButtonElement>);

function removal(
  id: Removal["id"],
  calls: string[],
  extra: Partial<Removal> = {},
): Removal {
  return {
    id,
    label: id === "delete" ? "Delete entry" : "Reset to default",
    message: id === "delete" ? "Delete this entry?" : "Reset this entry?",
    action: id === "delete" ? "Delete" : "Reset",
    apply: () => {
      calls.push(id);
    },
    ...extra,
  };
}

describe("EditorDialog", () => {
  it("backdrop_never_closes", () => {
    render();
    assert.ok(dialog);
    assert.equal(dialog.closeOnBackdrop, false);
    assert.equal(dialog.open, true);
    assert.equal(dialog.closeLabel, "Close");
    assert.equal(dialog.className, "max-w-[40rem]!");
  });

  it("dirty_close_asks_and_clean_close_closes", () => {
    const closed: string[] = [];
    render({ dirty: true, onClose: closing(closed) });
    assert.ok(dialog);
    dialog.onOpenChange(true);
    assert.deepEqual(confirm.asks, [], "opening is not a close");
    dialog.onOpenChange(false);
    assert.deepEqual(confirm.asks, ["discard"]);
    assert.deepEqual(closed, [], "a changed form never closes at once");
    click(button("Cancel"));
    assert.deepEqual(confirm.asks, ["discard", "discard"], "Cancel asks too");
    assert.deepEqual(closed, []);

    render({ dirty: false, onClose: closing(closed) });
    assert.ok(dialog);
    dialog.onOpenChange(false);
    assert.deepEqual(closed, ["close"]);
    assert.deepEqual(confirm.asks, []);
    click(button("Cancel"));
    assert.deepEqual(closed, ["close", "close"]);
    assert.deepEqual(confirm.asks, []);
  });

  it("discard_question_keeps_editing_or_discards", async () => {
    const closed: string[] = [];
    const html = render({ dirty: true, onClose: closing(closed) }, "discard");
    assert.ok(html.includes(">Discard your changes?<"));
    assert.deepEqual(labels(), ["Keep editing", "Discard"]);
    assert.ok(!html.includes(">Save<"), "Save is hidden while asking");
    assert.equal(button("Discard").variant, "danger");
    click(button("Keep editing"));
    assert.equal(confirm.cancels, 1);
    assert.deepEqual(closed, [], "keeping the edit closes nothing");
    assert.ok(confirm.deps);
    await confirm.deps.apply("discard");
    assert.deepEqual(closed, ["close"]);
  });

  it("removal_asks_then_applies_its_own_action", async () => {
    const calls: string[] = [];
    const removals = [removal("delete", calls), removal("reset", calls)];
    const html = render({ removals }, "delete");
    assert.ok(html.includes(">Delete this entry?<"));
    assert.deepEqual(labels(), ["Cancel", "Delete"]);
    assert.ok(!html.includes("Discard your changes?"));
    assert.ok(confirm.deps);
    await confirm.deps.apply("reset");
    assert.deepEqual(calls, ["reset"], "only reset's own action ran");
    await confirm.deps.apply("delete");
    assert.deepEqual(calls, ["reset", "delete"]);
    assert.equal(confirm.deps.present?.("delete"), true);
    assert.equal(confirm.deps.present?.("discard"), true);
    render({ removals: [removal("reset", calls)] });
    assert.equal(
      confirm.deps?.present?.("delete"),
      false,
      "a removal that went is dropped",
    );
  });

  it("removal_buttons_only_ask", () => {
    const calls: string[] = [];
    render({ removals: [removal("delete", calls), removal("reset", calls)] });
    assert.equal(button("Delete entry").variant, "danger-ghost");
    assert.equal(button("Reset to default").variant, "secondary");
    click(button("Delete entry"));
    click(button("Reset to default"));
    assert.deepEqual(confirm.asks, ["delete", "reset"]);
    assert.deepEqual(calls, [], "pressing a removal removes nothing");
  });

  it("disabled_removal_shows_its_reason", () => {
    const html = render({
      removals: [
        removal("delete", [], {
          disabledReason: "Built-in entries cannot be deleted.",
        }),
      ],
    });
    const span = html.match(
      /<span id="([^"]+)" class="text-xs text-ink-2">Built-in entries cannot be deleted\.<\/span>/,
    );
    assert.ok(span, "the reason is a visible span");
    const deleteButton = button("Delete entry");
    assert.equal(deleteButton.disabled, true);
    assert.equal(deleteButton["aria-describedby"], span[1]);
    assert.ok(
      html.indexOf(span[0]) < html.indexOf(">Delete entry<"),
      "the reason comes before the button",
    );

    render({ removals: [removal("delete", [])] });
    assert.ok(!button("Delete entry").disabled);
    assert.equal(button("Delete entry")["aria-describedby"], undefined);
  });

  it("notice_is_an_alert_before_the_body", () => {
    const html = render({ notice: "The file changed." });
    const alertAt = html.indexOf('role="alert"');
    assert.ok(alertAt >= 0);
    assert.ok(html.indexOf("The file changed.") > alertAt);
    assert.ok(
      alertAt < html.indexOf("data-body"),
      "the alert precedes the children",
    );
    assert.ok(!render({ notice: null }).includes('role="alert"'));
    assert.ok(!render().includes('role="alert"'));
  });

  it("busy_disables_save_and_removals", () => {
    const removals = [removal("delete", []), removal("reset", [])];
    render({ busy: true, removals });
    assert.equal(button("Save").disabled, true, "Save waits for the write");
    assert.equal(button("Delete entry").disabled, true);
    assert.equal(button("Reset to default").disabled, true);
    assert.ok(!button("Cancel").disabled);

    render({ busy: false, removals });
    assert.ok(!button("Save").disabled);
    assert.ok(!button("Delete entry").disabled);
    assert.ok(!button("Reset to default").disabled);

    render({ save: { label: "Save", disabled: true, form: "entry-form" } });
    assert.equal(button("Save").disabled, true, "the host's disabled applies");
  });

  it("save_submits_the_hosts_form_and_actions_sit_before_cancel", () => {
    const html = render({ actions: <i data-action="" /> });
    const save = button("Save");
    assert.equal(save.type, "submit");
    assert.equal(save.form, "entry-form");
    assert.equal(button("Cancel").variant, "secondary");
    assert.ok(html.indexOf("data-action") < html.indexOf(">Cancel<"));
    assert.ok(html.indexOf(">Cancel<") < html.indexOf(">Save<"));
  });

  it("confirm_rows_wrap_the_buttons_so_focus_returns_to_the_button", () => {
    const html = render({
      removals: [removal("delete", []), removal("reset", [])],
    });
    const rows = [
      ...html.matchAll(
        /<(\w+)[^>]*data-confirm-row="(\w+)"[^>]*>([\s\S]*?)<\/\1>/g,
      ),
    ];
    assert.deepEqual(
      rows.map((row) => row[2]),
      ["delete", "reset", "discard"],
    );
    const expected: Record<string, string> = {
      delete: "Delete entry",
      reset: "Reset to default",
      discard: "Cancel",
    };
    for (const [, tag, key, inner] of rows) {
      assert.notEqual(tag, "button", `${key}: the marker is not on the button`);
      const inside = [...inner.matchAll(/<button([^>]*)>([^<]*)</g)].map(
        (match) => ({
          label: match[2],
          disabled: /\bdisabled=""/.test(match[1]),
          closest: () => null,
        }),
      );
      assert.equal(real.returnTarget(inside)?.label, expected[key]);
    }
  });

  it("footer_row_holds_the_rows_ref", () => {
    render();
    assert.ok(dialog);
    const footer = dialog.footer as unknown as { ref: unknown };
    assert.equal(footer.ref, rowsRef);
  });
  it("implicit_submit_is_blocked_when_save_is_off_or_a_question_is_open", () => {
    const submit = (
      props: Partial<EditorDialogProps>,
      asking: Question | null,
    ) => {
      render(props, asking);
      assert.ok(dialog);
      const wrapper = dialog.children as React.ReactElement<{
        onSubmitCapture: (event: unknown) => void;
      }>;
      const seen: string[] = [];
      wrapper.props.onSubmitCapture({
        preventDefault: () => seen.push("prevent"),
        stopPropagation: () => seen.push("stop"),
      });
      return seen;
    };
    const save = (disabled: boolean) => ({
      label: "Save",
      disabled,
      form: "entry-form",
    });
    assert.deepEqual(submit({ save: save(false) }, null), [], "Save is on");
    assert.deepEqual(submit({ save: save(true) }, null), ["prevent", "stop"]);
    assert.deepEqual(submit({ save: save(false) }, "discard"), [
      "prevent",
      "stop",
    ]);
    assert.deepEqual(
      submit(
        { save: save(false), removals: [removal("delete", [])] },
        "delete",
      ),
      ["prevent", "stop"],
    );
    assert.deepEqual(submit({ save: save(false), busy: true }, null), [
      "prevent",
      "stop",
    ]);
  });
});
