import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import en from "../../../i18n/locales/en/translation.json";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import type { TtsModelInfo } from "../../../bindings";
const {
  mock,
  test,
}: {
  mock: { module: (name: string, factory: () => unknown) => void };
  test: (name: string, run: () => void) => void;
} = createRequire(import.meta.url)("bun:test");
mock.module("@/i18n", () => ({ default: i18next }));
mock.module("@/hooks/useSettings", () => ({
  useSettings: () => ({
    getSetting: () => undefined,
    isUpdating: () => false,
  }),
}));
// Records every switch's props and renders the real switch as well.
const { Switch: RealSwitch } = await import("@/components/ui/Switch");
const switches: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}[] = [];
mock.module("@/components/ui/Switch", () => ({
  Switch: (props: Parameters<typeof RealSwitch>[0]) => {
    switches.push(props);
    return RealSwitch(props);
  },
}));
const { SettingsControls, loadModels } = await import("./SettingsPage");
const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: en } } });
const supertonic = {
  id: "supertonic-3",
  display_name: "Supertonic",
  downloaded: true,
  voices: ["alba"],
  default_voice: "alba",
} as TtsModelInfo;
const pocket = {
  id: "pocket-en",
  display_name: "Pocket",
  downloaded: false,
  voices: ["alba"],
  default_voice: "alba",
} as TtsModelInfo;
const retention = {
  entries: [],
  refresh: async () => [],
  changeLimit: () => {},
  changeRetention: () => {},
};
test("settings use grouped themed controls", () => {
  const html = renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <SettingsControls
        selected={{
          model_id: "supertonic-3",
          voice: "alba",
          speed: 1,
          pitch: 0,
          output_device: null,
          read_code: false,
          technical: true,
          full_paths: true,
          full_links: false,
        }}
        models={[supertonic]}
        outputDevices={[]}
        error="tts.errors.generic"
        modelsFailed={false}
        change={() => {}}
        preview={() => {}}
        openModels={() => {}}
        retention={retention}
      />
    </I18nextProvider>,
  );
  assert.ok(
    !/<select\b/.test(html),
    "settings use themed dropdowns and switch",
  );
  const checkbox = html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0];
  assert.ok(
    checkbox?.includes('class="sr-only peer"'),
    "code blocks use shared themed ToggleSwitch",
  );
  const speed = html.match(/<input[^>]*aria-label="Speed"[^>]*>/)?.[0];
  assert.ok(
    speed?.includes('class="flex-grow'),
    "speed uses shared styled Slider",
  );
  assert.ok(
    speed?.includes('min="0.5"') &&
      speed.includes('max="2"') &&
      speed.includes('step="0.1"'),
    speed,
  );
  const speedValue = html.match(
    /<input[^>]*aria-label="Speed"[^>]*>(.*?)<\/span>/s,
  )?.[1];
  assert.ok(speedValue?.includes("1.0x"));
  const pitch = html.match(/<input[^>]*aria-label="Pitch"[^>]*>/)?.[0];
  assert.ok(
    pitch?.includes('min="-6"') &&
      pitch.includes('max="6"') &&
      pitch.includes('step="1"'),
    pitch,
  );
  const titles = [...html.matchAll(/<h3[^>]*>(.*?)<\/h3>/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(titles, [
    "Model",
    "Voice",
    "Speed",
    "Pitch",
    "Read-aloud output device",
    "Read code blocks",
    "Technical reading",
    "Read full paths",
    "Read full links",
    "Keep history",
    "Keep the latest",
  ]);
  const alert = html.match(/<div role="alert">(.*?)<\/div>/s)?.[1];
  assert.ok(
    alert?.includes(en.tts.errors.generic) && alert.includes("bg-error-wash"),
  );
  const listen = html.match(/<button[^>]*>Listen<\/button>/)?.[0];
  assert.ok(listen && !listen.includes('disabled=""'), "listen is available");
  assert.ok(!html.includes("Preview voice"));
  console.log(
    "settings layout, themed controls, slider bounds/value and alert assertions passed",
  );
});

function renderControls(
  models: readonly TtsModelInfo[] | null,
  modelId: string,
  modelsFailed = false,
  error: string | null = null,
): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <SettingsControls
        selected={{
          model_id: modelId,
          voice: "alba",
          speed: 1,
          pitch: 0,
          output_device: null,
          read_code: false,
        }}
        models={models}
        outputDevices={[]}
        error={error}
        modelsFailed={modelsFailed}
        change={() => {}}
        preview={() => {}}
        openModels={() => {}}
        retention={retention}
      />
    </I18nextProvider>,
  );
}
const groupTitles = (html: string) =>
  [...html.matchAll(/<h2[^>]*>(.*?)<\/h2>/g)].map((match) => match[1]);
