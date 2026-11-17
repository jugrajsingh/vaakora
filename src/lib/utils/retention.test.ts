import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import en from "../../i18n/locales/en/translation.json";
import type {
  ReadHistoryEntry,
  ReadHistoryRetention,
  RecordingRetentionPeriod,
} from "@/bindings";
const {
  mock,
  describe,
  it,
}: {
  mock: { module: (name: string, factory: () => unknown) => void };
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => Promise<void> | void) => void;
} = createRequire(import.meta.url)("bun:test");

let settings: Record<string, unknown> = {};
const updates: [string, unknown][] = [];
mock.module("@/hooks/useSettings", () => ({
  useSettings: () => ({
    getSetting: (key: string) => settings[key],
    isUpdating: () => false,
    updateSetting: async (key: string, value: unknown) => {
      updates.push([key, value]);
    },
  }),
}));
const { Input: RealInput } = await import("@/components/ui/Input");
const { Dropdown: RealDropdown } = await import("@/components/ui/Dropdown");
type InputProps = Parameters<typeof RealInput>[0];
type DropdownProps = Parameters<typeof RealDropdown>[0];
let inputProps: InputProps | undefined;
let dropdownProps: DropdownProps | undefined;
mock.module("@/components/ui/Input", () => ({
  Input: (props: InputProps) => {
    inputProps = props;
    return RealInput(props);
  },
}));
mock.module("@/components/ui/Dropdown", () => ({
  Dropdown: (props: DropdownProps) => {
    dropdownProps = props;
    return RealDropdown(props);
  },
}));
const {
  autoDeleteConfirm,
  currentKeep,
  dictationChangeDeletes,
  readsRemovedBy,
  routeChange,
} = await import("./retention");
const { createPendingConfirm } = await import(
  "@/components/shared/InlineConfirm"
);
const { HistorySettingsRow } = await import(
  "@/components/settings/tts/history/HistorySettingsRow"
);
const { RecordingRetentionPeriodSelector } = await import(
  "@/components/settings/RecordingRetentionPeriod"
);
const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: en } } });

const DAY = 24 * 60 * 60;
const NOW = 1_800_000_000;

function render(element: React.ReactElement) {
  inputProps = undefined;
  dropdownProps = undefined;
  updates.length = 0;
  renderToStaticMarkup(React.createElement(I18nextProvider, { i18n }, element));
}

/** Lets a change finish reading the stored list before the test looks at it. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The read settings row; `entries` is the page's list, `stored` what a refresh reads now. */
function readRow(
  entries: readonly ReadHistoryEntry[] | null,
  stored: readonly ReadHistoryEntry[] | null = entries,
) {
  const changes: [string, unknown][] = [];
  settings = { tts_history_limit: 5, tts_history_retention: "keep_limit" };
  render(
    React.createElement(HistorySettingsRow, {
      entries,
      refresh: async () => stored,
      clearing: false,
      canClear: true,
      clear: () => {},
      changeLimit: (limit: number) => changes.push(["limit", limit]),
      changeRetention: (retention: ReadHistoryRetention) =>
        changes.push(["retention", retention]),
    }),
  );
  assert.ok(inputProps && dropdownProps);
  return { changes, input: inputProps, dropdown: dropdownProps };
}

/** Five reads at now, now-2d, now-10d, now-40d and now-100d, newest first, ids 1 to 5. */
function reads(now: number): ReadHistoryEntry[] {
  return [0, 2, 10, 40, 100].map((days, index) => ({
    id: index + 1,
    timestamp: now - days * DAY,
    model_id: "m",
    voice: "v",
    speed: 1,
    technical: false,
    source: "s",
    chunks: [],
  }));
}

