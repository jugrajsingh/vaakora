import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import en from "../../../../i18n/locales/en/translation.json";
import type { ReadHistoryEntry } from "@/bindings";
import { models } from "../vocabulary/fixtures";
import {
  NO_READ_VIEW,
  readView,
  type ReadView,
  type ReadViewAction,
} from "./selection";
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
mock.module("@/hooks/useOsType", () => ({ useOsType: () => "linux" }));
let settings: Record<string, unknown> = {};
mock.module("@/hooks/useSettings", () => ({
  useSettings: () => ({
    getSetting: (key: string) => settings[key],
    isUpdating: () => false,
    refreshSettings: async () => {},
  }),
}));
const corrections: Record<string, unknown>[] = [];
mock.module("../vocabulary/CorrectionBox", () => ({
  CorrectionBox: (props: Record<string, unknown>) => {
    corrections.push(props);
    return <i data-correction-box={String(props.written)} />;
  },
}));
const notices: { title: string }[] = [];
const realNotices = await import("@/stores/noticeStore");
mock.module("@/stores/noticeStore", () => ({
  ...realNotices,
  notify: (options: { title: string }) => notices.push(options),
}));
const {
  ReadHistoryTab,
  ReadHistoryRows,
  ReadHistoryStateLine,
  readHistoryActions,
} = await import("./ReadHistoryTab");
const { HistoryToolbar } = await import("@/components/shared/HistoryList");
const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: en } } });

describe("ReadHistoryTab", () => {
  it("history_tab_keeps_clear_without_retention_rows", () => {
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <ReadHistoryTab models={[]} changeRetention={() => {}} />
      </I18nextProvider>,
    );
    const clear = html.match(/<button[^>]*>Clear history<\/button>/)?.[0];
    assert.ok(clear, "the Clear history button");
    assert.ok(clear.includes('disabled=""'), "disabled with no reads");
    assert.ok(!html.includes("Keep history"));
    assert.ok(!html.includes("Keep the latest"));
    assert.ok(!html.includes("History settings"));
    const source = readFileSync(
      new URL("./ReadHistoryTab.tsx", import.meta.url),
      "utf8",
    );
    assert.ok(!source.includes("plugin-dialog"), "no system dialog");
  });

  const renderTab = (changeRetention: () => void = () => {}) =>
    renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <ReadHistoryTab models={[]} changeRetention={changeRetention} />
      </I18nextProvider>,
    );

  it("toolbar_has_summary_change_and_clear", () => {
    settings = {};
    const html = renderTab();
    assert.ok(html.includes("Keeps the latest 5 entries."), "default summary");
    const change = html.match(/<button[^>]*>Change<\/button>/)?.[0];
    assert.ok(change, "a Change button");
    assert.ok(change.includes('aria-label="Change how history is kept"'));
    assert.ok(html.includes(">Clear history</button>"));
    assert.ok(!html.includes("Transcribe file"));
    assert.ok(
      html.indexOf("Keeps the latest") < html.indexOf(">Change<") &&
        html.indexOf(">Change<") < html.indexOf(">Clear history<"),
      "summary, Change, then Clear history",
    );
    const toolbar = html.indexOf("data-history-toolbar");
    const alertAt = html.indexOf('role="alert"');
    assert.ok(toolbar >= 0);
    assert.ok(alertAt === -1 || toolbar < alertAt, "the toolbar comes first");
    settings = { tts_history_limit: 50, tts_history_retention: "weeks_2" };
    assert.ok(
      renderTab().includes(
        "Keeps the latest 50 entries, none older than 2 weeks.",
      ),
      "the summary follows the stored settings",
    );
    settings = { tts_history_limit: 0 };
    const off = renderTab();
    assert.ok(off.includes("History is not being kept."));
    assert.ok(off.includes(">Change<"), "Change stays when nothing is kept");
    settings = {};
  });

  it("toolbar_buttons_do_not_shrink_and_summary_wraps", () => {
    settings = {};
    const html = renderTab();
    const bar = html
      .match(/<div\b[^>]*\bdata-history-toolbar\b[^>]*>/u)?.[0]
      .match(/class="([^"]*)"/u)?.[1];
    assert.ok(bar, "the toolbar element");
    const barClasses = bar.split(/\s+/);
    for (const name of [
      "sticky",
      "top-0",
      "z-10",
      "flex-wrap",
      "bg-background",
    ]) {
      assert.ok(barClasses.includes(name), `${name} in "${bar}"`);
    }
    const summary = html.match(/<p class="([^"]*)">Keeps the latest/)?.[1];
    assert.ok(summary, "the summary paragraph");
    const summaryClasses = summary.split(/\s+/);
    for (const name of ["min-w-0", "flex-1", "text-xs", "text-ink-2"]) {
      assert.ok(summaryClasses.includes(name), `${name} in "${summary}"`);
    }
    const clear = html.match(/<button([^>]*)>Clear history<\/button>/)?.[1];
    assert.ok(clear, "the Clear history button");
    assert.match(clear, /class="[^"]*\bshrink-0\b/);
  });

  it("summary_keeps_its_width", () => {
    settings = {};
    const summary = renderTab().match(
      /<p class="([^"]*)">Keeps the latest/,
    )?.[1];
    assert.ok(summary, "the summary paragraph");
    const classes = summary.split(/\s+/);
    for (const name of ["flex-1", "basis-[20rem]"]) {
      assert.ok(classes.includes(name), `${name} in "${summary}"`);
    }
  });

  it("change_button_calls_change", () => {
    let changed = 0;
    let tree: React.ReactElement | null = null;
    function Probe() {
      tree = HistoryToolbar({
        summary: "Summary.",
        change: () => {
          changed += 1;
        },
        children: <i data-child />,
      });
      return null;
    }
    renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <Probe />
      </I18nextProvider>,
    );
    const buttons: { props: { onClick?: () => void; type?: string } }[] = [];
    const walk = (node: React.ReactNode): void => {
      React.Children.forEach(node, (child) => {
        if (!React.isValidElement(child)) return;
        const element = child as React.ReactElement<{
          children?: React.ReactNode;
          type?: string;
          onClick?: () => void;
        }>;
        if (element.type === "button") buttons.push(element);
        walk(element.props.children);
      });
    };
    walk(tree);
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0].props.type, "button");
    buttons[0].props.onClick?.();
    assert.equal(changed, 1);
  });
});

