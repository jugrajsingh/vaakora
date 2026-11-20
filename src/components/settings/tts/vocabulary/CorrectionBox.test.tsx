import assert from "node:assert/strict";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import en from "../../../../i18n/locales/en/translation.json";
import type { EditorDialogProps } from "@/components/shared/EditorDialog";
import type { DerivedRule } from "@/bindings";
import { initialCorrection } from "./correction";
import { models } from "./fixtures";
const {
  mock,
  describe,
  it,
}: {
  mock: { module: (name: string, factory: () => unknown) => void };
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => void) => void;
} = createRequire(import.meta.url)("bun:test");

// The dialog host is replaced by a recorder that renders title and body inline; footer actions
// are rendered by the test so it can tell the footer from the body.
let dialog: EditorDialogProps | undefined;
mock.module("@/components/shared/EditorDialog", () => ({
  EditorDialog: (props: EditorDialogProps) => {
    dialog = props;
    return (
      <div data-dialog="">
        <h2>{props.title}</h2>
        {props.notice && <p data-notice="">{props.notice}</p>}
        <div data-body="">{props.children}</div>
      </div>
    );
  },
}));
// Every command resolves to nothing unless a test hands one a pending result; a render must not
// call one.
const commandCalls: string[] = [];
const commandResults: Record<string, () => Promise<unknown>> = {};
const realBindings = await import("@/bindings");
mock.module("@/bindings", () => ({
  ...realBindings,
  commands: new Proxy(
    {},
    {
      get: (_target, name) => async () => {
        commandCalls.push(String(name));
        return commandResults[String(name)]?.() ?? { status: "ok", data: null };
      },
    },
  ),
}));
// A test can seed the first `useState` calls of a render, in call order, to stand in for typing.
let seeded: unknown[] = [];
let seededUsed = 0;
const realReact = await import("react");
const realUseState = realReact.useState;
// react-i18next keeps its own state, which would take the seeded values first.
const realI18next = await import("react-i18next");
mock.module("react-i18next", () => ({
  ...realI18next,
  useTranslation: () => ({ t: i18n.t.bind(i18n), i18n }),
}));
mock.module("react", () => ({
  ...realReact,
  useState: (initial: unknown) =>
    realUseState(seededUsed < seeded.length ? seeded[seededUsed++] : initial),
}));
mock.module("../ModelsPage", () => ({
  unwrapTts: (result: { data?: unknown }) => result.data,
}));
const { CorrectionBox } = await import("./CorrectionBox");
const { CorrectionStart } = await import("./CorrectionStart");
const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: en } } });

const wrap = (node: React.ReactNode) => (
  <I18nextProvider i18n={i18n}>{node}</I18nextProvider>
);
const seen = () => {
  assert.ok(dialog, "the component renders on the editor dialog");
  return dialog;
};

function renderBox(onClose: () => void = () => {}) {
  dialog = undefined;
  commandCalls.length = 0;
  const html = renderToStaticMarkup(
    wrap(
      <CorrectionBox
        written="README.md"
        spokenAs="README dot markdown"
        readingModel="pocket-en"
        models={models}
        onSaved={() => {}}
        onClose={onClose}
      />,
    ),
  );
  return { html, dialog: seen() };
}

describe("CorrectionBox", () => {
  it("correction_is_a_dialog_titled_correct_a_reading", () => {
    const closed: string[] = [];
    const { html, dialog: box } = renderBox(() => closed.push("close"));
    assert.equal(box.title, "Correct a reading");
    assert.equal(box.dirty, false, "nothing is typed yet");
    assert.equal(box.save.label, "Save");
    assert.equal(box.save.disabled, true, "no scope chosen yet");
    assert.ok(
      html.includes(`id="${box.save.form}"`),
      "the footer Save submits the body form",
    );
    assert.ok(box.initialFocusRef, "the dialog names Should say to focus");
    box.onClose();
    assert.deepEqual(closed, ["close"]);
    assert.deepEqual(commandCalls, [], "a render calls no command");
  });

  it("listen_is_in_the_footer", () => {
    const { html, dialog: box } = renderBox();
    const footer = renderToStaticMarkup(wrap(<>{box.actions}</>));
    assert.match(footer, /<button[^>]*>Listen<\/button>/);
    assert.doesNotMatch(html, />Listen</, "the body has no Listen button");
    assert.ok(html.includes('aria-label="Should say"'));
  });
});

describe("CorrectionStart", () => {
  it("start_asks_for_the_written_text_then_next", () => {
    dialog = undefined;
    const html = renderToStaticMarkup(
      wrap(
        <CorrectionStart
          speak={async () => null}
          open={() => {}}
          cancel={() => {}}
        />,
      ),
    );
    const start = seen();
    assert.equal(start.title, "Correct a reading");
    assert.equal(start.save.label, "Next");
    assert.equal(start.save.disabled, true, "off while the text is blank");
    assert.equal(start.dirty, false);
    assert.ok(html.includes('aria-label="Written text"'));
    assert.ok(html.includes(`id="${start.save.form}"`));
    assert.ok(start.initialFocusRef, "the dialog names Written text to focus");
  });
});