describe("retention", () => {
  it("dictation_rules", () => {
    const rows: [
      RecordingRetentionPeriod,
      number,
      RecordingRetentionPeriod,
      number,
      boolean,
    ][] = [
      ["never", 50, "preserve_limit", 50, true],
      ["preserve_limit", 50, "preserve_limit", 100, false],
      ["preserve_limit", 50, "preserve_limit", 10, true],
      ["preserve_limit", 50, "never", 50, false],
      ["preserve_limit", 50, "days_3", 50, true],
      ["weeks_2", 50, "days_3", 50, true],
      ["days_3", 50, "months_3", 50, false],
      ["months_3", 5, "months_3", 1, false],
      ["never", 50, "never", 1, false],
      ["never", 50, "weeks_2", 50, true],
      ["days_3", 50, "days_3", 50, false],
      ["months_3", 50, "preserve_limit", 50, true],
    ];
    for (const [fromPeriod, fromLimit, toPeriod, toLimit, deletes] of rows) {
      assert.equal(
        dictationChangeDeletes(
          { period: fromPeriod, limit: fromLimit },
          { period: toPeriod, limit: toLimit },
        ),
        deletes,
        `${fromPeriod} ${fromLimit} -> ${toPeriod} ${toLimit}`,
      );
    }
  });
  it("dictation_rules_read_the_stored_spelling", () => {
    // The settings store and the dropdown carry serde's "days3", not the binding's "days_3".
    const rows: [string, string, boolean][] = [
      ["days3", "months3", false],
      ["weeks2", "days3", true],
      ["days3", "days_3", false],
      ["preserve_limit", "weeks2", true],
    ];
    for (const [from, to, deletes] of rows) {
      assert.equal(
        dictationChangeDeletes(
          { period: from as RecordingRetentionPeriod, limit: 5 },
          { period: to as RecordingRetentionPeriod, limit: 5 },
        ),
        deletes,
        `${from} -> ${to}`,
      );
    }
  });
  it("unset_period_is_treated_as_the_backend_default", () => {
    const only =
      (values: Record<string, unknown>) =>
      <K extends string>(key: K) =>
        values[key] as never;
    assert.deepEqual(currentKeep(only({ history_limit: 50 })), {
      period: "preserve_limit",
      limit: 50,
    });
    assert.deepEqual(currentKeep(only({})), {
      period: "preserve_limit",
      limit: 5,
    });
    assert.deepEqual(
      currentKeep(
        only({ history_limit: 0, recording_retention_period: "never" }),
      ),
      { period: "never", limit: 0 },
    );
  });
  it("reads_removed_count", () => {
    const entries = reads(NOW);
    const cases: [number, ReadHistoryRetention, number][] = [
      [5, "keep_limit", 0],
      [2, "keep_limit", 3],
      [0, "keep_limit", 5],
      [5, "keep_nothing", 5],
      [5, "weeks_2", 2],
      [1, "days_3", 4],
      [5, "months_3", 1],
    ];
    for (const [limit, retention, removed] of cases) {
      assert.equal(
        readsRemovedBy(entries, { limit, retention }, NOW),
        removed,
        `${limit} ${retention}`,
      );
    }
    assert.equal(
      readsRemovedBy([], { limit: 0, retention: "keep_nothing" }, NOW),
      0,
    );
  });
  it("reads_removed_count_with_equal_timestamps", () => {
    const tied = reads(NOW).map((entry) => ({ ...entry, timestamp: NOW }));
    assert.equal(
      readsRemovedBy(tied, { limit: 2, retention: "keep_limit" }, NOW),
      3,
    );
    assert.equal(
      readsRemovedBy(tied, { limit: 2, retention: "days_3" }, NOW),
      3,
    );
  });
  it("route_change_asks_only_when_it_deletes", () => {
    const calls: string[] = [];
    const deps = {
      deletes: (change: number) => change < 0,
      ask: (change: number) => calls.push(`ask ${change}`),
      apply: (change: number) => calls.push(`apply ${change}`),
    };
    routeChange(1, deps);
    routeChange(-1, deps);
    assert.deepEqual(calls, ["apply 1", "ask -1"]);
  });
  it("read_retention_controls_wait_for_the_list", () => {
    const waiting = readRow(null);
    assert.equal(waiting.input.disabled, true);
    assert.equal(waiting.dropdown.disabled, true);
    const loaded = readRow([]);
    assert.equal(loaded.input.disabled, false);
    assert.equal(loaded.dropdown.disabled, false);
  });
  it("read_change_counts_the_stored_list_not_the_page", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stale = readRow([], reads(now).slice(0, 1));
    stale.dropdown.onSelect("keep_nothing");
    await settle();
    assert.deepEqual(stale.changes, []);
    const empty = readRow([], []);
    empty.dropdown.onSelect("keep_nothing");
    await settle();
    assert.deepEqual(empty.changes, [["retention", "keep_nothing"]]);
  });
  it("read_change_is_dropped_when_the_list_cannot_be_read", async () => {
    const row = readRow([], null);
    row.dropdown.onSelect("months_3");
    row.input.onChange?.({
      target: { value: "10" },
    } as React.ChangeEvent<HTMLInputElement>);
    row.input.onBlur?.({} as React.FocusEvent<HTMLInputElement>);
    await settle();
    assert.deepEqual(row.changes, []);
  });
  it("read_limit_enter_keeps_its_keypress_from_the_confirm", () => {
    const { input } = readRow([]);
    const pressed = (key: string) => {
      let prevented = false;
      input.onKeyDown?.({
        key,
        preventDefault: () => {
          prevented = true;
        },
      } as React.KeyboardEvent<HTMLInputElement>);
      return prevented;
    };
    assert.equal(pressed("a"), false);
    assert.equal(pressed("Enter"), true);
  });
  it("read_changes_ask_only_when_they_delete", async () => {
    const now = Math.floor(Date.now() / 1000);
    const row = readRow(reads(now));
    row.dropdown.onSelect("weeks_2");
    row.dropdown.onSelect("keep_nothing");
    await settle();
    assert.deepEqual(row.changes, []);
    row.dropdown.onSelect("keep_limit");
    await settle();
    assert.deepEqual(row.changes, [["retention", "keep_limit"]]);
    const field = readRow(reads(now));
    field.input.onChange?.({
      target: { value: "2" },
    } as React.ChangeEvent<HTMLInputElement>);
    field.input.onBlur?.({} as React.FocusEvent<HTMLInputElement>);
    await settle();
    assert.deepEqual(field.changes, []);
    field.input.onChange?.({
      target: { value: "10" },
    } as React.ChangeEvent<HTMLInputElement>);
    field.input.onBlur?.({} as React.FocusEvent<HTMLInputElement>);
    await settle();
    assert.deepEqual(field.changes, [["limit", 10]]);
  });
  it("dictation_period_select_asks_only_when_it_deletes", () => {
    settings = { history_limit: 50 };
    render(React.createElement(RecordingRetentionPeriodSelector, {}));
    assert.ok(dropdownProps);
    dropdownProps.onSelect("days3");
    dropdownProps.onSelect("never");
    assert.deepEqual(updates, [["recording_retention_period", "never"]]);
  });
  it("pending_auto_delete_names_the_limit_its_confirm_applies", async () => {
    // Auto-delete Never with limit 50, Keep latest asked, the limit then set to 0, then Confirm.
    const store: Record<string, unknown> = {
      recording_retention_period: "never",
      history_limit: 50,
    };
    const stored = () =>
      currentKeep(<K extends string>(key: K) => store[key] as never);
    type Keep = { period: RecordingRetentionPeriod; limit: number };
    const shown: { value: Keep | null } = { value: null };
    const pending = createPendingConfirm<Keep>({
      show: (value) => {
        shown.value = value;
      },
      apply: (to) => {
        store.recording_retention_period = to.period;
      },
    });
    const from = stored();
    routeChange(
      { ...from, period: "preserve_limit" },
      {
        deletes: (to) => dictationChangeDeletes(from, to),
        ask: pending.ask,
        apply: () => assert.fail("Keep latest from Never must ask"),
      },
    );
    store.history_limit = 0;
    assert.ok(shown.value);
    const sentence = autoDeleteConfirm(shown.value, stored());
    await pending.confirm();
    assert.deepEqual(stored(), { period: "preserve_limit", limit: 0 });
    assert.deepEqual(sentence, {
      key: "settings.history.retentionConfirm.preserveLimit",
      count: 0,
    });
    assert.equal(
      autoDeleteConfirm(
        { period: "days3" as RecordingRetentionPeriod, limit: 50 },
        stored(),
      ).key,
      "settings.history.retentionConfirm.days3",
    );
    assert.equal(
      autoDeleteConfirm({ period: "weeks_2", limit: 50 }, stored()).key,
      "settings.history.retentionConfirm.weeks2",
    );
  });
  it("confirm_counts_read_right_in_every_locale", async () => {
    const root = new URL("../../i18n/locales/", import.meta.url);
    const languages = readdirSync(root);
    const resources = Object.fromEntries(
      languages.map((language) => [
        language,
        {
          translation: JSON.parse(
            readFileSync(new URL(`${language}/translation.json`, root), "utf8"),
          ),
        },
      ]),
    );
    const all = i18next.createInstance();
    await all.init({ lng: "en", fallbackLng: "en", resources });
    const keys = [
      "tts.history.retentionConfirm.message",
      "settings.history.retentionConfirm.preserveLimit",
    ];
    for (const key of keys) {
      for (const count of [1, 2, 5, 21]) {
        const english = all.t(key, { lng: "en", count });
        for (const language of languages) {
          const text = all.t(key, { lng: language, count });
          const where = `${language} ${key} ${count}: ${text}`;
          if (count !== 1) assert.ok(text.includes(String(count)), where);
          if (language !== "en") assert.notEqual(text, english, where);
        }
      }
    }
    const read = (language: string, count: number) =>
      all.t("tts.history.retentionConfirm.message", { lng: language, count });
    assert.equal(
      read("en", 1),
      "Delete 1 stored read now? Your vocabulary is not changed.",
    );
    assert.equal(
      read("en", 5),
      "Delete 5 stored reads now? Your vocabulary is not changed.",
    );
    assert.equal(
      read("ru", 21),
      "Удалить сейчас 21 сохранённое чтение? Ваш словарь не изменится.",
    );
    assert.equal(
      read("ru", 5),
      "Удалить сейчас сохранённые чтения (5)? Ваш словарь не изменится.",
    );
    assert.equal(
      read("ar", 2),
      "هل تريد حذف 2 من القراءات المخزنة الآن؟ لن يتغير قاموس المفردات لديك.",
    );
  });
});
