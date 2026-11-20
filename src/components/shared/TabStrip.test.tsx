import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import en from "../../i18n/locales/en/translation.json";
import { createRequire } from "node:module";
const {
  mock,
  test,
}: {
  mock: { module: (name: string, factory: () => unknown) => void };
  test: (name: string, run: () => void) => void;
} = createRequire(import.meta.url)("bun:test");
mock.module("@/i18n", () => ({ default: i18next }));
const { TabStrip, stripKey } = await import("./TabStrip");
const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: en } } });

const tabs = ["history", "settings", "vocabulary"] as const;

function render(): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <TabStrip
        label="Read aloud"
        tabs={tabs}
        active="settings"
        select={() => {}}
        rtl={false}
      />
    </I18nextProvider>,
  );
}

function buttons(html: string): string[] {
  return html.match(/<button[^>]*>.*?<\/button>/g) ?? [];
}

test("renders_one_tablist_with_roving_focus", () => {
  const html = render();
  assert.equal(html.match(/role="tablist"/g)?.length, 1);
  assert.match(html, /role="tablist" aria-label="Read aloud"/);
  const rows = buttons(html);
  assert.equal(rows.length, 3);
  const expected = [
    ["history", "History", false],
    ["settings", "Settings", true],
    ["vocabulary", "Vocabulary", false],
  ] as const;
  expected.forEach(([tab, text, active], i) => {
    const row = rows[i];
    assert.match(row, /role="tab"/);
    assert.match(row, new RegExp(`id="nav-tab-${tab}"`));
    assert.match(row, /aria-controls="nav-panel"/);
    assert.match(row, new RegExp(`aria-selected="${active}"`));
    assert.match(row, new RegExp(`tabindex="${active ? 0 : -1}"`));
    assert.match(row, new RegExp(`>${text}</button>$`));
  });
});

test("inactive_tabs_use_ink_2", () => {
  const history = buttons(render())[0];
  const classes = (history.match(/class="([^"]*)"/)?.[1] ?? "").split(/\s+/);
  assert.ok(classes.includes("text-ink-2"));
  assert.ok(!classes.includes("text-ink-3"));
});

test("strip_keys_select_and_focus", () => {
  const calls: string[] = [];
  const deps = {
    select: (tab: (typeof tabs)[number]) => calls.push(`select ${tab}`),
    focus: (index: number) => calls.push(`focus ${index}`),
  };
  assert.equal(stripKey("ArrowRight", tabs, "history", false, deps), true);
  assert.deepEqual(calls, ["select settings", "focus 1"]);
  calls.length = 0;
  assert.equal(stripKey("ArrowRight", tabs, "history", true, deps), true);
  assert.deepEqual(calls, ["select vocabulary", "focus 2"]);
  calls.length = 0;
  assert.equal(stripKey("a", tabs, "history", false, deps), false);
  assert.deepEqual(calls, []);
});
