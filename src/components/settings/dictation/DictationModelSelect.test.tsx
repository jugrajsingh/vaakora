import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import en from "../../../i18n/locales/en/translation.json";
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

type Model = { id: string; name: string; is_downloaded: boolean };
type DropdownProps = {
  options: { value: string; label: string }[];
  selectedValue: string | null;
  onSelect: (value: string) => void;
  disabled?: boolean;
};

mock.module("@/i18n", () => ({ default: i18next }));
const selected: string[] = [];
const modelState: { currentModel: string; models: Model[] } = {
  currentModel: "",
  models: [],
};
mock.module("@/stores/modelStore", () => ({
  useModelStore: () => ({
    ...modelState,
    selectModel: async (id: string) => {
      selected.push(id);
      return true;
    },
  }),
}));
const locks = { locked: false };
mock.module("@/stores/transcriptionJobsStore", () => ({
  useModelsLocked: () => locks.locked,
}));
const dropdowns: DropdownProps[] = [];
mock.module("@/components/ui/Dropdown", () => ({
  Dropdown: (props: DropdownProps) => {
    dropdowns.push(props);
    return <i data-marker="dropdown" />;
  },
}));
const { DictationModelSelect } = await import("./DictationModelSelect");
const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: en } } });

function render(locked = false): DropdownProps {
  modelState.currentModel = "a";
  modelState.models = [
    { id: "a", name: "Model A", is_downloaded: true },
    { id: "b", name: "Model B", is_downloaded: false },
    { id: "c", name: "Model C", is_downloaded: true },
  ];
  locks.locked = locked;
  dropdowns.length = 0;
  selected.length = 0;
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <DictationModelSelect />
    </I18nextProvider>,
  );
  assert.equal(dropdowns.length, 1);
  return dropdowns[0];
}

describe("DictationModelSelect", () => {
  it("options_are_downloaded_models", () => {
    const props = render();
    assert.deepEqual(
      props.options.map((option) => option.value),
      ["a", "c"],
    );
    assert.deepEqual(
      props.options.map((option) => option.label),
      ["Model A", "Model C"],
    );
    assert.equal(props.selectedValue, "a");
  });

  it("select_calls_selectModel", () => {
    const props = render();
    props.onSelect("c");
    assert.deepEqual(selected, ["c"]);
  });

  it("locked_while_a_file_transcribes", () => {
    assert.equal(render(true).disabled, true);
    assert.equal(render(false).disabled, false);
  });
});
