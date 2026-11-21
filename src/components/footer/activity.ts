import type { TFunction } from "i18next";
import type {
  DictationActivity,
  ModelInfo,
  PlaybackState,
  TranscriptionJobStatus,
} from "@/bindings";
import { LINKS, type Link } from "@/lib/navigation";
import { getTranslatedModelName } from "@/lib/utils/modelTranslation";

export type FooterDot = "idle" | "recording" | "busy" | "reading";

export type FileJobInput = { percent: number } | "waiting" | null;

export type DownloadInput =
  | { name: string; percent: number }
  | { count: number }
  | null;

export interface ActivityInput {
  dictation: DictationActivity;
  reading: PlaybackState | null;
  fileJob: FileJobInput;
  download: DownloadInput;
}

export interface FooterActivity {
  key: string;
  values?: Record<string, string | number>;
  dot: FooterDot;
  link: Link | null;
  percent: number | null;
}

const READING: readonly PlaybackState[] = [
  "starting",
  "buffering",
  "playing",
  "paused",
];

const status = (key: string, dot: FooterDot): FooterActivity => ({
  key,
  dot,
  link: null,
  percent: null,
});

/** The one thing the footer says: dictation, then reading, then a file transcription, then a download. */
export function footerActivity(input: ActivityInput): FooterActivity {
  switch (input.dictation) {
    case "recording":
      return status("footer.activity.recording", "recording");
    case "transcribing":
      return status("footer.activity.transcribing", "busy");
    case "cleaning_up":
      return status("footer.activity.cleaningUp", "busy");
    case "ready":
      break;
  }
  if (input.reading !== null && READING.includes(input.reading)) {
    return status("footer.activity.reading", "reading");
  }
  const job = input.fileJob;
  if (job !== null) {
    const history = { link: LINKS.dictationHistory };
    if (job === "waiting") {
      return { ...status("settings.history.waiting", "busy"), ...history };
    }
    return job.percent > 0
      ? {
          ...status("settings.history.transcribingPercent", "busy"),
          values: { percent: job.percent },
          ...history,
        }
      : { ...status("footer.activity.transcribing", "busy"), ...history };
  }
  const download = input.download;
  if (download !== null) {
    const models = { link: LINKS.dictationModels };
    return "count" in download
      ? {
          ...status("footer.activity.downloadingMany", "busy"),
          values: { count: download.count },
          ...models,
        }
      : {
          ...status("footer.activity.downloading", "busy"),
          values: { name: download.name, percent: download.percent },
          ...models,
          percent: download.percent,
        };
  }
  return status("footer.activity.ready", "idle");
}

/** Jobs run one at a time; the rest wait behind the running one. */
export function fileJobInput(
  jobs: Record<number, TranscriptionJobStatus>,
): FileJobInput {
  const all = Object.values(jobs);
  if (all.length === 0) return null;
  const running = all.find((job) => job.state === "running");
  return running ? { percent: running.percent } : "waiting";
}

/** Each model once, across the transfer and its checksum check; a verifying model is at 100. */
export function downloadInput(
  progress: Record<string, { percentage: number }>,
  verifying: Record<string, true>,
  name: (id: string) => string,
): DownloadInput {
  const ids = [
    ...new Set([...Object.keys(progress), ...Object.keys(verifying)]),
  ];
  if (ids.length === 0) return null;
  if (ids.length > 1) return { count: ids.length };
  const [id] = ids;
  const percent =
    id in verifying
      ? 100
      : Math.max(0, Math.min(100, Math.round(progress[id].percentage)));
  return { name: name(id), percent };
}

/** The language detector downloads like a model but has no catalogue entry; an unlisted id shows as itself. */
export function downloadName(
  id: string,
  models: ModelInfo[],
  detectorId: string,
  t: TFunction,
): string {
  if (id === detectorId) return t("footer.activity.languageDetector");
  const model = models.find((entry) => entry.id === id);
  return model ? getTranslatedModelName(model, t) : id;
}

export interface ActivitySources {
  listenDictation: (
    apply: (activity: DictationActivity) => void,
  ) => Promise<() => void>;
  listenReader: (apply: (state: PlaybackState) => void) => Promise<() => void>;
  queryReader: () => Promise<PlaybackState | null>;
  setDictation: (activity: DictationActivity) => void;
  setReader: (state: PlaybackState | null) => void;
}

/** Follows the dictation and the reader until the returned stop runs; the reader's first query yields to any event that arrives first. */
export function connectActivity(sources: ActivitySources): () => void {
  let alive = true;
  let readerEvent = false;
  const stops = [
    sources.listenDictation((activity) => {
      if (alive) sources.setDictation(activity);
    }),
    sources.listenReader((state) => {
      if (!alive) return;
      readerEvent = true;
      sources.setReader(state);
    }),
  ];
  sources.queryReader().then(
    (state) => {
      if (alive && !readerEvent) sources.setReader(state);
    },
    () => undefined,
  );
  return () => {
    alive = false;
    for (const stop of stops) {
      stop.then(
        (off) => off(),
        () => undefined,
      );
    }
  };
}
