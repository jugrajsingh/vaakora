import type { TFunction } from "i18next";
import { catalog, type MachineTier } from "@handy-computer/models";
import type {
  Device,
  LocalLlmModelInfo,
  ModelInfo,
  TtsModelInfo,
} from "@/bindings";
import type { Place } from "@/components/settings/models/modelEntries";
import { BYTES_PER_MB } from "@/lib/utils/format";
import type { TableModel } from "./context";

export type ModelRole = "dictation" | "readAloud" | "cleanup";

type Runtime = "notLoaded" | "loading" | "ready" | "failed";

export type ModelState =
  | { kind: "remote" }
  | { kind: "downloading"; percent: number | null; cancellable: boolean }
  | { kind: "failed"; error: string }
  | { kind: "downloaded" }
  | { kind: "selected"; runtime: Runtime | null };

/** A quality or speed cell; `text` null renders "?" and `level` counts the speed glyph's bars. */
export interface Measure {
  text: string | null;
  level: 0 | 1 | 2 | 3 | 4;
  figure: string | null;
  provenance: string | null;
}

export interface ManagerModel {
  id: string;
  role: ModelRole;
  name: string;
  description: string;
  tags: (
    | "recommended"
    | "live"
    | "translates"
    | "custom"
    | "oldFormat"
    | "needsToken"
    | "nativeWords"
  )[];
  languages: string[] | null;
  quality: Measure;
  speed: Measure;
  sizeBytes: number | null;
  state: ModelState;
  licence: { name: string | null; terms: string | null; url: string | null };
  sources: { repository: string; revision: string }[];
  measuredOn: string | null;
  memoryBytes: number | null;
  runOn: { kind: "text"; text: string } | { kind: "control" } | null;
  voices: string[];
  customWords: boolean | null;
  needsToken: boolean;
}

const NOT_MEASURED: Measure = {
  text: null,
  level: 0,
  figure: null,
  provenance: null,
};

/** The lowest 0 to 10 speed score for 2, 3 and 4 bars; 1 bar needs a score above 0. */
export const SPEED_SCORE_FLOORS = [2.5, 5, 7.5] as const;

/** Bars for a 0 to 10 speed score: 4 from 7.5, 3 from 5, 2 from 2.5, 1 above 0. */
export function speedLevelFromScore(score: number | null): 0 | 1 | 2 | 3 | 4 {
  if (score === null || !Number.isFinite(score) || score <= 0) return 0;
  return (1 + SPEED_SCORE_FLOORS.filter((floor) => score >= floor).length) as
    | 1
    | 2
    | 3
    | 4;
}

const knownBytes = (bytes: number): number | null =>
  Number.isFinite(bytes) && bytes > 0 ? bytes : null;

// Equal scores resolve cpu, npu, gpu, as the backend's choice does.
const DEVICES: readonly Device[] = ["cpu", "npu", "gpu"];

/** The device a read-aloud model runs on: the saved choice, else the backend's Auto pick (fastest usable), else CPU. */
export function ttsSpeedDevice(
  model: Pick<TtsModelInfo, "run_on" | "rating" | "npu_driver_too_old">,
  available: readonly Device[],
): Device {
  const usable = (device: Device) =>
    available.includes(device) &&
    !(device === "npu" && model.npu_driver_too_old) &&
    model.rating.devices[device]?.supported === true;
  if (model.run_on !== "auto" && usable(model.run_on)) return model.run_on;
  const score = (device: Device) =>
    model.rating.devices[device]?.speed_score ?? 0;
  const [fastest] = DEVICES.filter(usable).sort((a, b) => score(b) - score(a));
  return fastest ?? "cpu";
}

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;

/** The machine and backend the catalogue's speed figures were taken on, for this tier. */
const makerBenchmark = (
  tier: MachineTier,
): { machine: string; backend: string } | null => {
  const cell = field(field(catalog.data.benchmarks, "speed"), tier);
  const machine = field(cell, "machine");
  const backend = field(cell, "backend");
  return typeof machine === "string" && typeof backend === "string"
    ? { machine, backend }
    : null;
};

