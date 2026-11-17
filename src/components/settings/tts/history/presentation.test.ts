import assert from "node:assert/strict";
import { createRequire } from "node:module";
import i18next from "i18next";
import en from "../../../../i18n/locales/en/translation.json";
import type { ReadHistoryEntry } from "@/bindings";
import { formatDateTime } from "@/utils/dateFormat";
import { models } from "../vocabulary/fixtures";
import { entryHeading, entryLines, retentionOptions } from "./presentation";
const {
  describe,
  it,
}: {
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => void) => void;
} = createRequire(import.meta.url)("bun:test");
const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: en } } });
const t = i18n.t.bind(i18n);

const ENTRY: ReadHistoryEntry = {
  id: 1,
  timestamp: 1_700_000_000,
  model_id: "pocket-en",
  voice: "alba",
  speed: 1.5,
  technical: true,
  source: "",
  chunks: [],
};

describe("entry presentation", () => {
  it("lists the time and the voice model with its voice", () => {
    assert.deepEqual(entryLines(models, ENTRY, "en"), {
      when: formatDateTime("1700000000", "en"),
      voice: "Pocket TTS · alba",
    });
  });
  it("names the raw model id when the catalog has no such model", () => {
    assert.equal(
      entryLines(models, { ...ENTRY, model_id: "gone-model" }, "en").voice,
      "gone-model · alba",
    );
  });
  it("heads the selected read with time, voice model, voice and speed", () => {
    assert.equal(
      entryHeading(t, models, ENTRY, "en"),
      `${formatDateTime("1700000000", "en")} · Pocket TTS · alba · Speed: 1.5x`,
    );
  });
});

describe("retentionOptions", () => {
  it("offers the five choices in order, the limit named in Keep latest", () => {
    assert.deepEqual(retentionOptions(t, 7), [
      { value: "keep_nothing", label: "Never keep" },
      { value: "keep_limit", label: "Keep latest 7" },
      { value: "days_3", label: "After 3 days" },
      { value: "weeks_2", label: "After 2 weeks" },
      { value: "months_3", label: "After 3 months" },
    ]);
  });
});
