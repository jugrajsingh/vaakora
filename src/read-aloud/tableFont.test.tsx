import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import en from "../i18n/locales/en/translation.json";
import type { GridBlock, SessionSnapshot } from "../bindings";
import { previewSegments } from "./presentation";
import { ReadAloudPopup } from "./ReadAloudPopup";
const {
  describe,
  it,
}: {
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => void) => void;
} = createRequire(import.meta.url)("bun:test");

const i18n = i18next.createInstance();
await i18n.init({
  lng: "en",
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
});

const TABLE = [
  "┌──────┬───────┐",
  "│ Lane │ Owner │",
  "├──────┼───────┤",
  "│ B    │ Opus  │",
  "└──────┴───────┘",
].join("\n");
const ROW = "│ B    │ Opus  │";
const TEXT = `Intro line.\n\n${TABLE}\n\nAfter line.`;
const BLOCK: GridBlock = {
  start: TEXT.indexOf(TABLE),
  end: TEXT.indexOf(TABLE) + TABLE.length,
};
const MARKDOWN = "| h | i |\n|---|---|\n| a | b |";

const snapshotAt = (start: number, end: number): SessionSnapshot => ({
  epoch: 0,
  state: "paused",
  source_start: start,
  source_end: end,
  elapsed_seconds: 1,
  remaining_seconds: 9,
  progress: 0.1,
  error: null,
  output_fallback: false,
  queued_audio_seconds: 0,
  buffering_pauses: 0,
  head_start_seconds: null,
});
const render = (
  text: string,
  gridBlocks: readonly GridBlock[],
  start: number,
  end: number,
) =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <ReadAloudPopup
        text={text}
        gridBlocks={gridBlocks}
        heading={null}
        editing={false}
        enterEdit={() => {}}
        snapshot={snapshotAt(start, end)}
        edit={() => {}}
        toggle={() => {}}
        close={() => {}}
        readClipboard={() => {}}
        models={() => {}}
      />
    </I18nextProvider>,
  );

