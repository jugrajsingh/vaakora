import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import {
  catalog,
  languageIdentity,
  type CatalogModel,
} from "@handy-computer/models";
import type {
  Device,
  DeviceRating,
  LocalLlmModelInfo,
  LocalLlmStatus,
  ModelInfo,
  RunOn,
  TtsModelInfo,
} from "@/bindings";
import type { Place } from "@/components/settings/models/modelEntries";
import {
  deleteChecks,
  deleteMessage,
  dictationRow,
  joinSentences,
  markPress,
  type DeleteAsk,
} from "@/components/settings/models/managerRows";
import {
  CleanupRows,
  cleanupAskedFor,
  cleanupApply,
  cleanupMark,
  cleanupPresent,
  cleanupRuntime,
  type CleanupDeleteView,
  type CleanupRowsProps,
} from "@/components/settings/post-processing/CleanupRows";
import { createLocalLlmRowActions } from "@/components/settings/post-processing/localLlmRowActions";
import { HistoryRow } from "@/components/shared/HistoryList";
import { createPendingConfirm } from "@/components/shared/InlineConfirm";
import { revealingToggle } from "@/components/shared/useRevealOnOpen";
import { languageName } from "@/lib/constants/languages";
import { formatBytes, formatModelSize } from "@/lib/utils/format";
import english from "@/i18n/locales/en/translation.json";
import japanese from "@/i18n/locales/ja/translation.json";
import german from "@/i18n/locales/de/translation.json";
import {
  getTranslatedModelDescription,
  translationKeyId,
} from "@/lib/utils/modelTranslation";
import { toTableModel } from "./tableModel";
import { Codes } from "./columns";
import type { TableModel } from "./context";
import { makeGrading } from "@/lib/models/grading";
import { GradeChip } from "@/components/shared/GradeChip";
import {
  DictationCells,
  ManagerRow,
  ManagerRowView,
  RoleCells,
  RoleHeads,
  type ManagerRowProps,
} from "./ManagerRow";
import {
  ManagerTable,
  ManagerTableView,
  RoleLegendBody,
  type ManagerTableProps,
} from "./ManagerTable";
import {
  applyChips,
  cleanupModel,
  createOpenSync,
  dictationModel,
  matchesQuery,
  nextOpen,
  readAloudModel,
  speedLevelFromScore,
  ttsSpeedDevice,
  type Chip,
  type ManagerModel,
  type ModelState,
} from "./roles";

const {
  describe,
  it,
}: {
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => Promise<void> | void) => void;
} = createRequire(import.meta.url)("bun:test");

const i18n = i18next.createInstance();
await i18n.init({
  lng: "en",
  resources: { en: { translation: english } },
  interpolation: { escapeValue: false },
});
const t = i18n.t.bind(i18n);

describe("formatBytes", () => {
  it("bytes_are_decimal", () => {
    assert.equal(formatBytes(273_000_000), "273 MB");
    assert.equal(formatBytes(1_274_396_096), "1.3 GB");
    assert.equal(formatBytes(12_000_000_000), "12 GB");
    assert.equal(formatBytes(8_500_000), "8.5 MB");
    assert.equal(formatBytes(0), null);
    assert.equal(formatBytes(Number.NaN), null);
    assert.equal(formatModelSize(697), "731 MB");
    assert.equal(formatModelSize(0), "Unknown size");
  });
});

describe("speedLevelFromScore", () => {
  it("speed_bands_from_score", () => {
    assert.equal(speedLevelFromScore(10), 4);
    assert.equal(speedLevelFromScore(7.5), 4);
    assert.equal(speedLevelFromScore(7.4), 3);
    assert.equal(speedLevelFromScore(5), 3);
    assert.equal(speedLevelFromScore(2.5), 2);
    assert.equal(speedLevelFromScore(0.88), 1);
    assert.equal(speedLevelFromScore(0), 0);
    assert.equal(speedLevelFromScore(null), 0);
  });
});

const rate = (
  speed_score: number | null,
  recommended = false,
  supported = true,
): DeviceRating => ({
  supported,
  placement: supported ? { main: "cpu" } : {},
  first_audio_p95_s: supported ? 1 : null,
  rtf_1x: supported ? 0.3 : null,
  rtf_2x: supported ? 0.5 : null,
  load_s_cold: supported ? 1 : null,
  load_s_cached: supported ? 0.5 : null,
  speed_score,
  recommended,
});

const supertonic: Pick<
  TtsModelInfo,
  "run_on" | "rating" | "npu_driver_too_old"
> = {
  run_on: "auto",
  npu_driver_too_old: false,
  rating: {
    quality: 8,
    devices: {
      cpu: rate(4.885),
      npu: rate(6.585),
      gpu: rate(10, true),
    },
  },
};
const speedDevice = (
  run_on: RunOn,
  available: readonly Device[],
  npu_driver_too_old = false,
) => ttsSpeedDevice({ ...supertonic, run_on, npu_driver_too_old }, available);

describe("ttsSpeedDevice", () => {
  it("tts_speed_device_prefers_run_on_then_recommended", () => {
    assert.equal(speedDevice("auto", ["cpu", "gpu"]), "gpu");
    assert.equal(speedDevice("cpu", ["cpu", "gpu"]), "cpu");
    assert.equal(speedDevice("auto", ["cpu"]), "cpu");
    assert.equal(speedDevice("gpu", ["cpu"]), "cpu");
  });

  it("auto_picks_the_fastest_device_with_an_npu_and_no_gpu", () => {
    assert.equal(speedDevice("auto", ["cpu", "npu"]), "npu");
    assert.equal(speedDevice("auto", ["cpu", "npu"], true), "cpu");
  });

  it("auto_skips_unsupported_devices_and_falls_back_to_cpu", () => {
    const only = {
      run_on: "auto" as const,
      npu_driver_too_old: false,
      rating: {
        quality: 5,
        devices: {
          cpu: rate(0.9, true),
          npu: rate(null, false, false),
          gpu: rate(null, false, false),
        },
      },
    };
    assert.equal(ttsSpeedDevice(only, ["cpu", "gpu", "npu"]), "cpu");
    assert.equal(ttsSpeedDevice(only, []), "cpu");
  });
});

const pocket: TtsModelInfo = {
  id: "pocket-en",
  display_name: "Pocket TTS",
  license: "CC-BY-4.0",
  attribution: "tts.pocketAttribution",
  card_url: "https://huggingface.co/kyutai/pocket-tts",
  size_bytes: 295_738_958,
  voices: ["alba", "marius"],
  default_voice: "alba",
  downloaded: true,
  downloading: false,
  active: true,
  rating: {
    quality: 9,
    devices: {
      cpu: rate(3.4739535298609416, true),
      npu: rate(null, false, false),
      gpu: rate(2.8766273753467875),
    },
  },
  run_on: "auto",
  preparation: { state: "ready", device: "cpu" },
  npu_driver_too_old: false,
  recommended: true,
  needs_token: false,
  languages: ["en"],
  measured: { machine: "Intel Core Ultra 7 258V", date: "2026-11-08" },
  memory_bytes: { cpu: 453_000_000, gpu: 700_000_000 },
  sources: [{ repository: "kyutai/pocket-tts", revision: "abc123" }],
};
const readCtx = {
  available: ["cpu", "gpu"] as Device[],
  downloading: null,
  percent: null,
  error: null,
  t,
};

describe("readAloudModel", () => {
  it("read_aloud_model_fills_the_detail", () => {
    const m = readAloudModel(pocket, readCtx);
    assert.equal(m.role, "readAloud");
    assert.deepEqual(m.state, { kind: "selected", runtime: "ready" });
    assert.equal(m.quality.text, "9");
    assert.equal(m.speed.level, 2);
    assert.equal(m.memoryBytes, 453_000_000);
    assert.equal(m.measuredOn, "Intel Core Ultra 7 258V, 2026-11-08");
    assert.deepEqual(m.licence, {
      name: "CC-BY-4.0",
      terms: english.tts.pocketAttribution,
      url: "https://huggingface.co/kyutai/pocket-tts",
    });
    assert.equal(m.runOn?.kind, "control");
    assert.ok(m.tags.includes("recommended"));
    assert.deepEqual(m.languages, ["en"]);
    assert.deepEqual(m.voices, ["alba", "marius"]);
    assert.deepEqual(m.sources, [
      { repository: "kyutai/pocket-tts", revision: "abc123" },
    ]);
    assert.equal(m.sizeBytes, 295_738_958);
  });

  it("read_aloud_states_and_token_tag", () => {
    const gated = {
      ...pocket,
      downloaded: false,
      active: false,
      needs_token: true,
    };
    const remote = readAloudModel(gated, readCtx);
    assert.deepEqual(remote.state, { kind: "remote" });
    assert.ok(remote.tags.includes("needsToken"));
    assert.equal(remote.needsToken, true);
    assert.deepEqual(
      readAloudModel(gated, {
        ...readCtx,
        downloading: "pocket-en",
        percent: 40,
      }).state,
      { kind: "downloading", percent: 40, cancellable: true },
    );
    assert.deepEqual(
      readAloudModel(gated, { ...readCtx, error: "tts.errors.generic" }).state,
      { kind: "failed", error: "tts.errors.generic" },
    );
    assert.deepEqual(
      readAloudModel({ ...pocket, active: false }, readCtx).state,
      { kind: "downloaded" },
    );
    const open = readAloudModel({ ...gated, needs_token: false }, readCtx);
    assert.ok(!open.tags.includes("needsToken"));
    const unmeasured = readAloudModel(
      { ...pocket, measured: null, memory_bytes: {} },
      readCtx,
    );
    assert.equal(unmeasured.measuredOn, "Not measured");
    assert.equal(unmeasured.memoryBytes, null);
  });
});

