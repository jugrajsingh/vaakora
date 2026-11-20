import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import en from "../i18n/locales/en/translation.json";
import {
  DESTINATIONS,
  FIRST_LOCATION,
  LINKS,
  groupAnchor,
  NAV,
  createNavigator,
  defaultStorage,
  labelKey,
  loadLocation,
  normalizeLocation,
  revealGroup,
  rovingTarget,
  visibleTabs,
  type GroupId,
  type Location,
} from "./navigation";

const {
  describe,
  it,
}: {
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => void) => void;
} = createRequire(import.meta.url)("bun:test");

describe("navigation model", () => {
  it("tab_table_matches_the_spec", () => {
    assert.deepEqual(DESTINATIONS, [
      "dictation",
      "readAloud",
      "models",
      "settings",
    ]);
    assert.deepEqual(visibleTabs("settings", false), [
      "general",
      "advanced",
      "about",
    ]);
    assert.deepEqual(visibleTabs("settings", true), [
      "general",
      "advanced",
      "about",
      "debug",
    ]);
    assert.deepEqual(visibleTabs("readAloud", false), [
      "history",
      "settings",
      "vocabulary",
    ]);
    assert.deepEqual(FIRST_LOCATION, {
      destination: "dictation",
      tab: "history",
    });
  });

  it("normalize_falls_back_for_unknown_values", () => {
    for (const raw of [
      null,
      "models",
      42,
      {},
      { destination: "tts" },
      { destination: "__proto__", tab: "history" },
    ]) {
      assert.deepEqual(normalizeLocation(raw, false), FIRST_LOCATION);
    }
    assert.deepEqual(
      normalizeLocation({ destination: "dictation", tab: "vocabulary" }, false),
      { destination: "dictation", tab: "history" },
    );
    const kept = normalizeLocation(
      { destination: "models", tab: "readAloud", extra: 1 },
      false,
    );
    assert.deepEqual(kept, { destination: "models", tab: "readAloud" });
    assert.equal("extra" in kept, false);
  });

  it("debug_tab_waits_for_debug_mode", () => {
    const loaded = loadLocation({
      getItem: () => '{"destination":"settings","tab":"debug"}',
    });
    assert.deepEqual(loaded, { destination: "settings", tab: "debug" });
    assert.deepEqual(normalizeLocation(loaded, false), {
      destination: "settings",
      tab: "general",
    });
    assert.deepEqual(normalizeLocation(loaded, true), {
      destination: "settings",
      tab: "debug",
    });
  });

  it("storage_failures_never_throw", () => {
    assert.deepEqual(loadLocation(undefined), FIRST_LOCATION);
    assert.deepEqual(
      loadLocation({
        getItem: () => {
          throw new Error("denied");
        },
      }),
      FIRST_LOCATION,
    );
    assert.deepEqual(
      loadLocation({ getItem: () => "{not json" }),
      FIRST_LOCATION,
    );
    const received: Location[] = [];
    const navigator = createNavigator({
      storage: {
        setItem: () => {
          throw new Error("full");
        },
      },
      set: (location) => received.push(location),
      reveal: () => {},
    });
    assert.doesNotThrow(() => navigator.navigate(LINKS.cleanup));
    assert.deepEqual(received, [
      { destination: LINKS.cleanup.destination, tab: LINKS.cleanup.tab },
    ]);
  });

  it("navigate_sets_then_saves", () => {
    const calls: unknown[][] = [];
    const navigator = createNavigator({
      storage: { setItem: (key, value) => calls.push(["setItem", key, value]) },
      set: (location) => calls.push(["set", location]),
      reveal: (group) => calls.push(["reveal", group]),
    });
    navigator.navigate(LINKS.readAloudModels);
    assert.deepEqual(calls, [
      ["set", LINKS.readAloudModels],
      ["reveal", null],
      [
        "setItem",
        "handy.navigation",
        '{"destination":"models","tab":"readAloud"}',
      ],
    ]);
  });

  it("links_are_valid_locations", () => {
    for (const value of Object.values(LINKS)) {
      assert.deepEqual(normalizeLocation(value, false), {
        destination: value.destination,
        tab: value.tab,
      });
    }
  });

  it("dictation_settings_is_a_valid_location", () => {
    assert.deepEqual(visibleTabs("dictation", false), [
      "history",
      "settings",
      "cleanup",
    ]);
    assert.deepEqual(
      normalizeLocation({ destination: "dictation", tab: "settings" }, false),
      { destination: "dictation", tab: "settings" },
    );
    const withGroup = normalizeLocation(
      { destination: "dictation", tab: "settings", group: "languages" },
      false,
    );
    assert.deepEqual(withGroup, { destination: "dictation", tab: "settings" });
    assert.equal("group" in withGroup, false);
  });

  it("navigate_reveals_the_link_group_without_saving_it", () => {
    const sets: Location[] = [];
    const reveals: (GroupId | null)[] = [];
    const saved: [string, string][] = [];
    const navigator = createNavigator({
      storage: { setItem: (key, value) => saved.push([key, value]) },
      set: (location) => sets.push(location),
      reveal: (group) => reveals.push(group),
    });
    navigator.navigate(LINKS.languages);
    assert.deepEqual(sets, [{ destination: "dictation", tab: "settings" }]);
    assert.equal("group" in sets[0], false);
    assert.deepEqual(reveals, ["languages"]);
    assert.deepEqual(saved, [
      ["handy.navigation", '{"destination":"dictation","tab":"settings"}'],
    ]);
    navigator.navigate(LINKS.dictationHistory);
    assert.deepEqual(reveals, ["languages", null]);
  });

  it("reveal_scrolls_to_a_found_group_else_top", () => {
    const scrolls: unknown[] = [];
    const asked: string[] = [];
    let tops = 0;
    const found = {
      scrollIntoView: (options?: ScrollIntoViewOptions) =>
        scrolls.push(options),
    };
    const top = () => {
      tops += 1;
    };
    revealGroup("languages", {
      find: (id) => {
        asked.push(id);
        return id === "group-languages" ? found : null;
      },
      top,
    });
    assert.deepEqual(scrolls, [{ block: "start" }]);
    assert.equal(tops, 0);
    assert.deepEqual(asked, ["group-languages"]);

    revealGroup("languages", { find: () => null, top });
    assert.equal(tops, 1);
    assert.deepEqual(scrolls, [{ block: "start" }]);

    asked.length = 0;
    revealGroup(null, {
      find: (id) => {
        asked.push(id);
        return found;
      },
      top,
    });
    assert.equal(tops, 2);
    assert.deepEqual(asked, []);
    assert.deepEqual(scrolls, [{ block: "start" }]);
  });

  it("retention_links_reveal_their_groups", () => {
    assert.deepEqual(LINKS.dictationRetention, {
      destination: "dictation",
      tab: "settings",
      group: "dictationHistory",
    });
    assert.deepEqual(LINKS.readAloudRetention, {
      destination: "readAloud",
      tab: "settings",
      group: "readAloudHistory",
    });
    for (const link of [LINKS.dictationRetention, LINKS.readAloudRetention]) {
      assert.deepEqual(
        normalizeLocation(link, false),
        { destination: link.destination, tab: link.tab },
        "a valid location",
      );
    }
    assert.equal(groupAnchor("dictationHistory"), "group-dictationHistory");
    assert.equal(groupAnchor("readAloudHistory"), "group-readAloudHistory");
    const source = (path: string) =>
      readFileSync(new URL(path, import.meta.url), "utf8");
    assert.ok(
      source("../components/settings/dictation/DictationSettings.tsx").includes(
        'id={groupAnchor("dictationHistory")}',
      ),
      "DictationSettings carries the dictationHistory anchor",
    );
    assert.ok(
      source("../components/settings/tts/SettingsPage.tsx").includes(
        'id={groupAnchor("readAloudHistory")}',
      ),
      "SettingsPage carries the readAloudHistory anchor",
    );
    const sets: Location[] = [];
    const reveals: (GroupId | null)[] = [];
    const navigator = createNavigator({
      storage: undefined,
      set: (location) => sets.push(location),
      reveal: (group) => reveals.push(group),
    });
    navigator.navigate(LINKS.dictationRetention);
    navigator.navigate(LINKS.readAloudRetention);
    assert.deepEqual(sets, [
      { destination: "dictation", tab: "settings" },
      { destination: "readAloud", tab: "settings" },
    ]);
    assert.deepEqual(reveals, ["dictationHistory", "readAloudHistory"]);
  });

  it("rovingTarget_moves_and_wraps", () => {
    assert.equal(rovingTarget(4, 0, "ArrowDown", "vertical", false), 1);
    assert.equal(rovingTarget(4, 0, "ArrowUp", "vertical", false), 3);
    assert.equal(rovingTarget(4, 3, "ArrowDown", "vertical", false), 0);
    assert.equal(rovingTarget(3, 1, "Home", "horizontal", false), 0);
    assert.equal(rovingTarget(3, 1, "End", "horizontal", false), 2);
    assert.equal(rovingTarget(3, 1, "ArrowDown", "horizontal", false), null);
    assert.equal(rovingTarget(3, 1, "Enter", "vertical", false), null);
  });

  it("rtl_swaps_left_and_right", () => {
    assert.equal(rovingTarget(3, 1, "ArrowRight", "horizontal", false), 2);
    assert.equal(rovingTarget(3, 1, "ArrowRight", "horizontal", true), 0);
    assert.equal(rovingTarget(3, 1, "ArrowLeft", "horizontal", true), 2);
  });

  it("default_storage_is_window_local_storage_or_undefined", () => {
    const scope = globalThis as { window?: unknown };
    const had = Object.prototype.hasOwnProperty.call(scope, "window");
    const previous = scope.window;
    try {
      delete scope.window;
      assert.equal(defaultStorage(), undefined, "no window");
      scope.window = {
        get localStorage(): Storage {
          throw new Error("SecurityError");
        },
      };
      assert.equal(defaultStorage(), undefined, "throwing getter");
      const storage = { getItem: () => null } as unknown as Storage;
      scope.window = { localStorage: storage };
      assert.equal(defaultStorage(), storage, "the window's own storage");
    } finally {
      if (had) scope.window = previous;
      else delete scope.window;
    }
  });

  it("label_keys_name_nav_strings", () => {
    assert.equal(labelKey("dictation"), "nav.dictation");
    assert.equal(labelKey("readAloud"), "nav.readAloud");
    assert.equal(labelKey("cleanup"), "nav.cleanup");
    assert.equal(labelKey("debug"), "nav.debug");
    const ids = new Set<string>(DESTINATIONS);
    for (const tabs of Object.values(NAV)) {
      for (const tab of tabs) ids.add(tab);
    }
    const strings: Record<string, unknown> = en.nav;
    for (const id of ids) {
      const [, key] = labelKey(id).split(".");
      assert.equal(typeof strings[key], "string", labelKey(id));
    }
  });
});
