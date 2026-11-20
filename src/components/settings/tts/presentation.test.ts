import assert from "node:assert/strict";
import { runOnChoices } from "./presentation";

assert.deepEqual(runOnChoices(["cpu", "npu"]), ["auto", "cpu", "npu"]);
assert.deepEqual(runOnChoices([]), ["auto"]);
console.log("TTS rating presentation assertions passed");