const s1: LocalLlmModelInfo = {
  id: "s1-mini-q4km",
  display_name: "S1-mini",
  downloaded: true,
  attribution: "Superwhisper",
  card_url: "https://superwhisper.com",
  license: "Apache-2.0",
  license_url: "https://example.com/license",
  license_note: "settings.postProcessing.localLlm.licenseNotes.s1Name",
  size_bytes: 484_219_808,
  prompt_style: "s1_control_line",
  source: { repository: "superwhisper/s1-mini", revision: "def456" },
};
const cleanCtx = {
  selectedId: null,
  downloadId: null,
  percent: null,
  error: null,
  runtime: null,
  t,
};

describe("cleanupModel", () => {
  it("cleanup_model_marks_unmeasured", () => {
    const m = cleanupModel(s1, cleanCtx);
    assert.equal(m.quality.text, null);
    assert.equal(m.speed.text, null);
    assert.equal(m.speed.level, 0);
    assert.equal(m.measuredOn, "Not measured");
    assert.equal(m.memoryBytes, null);
    assert.deepEqual(m.runOn, { kind: "text", text: "CPU" });
    assert.equal(m.languages, null);
    assert.deepEqual(m.sources, [
      { repository: "superwhisper/s1-mini", revision: "def456" },
    ]);
    assert.deepEqual(m.licence, {
      name: "Apache-2.0",
      terms: english.settings.postProcessing.localLlm.licenseNotes.s1Name,
      url: "https://superwhisper.com",
    });
    assert.equal(
      cleanupModel({ ...s1, license_note: null }, cleanCtx).licence.terms,
      null,
      "no note, no terms",
    );
    assert.deepEqual(m.state, { kind: "downloaded" });
    assert.deepEqual(
      cleanupModel(s1, { ...cleanCtx, selectedId: s1.id, runtime: "loading" })
        .state,
      { kind: "selected", runtime: "loading" },
    );
    const downloading = cleanupModel(
      { ...s1, downloaded: false, source: null },
      { ...cleanCtx, downloadId: s1.id, percent: 12 },
    );
    assert.deepEqual(downloading.state, {
      kind: "downloading",
      percent: 12,
      cancellable: false,
    });
    assert.deepEqual(downloading.sources, []);
    assert.deepEqual(
      cleanupModel({ ...s1, downloaded: false }, { ...cleanCtx, error: "boom" })
        .state,
      { kind: "failed", error: "boom" },
    );
  });
});

const parakeet = catalog.getModel("parakeet-unified-en-0.6b");
if (!parakeet) throw new Error("catalog lacks parakeet-unified-en-0.6b");
const catalogEntry: TableModel = {
  id: "parakeet-unified-en-0.6b",
  name: "Parakeet Unified English 0.6B",
  description: "Best all-around choice for English dictation",
  languages: ["en"],
  streaming: true,
  translate: false,
  sizeMb: 697,
  quant: "Q8_0",
  kind: "curated",
  model: parakeet,
};
const customEntry: TableModel = {
  id: "my-model",
  name: "My model",
  description: "",
  languages: [],
  streaming: false,
  translate: true,
  sizeMb: 0,
  quant: null,
  kind: "custom",
};
const info = (supports_vocabulary: boolean | null): ModelInfo => ({
  id: "parakeet-unified-en-0.6b",
  name: "Parakeet Unified English 0.6B",
  description: "",
  filename: "parakeet.gguf",
  source: {
    HuggingFace: { repo_id: parakeet.repository, revision: parakeet.revision },
  },
  size_mb: 697,
  is_downloaded: true,
  is_downloading: false,
  partial_size: 0,
  accuracy_score: 0.8,
  speed_score: 0.8,
  supports_translation: false,
  is_recommended: true,
  supported_languages: ["en"],
  supports_language_selection: false,
  is_custom: false,
  supports_streaming: true,
  supports_language_detection: false,
  supports_vocabulary,
});
const dictCtx = {
  place: "ready" as Place,
  percent: 0,
  tier: "accelerated" as const,
  runOnText: "GPU, set in Settings, Advanced",
  t,
};

describe("dictationModel", () => {
  it("dictation_model_missing_values", () => {
    const custom = dictationModel(customEntry, undefined, dictCtx);
    assert.equal(custom.licence.name, null);
    assert.deepEqual(custom.sources, []);
    assert.equal(custom.measuredOn, "Not measured");
    assert.equal(custom.languages, null);
    assert.ok(custom.tags.includes("custom"));
    assert.ok(custom.tags.includes("translates"));
    assert.equal(custom.sizeBytes, null);
    assert.equal(custom.speed.figure, null);
    assert.equal(custom.speed.provenance, null);

    const listed = dictationModel(catalogEntry, info(null), dictCtx);
    assert.equal(listed.licence.name, "cc-by-4.0");
    assert.deepEqual(listed.sources, [
      { repository: parakeet.repository, revision: parakeet.revision },
    ]);
    assert.equal(
      listed.measuredOn,
      "Maker's figure (ryzen-4750u, vulkan), not this machine",
    );
    assert.equal(
      dictationModel(catalogEntry, info(null), { ...dictCtx, tier: "cpu" })
        .measuredOn,
      "Maker's figure (ryzen-4750u, cpu), not this machine",
    );
    assert.ok(listed.tags.includes("recommended"));
    assert.ok(listed.tags.includes("live"));
    assert.deepEqual(listed.runOn, {
      kind: "text",
      text: "GPU, set in Settings, Advanced",
    });
    assert.equal(listed.sizeBytes, 697 * 1024 * 1024);
    assert.equal(listed.speed.figure, "1.2 s for 30 seconds of speech");
    assert.equal(listed.speed.provenance, listed.measuredOn);
    assert.equal(
      dictationModel(catalogEntry, info(null), { ...dictCtx, tier: "cpu" })
        .speed.figure,
      "2.1 s for 30 seconds of speech",
    );
    assert.equal(listed.quality.figure, null);

    const native = dictationModel(catalogEntry, info(true), dictCtx);
    assert.ok(native.tags.includes("nativeWords"));
    assert.equal(native.customWords, true);
    const corrected = dictationModel(catalogEntry, info(false), dictCtx);
    assert.ok(!corrected.tags.includes("nativeWords"));
    assert.equal(corrected.customWords, false);
    const unknown = dictationModel(catalogEntry, info(null), dictCtx);
    assert.ok(!unknown.tags.includes("nativeWords"));
    assert.equal(unknown.customWords, null);
    assert.equal(
      dictationModel(catalogEntry, undefined, dictCtx).customWords,
      null,
    );
  });

  it("dictation_places_map_to_states", () => {
    const at = (place: Place, percent = 0) =>
      dictationModel(catalogEntry, info(null), { ...dictCtx, place, percent })
        .state;
    assert.deepEqual(at("remote"), { kind: "remote" });
    assert.deepEqual(at("ready"), { kind: "downloaded" });
    assert.deepEqual(at("active"), { kind: "selected", runtime: null });
    assert.deepEqual(at("loading"), { kind: "selected", runtime: "loading" });
    assert.deepEqual(at("downloading", 55), {
      kind: "downloading",
      percent: 55,
      cancellable: true,
    });
    assert.deepEqual(at("checking"), {
      kind: "downloading",
      percent: 100,
      cancellable: true,
    });
  });
});

describe("matchesQuery", () => {
  const names = { t, language: "en", languageName };
  const parakeetModel = dictationModel(catalogEntry, info(null), dictCtx);

  it("query_matches_every_word", () => {
    const hit = (q: string) => matchesQuery(parakeetModel, q, names);
    assert.equal(hit(""), true);
    assert.equal(hit("parakeet english"), true);
    assert.equal(hit("parakeet hindi"), false);
    assert.equal(hit("PARAKEET"), true);
    assert.equal(hit("all-around dictation"), true);
    assert.equal(hit("live"), true);
    assert.equal(hit("recommended"), true);
    assert.equal(hit("translates"), false);
  });

  it("german_ui_finds_the_english_language_name", () => {
    const de = { t, language: "de", languageName };
    const plain = { ...parakeetModel, name: "Parakeet", description: "Fast" };
    assert.ok(!languageName("en", "de").toLowerCase().includes("english"));
    assert.equal(matchesQuery(plain, "english", de), true);
    assert.equal(matchesQuery(plain, "englisch", de), true);
    assert.equal(matchesQuery(plain, "hindi", de), false);
  });
});

const html = (node: React.ReactNode) =>
  renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);

type Tree = React.ReactElement<{
  children?: React.ReactNode;
  [prop: string]: unknown;
}>;