/** The element whose opening tag starts at `open`, through its matching close tag. */
const elementAt = (html: string, open: number) => {
  const name = /^<(\w+)/.exec(html.slice(open))?.[1];
  assert.ok(name, "an element opens here");
  const tags = new RegExp(`</?${name}\\b[^>]*>`, "g");
  tags.lastIndex = open;
  let depth = 0;
  for (let tag = tags.exec(html); tag; tag = tags.exec(html)) {
    depth += tag[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(open, tags.lastIndex);
  }
  throw new Error(`no close tag for ${name}`);
};
const textOf = (html: string) =>
  html
    .replace(/<[^>]*>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
const blocksIn = (html: string) =>
  [...html.matchAll(/<span[^>]*data-table-block[^>]*>/g)].map((found) =>
    elementAt(html, found.index),
  );
const classOf = (tag: string) =>
  (/class="([^"]*)"/.exec(tag)?.[1] ?? "").split(/\s+/);

describe("reader table font", () => {
  it("shows a box table block monospaced with whitespace preserved and the mark inside", () => {
    const rowAt = TEXT.indexOf(ROW);
    const html = render(TEXT, [BLOCK], rowAt, rowAt + ROW.length);
    const blocks = blocksIn(html);
    assert.equal(blocks.length, 1);
    const [block] = blocks;
    const classes = classOf(/^<span[^>]*>/.exec(block)?.[0] ?? "");
    for (const name of [
      "font-mono",
      "whitespace-pre",
      "overflow-x-auto",
      "max-w-full",
    ])
      assert.ok(classes.includes(name), `${name} in ${classes.join(" ")}`);
    assert.equal(textOf(block), TABLE, "every character, whitespace included");
    assert.ok(textOf(block).includes("│ B    │ Opus  │"), "inner spaces kept");
    const marks = [...block.matchAll(/<mark[^>]*>(.*?)<\/mark>/gs)];
    assert.equal(marks.length, 1, "the mark is inside the block");
    assert.equal(marks[0][1], ROW);
    assert.equal(
      (html.match(/<mark/g) ?? []).length,
      1,
      "no second mark outside the block",
    );
    const mark = /<mark[^>]*>/.exec(block)?.[0] ?? "";
    assert.ok(classOf(mark).includes("box-decoration-clone"));
    assert.ok(classOf(mark).includes("bg-logo-primary/25"));
  });

  it("keeps today's font and wrapping on the prose around the block", () => {
    const rowAt = TEXT.indexOf(ROW);
    const html = render(TEXT, [BLOCK], rowAt, rowAt + ROW.length);
    const outside = html.replace(blocksIn(html)[0], "");
    assert.ok(outside.includes("Intro line."));
    assert.ok(outside.includes("After line."));
    assert.equal(outside.includes("font-mono"), false);
    const preview = /<div[^>]*data-source-preview[^>]*>/.exec(html)?.[0] ?? "";
    assert.ok(classOf(preview).includes("whitespace-pre-wrap"));
    assert.equal(textOf(elementAt(html, html.indexOf(preview))), TEXT);
  });

  it("gives a Markdown table and prose no mono class", () => {
    for (const text of [
      `Intro.\n\n${MARKDOWN}\n\nAfter.`,
      "A plain sentence.",
    ]) {
      const html = render(text, [], 0, 3);
      assert.equal(html.includes("font-mono"), false, text);
      assert.equal(html.includes("data-table-block"), false, text);
      assert.equal(blocksIn(html).length, 0);
    }
  });

  it("splits a mark that crosses into the block and loses none of it", () => {
    const from = TEXT.indexOf("line.");
    const to = TEXT.indexOf(ROW) + ROW.length;
    const html = render(TEXT, [BLOCK], from, to);
    const [block] = blocksIn(html);
    const outside = html.replace(block, "");
    assert.equal((outside.match(/<mark/g) ?? []).length, 1);
    assert.equal((block.match(/<mark/g) ?? []).length, 1);
    const marked = [...html.matchAll(/<mark[^>]*>(.*?)<\/mark>/gs)]
      .map((found) => found[1])
      .join("");
    assert.equal(marked, TEXT.slice(from, to));
    assert.equal(textOf(block), TABLE);
  });

  it("keeps the block monospaced and unmarked when the mark is elsewhere", () => {
    const html = render(TEXT, [BLOCK], 0, 11);
    const [block] = blocksIn(html);
    assert.equal(block.includes("<mark"), false);
    assert.equal(textOf(block), TABLE);
  });

  it("styles the block with theme tokens only, no raw colour or font stack", () => {
    const html = render(TEXT, [BLOCK], 0, 11);
    const [block] = blocksIn(html);
    const classes = classOf(/^<span[^>]*>/.exec(block)?.[0] ?? "");
    assert.ok(
      classes.every((name) => !/#|rgb|font-\[/.test(name)),
      classes.join(" "),
    );
  });
});

describe("previewSegments", () => {
  const join = (
    text: string,
    blocks: readonly GridBlock[],
    a: number,
    b: number,
  ) =>
    previewSegments(text, blocks, a, b)
      .map((part) => part.before + part.current + part.after)
      .join("");

  it("splits the text at the block and keeps every character", () => {
    const parts = previewSegments(TEXT, [BLOCK], 0, 11);
    assert.deepEqual(
      parts.map((part) => part.mono),
      [false, true, false],
    );
    assert.equal(join(TEXT, [BLOCK], 0, 11), TEXT);
  });

  it("returns one prose segment holding the mark when there are no blocks", () => {
    const parts = previewSegments("A sentence", [], 2, 7);
    assert.deepEqual(parts, [
      { mono: false, before: "A ", current: "sente", after: "nce", mark: true },
    ]);
  });

  it("returns one prose segment for empty text", () => {
    assert.equal(previewSegments("", [], 0, 0).length, 1);
  });

  it("ignores ranges that are reversed, empty, overlapping or past the text", () => {
    const bad: GridBlock[] = [
      { start: 9, end: 4 },
      { start: 5, end: 5 },
      BLOCK,
      { start: BLOCK.start + 1, end: BLOCK.end },
      { start: TEXT.length + 5, end: TEXT.length + 9 },
    ];
    assert.equal(join(TEXT, bad, 3, 40), TEXT);
    assert.equal(
      previewSegments(TEXT, bad, 3, 40).filter((part) => part.mono).length,
      1,
    );
    assert.equal(join(TEXT, [{ start: 0, end: 9999 }], 0, 3), TEXT);
  });

  it("reads UTF-16 ranges after an astral character", () => {
    const text = `😀\n${TABLE}`;
    const block = { start: 3, end: 3 + TABLE.length };
    assert.equal(join(text, [block], 0, 2), text);
    assert.equal(previewSegments(text, [block], 0, 2)[1].mono, true);
  });
});

describe("reader window wiring", () => {
  it("hands the table blocks of every state event to the popup", () => {
    const source = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
    assert.ok(source.includes("setGridBlocks(next.grid_blocks);"));
    assert.ok(source.includes("gridBlocks={gridBlocks}"));
  });
});
