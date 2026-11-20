import assert from "node:assert/strict";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import en from "../../../i18n/locales/en/translation.json";
import type { TtsModelInfo } from "@/bindings";
import type { ModelCardProps } from "./ModelCard";
const {
  mock,
  describe,
  it,
}: {
  mock: { module: (name: string, factory: () => unknown) => void };
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => Promise<void> | void) => void;
} = createRequire(import.meta.url)("bun:test");

// useRowConfirm is replaced by a recorder: the page's wiring is what is under test.
type Deps = {
  apply: (id: string) => void;
  present?: (id: string) => boolean;
};
const calls: string[] = [];
let deps: Deps | undefined;
const recordedDeps = () => deps;
let asking: string | null = null;
const rowsRef = { current: null };
const real = await import("@/components/shared/InlineConfirm");
mock.module("@/components/shared/InlineConfirm", () => ({
  ...real,
  useRowConfirm: (given: Deps) => {
    deps = given;
    return {
      asking,
      ask: (id: string) => calls.push(`ask:${id}`),
      cancel: () => calls.push("cancel"),
      confirm: () => calls.push("confirm"),
      rowsRef,
    };
  },
}));
const pocket = { id: "pocket-en", downloaded: true } as TtsModelInfo;
mock.module("./token", () => ({
  groupModels: () => ({ downloaded: [pocket], available: [] }),
}));
mock.module("./TokenField", () => ({ tokenCardProps: () => ({}) }));
mock.module("./useToken", () => ({ useToken: () => ({}) }));
const cards: ModelCardProps[] = [];
mock.module("./ModelCard", () => ({
  ModelCard: (props: ModelCardProps) => {
    cards.push(props);
    return null;
  },
}));
const deleted: string[] = [];
mock.module("@/bindings", () => ({
  commands: {
    deleteTtsModel: async (id: string) => {
      deleted.push(id);
      return { status: "ok", data: null };
    },
    getTtsModels: async () => ({ status: "ok", data: [] }),
    getTtsDevices: async () => ({ status: "ok", data: ["cpu"] }),
  },
}));
mock.module("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
mock.module("@/hooks/useSettings", () => ({
  useSettings: () => ({ refreshSettingsChecked: async () => {} }),
}));
mock.module("@/stores/settingsStore", () => ({
  useSettingsStore: { getState: () => ({}) },
}));
const { ModelsPage } = await import("./ModelsPage");
const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: en } } });

function render() {
  calls.length = 0;
  cards.length = 0;
  deps = undefined;
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <ModelsPage />
    </I18nextProvider>,
  );
  const seen = recordedDeps();
  assert.ok(seen, "the page asks useRowConfirm for its delete question");
  const [card] = cards;
  assert.ok(card, "the downloaded model renders a card");
  return { card, deps: seen };
}

describe("ModelsPage delete question", () => {
  it("card_delete_asks_and_the_question_buttons_confirm_or_cancel", () => {
    const { card } = render();
    card.actions.delete("pocket-en");
    assert.deepEqual(calls, ["ask:pocket-en"], "Delete only asks");
    card.confirmDelete();
    card.cancelDelete();
    assert.deepEqual(calls, ["ask:pocket-en", "confirm", "cancel"]);
    assert.deepEqual(deleted, [], "nothing is deleted before the apply runs");
  });
  it("only_the_asked_card_shows_the_question", () => {
    asking = "pocket-en";
    assert.equal(render().card.confirming, true);
    asking = "kokoro";
    assert.equal(render().card.confirming, false);
    asking = null;
    assert.equal(render().card.confirming, false);
  });
  it("apply_deletes_the_asked_model_and_present_reads_the_downloaded_flag", async () => {
    const { deps: seen } = render();
    seen.apply("pocket-en");
    await Promise.resolve();
    assert.deepEqual(deleted, ["pocket-en"]);
    assert.equal(
      seen.present?.("pocket-en"),
      false,
      "the page holds no downloaded models yet, so a question for one is dropped",
    );
  });
});