/** Elements in a view's own output, without rendering nested components. */
function elements(
  node: React.ReactNode,
  keep: (element: Tree) => boolean,
  found: Tree[] = [],
): Tree[] {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, keep, found);
  } else if (React.isValidElement(node)) {
    const element = node as Tree;
    if (keep(element)) found.push(element);
    elements(element.props.children, keep, found);
  }
  return found;
}
const press = (element: Tree | undefined) => {
  assert.ok(element, "element to press");
  (element.props.onClick as () => void)();
};

const decode = (text: string) =>
  text
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
/** The detail row's label and value pairs, with each value's attributes. */
const detailPairs = (markup: string) =>
  [...markup.matchAll(/<dt[^>]*>(.*?)<\/dt><dd([^>]*)>(.*?)<\/dd>/g)].map(
    ([, label, attributes, value]) => ({
      label: decode(label),
      value: decode(value),
      attributes,
    }),
  );
const detailLabels = (markup: string) =>
  detailPairs(markup).map(({ label }) => label);
const detailValue = (markup: string, label: string) =>
  detailPairs(markup).find((pair) => pair.label === label)?.value;

const viewOf = (props: ManagerRowProps) =>
  ManagerRowView({
    ...props,
    t,
    language: "en",
    detailId: "detail-test",
    openLink: () => {},
  });

const downloadedPocket = readAloudModel({ ...pocket, active: false }, readCtx);
const rowProps = (over: Partial<ManagerRowProps> = {}): ManagerRowProps => ({
  model: downloadedPocket,
  open: false,
  toggle: () => {},
  cells: null,
  mark: null,
  ...over,
});

describe("nextOpen", () => {
  it("open_row_survives_reloads_and_drops_when_gone", () => {
    assert.equal(nextOpen("b", ["a", "b"]), "b");
    let open = nextOpen("b", ["b", "a", "c"]);
    assert.equal(open, "b");
    open = nextOpen(open, ["a"]);
    assert.equal(open, null);
    open = nextOpen(open, ["b"]);
    assert.equal(open, null);
    assert.equal(nextOpen(null, ["a", "b"]), null);
  });
});

describe("createOpenSync", () => {
  it("open_sync_reports_a_hidden_row_once", () => {
    const sync = createOpenSync();
    assert.equal(sync("x", ["x", "y"]), undefined);
    assert.equal(sync("x", ["y"]), null);
    assert.equal(sync("x", ["y"]), undefined, "the stale re-render");
    assert.equal(sync(null, ["y"]), undefined);
    assert.equal(sync("x", ["x"]), undefined);
    assert.equal(sync("x", []), null);
    assert.equal(sync(null, []), undefined);
  });

  it("open_sync_listed_row_clears_the_memory", () => {
    const sync = createOpenSync();
    assert.equal(sync("x", []), null);
    assert.equal(sync("x", []), undefined);
    assert.equal(sync("x", ["x"]), undefined, "listed again, still open");
    assert.equal(sync("x", []), null, "hidden again reports again");
    assert.equal(sync("y", []), null, "another hidden row reports");
  });

  it("manager_table_syncs_once", () => {
    const table = readFileSync(
      new URL("./ManagerTable.tsx", import.meta.url),
      "utf8",
    );
    assert.ok(table.includes("createOpenSync"));
    assert.ok(!table.includes("open !== openId"));
  });
});

describe("reveal on open", () => {
  it("reveal_toggle_calls_through_and_marks_only_an_open", () => {
    const calls: string[] = [];
    const reveal = { current: false };
    revealingToggle(false, reveal, () => calls.push("toggle"))();
    assert.deepEqual(calls, ["toggle"]);
    assert.equal(reveal.current, true, "opening reveals");
    revealingToggle(true, reveal, () => calls.push("toggle"))();
    assert.deepEqual(calls, ["toggle", "toggle"]);
    assert.equal(reveal.current, false, "closing never reveals");
  });

  it("model_rows_reveal_when_opened", () => {
    const row = readFileSync(
      new URL("./ManagerRow.tsx", import.meta.url),
      "utf8",
    );
    assert.match(
      row,
      /useRevealOnOpen<HTMLDivElement>\(\s*props\.open,\s*props\.toggle,\s*"\[data-model-toolbar\]",?\s*\)/,
    );
    assert.match(row, /rowRef=\{reveal\.ref\}/);
    assert.match(row, /toggle=\{reveal\.toggle\}/);
    assert.match(row, /<div\s+ref=\{rowRef\}\s+data-row=\{model\.id\}/);
    const history = readFileSync(
      new URL("../HistoryList.tsx", import.meta.url),
      "utf8",
    );
    assert.match(
      history,
      /useRevealOnOpen<HTMLDivElement>\(\s*open,\s*onToggle,\s*"\[data-history-toolbar\]",?\s*\)/,
    );
    assert.ok(!history.includes("revealScrollTop("));
  });

  it("history_chevron_shows_a_focus_ring", () => {
    const markup = html(
      <HistoryRow
        id={1}
        open={false}
        onToggle={() => {}}
        when={{ short: "1 Jan", long: "1 January" }}
        excerpt="Hello"
        tag={null}
      />,
    );
    const chevron = markup.match(/<button[^>]*aria-expanded[^>]*>/)?.[0] ?? "";
    assert.match(
      chevron,
      /focus-visible:ring-2 focus-visible:ring-logo-primary/,
    );
  });
});

const model = (id: string, tags: ManagerModel["tags"]): ManagerModel => ({
  ...downloadedPocket,
  id,
  name: id,
  description: "",
  tags,
});
const tagChips: Chip[] = [
  { key: "live", label: "Live", test: (m) => m.tags.includes("live") },
  {
    key: "translates",
    label: "Translates",
    test: (m) => m.tags.includes("translates"),
  },
];

describe("applyChips", () => {
  it("chips_and_query_filter_together", () => {
    const models = [
      model("alpha", ["live"]),
      model("bravo", ["live", "translates"]),
      model("charlie", ["translates"]),
      model("delta", []),
    ];
    const ids = (on: string[], list = models) =>
      applyChips(list, new Set(on), tagChips).map((m) => m.id);
    assert.deepEqual(ids([]), ["alpha", "bravo", "charlie", "delta"]);
    assert.deepEqual(ids(["live"]), ["alpha", "bravo"]);
    assert.deepEqual(ids(["live", "translates"]), ["bravo"]);
    const names = { t, language: "en", languageName };
    const searched = models.filter((m) => matchesQuery(m, "charlie", names));
    assert.deepEqual(ids(["translates"], searched), ["charlie"]);
    assert.deepEqual(ids(["live"], searched), []);
  });
});

const tableProps = (
  over: Partial<ManagerTableProps> = {},
): ManagerTableProps => ({
  role: "readAloud",
  sections: [{ key: "downloaded", label: "On this computer", rows: [] }],
  query: "",
  setQuery: () => {},
  chips: tagChips,
  pressed: new Set<string>(),
  toggleChip: () => {},
  heads: null,
  legend: null,
  openId: null,
  onOpenChange: () => {},
  renderRow: () => null,
  ...over,
});

describe("ManagerTable", () => {
  it("empty_search_offers_clear_filters", () => {
    const markup = html(<ManagerTable {...tableProps({ query: "zzz" })} />);
    assert.ok(markup.includes("Nothing matches &quot;zzz&quot;."), markup);
    assert.match(markup, /<button[^>]*>Clear filters<\/button>/);
    const root = markup.match(/^<div[^>]*>/)?.[0] ?? "";
    assert.match(root, /class="w-full max-w-3xl min-w-0"/);
    const toolbar = markup.match(/<div data-model-toolbar[^>]*>/)?.[0] ?? "";
    assert.match(toolbar, /sticky top-0 z-10/);
    assert.match(toolbar, /flex-wrap/);
    assert.match(toolbar, /bg-background/);
    const search = markup.match(/<input[^>]*type="search"[^>]*>/)?.[0] ?? "";
    assert.match(search, /aria-label="Search models"/);
    assert.match(search, /min-w-0 flex-1/);

    const chipOnly = html(
      <ManagerTable {...tableProps({ pressed: new Set(["live"]) })} />,
    );
    assert.ok(chipOnly.includes("No model matches these filters."));
    assert.match(chipOnly, /<button[^>]*>Clear filters<\/button>/);
    const unfiltered = html(<ManagerTable {...tableProps()} />);
    assert.doesNotMatch(unfiltered, /Clear filters/);

    const calls: string[] = [];
    const tree = ManagerTableView({
      ...tableProps({
        query: "zzz",
        pressed: new Set(["live", "translates"]),
        setQuery: (query) => calls.push(`query:${query}`),
        toggleChip: (key) => calls.push(`chip:${key}`),
      }),
      t,
    });
    press(elements(tree, (e) => e.props.children === "Clear filters")[0]);
    assert.deepEqual(calls, ["query:", "chip:live", "chip:translates"]);
  });

  it("opening_another_row_reports_the_first_closed", () => {
    const open: Record<string, boolean> = {};
    const toggles: Record<string, () => void> = {};
    const changes: (string | null)[] = [];
    const props = tableProps({
      sections: [
        {
          key: "downloaded",
          label: "On this computer",
          rows: [model("a", []), model("b", [])],
        },
      ],
      openId: "a",
      onOpenChange: (id) => changes.push(id),
      renderRow: (m, isOpen, toggle) => {
        open[m.id] = isOpen;
        toggles[m.id] = toggle;
        return <div data-row={m.id} />;
      },
    });
    const markup = html(<ManagerTable {...props} />);
    assert.match(markup, /data-row="a"/);
    assert.deepEqual(open, { a: true, b: false });
    toggles.b();
    assert.deepEqual(changes, ["b"]);
    toggles.a();
    assert.deepEqual(changes, ["b", null]);
  });
});

