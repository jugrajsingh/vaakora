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
const tooltips: unknown[] = [];
mock.module("@/components/ui/Input", () => ({
  Input: (props: InputProps) => {
    inputProps = props;
    return RealInput(props);
  },
}));
mock.module("@/components/ui/InfoTooltip", () => ({
  InfoTooltip: ({ text }: { text: unknown }) => {
    tooltips.push(text);
    return null;
  },
}));
mock.module("@/components/ui/Dropdown", () => ({
  Dropdown: (props: DropdownProps) => {
    dropdownProps = props;
    return RealDropdown(props);
  },
}));
const realConfirm = {
  ...(await import("@/components/shared/InlineConfirm")),
};
type PendingDeps = Parameters<typeof realConfirm.createPendingConfirm>[0];
const confirmDeps: { deps: PendingDeps; shown: unknown[] }[] = [];
mock.module("@/components/shared/InlineConfirm", () => ({
  ...realConfirm,
  createPendingConfirm: (deps: PendingDeps) => {
    const shown: unknown[] = [];
    confirmDeps.push({ deps, shown });
    return realConfirm.createPendingConfirm({
      ...deps,
      show: (value) => {
        shown.push(value);
        deps.show(value);
      },
    });
  },
}));
const {
  AUTO_DELETE_OPTIONS,
  autoDeleteConfirm,
  currentKeep,
  dictationChangeDeletes,
  dictationLimitRow,
  dictationSummary,
  readLimitRow,
  readRecount,
  readSummary,
  readsRemovedBy,
  routeChange,
} = await import("./retention");
const { READ_KEEP_OPTIONS } = await import(
  "@/components/settings/tts/history/presentation"
);
const { createPendingConfirm } = await import(
  "@/components/shared/InlineConfirm"
);
const { ReadRetentionGroup } = await import(
  "@/components/settings/tts/history/ReadRetentionGroup"
);
const { RecordingRetentionPeriodSelector } = await import(
  "@/components/settings/RecordingRetentionPeriod"
);
const { HistoryLimit } = await import("@/components/settings/HistoryLimit");
const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: en } } });

const DAY = 24 * 60 * 60;
const NOW = 1_800_000_000;

function render(element: React.ReactElement): string {
  inputProps = undefined;
  dropdownProps = undefined;
  tooltips.length = 0;
  updates.length = 0;
  return renderToStaticMarkup(
    React.createElement(I18nextProvider, { i18n }, element),
  );
}

