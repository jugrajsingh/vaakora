import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { subscribeAsync } from "./subscribeAsync";

const { describe, it } = createRequire(import.meta.url)("bun:test");

describe("subscribeAsync", () => {
  it("cleanup_after_resolve_runs_once", async () => {
    let cleanups = 0;
    const stop = subscribeAsync(async () => () => {
      cleanups += 1;
    });
    await Promise.resolve();
    await Promise.resolve();
    stop();
    stop();
    assert.equal(cleanups, 1);
  });

  it("cleanup_before_resolve_runs_on_resolve", async () => {
    let cleanups = 0;
    let resolveSetup: (cleanup: () => void) => void = () => {};
    const stop = subscribeAsync(
      () =>
        new Promise<() => void>((resolve) => {
          resolveSetup = resolve;
        }),
    );
    stop();
    assert.equal(cleanups, 0);
    resolveSetup(() => {
      cleanups += 1;
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(cleanups, 1);
    stop();
    assert.equal(cleanups, 1);
  });
});