describe("ManagerRow", () => {
  it("row_inspect_is_apart_from_select", () => {
    const calls: string[] = [];
    const props = rowProps({
      toggle: () => calls.push("toggle"),
      mark: { label: "Use Pocket TTS", press: () => calls.push("press") },
    });
    const closed = html(<ManagerRow {...props} />);
    assert.match(closed, /<button[^>]*aria-label="Use Pocket TTS"/);
    const name = closed.match(/<button[^>]*>Pocket TTS<\/button>/)?.[0] ?? "";
    assert.match(name, /aria-expanded="false"/);
    assert.doesNotMatch(closed, /<dl/);

    const tree = viewOf(props);
    const buttons = elements(tree, (e) => e.type === "button");
    press(buttons.find((b) => b.props.children === "Pocket TTS"));
    assert.deepEqual(calls, ["toggle"]);
    press(buttons.find((b) => b.props["aria-label"] === "Use Pocket TTS"));
    assert.deepEqual(calls, ["toggle", "press"]);

    const opened = html(
      <ManagerRow
        {...props}
        open
        runOn={<span data-run-on="">{english.tts.devices.auto}</span>}
      />,
    );
    assert.equal(opened.match(/<dl/g)?.length, 1);
    const id = opened.match(/<dl id="([^"]+)"/)?.[1] ?? "missing";
    assert.ok(opened.includes(`aria-controls="${id}"`));
    assert.match(
      opened.match(/<button[^>]*>Pocket TTS<\/button>/)?.[0] ?? "",
      /aria-expanded="true"/,
    );
    assert.deepEqual(detailLabels(opened), [
      "Languages",
      "Run on",
      "Memory",
      "Measured on",
      "Voices",
      "Licence",
      "Source",
    ]);
    assert.equal(detailValue(opened, "Languages"), "English");
    assert.equal(detailValue(opened, "Run on"), "Auto");
    assert.equal(detailValue(opened, "Memory"), "453 MB");
    assert.equal(
      detailValue(opened, "Measured on"),
      "Intel Core Ultra 7 258V, 2026-11-08 · Speed: 3.5",
    );
    assert.equal(detailValue(opened, "Voices"), "alba, marius");
    assert.equal(
      detailValue(opened, "Source"),
      "kyutai/pocket-tts · revision abc123",
    );
    assert.match(
      detailValue(opened, "Licence") ?? "",
      /^CC-BY-4\.0 · .* · Model card$/,
    );
    for (const { attributes } of detailPairs(opened)) {
      assert.match(attributes, /min-w-0/);
      assert.match(attributes, /\[overflow-wrap:anywhere\]/);
    }

    const dictation = html(
      <ManagerRow
        {...rowProps({
          model: dictationModel(catalogEntry, info(true), dictCtx),
        })}
        open
      />,
    );
    assert.deepEqual(detailLabels(dictation), [
      "Languages",
      "Run on",
      "Memory",
      "Measured on",
      "Licence",
      "Source",
      "Custom words",
    ]);
    assert.equal(detailValue(dictation, "Custom words"), "Native word list");
    assert.equal(
      detailValue(dictation, "Run on"),
      "GPU, set in Settings, Advanced",
    );
    assert.equal(
      detailValue(dictation, "Source"),
      `${parakeet.repository} · revision ${parakeet.revision.slice(0, 7)}`,
    );
    const cleanup = html(
      <ManagerRow {...rowProps({ model: cleanupModel(s1, cleanCtx) })} open />,
    );
    assert.ok(!detailLabels(cleanup).includes("Voices"));
    assert.ok(!detailLabels(cleanup).includes("Custom words"));
  });

  it("missing_values_follow_r15b", () => {
    const s1Model = cleanupModel(s1, cleanCtx);
    const cleanup = html(
      <ManagerRow
        {...rowProps({ model: s1Model, cells: <RoleCells model={s1Model} /> })}
        open
      />,
    );
    const cells = [
      ...cleanup.matchAll(
        /<span role="img" aria-label="([^"]*)"[^>]*>(.*?)<\/span>/g,
      ),
    ].map(([, label, shown]) => [label, decode(shown)]);
    assert.deepEqual(cells.slice(0, 2), [
      ["Score: not measured", "?"],
      ["Speed: not measured", "?"],
    ]);
    assert.equal(detailValue(cleanup, "Memory"), "Not measured");
    assert.equal(detailValue(cleanup, "Measured on"), "Not measured");
    assert.equal(detailValue(cleanup, "Languages"), "Not listed");

    const custom = html(
      <ManagerRow
        {...rowProps({
          model: dictationModel(customEntry, undefined, dictCtx),
        })}
        open
      />,
    );
    assert.equal(detailValue(custom, "Licence"), "Licence not listed");
    assert.equal(detailValue(custom, "Source"), "Not listed");
    assert.equal(
      detailValue(custom, "Custom words"),
      "Known once the model has loaded",
    );

    const measured = html(
      <RoleCells model={readAloudModel(pocket, readCtx)} />,
    );
    assert.match(
      measured,
      /aria-label="Score: 9, measured on Intel Core Ultra 7 258V, 2026-11-08"/,
    );
    assert.match(
      measured,
      /aria-label="Speed: 3\.5, measured on Intel Core Ultra 7 258V, 2026-11-08"/,
    );
    assert.match(measured, /aria-label="Size: 296 MB"/);
    assert.match(measured, /title="Speed: 3\.5, measured on/);
    const heads = html(<RoleHeads />);
    assert.deepEqual(
      [...heads.matchAll(/<span [^>]*class="[^"]*"[^>]*>([^<]+)<\/span>/g)].map(
        ([, head]) => head,
      ),
      ["Score", "Speed", "Size"],
    );
    assert.equal(
      heads.match(/^<span class="([^"]*)"/)?.[1],
      measured.match(/^<span class="([^"]*)"/)?.[1],
    );
  });

  it("r13_dictation_figure_reaches_detail_and_cell", () => {
    const figure = "1.2 s for 30 seconds of speech";
    const maker = "Maker's figure (ryzen-4750u, vulkan), not this machine";
    const grading = makeGrading(["en"], "accelerated", []);
    const render = (entry: TableModel, model: ManagerModel) =>
      html(
        <ManagerRow
          {...rowProps({
            model,
            cells: (
              <DictationCells model={model} entry={entry} grading={grading} />
            ),
          })}
          open
        />,
      );
    const speedNames = (markup: string) => [
      ...[...markup.matchAll(/<[^>]*aria-label="(Speed[^"]*)"[^>]*>/g)].map(
        ([, name]) => decode(name),
      ),
    ];

    const listed = render(
      catalogEntry,
      dictationModel(catalogEntry, info(null), dictCtx),
    );
    const measured = detailValue(listed, "Measured on") ?? "";
    assert.ok(measured.includes(figure), measured);
    assert.ok(measured.includes(maker), measured);
    const [name, ...others] = speedNames(listed);
    assert.deepEqual(others, []);
    assert.ok(name.includes(figure), name);
    assert.ok(name.includes(maker), name);

    const custom = render(
      customEntry,
      dictationModel(customEntry, undefined, dictCtx),
    );
    assert.equal(detailValue(custom, "Measured on"), "Not measured");
    assert.deepEqual(speedNames(custom), ["Speed: not measured"]);
  });

  it("r13_read_aloud_figure_reaches_detail", () => {
    const model = readAloudModel(pocket, readCtx);
    const opened = html(
      <ManagerRow
        {...rowProps({ model })}
        open
        runOn={<span>{english.tts.devices.auto}</span>}
      />,
    );
    const measured = detailValue(opened, "Measured on") ?? "";
    assert.ok(measured.includes("Speed: 3.5"), measured);
    assert.ok(
      measured.includes("Intel Core Ultra 7 258V, 2026-11-08"),
      measured,
    );
    assert.equal(detailLabels(opened).length, 7);
  });

  it("question_keeps_its_snapshot", () => {
    const selected = readAloudModel(pocket, readCtx);
    const calls: string[] = [];
    const question = {
      message:
        "Delete Pocket TTS? It frees 296 MB. Read aloud stops working until you choose another model.",
      confirm: () => calls.push("confirm"),
      cancel: () => calls.push("cancel"),
    };
    const props = rowProps({
      model: selected,
      cells: <RoleCells model={selected} />,
      mark: { label: "Use Pocket TTS", press: () => calls.push("press") },
      remove: { label: "Delete Pocket TTS", press: () => calls.push("ask") },
      question,
    });
    const markup = html(<ManagerRow {...props} />);
    assert.equal(markup.match(/role="group"/g)?.length, 1);
    assert.ok(markup.includes(question.message));
    const cancel = markup.indexOf(">Cancel<");
    assert.ok(cancel > 0 && cancel < markup.indexOf(">Delete model<"));
    assert.doesNotMatch(markup, /aria-label="Use Pocket TTS"/);
    assert.doesNotMatch(markup, /aria-label="Delete Pocket TTS"/);
    assert.doesNotMatch(markup, /Show details|Hide details/);
    // Its own full-width line under the row; the cells keep their track.
    assert.match(markup, /<div class="col-span-full[^"]*"><div role="group"/);
    assert.ok(markup.indexOf("Size: 296 MB") < markup.indexOf('role="group"'));

    const later = html(
      <ManagerRow
        {...props}
        model={readAloudModel({ ...pocket, active: false }, readCtx)}
      />,
    );
    assert.ok(later.includes(question.message));

    const [confirm] = elements(
      viewOf(props),
      (e) => e.props.action === "Delete model",
    );
    assert.equal(confirm.props.onConfirm, question.confirm);
    assert.equal(confirm.props.onCancel, question.cancel);
  });

  it("downloading_mark_cancels_only_when_cancellable", () => {
    const downloading = readAloudModel(
      { ...pocket, downloaded: false, active: false },
      { ...readCtx, downloading: "pocket-en", percent: 40 },
    );
    const mark = { label: "Stop downloading Pocket TTS", press: () => {} };
    const cancellable = html(
      <ManagerRow {...rowProps({ model: downloading, mark })} />,
    );
    assert.match(
      cancellable,
      /<button[^>]*aria-label="Stop downloading Pocket TTS"/,
    );
    assert.match(cancellable, /stroke-dashoffset/);
    assert.ok(cancellable.includes("Downloading 40% of 296 MB"));

    const fixed = html(
      <ManagerRow
        {...rowProps({
          model: {
            ...downloading,
            state: { kind: "downloading", percent: 40, cancellable: false },
          },
          mark,
        })}
      />,
    );
    assert.doesNotMatch(fixed, /aria-label="Stop downloading Pocket TTS"/);
    assert.match(fixed, /stroke-dashoffset/);
  });

  it("marks_and_second_lines_follow_the_state", () => {
    const at = (state: ModelState) =>
      html(
        <ManagerRow
          {...rowProps({
            model: { ...downloadedPocket, state },
            mark: { label: "Act", press: () => {} },
          })}
        />,
      );
    const checked = /M5 12\.5l4\.5 4\.5L19 7\.5/;
    const ready = at({ kind: "selected", runtime: "ready" });
    assert.match(ready, checked);
    assert.match(ready, /class="text-moss">Selected<\/span> · Ready/);
    const loading = at({ kind: "selected", runtime: "loading" });
    assert.match(loading, /animate-spin/);
    assert.match(loading, /Selected<\/span> · Loading/);
    const dictation = at({ kind: "selected", runtime: null });
    assert.match(dictation, /class="text-moss">Selected<\/span><\/span>/);
    const downloaded = at({ kind: "downloaded" });
    assert.doesNotMatch(downloaded, checked);
    assert.match(downloaded, /<button[^>]*aria-label="Act"/);
    assert.ok(downloaded.includes(downloadedPocket.description));
    const remote = at({ kind: "remote" });
    assert.match(remote, /border-dashed/);
    const failed = at({ kind: "failed", error: "Download stopped: disk full" });
    assert.match(failed, /lucide-rotate-ccw/);
    assert.ok(failed.includes("Download stopped: disk full"));

    const busy = html(
      <ManagerRow
        {...rowProps({
          mark: { label: "Use Pocket TTS", disabled: "Busy", press: () => {} },
        })}
      />,
    );
    assert.match(
      busy,
      /<button[^>]*aria-label="Use Pocket TTS" title="Busy" disabled=""/,
    );
  });

  it("names_wrap_never_truncate", () => {
    const long = {
      ...downloadedPocket,
      name: "Pocket TTS with a very long name that needs two lines at 528 pixels",
    };
    const markup = html(<ManagerRow {...rowProps({ model: long })} />);
    const name =
      markup.match(
        /<button[^>]*>Pocket TTS with a very long[^<]*<\/button>/,
      )?.[0] ?? "";
    assert.match(name, /break-words/);
    assert.doesNotMatch(
      name,
      /truncate|text-ellipsis|whitespace-nowrap|line-clamp/,
    );
  });

  it("row_passes_keys_and_takes_a_lock_and_a_line", () => {
    const onKeyDown = () => {};
    const props = rowProps({
      remove: { label: "Delete Pocket TTS", press: () => {} },
      onKeyDown,
    });
    const root = viewOf(props);
    assert.equal(root.props.tabIndex, 0);
    assert.equal(root.props.onKeyDown, onKeyDown);
    assert.equal(root.props["data-row"], "pocket-en");
    const markup = html(<ManagerRow {...props} />);
    assert.match(
      markup,
      /data-confirm-row="pocket-en"[^>]*><button[^>]*aria-label="Delete Pocket TTS"/,
    );
    assert.doesNotMatch(markup, /Show details/);

    const locked = html(
      <ManagerRow
        {...rowProps({
          model: readAloudModel(pocket, readCtx),
          locked: true,
          line: "Locked while transcribing",
        })}
      />,
    );
    assert.match(locked, /lucide-lock/);
    assert.ok(locked.includes("Locked while transcribing"));
    assert.doesNotMatch(locked, /Show details/);
    assert.match(locked, /data-selected=""/);

    const plain = html(<ManagerRow {...rowProps()} />);
    assert.match(plain, /aria-label="Show details"/);
    assert.doesNotMatch(plain, /data-selected/);
  });
});