describe("ReadHistoryStateLine", () => {
  const line = (
    state: "loading" | "notKept" | "empty",
    binding: string | null = "super+alt+r",
  ) =>
    renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <ReadHistoryStateLine state={state} binding={binding} osType="linux" />
      </I18nextProvider>,
    );

  it("empty_names_the_shortcut", () => {
    const html = line("empty");
    assert.ok(html.includes("Nothing read yet."));
    assert.equal(html.match(/role="img"/g)?.length, 1);
    assert.ok(html.includes('aria-label="Super + Alt + R"'), html);
    assert.ok(html.includes("Copy some text and press "));
    assert.match(html, /^<div class="[^"]*\bpy-10\b[^"]*\btext-center\b/);
    assert.ok(!html.includes("italic"));
    const bare = line("empty", null);
    assert.ok(bare.includes("Nothing read yet."));
    assert.ok(!bare.includes('role="img"'), "no hint when unbound");
    assert.ok(!bare.includes("Copy some text"));
  });

  it("not_kept_says_so_without_a_second_change", () => {
    const html = line("notKept");
    assert.ok(html.includes("History is not being kept."));
    assert.ok(!html.includes("<button"), "the toolbar owns Change");
    assert.ok(!html.includes("Nothing read yet."));
  });

  it("loading_is_a_status_line", () => {
    const html = line("loading");
    assert.match(html, /<p role="status" class="text-sm text-ink-2">/);
    assert.ok(html.includes("Loading history..."));
    assert.ok(!html.includes("Nothing read yet."));
    assert.ok(!html.includes('role="img"'));
  });

  it("the_tab_shows_loading_first_and_drops_the_fork_empty_key", () => {
    settings = {};
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <ReadHistoryTab models={[]} changeRetention={() => {}} />
      </I18nextProvider>,
    );
    assert.ok(html.includes('role="status"'));
    assert.ok(!html.includes("Nothing read yet."));
    const source = readFileSync(
      new URL("./ReadHistoryTab.tsx", import.meta.url),
      "utf8",
    );
    assert.ok(source.includes("historyState({"));
    assert.ok(!source.includes("tts.history.empty"));
    assert.equal(
      source.match(/useOsType\(\)/g)?.length,
      1,
      "osType is read once and passed down",
    );
  });
});

const FIRST: ReadHistoryEntry = {
  id: 1,
  timestamp: 1_700_000_000,
  model_id: "pocket-en",
  voice: "alba",
  speed: 1,
  technical: true,
  source: "Open\n  README.md   now",
  chunks: [
    {
      chunk: {
        index: 0,
        text: "Open README dot markdown now",
        source_start: 0,
        source_end: 18,
        pause_ms: 450,
      },
      words: [
        { source_start: 0, source_end: 4, spoken_start: 0, spoken_end: 4 },
        { source_start: 5, source_end: 14, spoken_start: 5, spoken_end: 24 },
        { source_start: 15, source_end: 18, spoken_start: 25, spoken_end: 28 },
      ],
    },
  ],
};
const SECOND: ReadHistoryEntry = { ...FIRST, id: 2, source: "Second read" };
const ENTRIES = [FIRST, SECOND];

