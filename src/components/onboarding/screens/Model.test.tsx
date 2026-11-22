import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import en from "../../../i18n/locales/en/translation.json";
import de from "../../../i18n/locales/de/translation.json";
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
const store = {
  modelId: null as string | null,
  extraModelId: null as string | null,
};
mock.module("../onboardingStore", () => ({
  useOnboardingStore: () => ({
    modelId: store.modelId,
    extraModelId: store.extraModelId,
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
const { ReadAloudLine } = await import("../ReadAloudLine");
const { keycapLabel, keycapLabels } = await import("@/lib/utils/keyboard");
const { formatModelSize } = await import("@/lib/utils/format");
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

const render = (
  models: Models,
  showAll = false,
  opened: string[] = [],
  instance: typeof i18n = i18n,
) => {
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
    <I18nextProvider i18n={instance}>
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

  it("onboarding_sizes_are_isolated", () => {
    const pickRow: Row = {
      model: offered[0],
      role: "pick",
      missing: [],
      error: null,
      wait: 1,
    };
    const extraRow: Row = { ...pickRow, model: CURATED_ASR[1], role: null };
    const models = fixture(
      [{ model: offered[0], role: "pick" }],
      [pickRow],
      true,
    );
    store.extraModelId = extraRow.model.id;
    try {
      models.groups.others = [extraRow];
      const html = render(models);
      const sizes =
        html.match(
          new RegExp(`<span [^>]*>${formatModelSize(100)}</span>`, "g"),
        ) ?? [];
      assert.equal(sizes.length, 2, "the selected card and the one-line row");
      for (const size of sizes) assert.match(size, /dir="ltr"/, size);
    } finally {
      store.extraModelId = null;
    }
  });

  it("migration_size_is_isolated", () => {
    assert.match(
      readFileSync(new URL("../ModelMigration.tsx", import.meta.url), "utf8"),
      /<span dir="ltr" className="tabular-nums">\s*\{formatModelSize\(Number\(replacement\.size_mb\)\)\}/,
    );
  });
});

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const escapeHtml = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
const renderLine = (
  binding: string | null,
  instance: typeof i18n = i18n,
  os: "linux" | "macos" = "linux",
) =>
  renderToStaticMarkup(
    <I18nextProvider i18n={instance}>
      <ReadAloudLine binding={binding} os={os} onChooseModel={() => {}} />
    </I18nextProvider>,
  );

describe("finish line", () => {
  it("finish_line_names_the_read_aloud_keys", () => {
    const html = renderLine("super+alt+r");
    assert.equal(html.match(/<p /g)?.length, 1, "one paragraph");
    assert.match(html, /^<p [^>]*data-read-aloud-line/);
    assert.match(html, /To hear text read aloud, copy it and press /);
    assert.ok(
      html.includes(`aria-label="${keycapLabel("super+alt+r", "linux")}"`),
      "the keycaps name the binding",
    );
    for (const label of keycapLabels("super+alt+r", "linux")) {
      assert.ok(html.includes(`>${label}</span>`), `keycap ${label}`);
    }
    assert.match(html, /<button[^>]*>Choose a read-aloud model<\/button>/);
    assert.ok(
      renderLine("super+alt+r", i18n, "macos").includes(
        `aria-label="${keycapLabel("super+alt+r", "macos")}"`,
      ),
      "macOS glyphs",
    );
    for (const binding of [null, ""]) {
      const unbound = renderLine(binding);
      assert.match(unbound, /data-read-aloud-line/);
      assert.match(
        unbound,
        /To hear text read aloud, set its shortcut in Settings, General\./,
      );
      assert.doesNotMatch(unbound, /role="img"/, "no keycaps");
      assert.doesNotMatch(unbound, /copy it and press/);
      assert.match(
        unbound,
        /<button[^>]*>Choose a read-aloud model<\/button>/,
        "the link stays",
      );
    }
  });

  it("finish_line_link_has_a_focus_ring", () => {
    for (const binding of ["super+alt+r", null]) {
      const link = renderLine(binding).match(
        /<button[^>]*>Choose a read-aloud model<\/button>/,
      );
      assert.ok(link, "the link button");
      assert.match(link[0], /focus-visible:ring-2/);
      assert.match(link[0], /focus-visible:ring-logo-primary/);
    }
  });

  it("finish_line_renders_keys_and_link_in_every_locale", async () => {
    const dir = new URL("../../../i18n/locales/", import.meta.url);
    const locales = readdirSync(dir);
    assert.equal(locales.length, 27);
    for (const locale of locales) {
      const translation = JSON.parse(
        readFileSync(new URL(`${locale}/translation.json`, dir), "utf8"),
      );
      const done = translation.onboarding.done;
      for (const key of [
        "readAloud",
        "readAloudUnbound",
        "chooseReadAloudModel",
      ]) {
        assert.equal(typeof done[key], "string", `${locale} ${key}`);
        assert.notEqual(done[key].trim(), "", `${locale} ${key}`);
        if (locale !== "en") {
          assert.notEqual(
            done[key],
            en.onboarding.done[key as "readAloud"],
            `${locale} ${key} is translated`,
          );
        }
      }
      assert.ok(
        done.readAloud.includes("<keys/>"),
        `${locale} places the keys`,
      );
      assert.ok(
        !done.readAloudUnbound.includes("<keys/>"),
        `${locale} unbound has no keys`,
      );
      const instance = i18next.createInstance();
      await instance.init({
        lng: locale,
        fallbackLng: false,
        interpolation: { escapeValue: false },
        resources: { [locale]: { translation } },
      });
      const link = escapeHtml(done.chooseReadAloudModel);
      const bound = renderLine("super+alt+r", instance);
      assert.ok(
        bound.includes(`aria-label="${keycapLabel("super+alt+r", "linux")}"`),
        `${locale} renders the keycaps`,
      );
      assert.ok(bound.includes(`>${link}</button>`), `${locale} link text`);
      const unbound = renderLine(null, instance);
      assert.doesNotMatch(
        unbound,
        /role="img"/,
        `${locale} unbound has no keys`,
      );
      assert.ok(
        unbound.includes(escapeHtml(done.readAloudUnbound)),
        `${locale} unbound sentence`,
      );
      assert.ok(
        unbound.includes(`>${link}</button>`),
        `${locale} unbound link`,
      );
    }
  });

  it("choose_model_finishes_into_models", () => {
    const flow = source("../OnboardingFlow.tsx");
    const app = source("../../../App.tsx");
    const tryIt = source("./TryIt.tsx");
    assert.ok(
      flow.includes(
        "onChooseReadAloudModel={() => finish(LINKS.readAloudModels)}",
      ),
      "the link finishes into Models, Read aloud",
    );
    const finish = flow.slice(
      flow.indexOf("const finish = async ("),
      flow.indexOf("const chooseModel"),
    );
    assert.match(finish, /finish = async \(then\?: Location\)/);
    const complete = finish.indexOf("onComplete(then)");
    assert.ok(complete > 0, "finish hands the destination on");
    assert.ok(
      finish.indexOf("commands.completeOnboarding()") < complete,
      "completeOnboarding first",
    );
    assert.ok(
      complete < finish.indexOf("clearOnboardingProgress()"),
      "onComplete before clearOnboardingProgress",
    );
    assert.match(flow, /onComplete: \(then\?: Location\) => void/);
    assert.ok(
      flow.includes("readAloudBinding={readAloudBinding}") &&
        flow.includes(
          "settings?.bindings?.read_aloud?.current_binding || null",
        ),
      "the binding comes from settings",
    );
    assert.ok(
      tryIt.includes("onChooseModel={onChooseReadAloudModel}") &&
        /after && \(\s*<ReadAloudLine/.test(tryIt),
      "TryIt renders the line on the finished stage only",
    );
    const real = app.match(
      /<OnboardingFlow\s+onComplete=\{\(then\) =>[\s\S]*?\}\)\s*\}\s*\/>/,
    );
    assert.ok(real, "the real flow's handler");
    assert.match(real[0], /afterOnboarding\(then,/);
    assert.match(real[0], /close: \(\) => setOnboardingStep\("done"\)/);
    assert.match(real[0], /navigate: navigation\.navigate/);
    const preview = app.match(
      /preview\s+previewStep=\{onboardingPreview\}\s+onComplete=\{\(then\) =>[\s\S]*?\}\)\s*\}/,
    );
    assert.ok(preview, "the preview's handler");
    assert.match(preview[0], /afterOnboarding\(then,/);
    assert.match(preview[0], /close: \(\) => setOnboardingPreview\(null\)/);
    assert.match(preview[0], /navigate: navigation\.navigate/);
  });

  it("done_button_passes_no_destination", () => {
    const flow = source("../OnboardingFlow.tsx");
    assert.ok(flow.includes("onDone={() => finish()}"));
    assert.ok(
      !flow.includes("onDone={finish}"),
      "the click event must not become the destination",
    );
  });
});

describe("extra card description", () => {
  it("extra_card_description_follows_the_app_language", async () => {
    const { translationKeyId } = await import("@/lib/utils/modelTranslation");
    const german = i18next.createInstance();
    await german.init({
      lng: "de",
      resources: { de: { translation: de } },
      interpolation: { escapeValue: false },
    });
    const extra = CURATED_ASR[1];
    const key = translationKeyId(extra.id);
    const words = (file: typeof en) =>
      (file.onboarding.models as Record<string, { description?: string }>)[key]
        ?.description;
    const row: Row = {
      model: offered[0],
      role: "pick",
      missing: [],
      error: null,
      wait: 1,
    };
    const models = fixture(
      [{ model: offered[0], role: "pick" }],
      [row, { ...row, model: extra, role: null }],
      true,
    );
    store.modelId = extra.id;
    store.extraModelId = extra.id;
    try {
      const inGerman = render(models, false, [], german);
      assert.ok(words(de), "de has the extra model's description");
      assert.ok(inGerman.includes(escapeHtml(words(de) ?? "")), "de text");
      assert.ok(!inGerman.includes("A model the table lists"), "no English");
      const inEnglish = render(models);
      assert.ok(inEnglish.includes(escapeHtml(words(en) ?? "")), "en text");
    } finally {
      store.modelId = null;
      store.extraModelId = null;
    }
  });

  it("extra_card_takes_its_line_from_the_translated_description", () => {
    const screen = source("./Model.tsx");
    assert.ok(screen.includes("getTranslatedModelDescription("));
    assert.ok(!screen.includes("row.model.description"));
  });
});
