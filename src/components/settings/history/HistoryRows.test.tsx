import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  it: (name: string, run: () => Promise<void> | void) => void;
  mock: { module: (name: string, factory: () => unknown) => void };
} = createRequire(import.meta.url)("bun:test");

mock.module("@/i18n", () => ({ default: i18next }));
const stored: Record<string, unknown> = {};
mock.module("@/hooks/useSettings", () => ({
  useSettings: () => ({ getSetting: (key: string) => stored[key] }),
}));
const viewChanges: string[] = [];
mock.module("@/stores/settingsStore", () => ({
  useSettingsStore: (
    select: (state: Record<string, unknown>) => unknown,
  ): unknown =>
    select({
      changeHistoryCompareView: async (view: string) => {
        viewChanges.push(view);
      },
    }),
}));
let folderOpens = 0;
mock.module("@/bindings", () => ({
  commands: {
    openRecordingsFolder: async () => {
      folderOpens += 1;
      return { status: "ok", data: null };
    },
  },
}));
// Record each control's props and render the real control as well.
const { Dropdown: RealDropdown } = await import("@/components/ui/Dropdown");
const { Button: RealButton } = await import("@/components/ui/Button");
type DropdownProps = Parameters<typeof RealDropdown>[0];
type ButtonProps = Parameters<typeof RealButton>[0];
const dropdowns: DropdownProps[] = [];
const buttons: ButtonProps[] = [];
mock.module("@/components/ui/Dropdown", () => ({
  Dropdown: (props: DropdownProps) => {
    dropdowns.push(props);
    return RealDropdown(props);
  },
}));
mock.module("@/components/ui/Button", () => ({
  Button: (props: ButtonProps) => {
    buttons.push(props);
    return RealButton(props);
  },
}));
const { CompareViewSetting, RecordingsFolderSetting } = await import(
  "./HistoryRows"
);
const { ClearHistoryView, clearDisabled } = await import(
  "@/components/shared/ClearHistory"
);
const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: en } } });

function render(element: React.ReactElement): string {
  dropdowns.length = 0;
  buttons.length = 0;
  viewChanges.length = 0;
  folderOpens = 0;
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>{element}</I18nextProvider>,
  );
}

describe("HistoryRows", () => {
  it("compare_row_offers_three_views", () => {
    stored.history_compare_view = "side_by_side";
    const html = render(<CompareViewSetting />);
    assert.ok(html.includes(">Compare view</h3>"));
    assert.ok(!/<p[ >]/.test(html) && !html.includes("More information"));
    assert.equal(dropdowns.length, 1);
    assert.deepEqual(
      dropdowns[0].options.map((option) => [option.value, option.label]),
      [
        ["diff", "Diff"],
        ["side_by_side", "Side by side"],
        ["stacked", "Stacked"],
      ],
    );
    assert.equal(dropdowns[0].selectedValue, "side_by_side");
    assert.equal(dropdowns[0].disabled, false);
    dropdowns[0].onSelect("stacked");
    assert.deepEqual(viewChanges, ["stacked"]);
    stored.history_compare_view = undefined;
    render(<CompareViewSetting />);
    assert.equal(dropdowns[0].selectedValue, "diff");
  });

  it("folder_row_opens_recordings_folder", async () => {
    const html = render(<RecordingsFolderSetting />);
    assert.ok(html.includes(">Recordings folder</h3>"));
    assert.ok(!/<p[ >]/.test(html) && !html.includes("More information"));
    const open = buttons.find((props) => props.children === "Open");
    assert.ok(open, "the Open button");
    assert.equal(open.variant, "secondary");
    await open.onClick?.({} as React.MouseEvent<HTMLButtonElement>);
    assert.equal(folderOpens, 1);
  });

  it("retry_lines_name_the_row_action", () => {
    const source = readFileSync(
      new URL("./HistorySettings.tsx", import.meta.url),
      "utf8",
    );
    const action = i18n.t("history.retranscribe");
    assert.equal(action, "Re-transcribe");
    assert.ok(source.includes('t("history.notTranscribedLine", {'));
    assert.ok(source.includes('t("history.failedLine", {'));
    assert.equal(source.split('action: t("history.retranscribe")').length, 3);
    assert.ok(!source.includes("settings.history.notTranscribed"));
    assert.ok(!source.includes("settings.history.transcriptionFailed"));
    assert.equal(
      i18n.t("history.failedLine", { action }),
      "This entry could not be transcribed. Use Re-transcribe to try again.",
    );
    assert.equal(
      i18n.t("history.notTranscribedLine", { action }),
      "This entry is not transcribed yet. Use Re-transcribe to transcribe it.",
    );
  });

  it("clear_history_follows_the_entries", () => {
    const toolbar = (input: {
      loading: boolean;
      failed: boolean;
      entries: number;
    }) => {
      const { disabled, empty } = clearDisabled(input);
      const html = render(
        <ClearHistoryView<number>
          state={{ kind: "idle" }}
          disabled={disabled}
          listEmpty={empty}
          refocus={false}
          message={() => ""}
          nothing={i18n.t("history.clear.nothing")}
          press={() => {}}
          confirm={() => {}}
          cancel={() => {}}
        />,
      );
      return { html, clear: buttons[0] };
    };
    const none = toolbar({ loading: false, failed: false, entries: 0 });
    assert.equal(none.clear.children, "Clear history");
    assert.equal(none.clear.disabled, true);
    assert.equal(none.html.split("Nothing to clear.").length - 1, 1);
    const one = toolbar({ loading: false, failed: false, entries: 1 });
    assert.equal(one.clear.disabled, false, "an entry arrives: Clear is back");
    assert.ok(!one.html.includes("Nothing to clear."));
    const loading = toolbar({ loading: true, failed: false, entries: 0 });
    assert.equal(loading.clear.disabled, true);
    assert.ok(!loading.html.includes("Nothing to clear."), "not yet loaded");
    const failed = toolbar({ loading: false, failed: true, entries: 0 });
    assert.equal(failed.clear.disabled, false, "a failed load keeps Clear on");
    assert.ok(!failed.html.includes("Nothing to clear."));
    assert.deepEqual(
      clearDisabled({ loading: true, failed: false, entries: 3 }),
      {
        disabled: true,
        empty: false,
      },
    );
    const source = readFileSync(
      new URL("./HistorySettings.tsx", import.meta.url),
      "utf8",
    );
    assert.ok(source.includes("clearDisabled({"));
    assert.ok(source.includes("disabled={clearing.disabled}"));
    assert.ok(source.includes("listEmpty={clearing.empty}"));
    assert.ok(!source.includes("disabled={loading}"));
  });

  it("history_header_lost_compare_and_folder", () => {
    const source = readFileSync(
      new URL("./HistorySettings.tsx", import.meta.url),
      "utf8",
    );
    assert.ok(!source.includes("settings.history.compare"));
    assert.ok(!source.includes("openRecordingsFolder"));
  });
});