const runtimeOf = (preparation: TtsModelInfo["preparation"]): Runtime => {
  switch (preparation.state) {
    case "idle":
      return "notLoaded";
    case "preparing":
      return "loading";
    case "ready":
      return "ready";
    case "failed":
      return "failed";
  }
};

export function readAloudModel(
  info: TtsModelInfo,
  ctx: {
    available: readonly Device[];
    downloading: string | null;
    percent: number | null;
    error: string | null;
    t: TFunction;
  },
): ManagerModel {
  const { t } = ctx;
  const device = ttsSpeedDevice(info, ctx.available);
  const score = info.rating.devices[device]?.speed_score ?? null;
  const measuredOn = info.measured
    ? t("models.measured.at", {
        machine: info.measured.machine,
        date: info.measured.date,
      })
    : t("models.missing.notMeasured");
  const provenance = info.measured ? measuredOn : null;
  const speedFigure = score === null ? null : score.toFixed(1);
  const needsToken = info.needs_token && !info.downloaded;
  const state: ModelState =
    ctx.downloading === info.id
      ? { kind: "downloading", percent: ctx.percent, cancellable: true }
      : !info.downloaded
        ? ctx.error
          ? { kind: "failed", error: ctx.error }
          : { kind: "remote" }
        : info.active
          ? { kind: "selected", runtime: runtimeOf(info.preparation) }
          : { kind: "downloaded" };
  return {
    id: info.id,
    role: "readAloud",
    name: info.display_name,
    description: t(`tts.description.${info.id}`),
    tags: [
      ...(info.recommended ? ["recommended" as const] : []),
      ...(needsToken ? ["needsToken" as const] : []),
    ],
    languages: info.languages,
    quality: {
      text: String(info.rating.quality),
      level: 0,
      figure: String(info.rating.quality),
      provenance,
    },
    speed: {
      text: speedFigure,
      level: speedLevelFromScore(score),
      figure: speedFigure,
      provenance,
    },
    sizeBytes: knownBytes(info.size_bytes),
    state,
    licence: {
      name: info.license,
      terms: t(info.attribution),
      url: info.card_url,
    },
    sources: info.sources,
    measuredOn,
    memoryBytes: info.memory_bytes[device] ?? null,
    runOn: { kind: "control" },
    voices: info.voices,
    customWords: null,
    needsToken,
  };
}

export function cleanupModel(
  info: LocalLlmModelInfo,
  ctx: {
    selectedId: string | null;
    downloadId: string | null;
    percent: number | null;
    error: string | null;
    runtime: Runtime | null;
    t: TFunction;
  },
): ManagerModel {
  const { t } = ctx;
  const state: ModelState =
    ctx.downloadId === info.id
      ? { kind: "downloading", percent: ctx.percent, cancellable: false }
      : !info.downloaded
        ? ctx.error
          ? { kind: "failed", error: ctx.error }
          : { kind: "remote" }
        : ctx.selectedId === info.id
          ? { kind: "selected", runtime: ctx.runtime }
          : { kind: "downloaded" };
  return {
    id: info.id,
    role: "cleanup",
    name: info.display_name,
    description: t(
      info.prompt_style === "s1_control_line"
        ? "settings.postProcessing.localLlm.s1Description"
        : "settings.postProcessing.localLlm.plainDescription",
    ),
    tags: [],
    languages: null,
    quality: NOT_MEASURED,
    speed: NOT_MEASURED,
    sizeBytes: knownBytes(info.size_bytes),
    state,
    licence: {
      name: info.license,
      terms: info.license_note ? t(info.license_note) : null,
      url: info.card_url,
    },
    sources: info.source ? [info.source] : [],
    measuredOn: t("models.missing.notMeasured"),
    memoryBytes: null,
    runOn: { kind: "text", text: t("models.runOn.cpu") },
    voices: [],
    customWords: null,
    needsToken: false,
  };
}

const dictationState = (place: Place, percent: number): ModelState => {
  switch (place) {
    case "remote":
      return { kind: "remote" };
    case "ready":
      return { kind: "downloaded" };
    case "active":
      return { kind: "selected", runtime: null };
    case "loading":
      return { kind: "selected", runtime: "loading" };
    case "downloading":
      return { kind: "downloading", percent, cancellable: true };
    case "checking":
      return { kind: "downloading", percent: 100, cancellable: true };
  }
};

