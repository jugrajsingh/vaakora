import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Theme } from "@/bindings";
import { followTheme } from "./followTheme";

const {
  describe,
  it,
}: {
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => Promise<void> | void) => void;
} = createRequire(import.meta.url)("bun:test");

describe("followTheme", () => {
  it("follow_theme_applies_stored_then_syncs_then_listens", () => {
    const calls: string[] = [];
    let onChange: ((e: { payload: Theme }) => void) | undefined;
    followTheme({
      apply: (theme) => calls.push(`apply:${theme}`),
      stored: () => {
        calls.push("stored");
        return "dark";
      },
      sync: () => calls.push("sync"),
      listen: (event, cb) => {
        calls.push(`listen:${event}`);
        onChange = cb;
      },
    });
    assert.deepEqual(calls, [
      "stored",
      "apply:dark",
      "sync",
      "listen:theme-changed",
    ]);
    onChange?.({ payload: "light" });
    assert.deepEqual(calls.slice(4), ["apply:light"]);
  });

  it("the_reader_entry_calls_follow_theme_before_render", () => {
    const source = readFileSync(
      new URL("../../read-aloud/main.tsx", import.meta.url),
      "utf8",
    );
    const call = source.indexOf("followTheme(");
    assert.ok(call >= 0, "src/read-aloud/main.tsx calls followTheme(");
    assert.ok(
      call < source.indexOf("ReactDOM.createRoot"),
      "followTheme( runs before the first render",
    );
  });
});