describe("column heads", () => {
  /** Every span of a head row: its classes, title and text. */
  const spans = (markup: string) =>
    [...markup.matchAll(/<span ([^>]*)>([^<]+)<\/span>/g)].map(
      ([, attributes, text]) => ({
        classes: attributes.match(/class="([^"]*)"/)?.[1].split(/\s+/) ?? [],
        title: attributes.match(/title="([^"]*)"/)?.[1],
        text,
      }),
    );

  it("heads_truncate_never_break", () => {
    const role = spans(html(<RoleHeads />));
    assert.deepEqual(
      role.map(({ text }) => text),
      [
        english.models.heads.short.score,
        english.models.heads.short.speed,
        english.models.heads.short.size,
      ],
    );
    assert.deepEqual(
      role.map(({ title }) => title),
      ["Score", "Speed", "Size"],
    );
    for (const { classes } of role) {
      assert.ok(classes.includes("truncate"), classes.join(" "));
      assert.ok(!classes.includes("[overflow-wrap:anywhere]"));
    }
    assert.ok(!html(<RoleHeads />).includes("overflow-wrap:anywhere"));

    const codes = spans(html(<Codes langs={["en", "pa"]} />));
    for (const title of ["Speed", "Size"]) {
      const head = codes.find((span) => span.title === title);
      assert.ok(head, `a ${title} head in ${JSON.stringify(codes)}`);
      assert.ok(head.classes.includes("truncate"), head.classes.join(" "));
      assert.equal(head.text, title);
    }
    const overall = spans(
      html(<Codes langs={["en", "pa", "hi", "de", "fr", "es"]} />),
    );
    const all = overall.find(({ title }) => title === "Accuracy");
    assert.ok(all, JSON.stringify(overall));
    assert.ok(all.classes.includes("truncate"), all.classes.join(" "));
    assert.equal(all.text, english.models.heads.short.all);
  });
});

describe("direction", () => {
  /** True when the element holding exactly `text` carries dir="ltr". */
  const isolated = (markup: string, text: string) =>
    new RegExp(`<[a-z]+ [^>]*dir="ltr"[^>]*>${text}</`).test(markup);

  it("sizes_and_grades_isolated", () => {
    assert.ok(isolated(html(<GradeChip letter="B" label="A−" />), "A−"));

    const sized = { ...downloadedPocket, sizeBytes: 731_000_000 };
    assert.ok(isolated(html(<RoleCells model={sized} />), "731 MB"));
    const unlisted = html(
      <RoleCells model={{ ...downloadedPocket, sizeBytes: null }} />,
    );
    assert.ok(unlisted.includes(">Not listed<"), unlisted);
    assert.ok(!isolated(unlisted, "Not listed"), unlisted);

    const grading = makeGrading(["en"], "accelerated", []);
    const dictation = html(
      <DictationCells
        model={dictationModel(catalogEntry, info(null), dictCtx)}
        entry={catalogEntry}
        grading={grading}
      />,
    );
    assert.ok(
      isolated(dictation, formatModelSize(catalogEntry.sizeMb)),
      dictation,
    );

    const memory = { ...downloadedPocket, memoryBytes: 453_000_000 };
    const open = html(<ManagerRow {...rowProps({ model: memory })} open />);
    assert.ok(isolated(open, "453 MB"), open);
    assert.equal(detailValue(open, "Memory"), "453 MB");
    const unmeasured = html(
      <ManagerRow
        {...rowProps({ model: { ...downloadedPocket, memoryBytes: null } })}
        open
      />,
    );
    assert.equal(detailValue(unmeasured, "Memory"), "Not measured");
    assert.ok(!isolated(unmeasured, "Not measured"), unmeasured);
  });
});