const renderRows = (
  view: ReadView,
  entries: readonly ReadHistoryEntry[] = ENTRIES,
  dispatch: (action: ReadViewAction) => void = () => {},
  copy: (text: string) => Promise<boolean> = async () => true,
) =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <ReadHistoryRows
        entries={entries}
        models={models}
        view={view}
        dispatch={dispatch}
        copy={copy}
      />
    </I18nextProvider>,
  );
/** The markup of the row for entry `id`, up to the next row. */
const rowMarkup = (html: string, id: number) => {
  const found = html
    .split("data-history-entry-id=")
    .find((part) => part.startsWith(`"${id}"`));
  assert.ok(found, `row ${id} is rendered`);
  return found;
};

/** Every element under `node`, including those held in props other than children. */
const elements = (node: React.ReactNode): React.ReactElement[] => {
  const found: React.ReactElement[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!React.isValidElement(value)) return;
    found.push(value);
    Object.values(value.props as Record<string, unknown>).forEach(walk);
  };
  walk(node);
  return found;
};

describe("ReadHistoryRows", () => {
  it("rows_are_collapsed_with_tag_and_copy", () => {
    const html = renderRows(NO_READ_VIEW);
    assert.ok(!html.includes('role="group"'), "no reading view");
    assert.equal(html.match(/aria-expanded="false"/g)?.length, 2);
    assert.ok(!html.includes('aria-expanded="true"'));
    for (const id of [1, 2]) {
      const row = rowMarkup(html, id);
      assert.ok(row.includes(">Pocket TTS, alba</span>"), "the tag");
      assert.match(row, /<button[^>]*title="Copy text"/, "a Copy button");
    }
    assert.ok(
      rowMarkup(html, 1).includes("Open README.md now"),
      "whitespace in the excerpt is collapsed",
    );
    assert.ok(!html.includes("Copy text</button>"), "no labelled Copy text");
  });

  it("open_row_shows_the_reading_view_at_full_width", () => {
    const html = renderRows({ ...NO_READ_VIEW, open: 1 });
    assert.equal(html.match(/role="group"/g)?.length, 1);
    const open = rowMarkup(html, 1);
    const closed = rowMarkup(html, 2);
    assert.ok(open.includes('role="group"'));
    assert.ok(!closed.includes('role="group"'));
    assert.ok(open.includes('aria-expanded="true"'));
    assert.ok(closed.includes('aria-expanded="false"'));
    const hint = open.match(/<p class="([^"]*)">Written text on top/)?.[1];
    assert.ok(hint, "the reading hint");
    assert.deepEqual(hint.split(/\s+/).sort(), ["text-ink-2", "text-xs"]);
    assert.ok(
      open.includes(
        "Written text on top, what was spoken underneath. Drag over words to correct how they were read.",
      ),
    );
    assert.match(open, /Copy text<\/button>/, "a labelled Copy text button");
    assert.ok(!html.includes("w-56"), "no fixed-width list column");
  });

  it("correction_renders_from_the_view_snapshot", () => {
    corrections.length = 0;
    const dispatched: ReadViewAction[] = [];
    const view: ReadView = {
      open: null,
      selection: null,
      correction: {
        key: "9:0-1",
        written: "README.md",
        spokenAs: "README dot markdown",
        readingModel: "pocket-en",
      },
    };
    const html = renderRows(view, [], (action) => dispatched.push(action));
    assert.ok(html.includes('data-correction-box="README.md"'));
    assert.equal(corrections.length, 1);
    const props = corrections[0] as {
      written: string;
      spokenAs: string;
      readingModel: string;
      models: unknown;
      onClose: () => void;
    };
    assert.equal(props.written, "README.md");
    assert.equal(props.spokenAs, "README dot markdown");
    assert.equal(props.readingModel, "pocket-en");
    assert.equal(props.models, models);
    props.onClose();
    assert.deepEqual(dispatched, [{ type: "closeCorrection" }]);
    corrections.length = 0;
    renderRows(NO_READ_VIEW);
    assert.equal(corrections.length, 0, "no correction, no box");
  });

  it("row_toggles_dispatch_toggle", () => {
    const dispatched: ReadViewAction[] = [];
    let tree: React.ReactNode = null;
    function Probe() {
      tree = ReadHistoryRows({
        entries: ENTRIES,
        models,
        view: { ...NO_READ_VIEW, open: 1 },
        dispatch: (action) => dispatched.push(action),
        copy: async () => true,
      });
      return null;
    }
    renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <Probe />
      </I18nextProvider>,
    );
    const toggles = elements(tree).filter(
      (element) =>
        typeof (element.props as { onToggle?: unknown }).onToggle ===
        "function",
    );
    assert.equal(toggles.length, 2);
    (toggles[1].props as { onToggle: () => void }).onToggle();
    assert.deepEqual(dispatched, [{ type: "toggle", id: 2 }]);
  });
});