/** Lets a change finish reading the stored list before the test looks at it. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The read retention group; `entries` is the page's list, `stored` what a refresh reads now. */
function readRow(
  entries: readonly ReadHistoryEntry[] | null,
  stored: readonly ReadHistoryEntry[] | null = entries,
  retention: ReadHistoryRetention = "keep_limit",
) {
  const changes: [string, unknown][] = [];
  settings = { tts_history_limit: 5, tts_history_retention: retention };
  const html = render(
    React.createElement(ReadRetentionGroup, {
      entries,
      refresh: async () => stored,
      changeLimit: (limit: number) => changes.push(["limit", limit]),
      changeRetention: (retention: ReadHistoryRetention) =>
        changes.push(["retention", retention]),
    }),
  );
  assert.ok(inputProps && dropdownProps);
  return {
    changes,
    html,
    tips: [...tooltips],
    input: inputProps,
    dropdown: dropdownProps,
  };
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
  it("option_values_keep_stored_spellings", () => {
    assert.deepEqual(
      AUTO_DELETE_OPTIONS.map((option) => option.value),
      ["never", "preserve_limit", "days3", "weeks2", "months3"],
    );
    assert.deepEqual(
      READ_KEEP_OPTIONS.map((option) => option.value),
      ["keep_nothing", "keep_limit", "days_3", "weeks_2", "months_3"],
    );
  });
  it("retention_wording_matches_4_3", () => {
    const words = (options: readonly { key: string }[]) =>
      options.map((option) => i18n.t(option.key, { count: 50 }));
    assert.deepEqual(words(AUTO_DELETE_OPTIONS), [
      "Off (keep everything)",
      "Keep latest 50",
      "Older than 3 days",
      "Older than 2 weeks",
      "Older than 3 months",
    ]);
    assert.deepEqual(words(READ_KEEP_OPTIONS), [
      "Do not keep",
      "Keep the latest 50",
      "Keep the latest 50, none older than 3 days",
      "Keep the latest 50, none older than 2 weeks",
      "Keep the latest 50, none older than 3 months",
    ]);
  });
  it("limit_rows_follow_the_choice", () => {
    const reason = "settings.dictationHistory.limitTimeLimit";
    for (const period of [
      "days3",
      "days_3",
      "weeks2",
      "weeks_2",
      "months3",
      "months_3",
    ]) {
      assert.deepEqual(
        dictationLimitRow(period),
        { disabled: true, reasonKey: reason },
        period,
      );
    }
    for (const period of ["never", "preserve_limit"]) {
      assert.deepEqual(
        dictationLimitRow(period),
        { disabled: false, reasonKey: null },
        period,
      );
    }
    assert.deepEqual(readLimitRow("keep_nothing"), {
      disabled: true,
      reasonKey: "settings.readAloudHistory.limitOff",
    });
    for (const keep of [
      "keep_limit",
      "days_3",
      "weeks_2",
      "months_3",
    ] as const) {
      assert.deepEqual(
        readLimitRow(keep),
        { disabled: false, reasonKey: null },
        keep,
      );
    }
  });
  it("disabled_limit_fields_never_write", () => {
    settings = { history_limit: 50, recording_retention_period: "weeks2" };
    const timed = render(React.createElement(HistoryLimit, {}));
    assert.ok(inputProps);
    assert.equal(inputProps.disabled, true);
    assert.ok(timed.includes("Not used with a time limit."));
    assert.deepEqual(tooltips, []);
    assert.deepEqual(updates, []);
    settings = { history_limit: 50, recording_retention_period: "never" };
    const open = render(React.createElement(HistoryLimit, {}));
    assert.ok(inputProps);
    assert.equal(inputProps.disabled, false);
    assert.ok(!open.includes("Not used with a time limit."));
    assert.deepEqual(tooltips, ["How many entries Keep latest keeps."]);
    const off = readRow([], [], "keep_nothing");
    assert.equal(off.input.disabled, true);
    assert.ok(off.html.includes("Not used when history is off."));
    assert.deepEqual(off.tips, []);
    const on = readRow([]);
    assert.equal(on.input.disabled, false);
    assert.ok(!on.html.includes("Not used when history is off."));
    assert.deepEqual(on.tips, ["How many entries Keep history keeps."]);
  });
  it("auto_delete_row_uses_its_own_help", () => {
    settings = { history_limit: 50, recording_retention_period: "weeks2" };
    const html = render(React.createElement(RecordingRetentionPeriodSelector));
    assert.ok(dropdownProps);
    assert.equal(dropdownProps.selectedValue, "weeks2");
    assert.deepEqual(
      dropdownProps.options.map((option) => option.label),
      [
        "Off (keep everything)",
        "Keep latest 50",
        "Older than 3 days",
        "Older than 2 weeks",
        "Older than 3 months",
      ],
    );
    assert.ok(html.includes(">Auto-delete</h3>"));
    assert.ok(
      html.includes(
        "Starred entries and transcribed files are never auto-deleted.",
      ),
    );
  });
  it("read_rows_order", () => {
    const { html } = readRow([]);
    const keep = html.indexOf("Keep history");
    const latest = html.indexOf("Keep the latest</h3>");
    assert.ok(keep >= 0 && latest > keep, "Keep history comes first");
    assert.ok(html.includes("Text only, no audio."));
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
  it("read_retention_group_has_no_clear", () => {
    settings = { tts_history_limit: 5, tts_history_retention: "keep_limit" };
    const html = renderToStaticMarkup(
      React.createElement(
        I18nextProvider,
        { i18n },
        React.createElement(ReadRetentionGroup, {
          entries: [],
          refresh: async () => [],
          changeLimit: () => {},
          changeRetention: () => {},
        }),
      ),
    );
    assert.ok(!html.includes("Clear history"));
    assert.deepEqual(
      [...html.matchAll(/<h3[^>]*>(.*?)<\/h3>/g)].map((match) => match[1]),
      ["Keep history", "Keep the latest"],
    );
    assert.ok(html.includes(">History</h2>"));
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
  it("read_recount_reasks_applies_or_drops", () => {
    const asked = {
      count: 2,
      newest: 1,
      next: { limit: 3, retention: "keep_limit" as ReadHistoryRetention },
    };
    const stored = reads(NOW);
    assert.equal(readsRemovedBy(stored, asked.next, NOW), 2);
    assert.equal(readRecount(asked, stored, NOW), "apply");
    const sixth = [{ ...stored[0], id: 6, timestamp: NOW }, ...stored];
    assert.deepEqual(readRecount(asked, sixth, NOW), {
      ...asked,
      count: 3,
      newest: 6,
    });
    const pruned = [
      { ...stored[0], id: 6, timestamp: NOW },
      ...stored.slice(0, 4),
    ];
    assert.equal(readsRemovedBy(pruned, asked.next, NOW), asked.count);
    assert.deepEqual(
      readRecount(asked, pruned, NOW),
      { ...asked, newest: 6 },
      "one read added and the oldest pruned keeps the count but is a new read",
    );
    assert.equal(readRecount(asked, [], NOW), "apply");
    assert.equal(readRecount(asked, null, NOW), "drop");
    const nothing = {
      count: 5,
      newest: 1,
      next: { limit: 0, retention: "keep_limit" as ReadHistoryRetention },
    };
    assert.equal(readRecount(nothing, [], NOW), "apply");
  });
  it("read_retention_confirm_recounts", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stored = reads(now);
    confirmDeps.length = 0;
    const row = readRow(stored, stored);
    row.dropdown.onSelect("keep_nothing");
    await settle();
    const recorded = confirmDeps[confirmDeps.length - 1];
    assert.ok(recorded?.deps.recount, "the confirm recounts before it applies");
    const asked = recorded.shown[recorded.shown.length - 1] as {
      count: number;
      newest: number;
    };
    assert.equal(asked.count, 5);
    assert.equal(asked.newest, 1);
    stored.unshift({ ...stored[0], id: 6, timestamp: now });
    const again = (await recorded.deps.recount(asked)) as {
      count: number;
      newest: number;
      next: unknown;
    };
    assert.equal(again.count, 6);
    assert.equal(again.newest, 6);
    assert.deepEqual(again.next, { limit: 5, retention: "keep_nothing" });
    assert.deepEqual(row.changes, []);
  });
  it("retention_controls_are_focus_rows", () => {
    const group = readRow([]).html;
    assert.match(group, /data-confirm-row="retention"/);
    assert.match(group, /data-confirm-row="limit"/);
    settings = { history_limit: 50, recording_retention_period: "weeks2" };
    assert.match(
      render(React.createElement(RecordingRetentionPeriodSelector)),
      /data-confirm-row="period"/,
    );
    for (const file of [
      "HistoryLimit.tsx",
      "RecordingRetentionPeriod.tsx",
      "tts/history/ReadRetentionGroup.tsx",
    ]) {
      const source = readFileSync(
        new URL(`../../components/settings/${file}`, import.meta.url),
        "utf8",
      );
      assert.match(source, /useRefocusOnClose\([^)]*CONTROL_TARGETS/s, file);
    }
  });
  it("retention_controls_show_a_focus_ring", () => {
    const element = (html: string, tag: string, marker: string) => {
      const found = html.match(new RegExp(`<${tag} [^>]*${marker}[^>]*>`));
      assert.ok(found, `${tag} with ${marker}`);
      return found[0];
    };
    const ringed = (opener: string, where: string) => {
      assert.match(opener, /focus-visible:ring-2/, where);
      assert.match(opener, /focus-visible:ring-logo-primary/, where);
    };
    settings = { history_limit: 50, recording_retention_period: "never" };
    const dictationLimit = render(React.createElement(HistoryLimit, {}));
    ringed(
      element(dictationLimit, "input", 'type="number"'),
      "HistoryLimit number field",
    );
    const period = render(
      React.createElement(RecordingRetentionPeriodSelector),
    );
    ringed(
      element(period, "button", "aria-expanded"),
      "RecordingRetentionPeriod trigger",
    );
    const group = readRow([]).html;
    ringed(
      element(group, "input", 'type="number"'),
      "ReadRetentionGroup number field",
    );
    ringed(
      element(group, "button", "aria-expanded"),
      "ReadRetentionGroup drop-down trigger",
    );
  });
  it("read_retention_group_cancels_its_question_on_unmount", () => {
    const source = readFileSync(
      new URL(
        "../../components/settings/tts/history/ReadRetentionGroup.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    assert.match(
      source,
      /useEffect\(\(\) => confirm\.cancel, \[confirm\]\)/,
      "ReadRetentionGroup registers confirm.cancel as an effect cleanup",
    );
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
      "Delete 1 entry now? Your vocabulary is not changed.",
    );
    assert.equal(
      read("en", 5),
      "Delete 5 entries now? Your vocabulary is not changed.",
    );
    assert.equal(
      read("ru", 21),
      "Удалить сейчас 21 запись? Ваш словарь не изменится.",
    );
    assert.equal(
      read("ru", 5),
      "Удалить сейчас записи (5)? Ваш словарь не изменится.",
    );
    assert.equal(
      read("ar", 2),
      "هل تريد حذف 2 من الإدخالات الآن؟ لن يتغير قاموس المفردات لديك.",
    );
  });

  it("dictation_summary_names_the_rule", async () => {
    const english = i18next.createInstance();
    await english.init({ lng: "en", resources: { en: { translation: en } } });
    const text = (keep: Parameters<typeof dictationSummary>[0]) => {
      const summary = dictationSummary(keep);
      return english.t(summary.key, { count: summary.count });
    };
    const STAR = "Starred entries are kept.";
    assert.equal(
      text({ period: "preserve_limit", limit: 50 }),
      `Keeps the latest 50 entries. ${STAR}`,
    );
    assert.equal(
      text({ period: "preserve_limit", limit: 1 }),
      `Keeps the latest entry. ${STAR}`,
    );
    assert.deepEqual(
      dictationSummary({ period: "preserve_limit", limit: 50 }),
      {
        key: "history.summary.dictation.latest",
        count: 50,
        kept: true,
      },
    );
    assert.deepEqual(dictationSummary({ period: "preserve_limit", limit: 0 }), {
      key: "history.summary.dictation.none",
      kept: false,
    });
    assert.equal(
      text({ period: "preserve_limit", limit: 0 }),
      "Keeps no entries. Starred entries and transcribed files are kept.",
    );
    for (const limit of [0, 50]) {
      assert.equal(
        text({ period: "never", limit }),
        `Keeps every entry. ${STAR}`,
        `never ignores the limit ${limit}`,
      );
    }
    const timed: [string, string][] = [
      ["days_3", "3 days"],
      ["days3", "3 days"],
      ["weeks_2", "2 weeks"],
      ["weeks2", "2 weeks"],
      ["months_3", "3 months"],
      ["months3", "3 months"],
    ];
    for (const [period, age] of timed) {
      for (const limit of [0, 50]) {
        const summary = dictationSummary({
          period: period as RecordingRetentionPeriod,
          limit,
        });
        assert.equal(summary.kept, true, `${period} ${limit}`);
        assert.equal(
          english.t(summary.key, { count: summary.count }),
          `Deletes entries older than ${age}. ${STAR}`,
          `${period} ${limit}`,
        );
      }
    }
    for (const { value } of AUTO_DELETE_OPTIONS) {
      assert.ok(
        text({ period: value, limit: 50 }).endsWith(STAR),
        `${value} says "${STAR}"`,
      );
    }
    assert.deepEqual(
      AUTO_DELETE_OPTIONS.map(
        ({ value }) => dictationSummary({ period: value, limit: 50 }).key,
      ),
      [
        "history.summary.dictation.never",
        "history.summary.dictation.latest",
        "history.summary.dictation.days3",
        "history.summary.dictation.weeks2",
        "history.summary.dictation.months3",
      ],
    );
  });
  it("read_summary_names_the_rule", async () => {
    const english = i18next.createInstance();
    await english.init({ lng: "en", resources: { en: { translation: en } } });
    const text = (limit: number, retention: ReadHistoryRetention) => {
      const summary = readSummary(limit, retention);
      return english.t(summary.key, { count: summary.count });
    };
    assert.equal(
      text(50, "weeks_2"),
      "Keeps the latest 50 entries, none older than 2 weeks.",
    );
    assert.equal(
      text(1, "days_3"),
      "Keeps the latest entry, none older than 3 days.",
    );
    assert.equal(
      text(5, "months_3"),
      "Keeps the latest 5 entries, none older than 3 months.",
    );
    assert.equal(text(5, "keep_limit"), "Keeps the latest 5 entries.");
    assert.equal(text(1, "keep_limit"), "Keeps the latest entry.");
    assert.deepEqual(readSummary(50, "keep_limit"), {
      key: "history.summary.read.latest",
      count: 50,
      kept: true,
    });
    for (const retention of [
      "keep_nothing",
      "keep_limit",
      "days_3",
      "weeks_2",
      "months_3",
    ] as const) {
      const off = readSummary(0, retention);
      assert.deepEqual(off, { key: "history.notKept", kept: false }, retention);
      assert.equal(english.t(off.key), "History is not being kept.");
    }
    assert.deepEqual(readSummary(50, "keep_nothing"), {
      key: "history.notKept",
      kept: false,
    });
  });
  it("summaries_keep_their_count_in_every_locale", async () => {
    const root = new URL("../../i18n/locales/", import.meta.url);
    const languages = readdirSync(root);
    assert.equal(languages.length, 26);
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
    const STAR_ENGLISH = all
      .t("history.summary.dictation.latest", {
        lng: "en",
        count: 50,
      })
      .split(". ")
      .pop();
    const failures: string[] = [];
    for (const language of languages) {
      for (const count of [1, 2, 5, 21, 31, 101]) {
        const summaries = [
          dictationSummary({ period: "preserve_limit", limit: count }),
          ...(["keep_limit", "days_3", "weeks_2", "months_3"] as const).map(
            (retention) => readSummary(count, retention),
          ),
        ];
        for (const summary of summaries) {
          const text = all.t(summary.key, { lng: language, count });
          const where = `${language} ${summary.key} count=${count}: ${text}`;
          if (text === "" || text === summary.key) failures.push(where);
          // Plural category "one" covers 21, 31 and 101 in some languages, so only 1 may omit the number.
          else if (count !== 1 && !text.includes(String(count))) {
            failures.push(where);
          }
        }
      }
      const lastSentence = (key: string) =>
        all
          .t(key, { lng: language, count: 50 })
          .split(/(?<=[.。।])\s*/u)
          .filter(Boolean)
          .pop();
      const shared = lastSentence("history.summary.dictation.latest");
      for (const key of ["never", "days3", "weeks2", "months3"]) {
        const full = `history.summary.dictation.${key}`;
        if (lastSentence(full) !== shared) {
          failures.push(
            `${language} ${full} lacks the common starred sentence`,
          );
        }
      }
      if (language !== "en" && shared === STAR_ENGLISH) {
        failures.push(`${language} starred sentence is English`);
      }
    }
    assert.deepEqual(failures, []);
  });
  it("summaries_in_every_locale", () => {
    const root = new URL("../../i18n/locales/", import.meta.url);
    const languages = readdirSync(root);
    assert.equal(languages.length, 26);
    const keys = [
      "history.change",
      "history.changeLabel",
      "history.transcribeFile",
      "history.notKept",
      "history.summary.dictation.never",
      "history.summary.dictation.none",
      "history.summary.dictation.latest",
      "history.summary.dictation.latest_one",
      "history.summary.dictation.days3",
      "history.summary.dictation.weeks2",
      "history.summary.dictation.months3",
      "history.summary.read.latest",
      "history.summary.read.latest_one",
      "history.summary.read.days3",
      "history.summary.read.days3_one",
      "history.summary.read.weeks2",
      "history.summary.read.weeks2_one",
      "history.summary.read.months3",
      "history.summary.read.months3_one",
    ];
    for (const language of languages) {
      const locale: unknown = JSON.parse(
        readFileSync(new URL(`${language}/translation.json`, root), "utf8"),
      );
      for (const key of keys) {
        const found = key
          .split(".")
          .reduce<unknown>(
            (node, part) =>
              typeof node === "object" && node !== null
                ? (node as Record<string, unknown>)[part]
                : undefined,
            locale,
          );
        assert.equal(typeof found, "string", `${language} ${key}`);
        assert.notEqual(found, "", `${language} ${key}`);
        if (
          /^history\.summary\.(read\.[a-z0-9]+|dictation\.latest)$/.test(key)
        ) {
          assert.ok(
            (found as string).includes("{{count}}"),
            `${language} ${key} names the count`,
          );
        }
      }
    }
  });
});
