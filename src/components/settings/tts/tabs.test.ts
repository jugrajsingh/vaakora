import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { visibleTabs } from "./tabs";
const {
  describe,
  it,
}: {
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => void) => void;
} = createRequire(import.meta.url)("bun:test");

describe("visibleTabs", () => {
  it("lists Settings and Vocabulary until history is ready", () => {
    assert.deepEqual(visibleTabs(false), ["settings", "vocabulary"]);
  });
  it("adds History between them once it is ready", () => {
    assert.deepEqual(visibleTabs(true), ["settings", "history", "vocabulary"]);
  });
});
