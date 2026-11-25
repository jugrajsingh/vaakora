import assert from "node:assert/strict";
import { createRequire } from "node:module";
import i18next from "i18next";
import en from "../../../../i18n/locales/en/translation.json";
import type { ReadHistoryEntry } from "@/bindings";
import { models } from "../vocabulary/fixtures";
import { entryTag, readExcerpt, retentionOptions } from "./presentation";
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
  grid_blocks: [],
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

const BOX = [
  "┌──────┬───────┐",
  "│ Lane │ Owner │",
  "├──────┼───────┤",
  "│ B    │ Opus  │",
  "└──────┴───────┘",
].join("\n");
const ASCII = ["+---+---+", "| a | b |", "| c | d |", "+---+---+"].join("\n");
/** A read whose grid block runs over `block` of `source`, as the backend reports it. */
const withBlock = (source: string, block: string) => {
  const start = source.indexOf(block);
  return {
    source,
    grid_blocks: [{ start, end: start + block.length }],
  };
};

describe("readExcerpt", () => {
  it("a read that starts with a box table previews its header, not the top border", () => {
    const excerpt = readExcerpt(withBlock(BOX, BOX));
    assert.equal(excerpt, "Lane Owner");
    assert.ok(!/[┌─│]/.test(excerpt));
  });
  it("skips every rule line and strips the walls of an ASCII table", () => {
    assert.equal(readExcerpt(withBlock(ASCII, ASCII)), "a b");
  });
  it("a table after blank lines is still where the read starts", () => {
    const source = `\n\n  ${BOX}\n\nAfter.`;
    assert.equal(readExcerpt(withBlock(source, BOX)), "Lane Owner");
  });
  it("skips the fence lines around a fenced box table", () => {
    const fenced = `\`\`\`text\n${BOX}\n\`\`\``;
    assert.equal(readExcerpt(withBlock(fenced, fenced)), "Lane Owner");
  });
  it("a plain read keeps today's collapsed text", () => {
    assert.equal(
      readExcerpt({ source: "Open\n  README.md   now", grid_blocks: [] }),
      "Open README.md now",
    );
  });
  it("a table that does not start the read leaves the preview as it was", () => {
    const source = `Intro line.\n\n${BOX}`;
    assert.equal(
      readExcerpt(withBlock(source, BOX)),
      source.replace(/\s+/g, " ").trim(),
    );
  });
  it("a Markdown table (no grid block) keeps today's collapsed text", () => {
    const source = "| h | i |\n|---|---|\n| a | b |";
    assert.equal(
      readExcerpt({ source, grid_blocks: [] }),
      "| h | i | |---|---| | a | b |",
    );
  });
  it("a block with nothing but borders falls back to today's text", () => {
    const rules = "┌───┐\n└───┘";
    assert.equal(
      readExcerpt(withBlock(rules, rules)),
      rules.replace(/\s+/g, " ").trim(),
    );
  });
  it("a block range past the text never throws", () => {
    assert.equal(
      readExcerpt({ source: "Short", grid_blocks: [{ start: 0, end: 900 }] }),
      "Short",
    );
  });
});
