import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import english from "../../../i18n/locales/en/translation.json";
import {
  RunOnControl,
  applyRunOnChoice,
  type RunOnControlProps,
} from "./RunOnControl";
import type { ModelRating, TtsRunOn } from "./presentation";
const supported = {
  supported: true,
  recommended: false,
  speed_score: 5,
  first_audio_p95_s: 0.5,
  rtf_1x: 0.2,
  rtf_2x: 0.3,
  load_s_cold: 2,
  load_s_cached: 1,
  placement: { graph: "cpu" as const },
};
const rating: ModelRating = {
  quality: 8,
  devices: {
    cpu: supported,
    gpu: { ...supported, supported: false },
    npu: supported,
  },
};
const choices: TtsRunOn[] = [];
const input: Pick<
  RunOnControlProps,
  "downloaded" | "invalidNpu" | "available" | "rating" | "change"
> = {
  downloaded: true,
  invalidNpu: false,
  available: ["cpu", "gpu", "npu"],
  rating,
  change: (next) => choices.push(next),
};
assert.equal(applyRunOnChoice(input, "auto"), true);
assert.equal(applyRunOnChoice(input, "npu"), true);
assert.deepEqual(choices, ["auto", "npu"]);
for (const [state, next] of [
  [{ ...input, downloaded: false }, "cpu"],
  [{ ...input, invalidNpu: true }, "npu"],
  [{ ...input, available: ["cpu"] as const }, "npu"],
  [input, "gpu"],
  [input, "invalid"],
] as const) {
  const accepted = applyRunOnChoice(state, next);
  assert.equal(choices.length, 2, `refused ${next} callback count`);
  assert.equal(accepted, false);
}
assert.deepEqual(choices, ["auto", "npu"]);
console.log(
  "Run on action seam: download/driver/visibility/support/unknown guards passed",
);

const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: english } } });
const render = (patch: Partial<RunOnControlProps>) =>
  renderToStaticMarkup(
    React.createElement(
      I18nextProvider,
      { i18n },
      React.createElement(RunOnControl, {
        ...input,
        value: "auto",
        preparation: { state: "idle" },
        ...patch,
      }),
    ),
  );
const preparing = render({
  preparation: {
    state: "preparing",
    device: "npu",
    completed: 1,
    total: 4,
    graph: "decoder",
  },
}).match(/<div role="status"[^>]*>(.*?)<\/div>/);
assert.ok(preparing, "Preparing status row");
assert.ok(preparing[1].includes("Preparing for NPU: decoder"));
assert.ok(preparing[1].includes('value="1"'));
assert.ok(preparing[1].includes('max="4"'));
const select = render({}).match(/<select[^>]*>(.*?)<\/select>/);
assert.ok(select, "Run on select");
assert.ok(select[1].includes('<option value="auto"'));
assert.ok(select[1].includes('<option value="npu"'));
assert.ok(
  !select[1].includes('<option value="gpu"'),
  "unsupported GPU is hidden",
);
assert.ok(
  render({}).includes('<span class="sr-only">Run on</span>'),
  "the row's Run on term names the select, so the control carries no visible label",
);
const oldDriver = render({ invalidNpu: true });
assert.ok(oldDriver.match(/<option value="npu"[^>]*disabled/));
assert.ok(oldDriver.includes("NPU driver too old"));
console.log(
  "Run on control render: preparing status, hidden unsupported device, disabled NPU on an old driver passed",
);
