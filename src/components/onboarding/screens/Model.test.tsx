import assert from "node:assert/strict";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import en from "../../../i18n/locales/en/translation.json";
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
mock.module("../onboardingStore", () => ({
  useOnboardingStore: () => ({
    modelId: null,
    extraModelId: null,
    downloadId: null,
    set() {},
  }),
}));
mock.module("../DownloadStatus", () => ({
  useDownloadWords: () => ({
    percent: () => 0,
    sizes: () => ({ done: "", total: "" }),
    time: () => null,
    speed: () => null,
  }),
}));

const i18n = i18next.createInstance();
await i18n.init({
  lng: "en",
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
});

mock.module("@/i18n", () => ({ default: i18n }));

const { ModelView } = await import("./Model");
const { NO_FILTERS } = await import("../../shared/modelTable/ModelTable");
const { CURATED_ASR } = await import("@/lib/models/catalog");
const { makeGrading } = await import("@/lib/models/grading");
type ViewProps = Parameters<typeof ModelView>[0];
type Models = ViewProps["models"];
type List = ViewProps["list"];
type Row = Models["groups"]["picks"][number];

const LANGS = ["en", "pa"];
const offered = CURATED_ASR.slice(0, 1);

const info = (model: (typeof offered)[number]) => ({
  id: model.id,
  name: "Fixture offered model",
  description: "A model the table lists",
  filename: "model.gguf",
  source: { HuggingFace: { repo_id: model.repository, revision: "main" } },
  size_mb: 100,
  is_downloaded: false,
  is_downloading: false,
  partial_size: 0,
  accuracy_score: 0.5,
  speed_score: 0.5,
  supports_translation: false,
  is_recommended: false,
  supported_languages: LANGS,
  supports_language_selection: true,
  is_custom: false,
  supports_streaming: false,
  supports_language_detection: false,
});

const fixture = (
  picks: Models["picks"],
  rows: Row[],
  withInfo = false,
): Models =>
  ({
    tier: "accelerated",
    offered,
    picks,
    groups: {
      picks: picks.length ? rows : [],
      others: picks.length ? [] : rows,
      partial: [],
    },
    grading: makeGrading(LANGS, "accelerated", picks),
    infoFor: (model: (typeof offered)[number]) =>
      withInfo ? info(model) : undefined,
    catalogFor: () => undefined,
    downloadState: () => ({ state: "none" }),
    startDownload: () => undefined,
  }) as unknown as Models;

const render = (models: Models, showAll = false, opened: string[] = []) => {
  buttons.length = 0;
  const list: List = {
    showAll,
    open: (query) => opened.push(query ?? ""),
    close: () => undefined,
    move: (update) => update(),
    rootRef: { current: null },
    filterState: {
      filters: NO_FILTERS,
      setFilters: () => undefined,
      matches: () => true,
      searching: false,
    },
  };
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <ModelView
        models={models}
        onBack={() => undefined}
        onChoose={() => {}}
        list={list}
      />
    </I18nextProvider>,
  );
};

describe("Model", () => {
  it("no_pick_shows_the_recovery_state", () => {
    const html = render(fixture([], []));
    assert.notEqual(html, "");
    assert.match(
      html,
      /No recommended model covers English and Punjabi\./,
      "names the languages",
    );
    assert.match(
      html,
      /Show every model, or go back and change your languages\./,
    );
    const showAll = buttons.filter((b) => b.children === "Show all models");
    assert.equal(showAll.length, 1, "one Show all models button");
    assert.equal(showAll[0].variant, "primary");
    assert.equal(showAll[0].disabled, undefined);
    assert.match(html, />Back</);
  });

  it("pressing_show_all_models_opens_the_list", () => {
    const opened: string[] = [];
    render(fixture([], []), false, opened);
    const showAll = buttons.filter((b) => b.children === "Show all models");
    assert.equal(showAll.length, 1);
    showAll[0].onClick?.({} as React.MouseEvent<HTMLButtonElement>);
    assert.deepEqual(opened, [""]);
  });

  it("an_open_list_with_no_choice_shows_the_table_and_a_disabled_primary", () => {
    const model = offered[0];
    const row: Row = { model, role: null, missing: [], error: null, wait: 1 };
    const html = render(fixture([], [row], true), true);
    assert.doesNotMatch(html, /No recommended model covers/);
    assert.ok(html.includes("Fixture offered model"), "the offered row shows");
    const primary = buttons.filter((b) => b.children === "Choose a model");
    assert.equal(primary.length, 1, "one Choose a model button");
    assert.equal(primary[0].disabled, true);
    assert.equal(primary[0].variant, "primary");
    assert.equal(
      buttons.filter((b) => b.disabled !== true && b.variant === "primary")
        .length,
      0,
      "no enabled primary button",
    );
  });

  it("a_pick_keeps_the_picks_screen", () => {
    const model = offered[0];
    const row: Row = { model, role: "pick", missing: [], error: null, wait: 1 };
    const html = render(fixture([{ model, role: "pick" }], [row]));
    assert.doesNotMatch(html, /No recommended model covers/);
    assert.ok(html.includes(model.name), "the pick's card is shown");
  });
});