const rowTitles = (html: string) =>
  [...html.matchAll(/<h3[^>]*>(.*?)<\/h3>/g)].map((match) => match[1]);
test("model_group_comes_first", () => {
  const ready = renderControls([pocket, supertonic], "supertonic-3");
  assert.equal(groupTitles(ready)[0], "Model");
  assert.ok(ready.includes("Manage models"));
  assert.ok(ready.includes(">Listen</button>"));
  assert.deepEqual(rowTitles(ready).slice(0, 2), ["Model", "Voice"]);
  assert.ok(
    ready.indexOf("Manage models") < ready.indexOf("Speed"),
    "the Model group precedes the other rows",
  );
  assert.ok(
    /<div class="w-full"><div class="flex items-center gap-2">/.test(ready),
    "Voice is a stacked row",
  );
  const unavailable = renderControls([pocket, supertonic], "pocket-en");
  assert.ok(
    /<button[^>]*disabled=""[^>]*>Listen<\/button>/.test(unavailable),
    "listen unavailable for a model that is not downloaded",
  );

  const loading = renderControls(null, "supertonic-3");
  assert.equal(groupTitles(loading)[0], "Model");
  assert.ok(loading.includes("Loading models"));
  assert.ok(!loading.includes("No read-aloud model yet."));
  assert.ok(!rowTitles(loading).includes("Voice"));
  assert.ok(!loading.includes("Listen"));

  const empty = renderControls([pocket], "pocket-en");
  assert.equal(groupTitles(empty)[0], "Model");
  assert.ok(empty.includes("No read-aloud model yet."));
  assert.ok(empty.includes(">Choose a model</button>"));
  assert.ok(!rowTitles(empty).includes("Voice"));
});

test("failed_model_listing_shows_the_error_not_the_empty_state", () => {
  const failed = renderControls(null, "pocket-en", true);
  assert.equal(groupTitles(failed)[0], "Model");
  const modelGroup = failed.slice(
    failed.indexOf(">Model</h2>"),
    failed.indexOf(">Playback</h2>"),
  );
  const alert = modelGroup.match(/<div role="alert">(.*?)<\/div>/s)?.[1];
  assert.ok(
    alert?.includes(en.tts.errors.generic),
    "the error is in the group",
  );
  for (const text of ["No read-aloud model yet.", "Loading models"]) {
    assert.equal(failed.includes(text), false, text);
  }
  assert.ok(!failed.includes(">Choose a model</button>"));
  assert.ok(!rowTitles(failed).includes("Voice"));
  // A later retention load clears the shared error; the model error stays.
  const afterRetention = renderControls(null, "pocket-en", true, null);
  assert.ok(afterRetention.includes(en.tts.errors.generic));
  assert.ok(!afterRetention.includes("No read-aloud model yet."));
  const ok = renderControls([supertonic], "supertonic-3");
  assert.ok(!ok.includes(en.tts.errors.generic), "no error when listing works");
});

test("loadModels_failure_is_reported_and_never_becomes_an_empty_list", async () => {
  const shown: (readonly TtsModelInfo[])[] = [];
  let failures = 0;
  await loadModels({
    load: async () => {
      throw new Error("listing failed");
    },
    show: (models) => shown.push(models),
    fail: () => (failures += 1),
  });
  assert.equal(failures, 1);
  assert.equal(shown.length, 0);
  await loadModels({
    load: async () => [supertonic],
    show: (models) => shown.push(models),
    fail: () => (failures += 1),
  });
  assert.deepEqual(shown, [[supertonic]]);
  assert.equal(failures, 1);
});

test("groups_are_model_playback_text_handling_history", () => {
  const html = renderControls([pocket, supertonic], "supertonic-3");
  assert.deepEqual(groupTitles(html), [
    "Model",
    "Playback",
    "Text handling",
    "History",
  ]);
  const group = (title: string) => {
    const start = html.indexOf(`>${title}</h2>`);
    const next = groupTitles(html)[groupTitles(html).indexOf(title) + 1];
    return html.slice(start, next ? html.indexOf(`>${next}</h2>`) : undefined);
  };
  assert.deepEqual(rowTitles(group("Playback")), [
    "Speed",
    "Pitch",
    "Read-aloud output device",
  ]);
  assert.deepEqual(rowTitles(group("Text handling")), [
    "Read code blocks",
    "Technical reading",
    "Read full paths",
    "Read full links",
  ]);
  assert.deepEqual(rowTitles(group("History")), [
    "Keep history",
    "Keep the latest",
  ]);
  assert.ok(!html.includes("Clear history"));
  assert.ok(!html.includes("Text-to-speech"));
});