// Results of a Next or a Save that arrive after their dialog closed. Static renders cannot type, so
// the first `useState` values stand in for what was typed, and the form's own onSubmit is called.
const flush = async () => {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
};
type FormProps = {
  onSubmit: (event: { preventDefault: () => void }) => unknown;
};
function renderSeeded(node: React.ReactNode, values: unknown[]) {
  seeded = values;
  seededUsed = 0;
  dialog = undefined;
  renderToStaticMarkup(wrap(node));
  seeded = [];
  const shown = seen();
  const form = shown.children as React.ReactElement<FormProps>;
  return {
    close: () => shown.onClose(),
    submit: () => form.props.onSubmit({ preventDefault: () => {} }),
  };
}
const pending = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("CorrectionStart after it closed", () => {
  const start = (speak: Promise<string | null>, host: { shown: string }) =>
    renderSeeded(
      <CorrectionStart
        speak={() => speak}
        open={(written) => {
          host.shown = `box for ${written}`;
        }}
        cancel={() => {
          host.shown = "none";
        }}
      />,
      ["README.md", false],
    );

  it("next_after_close_opens_nothing", async () => {
    const host = { shown: "text prompt" };
    const answer = pending<string | null>();
    const prompt = start(answer.promise, host);
    void prompt.submit();
    prompt.close();
    answer.resolve("README dot markdown");
    await flush();
    assert.equal(host.shown, "none", "the discarded text is not reopened");
  });

  it("next_after_close_and_reopen_keeps_the_newer_dialog", async () => {
    const host = { shown: "text prompt" };
    const answer = pending<string | null>();
    const prompt = start(answer.promise, host);
    void prompt.submit();
    prompt.close();
    host.shown = "newer correction with typed text";
    answer.resolve("README dot markdown");
    await flush();
    assert.equal(host.shown, "newer correction with typed text");
  });

  it("next_when_still_open_opens_the_box", async () => {
    const host = { shown: "text prompt" };
    const answer = pending<string | null>();
    void start(answer.promise, host).submit();
    answer.resolve("README dot markdown");
    await flush();
    assert.equal(host.shown, "box for README.md");
  });
});

describe("CorrectionBox after it closed", () => {
  const rule: DerivedRule = {
    entry: { section: "term", model: null, key: "word" },
    rule: { say: "new words", matching: "whole", case: true },
    reach: { kind: "term", term: "word" },
    preview: "new words",
  };
  const loaded = {
    revision: "base",
    path: "test",
    file_error: null,
    rows: [],
    acronym_styles: [],
  };
  // Each host clears what its dialog shows on close; the Vocabulary tab adopts a saved table.
  const hosts = [
    { name: "Vocabulary tab", adopts: true },
    { name: "Read aloud history", adopts: false },
  ];

  hosts.forEach(({ name, adopts }) => {
    const box = (
      host: { shown: string; adopted: string[] },
      save: Promise<unknown>,
    ) => {
      commandResults.saveTtsRules = () => save;
      return renderSeeded(
        <CorrectionBox
          written="word"
          spokenAs="old words"
          readingModel="pocket-en"
          models={models}
          onSaved={(saved) => {
            if (adopts) host.adopted.push(saved.revision);
          }}
          onClose={() => {
            host.shown = "none";
          }}
        />,
        [
          {
            ...initialCorrection("old words"),
            shouldSay: "new words",
            scope: { kind: "all" },
          },
          { status: "ready", derivation: { rule, exact: null } },
          loaded,
          null,
          0,
          false,
        ],
      );
    };

    it(`save_after_close_does_not_close_anything_in_${name.replace(/ /g, "_")}`, async () => {
      const host = { shown: "correction A", adopted: [] as string[] };
      const written = pending<unknown>();
      const dialogA = box(host, written.promise);
      void dialogA.submit();
      dialogA.close();
      host.shown = "none";
      written.resolve({ status: "ok", data: { ...loaded, revision: "saved" } });
      await flush();
      assert.equal(host.shown, "none");
      assert.deepEqual(
        host.adopted,
        adopts ? ["saved"] : [],
        "the written table still reaches the host that adopts it",
      );
    });

    it(`save_after_close_and_reopen_keeps_the_newer_dialog_in_${name.replace(/ /g, "_")}`, async () => {
      const host = { shown: "correction A", adopted: [] as string[] };
      const written = pending<unknown>();
      const dialogA = box(host, written.promise);
      void dialogA.submit();
      dialogA.close();
      host.shown = "correction B with typed text";
      written.resolve({ status: "ok", data: { ...loaded, revision: "saved" } });
      await flush();
      assert.equal(host.shown, "correction B with typed text");
    });
  });

  it("save_when_still_open_closes_the_dialog", async () => {
    const host = { shown: "correction A", adopted: [] as string[] };
    const written = pending<unknown>();
    commandResults.saveTtsRules = () => written.promise;
    const open = renderSeeded(
      <CorrectionBox
        written="word"
        spokenAs="old words"
        readingModel="pocket-en"
        models={models}
        onSaved={(saved) => host.adopted.push(saved.revision)}
        onClose={() => {
          host.shown = "none";
        }}
      />,
      [
        {
          ...initialCorrection("old words"),
          shouldSay: "new words",
          scope: { kind: "all" },
        },
        { status: "ready", derivation: { rule, exact: null } },
        loaded,
        null,
        0,
        false,
      ],
    );
    void open.submit();
    written.resolve({ status: "ok", data: { ...loaded, revision: "saved" } });
    await flush();
    assert.equal(host.shown, "none");
    assert.deepEqual(host.adopted, ["saved"]);
  });
});
