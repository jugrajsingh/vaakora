import assert from "node:assert/strict";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import type { InlineConfirmProps } from "@/components/shared/InlineConfirm";
import en from "../../../i18n/locales/en/translation.json";
const {
  mock,
  describe,
  it,
}: {
  mock: { module: (name: string, factory: () => unknown) => void };
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => Promise<void> | void) => void;
} = createRequire(import.meta.url)("bun:test");

const confirms: InlineConfirmProps[] = [];
const real = await import("@/components/shared/InlineConfirm");
mock.module("@/components/shared/InlineConfirm", () => ({
  ...real,
  InlineConfirm: (props: InlineConfirmProps) => {
    confirms.push(props);
    return null;
  },
}));
// HistorySettings imports the app i18n setup; this test's instance stands in for it.
mock.module("@/i18n", () => ({ default: i18next }));
await i18next.use(initReactI18next).init({
  lng: "en",
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
});
const { EntryActionsOrConfirm, entryDeleteControls } = await import(
  "./HistorySettings"
);

function render(asking: boolean, calls: string[]) {
  confirms.length = 0;
  const html = renderToStaticMarkup(
    <EntryActionsOrConfirm
      processed
      rawAvailable
      hasText
      saved={false}
      retrying={false}
      copied={false}
      onCopy={() => calls.push("copy")}
      onCopyRaw={() => calls.push("copyRaw")}
      onToggleSaved={() => calls.push("save")}
      onRetranscribe={() => calls.push("retranscribe")}
      onDelete={() => calls.push("delete")}
      asking={asking}
      onConfirmDelete={() => calls.push("confirmDelete")}
      onCancelDelete={() => calls.push("cancelDelete")}
    />,
  );
  return html;
}

describe("EntryActionsOrConfirm", () => {
  it("entry_delete_asks_first", () => {
    const calls: string[] = [];
    const idle = render(false, calls);
    assert.equal((idle.match(/<button\b/gu) ?? []).length, 5);
    assert.match(idle, /<button[^>]*title="Delete entry"/u);
    assert.equal(confirms.length, 0);

    const asking = render(true, calls);
    assert.equal((asking.match(/<button\b/gu) ?? []).length, 0);
    assert.equal(confirms.length, 1);
    const [confirm] = confirms;
    assert.equal(confirm.message, "Delete this entry and its recording?");
    assert.equal(confirm.action, "Delete entry");
    confirm.onConfirm();
    assert.deepEqual(calls, ["confirmDelete"]);
    confirm.onCancel();
    assert.deepEqual(calls, ["confirmDelete", "cancelDelete"]);
  });
  it("entry_delete_button_asks_and_only_confirm_removes", async () => {
    const shown: boolean[] = [];
    const calls: string[] = [];
    const controls = entryDeleteControls({
      show: (asking) => shown.push(asking),
      remove: () => {
        calls.push("remove");
      },
    });
    controls.onDelete();
    assert.deepEqual(shown, [true]);
    assert.deepEqual(calls, [], "Delete only asks");
    controls.onCancelDelete();
    controls.onConfirmDelete();
    assert.deepEqual(calls, [], "nothing is removed after Cancel");
    controls.onDelete();
    controls.onConfirmDelete();
    controls.onConfirmDelete();
    await Promise.resolve();
    assert.deepEqual(calls, ["remove"]);
    assert.deepEqual(shown, [true, false, true, false]);
  });
});