test("output_row_names_the_read_aloud_device", () => {
  const html = renderControls([pocket, supertonic], "supertonic-3");
  assert.ok(html.includes("Read-aloud output device"));
  assert.ok(html.includes("Same as Output Device"), "names the feedback row");
  assert.ok(!html.includes("Same as Handy"));
});

const baseSelection = {
  model_id: "missing",
  voice: "alba",
  speed: 1,
  pitch: 0,
  output_device: null,
  read_code: false,
};
function renderSwitches(selected: Record<string, unknown>) {
  switches.length = 0;
  const changes: Record<string, unknown>[] = [];
  const html = renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <SettingsControls
        selected={{ ...baseSelection, ...selected }}
        models={[]}
        outputDevices={[]}
        error={null}
        modelsFailed={false}
        change={(patch) => changes.push(patch)}
        preview={() => {}}
        openModels={() => {}}
        retention={retention}
      />
    </I18nextProvider>,
  );
  // Read code blocks, Technical reading, Read full paths, Read full links.
  assert.equal(switches.length, 4);
  return {
    html,
    changes,
    readCode: switches[0],
    technical: switches[1],
    paths: switches[2],
    links: switches[3],
  };
}
test("technical reading toggle renders checked from the selection and sends technical", () => {
  const on = renderSwitches({
    technical: true,
    full_paths: true,
    full_links: false,
  });
  assert.equal(on.technical.checked, true);
  assert.equal(on.paths.checked, true);
  assert.equal(on.links.checked, false);
  on.technical.onChange(false);
  assert.deepEqual(on.changes, [{ technical: false }]);
  const off = renderSwitches({
    technical: false,
    full_paths: true,
    full_links: false,
  });
  assert.equal(off.technical.checked, false);
  off.technical.onChange(true);
  assert.deepEqual(off.changes, [{ technical: true }]);
  console.log("technical reading toggle assertions passed");
});
test("full paths and full links send their fields and grey out when technical reading is off", () => {
  const on = renderSwitches({
    technical: true,
    full_paths: false,
    full_links: true,
  });
  assert.equal(on.paths.checked, false);
  assert.equal(on.links.checked, true);
  assert.ok(!on.paths.disabled && !on.links.disabled);
  on.paths.onChange(true);
  on.links.onChange(false);
  assert.deepEqual(on.changes, [{ full_paths: true }, { full_links: false }]);
  const off = renderSwitches({
    technical: false,
    full_paths: true,
    full_links: false,
  });
  assert.equal(off.paths.disabled, true);
  assert.equal(off.links.disabled, true);
  assert.ok(!off.technical.disabled && !off.readCode.disabled);
  console.log("full paths and links toggle assertions passed");
});

test("dependent_rows_are_indented_and_disabled", () => {
  const off = renderSwitches({ technical: false });
  assert.equal(off.paths.disabled, true);
  assert.equal(off.links.disabled, true);
  const wrappers = off.html.split('<div class="ps-6">').slice(1);
  assert.equal(wrappers.length, 2, "two ps-6 wrappers");
  assert.ok(wrappers[0].includes("Read full paths"));
  assert.ok(!wrappers[0].includes("Read full links"));
  assert.ok(wrappers[1].includes("Read full links"));
  const before = off.html.split('<div class="ps-6">')[0];
  assert.ok(
    before.includes("Technical reading"),
    "the parent row is not indented",
  );
  assert.ok(!before.includes("Read full paths"));
  const reason = "Not used when technical reading is off.";
  assert.equal(off.html.split(reason).length - 1, 2, "one reason per row");
  const on = renderSwitches({ technical: true });
  assert.ok(!on.paths.disabled && !on.links.disabled);
  assert.ok(!on.html.includes(reason));
});

const source = (name: string) =>
  readFileSync(new URL(name, import.meta.url), "utf8");
test("page_root_fills_the_column_without_its_own_tabs", () => {
  const page = source("./SettingsPage.tsx");
  const body = page.slice(
    page.indexOf("export function SettingsPage"),
    page.indexOf("export function SettingsControls"),
  );
  const root = body.match(/return \(\s*<div className="([^"]*)"/)?.[1];
  assert.ok(root, "the first element after return ( in SettingsPage");
  const classes = root.split(/\s+/);
  for (const name of ["w-full", "max-w-3xl", "min-w-0"]) {
    assert.ok(classes.includes(name), `${name} in "${root}"`);
  }
  assert.ok(!page.includes("TtsTabs"), "no TtsTabs in SettingsPage.tsx");
  assert.ok(
    !page.includes("useState<TtsTab>"),
    "no useState<TtsTab> in SettingsPage.tsx",
  );
  const history = source("./history/ReadHistoryTab.tsx");
  assert.ok(/<section className="[^"]*\bmax-w-3xl\b/.test(history));
  assert.ok(!history.includes("max-w-5xl"));
  console.log("page root fills the column without its own tabs");
});