export function dictationModel(
  entry: TableModel,
  info: ModelInfo | undefined,
  ctx: {
    place: Place;
    percent: number;
    tier: MachineTier;
    runOnText: string;
    t: TFunction;
  },
): ManagerModel {
  const { t } = ctx;
  const catalogModel = entry.model;
  const benchmark = catalogModel ? makerBenchmark(ctx.tier) : null;
  const measuredOn = benchmark
    ? t("models.measured.maker", benchmark)
    : t("models.missing.notMeasured");
  const provenance = benchmark ? measuredOn : null;
  const wait = catalogModel
    ? catalog.modelWaitSeconds(catalogModel, ctx.tier)
    : undefined;
  const speedFigure =
    wait === undefined
      ? null
      : t("models.speedFigure.dictation", { value: wait.toFixed(1) });
  const nativeWords = info?.supports_vocabulary === true;
  const tags: ManagerModel["tags"] = [
    ...(info?.is_recommended ? ["recommended" as const] : []),
    ...(entry.streaming ? ["live" as const] : []),
    ...(entry.translate ? ["translates" as const] : []),
    ...(nativeWords ? ["nativeWords" as const] : []),
    ...(entry.kind === "custom" ? ["custom" as const] : []),
    ...(entry.kind === "legacy" ? ["oldFormat" as const] : []),
  ];
  return {
    id: entry.id,
    role: "dictation",
    name: entry.name,
    description: entry.description,
    tags,
    languages: entry.languages.length > 0 ? entry.languages : null,
    quality: { ...NOT_MEASURED, provenance },
    speed: { ...NOT_MEASURED, figure: speedFigure, provenance },
    sizeBytes: knownBytes(entry.sizeMb * BYTES_PER_MB),
    state: dictationState(ctx.place, ctx.percent),
    licence: { name: catalogModel?.license ?? null, terms: null, url: null },
    sources: catalogModel
      ? [
          {
            repository: catalogModel.repository,
            revision: catalogModel.revision,
          },
        ]
      : [],
    measuredOn,
    memoryBytes: null,
    runOn: { kind: "text", text: ctx.runOnText },
    voices: [],
    customWords: info?.supports_vocabulary ?? null,
    needsToken: false,
  };
}

/** Every whitespace-separated word of the query is in the name, description, tag words or language names (in the UI language and in English). */
export function matchesQuery(
  model: ManagerModel,
  query: string,
  names: {
    t: TFunction;
    language: string;
    languageName: (code: string, language: string) => string;
  },
): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = [
    model.name,
    model.description,
    ...model.tags.map((tag) => names.t(`models.tags.${tag}`)),
    ...(model.languages ?? []).flatMap((code) => [
      names.languageName(code, names.language),
      names.languageName(code, "en"),
    ]),
  ]
    .join(" ")
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** The open row after the list changed: kept while its model is listed, else none. */
export function nextOpen(
  current: string | null,
  ids: readonly string[],
): string | null {
  return current !== null && ids.includes(current) ? current : null;
}

/** Reports an open row that left the list (`null`) once per hiding; `undefined` means nothing to report. */
export function createOpenSync(): (
  openId: string | null,
  ids: readonly string[],
) => string | null | undefined {
  let reported: string | null = null;
  return (openId, ids) => {
    if (openId === null || ids.includes(openId)) {
      reported = null;
      return undefined;
    }
    if (reported === openId) return undefined;
    reported = openId;
    return null;
  };
}

/** A filter chip: pressed, it keeps only the models that pass `test`. */
export interface Chip {
  key: string;
  label: string;
  test: (m: ManagerModel) => boolean;
}

/** The models that pass every pressed chip. */
export function applyChips(
  models: readonly ManagerModel[],
  on: ReadonlySet<string>,
  chips: readonly Chip[],
): ManagerModel[] {
  const pressed = chips.filter((chip) => on.has(chip.key));
  return models.filter((m) => pressed.every((chip) => chip.test(m)));
}
