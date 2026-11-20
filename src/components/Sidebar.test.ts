import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import en from "../i18n/locales/en/translation.json";
import { DESTINATIONS } from "@/lib/navigation";
import { Sidebar, sidebarKey } from "./Sidebar";

const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: en } } });
const html = renderToStaticMarkup(
  React.createElement(
    I18nextProvider,
    { i18n },
    React.createElement(Sidebar, { active: "readAloud", navigate: () => {} }),
  ),
);

// four_destinations_in_order
const buttons = html.match(/<button\b[^>]*>.*?<\/button>/gs) ?? [];
assert.equal(buttons.length, 4, html);
for (const button of buttons) {
  assert.ok(button.startsWith('<button type="button"'), button);
}
assert.deepEqual(
  buttons.map((button) => button.replace(/<[^>]*>/g, "")),
  ["Dictation", "Read aloud", "Models", "Settings"],
);
assert.deepEqual(
  buttons.map((button) => button.includes('aria-current="page"')),
  [false, true, false, false],
);
console.log("four_destinations_in_order");

// sidebar_is_160px
const root = html.match(/^<nav class="([^"]*)"/)?.[1].split(/\s+/) ?? [];
assert.ok(root.includes("w-40"), `w-40 in ${root.join(" ")}`);
assert.ok(!root.includes("w-60"), `no w-60 in ${root.join(" ")}`);
console.log("sidebar_is_160px");

// sidebar_keys_move_focus_vertically: Up and Down wrap, Home and End jump, other keys stay with the button.
const focused: number[] = [];
const key = (name: string, current: number) =>
  sidebarKey(name, current, (index) => focused.push(index));
assert.equal(key("ArrowDown", 0), true);
assert.equal(key("ArrowDown", 3), true);
assert.equal(key("ArrowUp", 0), true);
assert.equal(key("End", 1), true);
assert.equal(key("Home", 2), true);
assert.deepEqual(focused, [1, 0, 3, 3, 0]);
for (const other of ["ArrowLeft", "ArrowRight", "Enter", " ", "Tab"]) {
  assert.equal(key(other, 1), false, other);
}
assert.deepEqual(focused, [1, 0, 3, 3, 0]);
console.log("sidebar_keys_move_focus_vertically");

// icons_unique: one distinct icon per destination, read from the icon table.
const source = readFileSync(new URL("./Sidebar.tsx", import.meta.url), "utf8");
const start = source.indexOf("const ICONS");
const table = source.slice(start, source.indexOf("};", start));
const icons = [...table.matchAll(/^ {2}(\w+): (\w+),$/gm)].map(
  ([, id, icon]) => ({ id, icon }),
);
assert.deepEqual(
  icons.map(({ id }) => id),
  [...DESTINATIONS],
);
assert.equal(new Set(icons.map(({ icon }) => icon)).size, icons.length);
console.log(`sidebar icons unique across ${icons.length} destinations`);

// destinations_are_buttons: no div carries a click handler.
assert.doesNotMatch(source, /<div\b[^>]*\bonClick=/, "no div carries onClick");
console.log("sidebar destinations are buttons");