describe("RoleLegend", () => {
  it("legend_lists_bands_and_the_measuring_machine", () => {
    const read = html(
      <RoleLegendBody
        role="readAloud"
        measuredOn="Intel Core Ultra 7 258V, 2026-11-08"
      />,
    );
    for (const band of ["7.5 to 10", "5 to 7.5", "2.5 to 5", "0 to 2.5"])
      assert.ok(read.includes(band), band);
    assert.ok(read.includes("? has not been measured."));
    assert.ok(
      read.includes("Measured on Intel Core Ultra 7 258V, 2026-11-08."),
    );
    assert.doesNotMatch(read, /this (machine|computer)/);
    const cleanup = html(<RoleLegendBody role="cleanup" measuredOn={null} />);
    assert.ok(cleanup.includes(english.models.legend.score.cleanup));
    assert.ok(!cleanup.includes("7.5 to 10"));
    assert.ok(!cleanup.includes("Measured on"));
  });
});

describe("Models, Dictation rows", () => {
  const PLACES: Place[] = [
    "active",
    "loading",
    "ready",
    "downloading",
    "checking",
    "remote",
  ];
  const recorder = () => {
    const calls: string[] = [];
    return {
      calls,
      deps: {
        pick: (id: string) => void calls.push(`pick:${id}`),
        cancel: (id: string) => void calls.push(`cancel:${id}`),
      },
    };
  };

  it("dictation_row_states", () => {
    const free = {
      active: { mark: "selected", deletable: true, inert: false },
      loading: { mark: "loading", deletable: true, inert: false },
      ready: { mark: "select", deletable: true, inert: false },
      downloading: { mark: "cancel", deletable: false, inert: false },
      checking: { mark: "cancel", deletable: false, inert: false },
      remote: { mark: "download", deletable: false, inert: false },
    } as const;
    const locked = {
      ...free,
      active: { mark: "selected", deletable: false, inert: false },
      ready: { mark: "select", deletable: true, inert: true },
    } as const;
    for (const place of PLACES) {
      assert.deepEqual(dictationRow(place, { locked: false }), free[place]);
      assert.deepEqual(dictationRow(place, { locked: true }), locked[place]);
    }
  });

  it("mark_during_download_follows_last_pressed", () => {
    const { calls, deps } = recorder();
    markPress(
      dictationRow("downloading", { locked: false }).mark,
      "A",
      deps,
    )?.();
    assert.deepEqual(calls, ["cancel:A"]);
    calls.length = 0;
    markPress(dictationRow("ready", { locked: false }).mark, "B", deps)?.();
    assert.deepEqual(calls, ["pick:B"]);
    calls.length = 0;
    markPress(dictationRow("remote", { locked: false }).mark, "C", deps)?.();
    assert.deepEqual(calls, ["pick:C"]);
  });

  it("checking_mark_cancels_the_download", () => {
    const { calls, deps } = recorder();
    const row = dictationRow("checking", { locked: false });
    const press = markPress(row.mark, catalogEntry.id, deps);
    press?.();
    assert.deepEqual(calls, [`cancel:${catalogEntry.id}`]);
    const checking = dictationModel(catalogEntry, info(null), {
      ...dictCtx,
      place: "checking",
    });
    const shown = html(
      <ManagerRow
        {...rowProps({
          model: checking,
          mark: press && { label: "Stop downloading it", press },
          line: "Checking the download…",
        })}
      />,
    );
    assert.match(shown, /<button[^>]*aria-label="Stop downloading it"/);
    assert.ok(shown.includes("Checking the download…"));
  });

  it("pick_then_cancel_keeps_the_selection", () => {
    const { calls, deps } = recorder();
    assert.equal(markPress("selected", "A", deps), null);
    assert.equal(markPress("loading", "A", deps), null);
    markPress("cancel", "A", deps)?.();
    assert.deepEqual(calls, ["cancel:A"]);
  });

  it("delete_question_names_the_selected_consequence", () => {
    const ask = (selected: boolean, size: string | null) =>
      deleteMessage(
        t,
        { name: "Whisper Small", size, selected, role: "dictation" },
        "en",
      );
    assert.equal(
      ask(true, "487 MB"),
      "Delete Whisper Small? It frees 487 MB. Dictation stops working until you choose another model. Your history is kept.",
    );
    assert.equal(
      ask(false, "487 MB"),
      "Delete Whisper Small? It frees 487 MB. Your history is kept.",
    );
    assert.equal(
      ask(true, null),
      "Delete Whisper Small? Dictation stops working until you choose another model. Your history is kept.",
    );
    assert.equal(
      ask(false, null),
      "Delete Whisper Small? Your history is kept.",
    );
  });

  it("cjk_sentences_join_without_space", async () => {
    const ja = i18next.createInstance();
    await ja.init({
      lng: "ja",
      resources: { ja: { translation: japanese } },
      interpolation: { escapeValue: false },
    });
    const model = {
      name: "Whisper Small",
      size: "487 MB",
      selected: true,
      role: "dictation" as const,
    };
    const text = deleteMessage(ja.t.bind(ja), model, "ja");
    const parts = [
      ja.t("models.delete.ask", { name: model.name, size: model.size }),
      ja.t("models.delete.selected.dictation"),
      ja.t("models.delete.kept.dictation"),
    ];
    assert.ok(!text.includes("。 "), text);
    assert.equal(text, parts.join(""));
    assert.ok(parts[0].endsWith("。") && text.includes(parts[0] + parts[1]));
    const en = deleteMessage(t, model, "en");
    assert.ok(en.includes("Whisper Small? It frees 487 MB. Dictation stops"));
    assert.ok(!en.includes("  "));
    assert.equal(joinSentences(["a。", "b。"], "zh-TW"), "a。b。");
    assert.equal(joinSentences(["a。", "b。"], "zh"), "a。b。");
    assert.equal(joinSentences(["a。", "b。"], "ja-JP"), "a。b。");
    assert.equal(joinSentences(["a.", "b."], "en"), "a. b.");
    assert.equal(joinSentences(["a.", "b."], "de"), "a. b.");
  });

  it("download_or_selection_change_closes_the_question", async () => {
    type Now = { place: Place; selected: boolean; locked: boolean };
    const idle: Now = { place: "ready", selected: false, locked: false };
    let now: Now = idle;
    let asked: DeleteAsk | null = null;
    const removed: string[] = [];
    const checks = deleteChecks({
      asked: () => asked,
      now: () => now,
      remove: (id) => void removed.push(id),
    });
    let shown: string | null = null;
    const pending = createPendingConfirm<string>({
      show: (key) => (shown = key),
      apply: checks.apply,
      present: checks.present,
    });
    const ask = (id: string, at: Now) => {
      now = at;
      asked = { id, selected: at.selected };
      pending.ask(id);
    };

    ask("A", idle);
    pending.prune();
    assert.equal(shown, "A");
    assert.equal(checks.present("B"), false);

    now = { ...idle, place: "downloading" };
    pending.prune();
    assert.equal(shown, null, "a download starting closes it");

    ask("A", idle);
    now = { ...idle, place: "remote" };
    pending.prune();
    assert.equal(shown, null, "the model leaving the disk closes it");

    ask("A", idle);
    now = { ...idle, place: "loading" };
    pending.prune();
    assert.equal(shown, "A", "loading stays deletable, as today");
    pending.cancel();

    ask("A", idle);
    now = { place: "active", selected: true, locked: false };
    pending.prune();
    assert.equal(shown, null, "selected from the tray while asking");

    ask("A", idle);
    now = { place: "active", selected: true, locked: false };
    await pending.confirm();
    assert.deepEqual(removed, [], "Confirm after a change deletes nothing");

    const selected: Now = { place: "active", selected: true, locked: false };
    ask("A", selected);
    now = { ...selected, locked: true };
    pending.prune();
    assert.equal(shown, null, "a transcription locks the selected model");

    ask("A", selected);
    now = { ...selected, selected: false, place: "ready" };
    pending.prune();
    assert.equal(shown, null, "another model selected while asking");

    ask("A", idle);
    pending.prune();
    await pending.confirm();
    assert.deepEqual(removed, ["A"]);
  });

  it("models_page_has_one_scroll_body", () => {
    const app = readFileSync(
      new URL("../../../App.tsx", import.meta.url),
      "utf8",
    );
    assert.ok(!app.includes('shown.destination === "models"'));
    assert.ok(!app.includes('" h-full"'));
    const page = readFileSync(
      new URL("../../settings/models/ModelsSettings.tsx", import.meta.url),
      "utf8",
    );
    assert.ok(!page.includes("<ModelTable"));
    assert.ok(page.includes("<ManagerTable"));
  });

  it("legend_never_claims_this_machine", () => {
    const dir = new URL("../../../i18n/locales/", import.meta.url);
    const codes = readdirSync(dir).sort();
    assert.equal(codes.length, 27);
    const shared = (a: string, b: string) => {
      let i = 0;
      for (; i < a.length && a[i] === b[i]; i += 1);
      return i;
    };
    for (const code of codes) {
      const file = JSON.parse(
        readFileSync(new URL(`${code}/translation.json`, dir), "utf8"),
      );
      for (const tier of ["accelerated", "cpu"] as const) {
        const upstream: string = file.settings.models.legend.speedNote[tier];
        const shown: unknown = file.models?.legend?.speedNote?.[tier];
        assert.equal(typeof shown, "string", `${code} ${tier} missing`);
        const note = shown as string;
        const claim = upstream.slice(shared(upstream, note)).trim();
        assert.ok(claim.length > 0, `${code} ${tier} keeps upstream's claim`);
        assert.ok(!note.includes(claim), `${code} ${tier}: ${note}`);
      }
    }
    assert.equal(
      english.models.legend.speedNote.cpu,
      "How long 30 seconds of speech takes to type out on our test laptop’s processor. Not measured on this computer.",
    );
    assert.ok(
      english.settings.models.legend.speedNote.cpu.endsWith(
        "This computer may differ.",
      ),
    );
    const legend = readFileSync(
      new URL("../../settings/models/Legend.tsx", import.meta.url),
      "utf8",
    );
    assert.ok(legend.includes("`models.legend.speedNote.${tier}`"));
    assert.ok(!legend.includes("settings.models.legend.speedNote"));
  });
});

