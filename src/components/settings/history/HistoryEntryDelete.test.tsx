import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import type { HistoryEntry } from "@/bindings";
import type { ActiveJobStatus } from "@/stores/transcriptionJobsStore";
import type { HistoryActionsProps } from "./HistoryActions";
import type { InlineConfirmProps } from "@/components/shared/InlineConfirm";
import type { HistoryRowProps } from "@/components/shared/HistoryList";
import { nextOpen } from "@/lib/utils/historyPresentation";
import { formatDateTime } from "@/utils/dateFormat";
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

const confirms: InlineConfirmProps[] = [];
// useRowConfirm is replaced by a recorder: the entry's wiring is what is under test.
type Deps = { apply: (id: number) => void; present?: (id: number) => boolean };
const confirmCalls: string[] = [];
let confirmDeps: Deps | undefined;
let asking: number | null = null;
const real = await import("@/components/shared/InlineConfirm");
mock.module("@/components/shared/InlineConfirm", () => ({
  ...real,
  InlineConfirm: (props: InlineConfirmProps) => {
    confirms.push(props);
    return null;
  },
  useRowConfirm: (deps: Deps) => {
    confirmDeps = deps;
    return {
      asking,
      ask: (id: number) => confirmCalls.push(`ask:${id}`),
      cancel: () => confirmCalls.push("cancel"),
      confirm: () => confirmCalls.push("confirm"),
      rowsRef: { current: null },
    };
  },
}));
let players = 0;
mock.module("../../ui/AudioPlayer", () => ({
  AudioPlayer: () => {
    players += 1;
    return <span data-audio-player />;
  },
  AudioPlayerGroup: ({ children }: { children: React.ReactNode }) => children,
}));
const actionProps: HistoryActionsProps[] = [];
const { HistoryActions: RealHistoryActions } = await import("./HistoryActions");
mock.module("./HistoryActions", () => ({
  HistoryActions: (props: HistoryActionsProps) => {
    actionProps.push(props);
    return RealHistoryActions(props);
  },
}));
const { Button: RealButton } = await import("../../ui/Button");
type ButtonProps = Parameters<typeof RealButton>[0];
const buttons: ButtonProps[] = [];
mock.module("../../ui/Button", () => ({
  Button: (props: ButtonProps) => {
    buttons.push(props);
    return RealButton(props);
  },
}));
// HistorySettings imports the app i18n setup; this test's instance stands in for it.
mock.module("@/i18n", () => ({ default: i18next }));
await i18next.use(initReactI18next).init({
  lng: "en",
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
});
const { HistoryRow } = await import("@/components/shared/HistoryList");
const { EntryBody, HistoryEntryComponent } = await import("./HistorySettings");

const TIMESTAMP = 1763324820;
const makeEntry = (over: Partial<HistoryEntry> = {}): HistoryEntry =>
  ({
    id: 7,
    file_name: "a.wav",
    timestamp: TIMESTAMP,
    saved: false,
    title: "",
    transcription_text: "hello there",
    post_processed_text: null,
    post_process_prompt: null,
    post_process_requested: false,
    post_process_provider: null,
    post_process_model: null,
    source_name: null,
    ...over,
  }) as HistoryEntry;
const cleanedEntry = makeEntry({
  transcription_text: "hello there",
  post_processed_text: "Hello there.",
  post_process_provider: "local_llm",
  post_process_model: "s1-mini-q4km",
});
const running = { state: "running", percent: 0 } as ActiveJobStatus;

const deleted: number[] = [];
function renderEntry({
  entry = makeEntry(),
  open,
  job,
  modelName = null,
}: {
  entry?: HistoryEntry;
  open: boolean;
  job?: ActiveJobStatus;
  modelName?: string | null;
}): string {
  confirmCalls.length = 0;
  confirms.length = 0;
  actionProps.length = 0;
  buttons.length = 0;
  confirmDeps = undefined;
  players = 0;
  return renderToStaticMarkup(
    <HistoryEntryComponent
      entry={entry}
      job={job}
      view="diff"
      modelName={modelName}
      open={open}
      toggle={() => undefined}
      onToggleSaved={() => undefined}
      onCopyText={async () => true}
      onCopyRaw={async () => true}
      getAudioUrl={async () => null}
      deleteAudio={async (id) => {
        deleted.push(id);
      }}
      retryTranscription={async () => undefined}
      cancelTranscription={async () => undefined}
      captureAnchor={() => undefined}
      restoreAnchor={() => undefined}
    />,
  );
}
const labelOf = (props: ButtonProps): string =>
  React.Children.toArray(props.children)
    .filter((child) => typeof child === "string")
    .join("");
const button = (label: string) =>
  buttons.find((props) => labelOf(props) === label);
