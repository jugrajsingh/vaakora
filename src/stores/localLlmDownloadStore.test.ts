import assert from "node:assert/strict";
import { createRequire } from "node:module";
const {
  test,
  mock,
}: {
  test: (name: string, run: () => void | Promise<void>) => void;
  mock: { module: (name: string, factory: () => unknown) => void };
} = createRequire(import.meta.url)("bun:test");
import type { Result } from "@/bindings";

let finish!: (result: Result<null, string>) => void;
const pending = new Promise<Result<null, string>>((resolve) => {
  finish = resolve;
});
const downloads: string[] = [];
mock.module("@tauri-apps/api/event", () => ({
  listen: async () => () => undefined,
}));
mock.module("@/bindings", () => ({
  commands: {
    downloadLocalLlmModel: async (id: string) => {
      downloads.push(id);
      return pending;
    },
  },
}));
const { useLocalLlmDownloadStore } = await import("./localLlmDownloadStore");

test("a Qwen download stays owned by its id until it finishes", async () => {
  const qwen = "qwen3-4b-instruct-2507-q4km";
  const store = useLocalLlmDownloadStore;
  store.setState({ modelId: null, percentage: null, error: null, version: 0 });
  const work = store.getState().download(qwen);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(store.getState().modelId, qwen);
  assert.equal(store.getState().start("other-download"), false);
  store.getState().progress(qwen, 35);
  store.getState().progress("wrong-id", 99);
  assert.equal(store.getState().percentage, 35);
  store.getState().finish("wrong-id", "wrong failure");
  assert.equal(store.getState().modelId, qwen);
  assert.equal(store.getState().version, 0);
  finish({ status: "ok", data: null });
  await work;
  assert.deepEqual(downloads, [qwen]);
  assert.equal(store.getState().modelId, null);
  assert.equal(store.getState().percentage, null);
  assert.equal(store.getState().version, 1);
});

test("the deleting id is one source for every reader of the store", () => {
  const store = useLocalLlmDownloadStore;
  store.setState({ modelId: null, deletingId: null });
  // Models, Cleanup and the Cleanup tab's Model row each read the same field.
  const readers = [() => store.getState(), () => store.getState()];
  assert.deepEqual(
    readers.map((read) => read().deletingId),
    [null, null],
  );
  store.getState().setDeletingId("quill-0-8b-q4km");
  assert.deepEqual(
    readers.map((read) => read().deletingId),
    ["quill-0-8b-q4km", "quill-0-8b-q4km"],
    "one reader's busy delete is every reader's",
  );
  store.getState().setDeletingId(null);
  assert.deepEqual(
    readers.map((read) => read().deletingId),
    [null, null],
  );
});
