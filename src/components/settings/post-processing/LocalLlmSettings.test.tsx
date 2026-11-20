import assert from "node:assert/strict";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import en from "../../../i18n/locales/en/translation.json";
import type { LocalLlmModelListProps } from "./LocalLlmModelList";
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
const lists: LocalLlmModelListProps[] = [];
mock.module("./LocalLlmModelList", () => ({
  LocalLlmModelList: (props: LocalLlmModelListProps) => {
    lists.push(props);
    return null;
  },
}));
mock.module("@/components/ui", () => ({
  Dropdown: () => null,
  SettingContainer: ({ children }: { children?: React.ReactNode }) => children,
}));
const deleted: string[] = [];
mock.module("@/bindings", () => ({
  commands: {
    getLocalLlmModels: async () => [],
    deleteLocalLlmModel: async (id: string) => {
      deleted.push(id);
      return { status: "ok", data: null };
    },
  },
}));
mock.module("@/hooks/useSettings", () => ({
  useSettings: () => ({
    getSetting: () => undefined,
    updateSetting: async () => {},
    refreshSettingsChecked: async () => {},
  }),
}));
mock.module("@/hooks/useLocalLlmStatus", () => ({
  useLocalLlmStatus: () => ({ status: null, error: null }),
}));
const downloadState = {
  version: 0,
  modelId: null,
  percentage: null,
  error: null,
  clearError: () => {},
  download: async () => {},
  modelsChanged: () => {},
};
mock.module("@/stores/localLlmDownloadStore", () => ({
  initializeLocalLlmDownloadProgress: async () => {},
  useLocalLlmDownloadStore: Object.assign(
    (select: (state: typeof downloadState) => unknown) => select(downloadState),
    { getState: () => downloadState },
  ),
}));
const { LocalLlmSettings } = await import("./LocalLlmSettings");
const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: en } } });

function render() {
  calls.length = 0;
  lists.length = 0;
  deps = undefined;
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <LocalLlmSettings />
    </I18nextProvider>,
  );
  const seen = recordedDeps();
  assert.ok(seen, "the settings ask useRowConfirm for their delete question");
  const [list] = lists;
  assert.ok(list, "the model list renders");
  return { list, deps: seen };
}

describe("LocalLlmSettings delete question", () => {
  it("list_delete_asks_and_the_question_buttons_confirm_or_cancel", () => {
    const { list } = render();
    list.onDelete("alternative-a");
    assert.deepEqual(calls, ["ask:alternative-a"], "Delete only asks");
    list.onConfirmDelete();
    list.onCancelDelete();
    assert.deepEqual(calls, ["ask:alternative-a", "confirm", "cancel"]);
    assert.deepEqual(deleted, [], "nothing is deleted before the apply runs");
  });
  it("the_list_shows_the_asked_model_question", () => {
    asking = "alternative-a";
    assert.equal(render().list.askingId, "alternative-a");
    asking = null;
    assert.equal(render().list.askingId, null);
  });
  it("apply_deletes_the_asked_model_and_present_reads_the_downloaded_flag", async () => {
    const { deps: seen } = render();
    seen.apply("alternative-a");
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(deleted, ["alternative-a"]);
    assert.equal(
      seen.present?.("alternative-a"),
      false,
      "the settings hold no downloaded models yet, so a question for one is dropped",
    );
  });
});
