import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import en from "../../../i18n/locales/en/translation.json";
import { createRequire } from "node:module";
const {
  describe,
  it,
  mock,
}: {
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => void) => void;
  mock: { module: (name: string, factory: () => unknown) => void };
} = createRequire(import.meta.url)("bun:test");

mock.module("@/i18n", () => ({ default: i18next }));
const stored: Record<string, boolean> = {};
const updates: unknown[][] = [];
mock.module("@/hooks/useSettings", () => ({
  useSettings: () => ({
    getSetting: (key: string) => stored[key],
    updateSetting: async (...args: unknown[]) => {
      updates.push(args);
    },
    isUpdating: () => false,
  }),
}));
const manageSeen: (() => void)[] = [];
mock.module("./PostProcessingSettings", () => ({
  PostProcessingSettings: ({ manage }: { manage: () => void }) => {
    manageSeen.push(manage);
    return <div data-marker="post-processing" />;
  },
}));
// Records every switch's props and renders the real switch as well.
const { Switch: RealSwitch } = await import("@/components/ui/Switch");
const switches: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}[] = [];
mock.module("@/components/ui/Switch", () => ({
  Switch: (props: Parameters<typeof RealSwitch>[0]) => {
    switches.push(props);
    return RealSwitch(props);
  },
}));
const { CleanupTab } = await import("./CleanupTab");
const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: en } } });

let manageCalls = 0;
function render(enabled: boolean): string {
  stored.post_process_enabled = enabled;
  manageSeen.length = 0;
  switches.length = 0;
  updates.length = 0;
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <CleanupTab manage={() => (manageCalls += 1)} />
    </I18nextProvider>,
  );
}

describe("CleanupTab", () => {
  it("cleanup_off_shows_only_the_switch", () => {
    const html = render(false);
    assert.ok(html.includes("Clean up dictations"));
    assert.equal(switches.length, 1);
    assert.equal(switches[0].checked, false);
    assert.ok(!html.includes('data-marker="post-processing"'));
  });

  it("cleanup_on_shows_the_settings_below_the_switch", () => {
    const html = render(true);
    const label = html.indexOf("Clean up dictations");
    const marker = html.indexOf('data-marker="post-processing"');
    assert.ok(label >= 0);
    assert.ok(marker > label);
    assert.equal(switches.length, 1);
    assert.equal(switches[0].checked, true);
  });

  it("manage_passes_through_to_the_cleanup_settings", () => {
    manageCalls = 0;
    render(true);
    assert.equal(manageSeen.length, 1);
    manageSeen[0]();
    assert.equal(manageCalls, 1, "Manage models reaches the page's navigate");
    render(false);
    assert.equal(manageSeen.length, 0, "off: no settings, no model row");
  });

  it("switch_writes_post_process_enabled", () => {
    render(false);
    switches[0].onChange(true);
    assert.deepEqual(updates, [["post_process_enabled", true]]);
  });
});