describe("Dictation model descriptions", () => {
  const de = i18next.createInstance();
  void de.init({
    lng: "de",
    resources: { de: { translation: german } },
    interpolation: { escapeValue: false },
  });
  const tde = de.t.bind(de);
  const germanText = (id: string): string | undefined =>
    (german.onboarding.models as Record<string, { description?: string }>)[
      translationKeyId(id)
    ]?.description;
  const v3 = catalog.getModel("parakeet-tdt-0.6b-v3");
  if (!v3) throw new Error("catalog lacks parakeet-tdt-0.6b-v3");
  const live = (m: CatalogModel, filename: string): ModelInfo => ({
    ...info(null),
    id: `${m.repository}/${filename}`,
    name: m.name,
    description: m.description,
    filename,
    source: { HuggingFace: { repo_id: m.repository, revision: m.revision } },
  });

  it("dictation_descriptions_are_translated", () => {
    assert.equal(
      translationKeyId("parakeet-tdt-0.6b-v3"),
      "parakeet-tdt-0_6b-v3",
    );
    const want = germanText(v3.id);
    assert.ok(want, "de has the key for a dotted catalog id");
    const v3Info = live(v3, "parakeet-tdt-0.6b-v3-Q8_0.gguf");
    assert.notEqual(want, v3.description);
    assert.equal(getTranslatedModelDescription(v3Info, tde), want);
    assert.equal(getTranslatedModelDescription(v3Info, t), v3.description);

    const entry = toTableModel(v3Info, tde);
    assert.equal(entry.description, want);
    const row = renderToStaticMarkup(
      <I18nextProvider i18n={de}>
        <ManagerRow
          {...rowProps({
            model: dictationModel(entry, v3Info, { ...dictCtx, t: tde }),
          })}
        />
      </I18nextProvider>,
    );
    assert.ok(
      decode(row).includes(want),
      "the Dictation row shows the de text",
    );

    const otherQuant = live(v3, "parakeet-tdt-0.6b-v3-Q4_K_M.gguf");
    assert.equal(getTranslatedModelDescription(otherQuant, tde), want);

    const unlisted: ModelInfo = {
      ...v3Info,
      id: "someone/unlisted-gguf/unlisted.gguf",
      description: "My own English words",
      source: {
        HuggingFace: { repo_id: "someone/unlisted-gguf", revision: "x" },
      },
    };
    assert.equal(
      getTranslatedModelDescription(unlisted, tde),
      "My own English words",
    );
    const custom: ModelInfo = { ...unlisted, id: "my-custom", is_custom: true };
    assert.equal(
      getTranslatedModelDescription(custom, tde),
      tde("onboarding.customModelDescription"),
    );
  });

  /** Mirrors generated_description in src-tauri/src/catalog/mod.rs. */
  const generated = (m: CatalogModel): string => {
    const features = [
      ...(m.capabilities.translate ? ["translation"] : []),
      ...(m.capabilities.languageDetection ? ["auto language detection"] : []),
      ...(m.capabilities.streaming ? ["streaming"] : []),
      ...(m.capabilities.timestamps ? ["timestamps"] : []),
    ];
    const languages = new Set(m.languages.map((l) => languageIdentity(l)));
    const names: Record<string, string> = {
      en: "English",
      ar: "Arabic",
      ja: "Japanese",
      ko: "Korean",
      ru: "Russian",
      uk: "Ukrainian",
      vi: "Vietnamese",
      zh: "Chinese",
    };
    const only = [...languages][0] ?? "en";
    const base =
      languages.size > 1
        ? `${languages.size}-language speech-to-text`
        : `${names[only] ?? only} speech-to-text`;
    return features.length
      ? `${base} with ${features.join(", ")}.`
      : `${base}.`;
  };

  it("every_catalog_description_has_a_key_in_every_locale", () => {
    const offered = catalog.models.filter(
      (m) => m.role === "asr" && !m.files[m.quant].filename.includes("/"),
    );
    assert.ok(offered.length > 60);
    assert.equal(
      new Set(offered.map((m) => translationKeyId(m.id))).size,
      offered.length,
      "sanitised ids stay distinct",
    );
    const dir = new URL("../../../i18n/locales/", import.meta.url);
    const codes = readdirSync(dir).sort();
    assert.equal(codes.length, 27);
    for (const code of codes) {
      const file = JSON.parse(
        readFileSync(new URL(`${code}/translation.json`, dir), "utf8"),
      );
      for (const m of offered) {
        const text = file.onboarding?.models?.[translationKeyId(m.id)]
          ?.description as unknown;
        assert.ok(
          typeof text === "string" && text.length > 0,
          `${code} lacks onboarding.models.${translationKeyId(m.id)}.description`,
        );
        if (code === "en")
          assert.equal(text, m.description || generated(m), `en ${m.id}`);
      }
    }
  });
});

