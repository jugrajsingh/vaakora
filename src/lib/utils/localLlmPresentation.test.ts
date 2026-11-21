import assert from "node:assert/strict";
import type { LocalLlmModelInfo } from "@/bindings";
import { cleanupHost, promptControls } from "./localLlmPresentation";

const model: LocalLlmModelInfo = {
  id: "s1-mini-q4km",
  display_name: "S1-mini",
  downloaded: true,
  attribution: "Superwhisper",
  card_url: "https://superwhisper.com",
  license: "Apache-2.0",
  license_url: "https://example.com/license",
  license_note: null,
  size_bytes: 484219808,
  prompt_style: "s1_control_line",
  source: null,
};
for (const [providerId, baseUrl, expected] of [
  ["openai", "https://api.openai.com/v1", "api.openai.com"],
  ["custom", "http://localhost:11434/v1", "localhost:11434"],
  ["local_llm", "local-llm://in-app", null],
  ["apple_intelligence", "apple-intelligence://local", null],
  ["custom", "", null],
  ["custom", "not a url", null],
  ["custom", "file:///tmp/x", null],
] as const) {
  assert.equal(cleanupHost(providerId, baseUrl), expected, baseUrl);
}
console.log("cleanupHost: all assertions passed");

const prompts = [
  { id: "p", name: "Prompt", prompt: "Return prose. ${output}" },
];
const plain = { ...model, prompt_style: "plain_system_prompt" as const };
assert.deepEqual(promptControls("local_llm", undefined, prompts, null), {
  hidePrompts: true,
  showS1Controls: false,
  missingPrompt: false,
});
assert.deepEqual(promptControls("openai", undefined, prompts, null), {
  hidePrompts: false,
  showS1Controls: false,
  missingPrompt: false,
});
assert.deepEqual(promptControls("local_llm", model, prompts, "p"), {
  hidePrompts: true,
  showS1Controls: true,
  missingPrompt: false,
});
assert.deepEqual(promptControls("local_llm", plain, prompts, "p"), {
  hidePrompts: false,
  showS1Controls: false,
  missingPrompt: false,
});
for (const selected of [null, "missing"]) {
  assert.equal(
    promptControls("local_llm", plain, prompts, selected).missingPrompt,
    true,
  );
}
for (const text of ["", " \n\t ", " ${output} "]) {
  assert.equal(
    promptControls("local_llm", plain, [{ ...prompts[0], prompt: text }], "p")
      .missingPrompt,
    true,
  );
}
assert.equal(promptControls("openai", model, prompts, "p").hidePrompts, false);
assert.equal(
  promptControls("local_llm", null, prompts, null).hidePrompts,
  false,
);
console.log("promptControls: all assertions passed");
