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

type Update = [string, unknown];
const updates: Update[] = [];
mock.module("../../hooks/useSettings", () => ({
  useSettings: () => ({
    getSetting: (key: string) => {
      if (key === "history_limit") return 50;
      if (key === "recording_retention_period") return "preserve_limit";
      return undefined;
    },
    isUpdating: () => false,
    updateSetting: (key: string, value: unknown) => {
      updates.push([key, value]);
    },
  }),
}));

const { Input: RealInput } = await import("../ui/Input");
type InputProps = Parameters<typeof RealInput>[0];
let inputProps: InputProps | undefined;
mock.module("../ui/Input", () => ({
  Input: (props: InputProps) => {
    inputProps = props;
    return RealInput(props);
  },
}));
const { HistoryLimit } = await import("./HistoryLimit");
const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: en } } });

function render() {
  updates.length = 0;
  inputProps = undefined;
  const html = renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <HistoryLimit />
    </I18nextProvider>,
  );
  const props = inputProps as InputProps | undefined;
  assert.ok(props);
  return {
    html,
    type: (value: string) =>
      props.onChange?.({
        target: { value },
      } as React.ChangeEvent<HTMLInputElement>),
    blur: () => props.onBlur?.({} as React.FocusEvent<HTMLInputElement>),
    key: (key: string) => {
      let prevented = false;
      props.onKeyDown?.({
        key,
        preventDefault: () => {
          prevented = true;
        },
      } as React.KeyboardEvent<HTMLInputElement>);
      return prevented;
    },
  };
}

describe("HistoryLimit", () => {
  it("the_number_field_sits_in_a_focus_row", () => {
    const row = render().html.match(
      /<div[^>]*data-confirm-row="limit"[^>]*>(.*?)<\/div>/s,
    );
    assert.ok(row, "a data-confirm-row=limit wrapper");
    assert.ok(row[1].includes('type="number"'), "around the number field");
  });
  it("typing_never_writes", () => {
    const field = render();
    for (const value of ["1", "10", "100"]) field.type(value);
    assert.deepEqual(updates, []);
  });
  it("blur_commits_once", () => {
    const field = render();
    for (const value of ["1", "10", "100"]) field.type(value);
    field.blur();
    assert.deepEqual(updates, [["history_limit", 100]]);
  });
  it("enter_commits_other_keys_do_not", () => {
    const field = render();
    field.type("75");
    field.key("a");
    assert.deepEqual(updates, []);
    field.key("Enter");
    assert.deepEqual(updates, [["history_limit", 75]]);
  });
  it("enter_keeps_its_keypress_from_the_confirm", () => {
    const field = render();
    field.type("10");
    assert.equal(field.key("a"), false);
    assert.equal(field.key("Enter"), true);
  });
  it("lowering_asks_instead_of_writing", () => {
    for (const value of ["10", "0"]) {
      const field = render();
      field.type(value);
      field.blur();
      assert.deepEqual(updates, [], value);
    }
  });
  it("drops_invalid_or_unchanged_drafts", () => {
    for (const value of ["", "abc", "-1", "1001", "50"]) {
      const field = render();
      field.type(value);
      field.blur();
      assert.deepEqual(updates, [], JSON.stringify(value));
    }
  });
});
