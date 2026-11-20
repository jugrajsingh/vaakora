import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import en from "../../i18n/locales/en/translation.json";
import { createRequire } from "node:module";
const {
  describe,
  it,
  mock,
}: {
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => void) => void;
  mock: { module: (name: string, factory: () => unknown) => void };
} = createRequire(import.meta.url)("bun:test");

mock.module("@/i18n", () => ({ default: i18next }));
// Records every button's props and renders the real button as well.
const { Button: RealButton } = await import("@/components/ui/Button");
const buttons: Parameters<typeof RealButton>[0][] = [];
mock.module("@/components/ui/Button", () => ({
  Button: (props: Parameters<typeof RealButton>[0]) => {
    buttons.push(props);
    return RealButton(props);
  },
}));
const { JobModelGroup, jobModelState } = await import("./JobModelGroup");
const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: en } } });

function render(
  role: "dictation" | "readAloud",
  state: "loading" | "empty" | "ready" | "failed",
  manage: () => void = () => {},
): string {
  buttons.length = 0;
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <JobModelGroup
        role={role}
        state={state}
        manage={manage}
        select={<i data-marker="select" />}
      >
        <i data-marker="children" />
      </JobModelGroup>
    </I18nextProvider>,
  );
}

describe("JobModelGroup", () => {
  it("job_model_state_from_the_list", () => {
    assert.equal(jobModelState(null), "loading");
    assert.equal(jobModelState(0), "empty");
    assert.equal(jobModelState(2), "ready");
  });

  it("loading_is_a_status_line", () => {
    const html = render("dictation", jobModelState(null));
    assert.match(html, /<p role="status"[^>]*>Loading models<\/p>/);
    assert.equal(html.includes("No dictation model yet."), false);
    assert.equal(html.includes("Manage models"), false);
    assert.equal(html.includes("Choose a model"), false);
    assert.equal(html.includes("data-marker"), false);
  });

  it("empty_state_names_the_role_and_offers_choose", () => {
    let calls = 0;
    const read = render("readAloud", "empty", () => (calls += 1));
    assert.ok(read.includes("No read-aloud model yet."));
    assert.equal(read.includes("No dictation model yet."), false);
    assert.deepEqual(
      buttons.map((button) => button.children),
      ["Choose a model"],
    );
    assert.equal(buttons[0].variant ?? "primary", "primary");
    buttons[0].onClick?.({} as never);
    assert.equal(calls, 1);
    const dictation = render("dictation", "empty");
    assert.ok(dictation.includes("No dictation model yet."));
    for (const html of [read, dictation]) {
      assert.equal(html.includes("data-marker"), false);
      assert.equal(html.includes("Manage models"), false);
      assert.ok(html.includes("Model</h2>"), "group title stays");
      assert.equal(html.includes("border-line"), false, "no card");
    }
  });

  it("ready_shows_the_model_row_with_manage_models", () => {
    let calls = 0;
    const html = render("dictation", "ready", () => (calls += 1));
    assert.ok(html.includes('data-marker="select"'));
    assert.ok(html.includes('data-marker="children"'));
    assert.ok(html.includes("Model</h2>"));
    assert.ok(html.includes("Model</h3>"));
    assert.deepEqual(
      buttons.map((button) => button.children),
      ["Manage models"],
    );
    assert.equal(buttons[0].variant, "ghost");
    buttons[0].onClick?.({} as never);
    assert.equal(calls, 1);
    assert.equal(html.includes("No dictation model yet."), false);
    assert.equal(html.includes("Loading models"), false);
    assert.ok(
      html.indexOf('data-marker="select"') <
        html.indexOf('data-marker="children"'),
    );
  });

  it("failed_shows_the_load_error_not_the_empty_state", () => {
    const html = render("readAloud", "failed");
    const alert = html.match(/<div role="alert">(.*?)<\/div>/s)?.[1];
    assert.ok(alert?.includes(en.tts.errors.generic), "the load error shows");
    assert.ok(html.includes("Model</h2>"), "group title stays");
    for (const text of ["No read-aloud model yet.", "Loading models"]) {
      assert.equal(html.includes(text), false, text);
    }
    assert.equal(html.includes("Choose a model"), false);
    assert.equal(html.includes("data-marker"), false);
  });
});