describe("Models, Cleanup rows", () => {
  const quill: LocalLlmModelInfo = {
    ...s1,
    id: "quill-0-8b-q4km",
    display_name: "Quill 0.8B",
    prompt_style: "plain_system_prompt",
    license_note: null,
    source: null,
  };
  const qwen: LocalLlmModelInfo = {
    ...quill,
    id: "qwen3-4b-instruct-2507-q4km",
    display_name: "Qwen3 4B",
    downloaded: false,
  };
  const idle = { selectedId: s1.id, downloadId: null, deletingId: null };
  const rowProps = (
    patch: Partial<CleanupRowsProps> = {},
  ): CleanupRowsProps => ({
    models: [s1, quill, qwen],
    ...idle,
    percentage: null,
    runtime: "ready",
    deletion: {
      asking: null,
      ask: () => {},
      cancel: () => {},
      confirm: () => {},
    },
    asked: null,
    openId: null,
    onOpenChange: () => {},
    act: { select: () => {}, download: () => {}, ask: () => {} },
    ...patch,
  });
  const render = (patch: Partial<CleanupRowsProps> = {}): string =>
    renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <CleanupRows {...rowProps(patch)} />
      </I18nextProvider>,
    );
  const rowOf = (html: string, id: string): string => {
    const start = html.indexOf(`data-row="${id}"`);
    assert.ok(start >= 0, `row ${id} is rendered`);
    const next = html.indexOf('data-row="', start + 1);
    return html.slice(start, next < 0 ? undefined : next);
  };
  const buttonLabelled = (html: string, label: string): string | undefined =>
    html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0];
  const isDisabled = (tag: string | undefined): boolean =>
    tag !== undefined && /\sdisabled=""/.test(tag);
  const BUSY = "Wait for the current download or delete to finish.";

  it("cleanup_marks_follow_row_actions", () => {
    const html = render();
    const select = buttonLabelled(rowOf(html, quill.id), "Select Quill 0.8B");
    assert.ok(
      select && !isDisabled(select),
      "a downloaded model offers Select",
    );
    const download = buttonLabelled(rowOf(html, qwen.id), "Download Qwen3 4B");
    assert.ok(
      download && !isDisabled(download),
      "a missing model offers Download",
    );
    assert.ok(
      !buttonLabelled(rowOf(html, s1.id), "Select S1-mini"),
      "the selected model has no mark button",
    );

    const downloading = render({ downloadId: qwen.id, percentage: 40 });
    const busySelect = buttonLabelled(
      rowOf(downloading, quill.id),
      "Select Quill 0.8B",
    );
    assert.ok(isDisabled(busySelect), busySelect);
    assert.ok(busySelect?.includes(`title="${BUSY}"`), busySelect);
    const ring = rowOf(downloading, qwen.id);
    assert.ok(!buttonLabelled(ring, "Stop downloading Qwen3 4B"), "no cancel");
    assert.ok(!buttonLabelled(ring, "Download Qwen3 4B"), "no second download");
    assert.ok(ring.includes("40%"), "the ring row shows progress");

    const deleting = render({ deletingId: s1.id });
    assert.ok(
      isDisabled(
        buttonLabelled(rowOf(deleting, quill.id), "Select Quill 0.8B"),
      ),
    );
    assert.ok(
      isDisabled(buttonLabelled(rowOf(deleting, qwen.id), "Download Qwen3 4B")),
    );

    // The mark is the row actions' permission, press for press.
    const calls: string[] = [];
    const states = [
      idle,
      { ...idle, downloadId: qwen.id },
      { ...idle, deletingId: quill.id },
    ];
    for (const state of states) {
      for (const model of [s1, quill, qwen]) {
        const kind = cleanupModel(model, { ...cleanCtx, ...state }).state.kind;
        const actions = createLocalLlmRowActions(model, state, {
          onSelect: (id) => calls.push(`select:${id}`),
          onDelete: () => {},
          onDownload: (id) => calls.push(`download:${id}`),
        });
        const mark = cleanupMark(model, kind, actions, t);
        if (kind === "selected" || kind === "downloading") {
          assert.equal(mark, null, `${model.id} ${kind}: no button`);
          continue;
        }
        assert.ok(mark, `${model.id} has a mark`);
        const permitted =
          kind === "downloaded" ? actions.canUse : actions.canDownload;
        assert.equal(mark.disabled === undefined, permitted, model.id);
        calls.length = 0;
        mark.press();
        assert.deepEqual(
          calls,
          permitted
            ? [`${kind === "downloaded" ? "select" : "download"}:${model.id}`]
            : [],
          "a disabled mark never calls through",
        );
      }
    }
  });

  it("cleanup_row_actions_dispatch_with_the_row_id_and_stay_inert_when_busy", () => {
    const calls: string[] = [];
    const callbacks = {
      onSelect: (id: string) => calls.push(`use:${id}`),
      onDelete: (id: string) => calls.push(`delete:${id}`),
      onDownload: (id: string) => calls.push(`download:${id}`),
    };
    for (const model of [s1, quill]) {
      calls.length = 0;
      const actions = createLocalLlmRowActions(model, idle, callbacks);
      assert.equal(actions.canUse, model.id !== s1.id);
      assert.equal(actions.canDelete, true);
      assert.equal(actions.canDownload, false);
      actions.use();
      actions.delete();
      actions.download();
      assert.deepEqual(calls, [
        ...(model.id === s1.id ? [] : [`use:${model.id}`]),
        `delete:${model.id}`,
      ]);
    }
    calls.length = 0;
    const missing = createLocalLlmRowActions(qwen, idle, callbacks);
    assert.deepEqual(
      [missing.canUse, missing.canDelete, missing.canDownload],
      [false, false, true],
    );
    missing.use();
    missing.delete();
    missing.download();
    assert.deepEqual(calls, [`download:${qwen.id}`]);
    for (const busyState of [
      { ...idle, downloadId: qwen.id },
      { ...idle, deletingId: s1.id },
    ]) {
      for (const model of [s1, quill, qwen]) {
        calls.length = 0;
        const actions = createLocalLlmRowActions(model, busyState, callbacks);
        assert.deepEqual(
          [actions.canUse, actions.canDelete, actions.canDownload],
          [false, false, false],
        );
        actions.use();
        actions.delete();
        actions.download();
        assert.deepEqual(calls, [], "a busy row dispatches nothing");
      }
    }
    assert.equal(
      createLocalLlmRowActions(
        qwen,
        { ...idle, downloadId: qwen.id },
        callbacks,
      ).isDownloading,
      true,
    );
  });

  const asked = (selected: boolean) => ({ id: quill.id, selected });
  const base = (): CleanupDeleteView => ({
    asked: asked(false),
    models: [s1, quill, qwen],
    selectedId: s1.id,
    downloadId: null,
    deletingId: null,
  });

  it("cleanup_delete_rechecks_at_confirm", () => {
    const removed: string[] = [];
    let view = base();
    const present = cleanupPresent(() => view);
    const apply = cleanupApply(
      () => view,
      (id) => removed.push(id),
    );
    assert.equal(present(quill.id), true, "an idle, downloaded model");
    apply(quill.id);
    assert.deepEqual(removed, [quill.id], "Confirm deletes it once");

    removed.length = 0;
    view = { ...base(), downloadId: qwen.id };
    assert.equal(present(quill.id), false, "a download started");
    apply(quill.id);
    view = { ...base(), deletingId: s1.id };
    assert.equal(present(quill.id), false, "another delete runs");
    apply(quill.id);
    view = { ...base(), models: [s1, qwen] };
    assert.equal(present(quill.id), false, "the model is gone");
    apply(quill.id);
    view = { ...base(), models: [s1, { ...quill, downloaded: false }, qwen] };
    assert.equal(present(quill.id), false, "the model is no longer downloaded");
    apply(quill.id);
    view = { ...base(), asked: null };
    assert.equal(present(quill.id), false, "no question asked");
    apply(quill.id);
    view = { ...base(), asked: { id: qwen.id, selected: false } };
    apply(quill.id);
    assert.deepEqual(removed, [], "every blocked Confirm deleted nothing");
  });

  it("cleanup_delete_closes_when_the_selection_changes_under_it", () => {
    const removed: string[] = [];
    const remove = (id: string) => removed.push(id);
    // Asked when S1-mini was selected; the tray then selected Quill.
    let view: CleanupDeleteView = {
      ...base(),
      asked: { id: s1.id, selected: true },
      selectedId: quill.id,
    };
    assert.equal(cleanupPresent(() => view)(s1.id), false);
    cleanupApply(() => view, remove)(s1.id);
    // Asked when Quill was not selected; it was selected under the question.
    view = { ...view, asked: asked(false) };
    assert.equal(cleanupPresent(() => view)(quill.id), false);
    cleanupApply(() => view, remove)(quill.id);
    assert.deepEqual(removed, [], "neither stale question deletes");
    view = { ...view, asked: asked(true) };
    assert.equal(
      cleanupPresent(() => view)(quill.id),
      true,
      "asked again, it holds",
    );
  });

  it("cleanup_delete_question_names_what_goes", () => {
    const plain = cleanupAskedFor(t, quill, false, "en");
    assert.deepEqual(
      { id: plain.id, selected: plain.selected },
      { id: quill.id, selected: false },
    );
    assert.equal(
      plain.message,
      "Delete Quill 0.8B? It frees 484 MB. Your prompts and history are kept.",
    );
    const selected = cleanupAskedFor(t, s1, true, "en");
    assert.ok(selected.selected);
    assert.ok(
      selected.message.includes(
        "Cleanup stops working until you choose another model.",
      ),
      selected.message,
    );
    assert.ok(selected.message.endsWith("Your prompts and history are kept."));
    const unknown = cleanupAskedFor(
      t,
      { ...quill, size_bytes: 0 },
      false,
      "en",
    );
    assert.ok(!unknown.message.includes("It frees"), unknown.message);

    const html = render({
      asked: plain,
      deletion: {
        asking: quill.id,
        ask: () => {},
        cancel: () => {},
        confirm: () => {},
      },
    });
    const row = rowOf(html, quill.id);
    assert.ok(row.includes("It frees 484 MB."), row);
    assert.ok(row.includes("Delete model"), "the red action");
    assert.ok(
      row.includes("data-confirm-row"),
      "Cancel returns focus to the row",
    );
    assert.ok(!rowOf(html, s1.id).includes("It frees"), "only the asked row");
  });

  it("cleanup_rows_sections_heads_and_no_chips", () => {
    const html = render();
    assert.ok(html.includes("On this computer"));
    assert.ok(html.includes("Available"));
    assert.ok(
      html.indexOf("On this computer") < html.indexOf(`data-row="${s1.id}"`),
    );
    assert.ok(
      html.indexOf(`data-row="${s1.id}"`) <
        html.indexOf(`data-row="${qwen.id}"`),
    );
    for (const head of ["Score", "Speed", "Size"]) {
      assert.ok(html.includes(head), head);
    }
    assert.ok(!html.includes("aria-pressed"), "no filter chips on Cleanup");
    assert.ok(
      rowOf(html, s1.id).includes("Ready"),
      "the selected row names its runtime",
    );
    assert.ok(
      buttonLabelled(rowOf(html, s1.id), "Delete S1-mini"),
      "trash on a downloaded row",
    );
    assert.ok(
      !buttonLabelled(rowOf(html, qwen.id), "Delete Qwen3 4B"),
      "none on a missing row",
    );
    const open = render({ openId: s1.id });
    assert.ok(open.includes("CPU"), "Run on is CPU");
    assert.ok(open.includes("Not measured"));
    assert.ok(open.includes("Model card"));
    const busy = render({ downloadId: qwen.id });
    assert.ok(
      !buttonLabelled(rowOf(busy, quill.id), "Delete Quill 0.8B"),
      "no trash during a download",
    );
  });

  it("cleanup_runtime_word_follows_the_status", () => {
    const status = (
      state: LocalLlmStatus["state"],
      model_id: string | null = s1.id,
      error: string | null = null,
    ): LocalLlmStatus => ({ state, model_id, error });
    assert.equal(cleanupRuntime(null, s1.id), "notLoaded");
    assert.equal(cleanupRuntime(status("ready"), s1.id), "ready");
    assert.equal(cleanupRuntime(status("starting"), s1.id), "loading");
    assert.equal(
      cleanupRuntime(status("failed", s1.id, "boom"), s1.id),
      "failed",
    );
    assert.equal(cleanupRuntime(status("unloaded", null), s1.id), "notLoaded");
    assert.equal(cleanupRuntime(status("stopping"), s1.id), "notLoaded");
    assert.equal(
      cleanupRuntime(status("ready", quill.id), s1.id),
      "notLoaded",
      "another model's status is not this model's",
    );
  });
});
