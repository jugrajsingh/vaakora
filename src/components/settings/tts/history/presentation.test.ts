import assert from "node:assert/strict";
import { createRequire } from "node:module";
import i18next from "i18next";
import en from "../../../../i18n/locales/en/translation.json";
import type { ReadHistoryEntry } from "@/bindings";
import { models } from "../vocabulary/fixtures";
import { entryTag, retentionOptions } from "./presentation";
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
  origin: "app",
  chunks: [],
};

describe("entry presentation", () => {
  it("entry_tag_names_model_and_voice", () => {
    assert.equal(entryTag(models, ENTRY), "Pocket TTS, alba");
  });
  it("names the raw model id when the catalog has no such model", () => {
    assert.equal(
      entryTag(models, { ...ENTRY, model_id: "gone-model" }),
      "gone-model, alba",
    );
  });
  it("entryTag leaves the from-agent label to its own tag", () => {
    assert.equal(
      entryTag(models, { ...ENTRY, origin: "agent" }),
      "Pocket TTS, alba",
    );
    assert.equal(t("tts.history.fromAgent"), "from agent");
  });
});

describe("retentionOptions", () => {
  it("offers the five choices in order, the limit named in each Keep the latest", () => {
    assert.deepEqual(retentionOptions(t, 7), [
      { value: "keep_nothing", label: "Do not keep" },
      { value: "keep_limit", label: "Keep the latest 7" },
      { value: "days_3", label: "Keep the latest 7, none older than 3 days" },
      { value: "weeks_2", label: "Keep the latest 7, none older than 2 weeks" },
      {
        value: "months_3",
        label: "Keep the latest 7, none older than 3 months",
      },
    ]);
  });
});