describe("read copy", () => {
  const press = async (
    view: ReadView,
    copy: (text: string) => Promise<boolean>,
    pick: (element: React.ReactElement<Record<string, unknown>>) => boolean,
  ) => {
    let tree: React.ReactNode = null;
    function Probe() {
      tree = ReadHistoryRows({
        entries: [FIRST],
        models,
        view,
        dispatch: () => {},
        copy,
      });
      return null;
    }
    renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <Probe />
      </I18nextProvider>,
    );
    const button = elements(tree).find(
      (element) =>
        typeof (element.props as { onClick?: unknown }).onClick ===
          "function" &&
        pick(element as React.ReactElement<Record<string, unknown>>),
    );
    assert.ok(button, "the Copy control");
    await (button.props as { onClick: () => Promise<void> }).onClick();
  };
  const titled = (element: React.ReactElement<Record<string, unknown>>) =>
    element.props.title === "Copy text";
  const labelled = (element: React.ReactElement<Record<string, unknown>>) =>
    JSON.stringify(element.props.children ?? "").includes("Copy text");

  it("copy_copies_the_source_text_from_the_row_and_the_open_body", async () => {
    const copied: string[] = [];
    notices.length = 0;
    const copy = async (text: string) => {
      copied.push(text);
      return true;
    };
    await press(NO_READ_VIEW, copy, titled);
    await press({ ...NO_READ_VIEW, open: 1 }, copy, labelled);
    assert.deepEqual(copied, [FIRST.source, FIRST.source]);
    assert.deepEqual(notices, []);
  });

  it("copy_failure_notifies_with_copy_error", async () => {
    notices.length = 0;
    await press(NO_READ_VIEW, async () => false, titled);
    await press({ ...NO_READ_VIEW, open: 1 }, async () => false, labelled);
    await press(
      NO_READ_VIEW,
      async () => {
        throw new Error("denied");
      },
      titled,
    );
    assert.deepEqual(notices, [
      { title: en.tts.history.copyFailed },
      { title: en.tts.history.copyFailed },
      { title: en.tts.history.copyFailed },
    ]);
  });
});

describe("read history host", () => {
  const host = (ids: number[][]) => {
    let view: ReadView = NO_READ_VIEW;
    const dispatch = (action: ReadViewAction) => {
      view = readView(view, action);
    };
    const loads = [...ids];
    const calls: string[] = [];
    const actions = readHistoryActions({
      load: async () => (loads.shift() ?? []).map((id) => ({ ...FIRST, id })),
      clear: async () => {
        calls.push("clear");
        return 0;
      },
      setEntries: () => calls.push("entries"),
      setError: () => {},
      dispatch,
    });
    return { actions, calls, view: () => view, dispatch };
  };

  it("every_loaded_list_reaches_the_reducer", async () => {
    const { actions, view, dispatch } = host([[3, 2], [2]]);
    await actions.load();
    dispatch({ type: "toggle", id: 3 });
    assert.equal(view().open, 3);
    await actions.load();
    assert.equal(view().open, null, "the open read left the list");
  });

  it("clear_through_the_host_drops_open_even_when_ids_restart", async () => {
    // Read ids restart after Clear history: the next list holds a new read with the old id.
    const { actions, view, dispatch, calls } = host([[3], [3]]);
    await actions.load();
    dispatch({ type: "toggle", id: 3 });
    assert.equal(view().open, 3);
    await actions.clear();
    assert.deepEqual(calls, ["entries", "clear", "entries"]);
    assert.equal(view().open, null, "a new read with the id stays closed");
  });

  it("the_tab_keeps_one_reducer_and_one_correction_box", () => {
    const source = readFileSync(
      new URL("./ReadHistoryTab.tsx", import.meta.url),
      "utf8",
    );
    assert.ok(source.includes("useReducer(readView, NO_READ_VIEW)"));
    assert.equal(source.match(/<CorrectionBox\b/g)?.length, 1);
  });
});