const buttonLabels = () => buttons.map(labelOf);

// Renders HistoryRow inside a probe component to read its element tree.
function rowTree(props: HistoryRowProps): React.ReactElement {
  let tree: React.ReactElement | null = null;
  const Probe = () => {
    tree = HistoryRow(props);
    return null;
  };
  renderToStaticMarkup(<Probe />);
  assert.ok(tree, "HistoryRow renders an element");
  return tree;
}

describe("HistoryEntryComponent", () => {
  it("collapsed_row_is_one_line_with_copy_star_and_chevron", () => {
    const html = renderEntry({ open: false });
    const long = formatDateTime(String(TIMESTAMP), "en");
    assert.ok(html.includes(`title="${long}"`), `long date title in ${html}`);
    assert.match(html, /class="[^"]*\bwhitespace-nowrap\b[^"]*"/u);
    assert.ok(html.includes("hello there"));
    assert.match(
      html,
      /<span class="[^"]*\btruncate\b[^"]*" title="No cleanup">No cleanup<\/span>/u,
    );
    assert.equal((html.match(/<button\b/gu) ?? []).length, 3);
    assert.match(html, /<button[^>]*aria-expanded="false"/u);
    assert.match(html, /<button[^>]*aria-label="Show entry"/u);
    assert.ok(!html.includes('aria-expanded="true"'));
    assert.equal(actionProps.length, 1);
    assert.equal(buttons.length, 0, "no labelled buttons while closed");

    const cleanedHtml = renderEntry({
      entry: cleanedEntry,
      open: false,
      modelName: "S1-mini by Superwhisper",
    });
    assert.match(
      cleanedHtml,
      /title="S1-mini by Superwhisper">S1-mini by Superwhisper<\/span>/u,
    );
    assert.ok(cleanedHtml.includes("Hello there."));
    const file = renderEntry({
      entry: { ...cleanedEntry, source_name: "meeting.m4a" },
      open: false,
      modelName: "S1-mini by Superwhisper",
    });
    assert.match(file, /title="meeting.m4a">meeting.m4a<\/span>/u);
    const legacy = renderEntry({
      entry: { ...cleanedEntry, post_process_model: null },
      open: false,
    });
    assert.match(legacy, /title="Cleaned text">Cleaned text<\/span>/u);

    const tree = rowTree({
      id: 7,
      open: false,
      onToggle: () => undefined,
      when: { short: "16 Nov 20:27", long: "16 November 2025 at 20:27" },
      excerpt: "hello there",
      tag: "No cleanup",
      actions: <span />,
    });
    const [header] = React.Children.toArray(
      (tree.props as { children: React.ReactNode }).children,
    ) as React.ReactElement<{ className: string; children: React.ReactNode }>[];
    const cells = React.Children.toArray(header.props.children);
    assert.equal(cells.length, 4, "date, excerpt, tag, actions and chevron");
    assert.match(
      header.props.className,
      /\bgrid-cols-\[auto_minmax\(0,1fr\)_auto_auto\]/u,
    );
    const cell = cells[3] as React.ReactElement<{ className: string }>;
    for (const name of ["flex", "shrink-0", "items-center"]) {
      assert.ok(cell.props.className.split(/\s+/u).includes(name), name);
    }
  });

  it("player_renders_only_in_the_open_row", () => {
    const closed = renderEntry({ open: false });
    assert.equal(players, 0, "a closed row mounts no player");
    assert.ok(!closed.includes("data-audio-player"));
    const open = renderEntry({ open: true });
    assert.equal(players, 1, "the open row mounts one player");
    assert.equal((open.match(/data-audio-player/gu) ?? []).length, 1);
    assert.match(open, /<button[^>]*aria-expanded="true"/u);
    assert.match(open, /<button[^>]*aria-label="Hide entry"/u);
  });

  it("open_row_has_labelled_actions", () => {
    renderEntry({ entry: cleanedEntry, open: true, modelName: "S1-mini" });
    assert.deepEqual(buttonLabels(), [
      "Copy original",
      "Re-transcribe",
      "Delete",
    ]);
    for (const props of buttons) {
      assert.equal(props.size, "sm");
      assert.equal(props.variant, "secondary");
      assert.ok(!props.disabled, `${labelOf(props)} enabled`);
    }
    renderEntry({ open: true });
    assert.deepEqual(buttonLabels(), ["Re-transcribe", "Delete"]);
    renderEntry({
      entry: { ...cleanedEntry, transcription_text: " " },
      open: true,
    });
    assert.ok(button("Copy original")?.disabled, "no original to copy");

    renderEntry({ entry: cleanedEntry, open: true, job: running });
    assert.deepEqual(buttonLabels(), [
      "Copy original",
      "Cancel transcription",
      "Delete",
    ]);
    assert.ok(
      button("Copy original")?.disabled,
      "Copy original while retrying",
    );
    assert.ok(!button("Cancel transcription")?.disabled);
    assert.ok(button("Delete")?.disabled, "Delete while retrying");

    const body = (cancelling: boolean) => {
      buttons.length = 0;
      renderToStaticMarkup(
        <EntryBody
          entry={cleanedEntry}
          view="diff"
          modelName={null}
          text="Transcribing..."
          retrying
          cancelling={cancelling}
          loadAudio={async () => null}
          onCopyRaw={() => undefined}
          onRetranscribe={() => undefined}
          onCancel={() => undefined}
          onDelete={async () => undefined}
        />,
      );
      return button("Cancel transcription");
    };
    assert.ok(!body(false)?.disabled);
    assert.ok(body(true)?.disabled, "Cancel stays off while cancelling");
  });

  it("delete_question_lives_in_the_open_body", async () => {
    renderEntry({ open: false });
    assert.equal(confirmDeps, undefined, "a closed row holds no question");
    const html = renderEntry({ open: true });
    const deps = confirmDeps as Deps | undefined;
    assert.ok(deps, "the open body asks useRowConfirm for its question");
    assert.equal(
      deps.present,
      undefined,
      "an entry's question is never pruned",
    );
    assert.equal(confirms.length, 0, "no question before Delete");
    // Cancel returns focus to the first enabled button inside the confirm row: Delete only.
    const confirmRows = html.match(/\bdata-confirm-row="7"/gu) ?? [];
    assert.equal(confirmRows.length, 1, "one confirm row");
    assert.match(
      html,
      /<span data-confirm-row="7" class="contents"><button\b[^>]*>(?:(?!<\/?button\b).)*Delete<\/button><\/span>/u,
      "the confirm row wraps the Delete button only",
    );
    button("Delete")?.onClick?.({} as React.MouseEvent<HTMLButtonElement>);
    assert.deepEqual(confirmCalls, ["ask:7"], "Delete only asks");
    deleted.length = 0;
    deps.apply(7);
    await Promise.resolve();
    assert.deepEqual(deleted, [7], "the apply removes the entry");

    asking = 7;
    try {
      renderEntry({ open: true });
      assert.equal(confirms.length, 1, "the asked entry shows its question");
      assert.deepEqual(buttonLabels(), [], "the question replaces the buttons");
      assert.equal(confirms[0].message, "Delete this entry and its recording?");
      assert.equal(confirms[0].action, "Delete entry");
      confirms[0].onConfirm();
      confirms[0].onCancel();
      assert.deepEqual(confirmCalls, ["confirm", "cancel"]);
      renderEntry({ open: false });
      assert.equal(confirms.length, 0, "closing the entry drops the question");
      assert.equal(confirmDeps, undefined);
    } finally {
      asking = null;
    }
  });

  it("transcript_is_upright", () => {
    for (const html of [
      renderEntry({ open: true }),
      renderEntry({ entry: cleanedEntry, open: true }),
      renderEntry({ open: true, job: running }),
      renderEntry({
        entry: makeEntry({ transcription_text: "", source_name: "a.m4a" }),
        open: true,
      }),
    ]) {
      assert.ok(!html.includes("italic"), html);
    }
    const raw = renderEntry({ open: true });
    assert.match(
      raw,
      /<p class="[^"]*\bwhitespace-pre-wrap\b[^"]*\bselect-text\b[^"]*">hello there<\/p>/u,
    );
  });

  it("open_entry_survives_arrivals_and_drops_when_gone", () => {
    let open: number | null = 7;
    const commit = (loading: boolean, ids: number[]) => {
      open = nextOpen(open, { loading, ids });
      return open;
    };
    assert.equal(commit(false, [9, 8, 7]), 7, "arrivals above keep it open");
    assert.equal(commit(true, []), 7, "loading never closes it");
    assert.equal(commit(false, [9, 8]), null, "a gone entry closes");
    assert.equal(commit(false, [7]), null, "a later list never opens one");
    assert.equal(commit(true, [7]), null, "loading never opens one");
    const source = readFileSync(
      new URL("./HistorySettings.tsx", import.meta.url),
      "utf8",
    );
    assert.match(
      source,
      /setOpen\(\(current\) =>\s*nextOpen\(current, \{\s*loading,\s*ids: entries\.map\(\(entry\) => entry\.id\),?\s*\}\),?\s*\)/u,
      "the host prunes the open entry with nextOpen",
    );
    assert.match(source, /open=\{open === entry\.id\}/u);
  });
});
