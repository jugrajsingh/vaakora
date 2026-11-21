import assert from "node:assert/strict";
import {
  formatKeyCombination,
  getKeyName,
  keycapLabel,
  keycapLabels,
} from "./keyboard";

const keyboardEvent = (value: { code?: string; key?: string }): KeyboardEvent =>
  value as KeyboardEvent;

const compoundKeys = [
  ["ScrollLock", "scrolllock", "Scroll Lock"],
  ["CapsLock", "capslock", "Caps Lock"],
  ["NumLock", "numlock", "Num Lock"],
  ["PageUp", "pageup", "Page Up"],
  ["PageDown", "pagedown", "Page Down"],
  ["PrintScreen", "printscreen", "Print Screen"],
] as const;

for (const [code, stored, displayed] of compoundKeys) {
  assert.equal(getKeyName(keyboardEvent({ code })), stored);
  assert.equal(formatKeyCombination(stored, "linux"), displayed);
}

assert.equal(getKeyName(keyboardEvent({ key: "CapsLock" })), "capslock");
assert.equal(
  getKeyName(keyboardEvent({ code: "AudioVolumeUp" })),
  "audiovolumeup",
);

assert.deepEqual(keycapLabels("super+alt+d", "linux"), ["Super", "Alt", "D"]);
assert.equal(
  keycapLabel("super+alt+d", "linux"),
  formatKeyCombination("super+alt+d", "linux"),
);
assert.equal(keycapLabel("super+alt+d", "linux"), "Super + Alt + D");
assert.deepEqual(keycapLabels("super+alt+d", "windows"), ["⊞", "Alt", "D"]);
assert.deepEqual(keycapLabels("super+alt+d", "macos"), ["⌘", "⌥", "D"]);
assert.deepEqual(keycapLabels("meta+space", "linux"), ["Super", "Space"]);
console.log("keyboard: linux_names_super");

console.log("keyboard: all assertions passed");
