import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import english from "../../../i18n/locales/en/translation.json";
import type { DeviceRating, TtsModelInfo } from "../../../bindings";
import {
  ModelCard,
  completeRating,
  applyModelUse,
  modelCardCallbacks,
  modelDeleteHandlers,
} from "./ModelCard";
import { rowActions } from "./actions";
import { TokenField, tokenCardProps } from "./TokenField";
import { tokenEntry, createTokenPresence } from "./token";
const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: english } } });
const rating: DeviceRating = {
  supported: true,
  placement: { main: "cpu" },
  first_audio_p95_s: 0.5,
  rtf_1x: 0.2,
  rtf_2x: 0.25,
  load_s_cold: 20,
  load_s_cached: 2,
  speed_score: 8,
  recommended: true,
};
const model: TtsModelInfo = {
  id: "pocket-en",
  display_name: "Pocket TTS",
  license: "CC-BY-4.0",
  attribution: "Voice attribution",
  card_url: "https://huggingface.co/kyutai/pocket-tts",
  recommended: true,
  needs_token: true,
  size_bytes: 295738958,
  voices: ["alba"],
  default_voice: "alba",
  downloaded: true,
  downloading: false,
  npu_driver_too_old: false,
  active: true,
  rating: {
    quality: 9,
    devices: {
      cpu: rating,
      gpu: { ...rating, supported: false, recommended: false },
      npu: { ...rating, recommended: false },
    },
  },
  run_on: "auto",
  preparation: {
    state: "preparing",
    device: "npu",
    completed: 1,
    total: 4,
    graph: "decoder",
  },
};
function render(
  value: TtsModelInfo,
  selectedId: string,
  downloadId: string | null = null,
  downloadedBytes?: number,
  tokenSet = false,
  tokenForm?: React.ReactNode,
  downloadError?: string,
) {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <ModelCard
        model={value}
        downloadProgress={
          downloadedBytes === undefined
            ? undefined
            : {
                model_id: value.id,
                downloaded_bytes: downloadedBytes,
                total_bytes: value.size_bytes,
              }
        }
        available={["cpu", "gpu", "npu"]}
        state={{ selectedId, downloadId, deletingId: null }}
        actions={{ use: () => {}, download: () => {}, delete: () => {} }}
        confirming={false}
        confirmDelete={() => {}}
        cancelDelete={() => {}}
        runOn={() => {}}
        cancel={() => {}}
        tokenSet={tokenSet}
        setToken={() => {}}
        tokenEntry={tokenForm}
        downloadError={downloadError}
      />
    </I18nextProvider>,
  );
}
function button(html: string, label: string) {
  const found = [...html.matchAll(/<button([^>]*)>(.*?)<\/button>/g)].find(
    (match) => match[2].replace(/<[^>]*>/g, "") === label,
  );
  assert.ok(found, html);
  return found[1].replace(/class="[^"]*"/g, "");
}
const active = render(model, "pocket-en");
assert.ok(active.includes('data-badge="active"'));
assert.ok(!active.includes("data-token-chip"));
assert.ok(!active.includes('data-badge="recommended"'));
assert.ok(active.includes("border-logo-primary/50 bg-logo-primary/10"));
assert.ok(!button(active, "Delete").includes("disabled"));
assert.ok(active.includes('data-tts-model="pocket-en"'));
assert.ok(active.includes(english.tts.description["pocket-en"]));
assert.ok(active.includes(i18n.t("tts.voiceCount", { count: 1 })));
assert.ok(!active.includes('data-device="gpu"'));
assert.ok(active.includes('value="1"'));
assert.ok(active.includes('max="4"'));
const preparing = active.match(/<div role="status"[^>]*>(.*?)<\/div>/);
assert.ok(preparing, "Preparing status row");
assert.ok(preparing[1].includes("Preparing for NPU: decoder"));
assert.ok(preparing[1].includes('value="1"'));
assert.ok(preparing[1].includes('max="4"'));
for (const [downloaded, selectedId, downloadId, deletingId] of [
  [false, "other", null, null],
  [true, "pocket-en", null, null],
  [true, "other", "other", null],
  [true, "other", null, "other"],
  [true, "other", null, null],
] as const) {
  let calls = 0;
  const row = rowActions(
    { id: model.id, downloaded, needs_token: false },
    { selectedId, downloadId, deletingId },
    { use: () => calls++, download: () => {}, delete: () => {} },
  );
  applyModelUse(row);
  assert.equal(
    calls,
    downloaded &&
      selectedId !== model.id &&
      downloadId === null &&
      deletingId === null
      ? 1
      : 0,
    "composed Use callback count",
  );
}
const missing = render({ ...model, downloaded: false, active: false }, "other");
assert.ok(!missing.includes(">Use</button>"));
assert.ok(button(missing, "Download296 MB").includes("disabled"));
assert.ok(!missing.includes("<select"));
assert.ok(missing.includes('data-token-chip="required"'));
assert.ok(missing.includes('data-badge="recommended"'));
assert.ok(!button(missing, "Set token").includes("disabled"));
// recommended_badge_follows_the_flag
const badgeOf = (value: Partial<TtsModelInfo>) =>
  render({ ...model, active: false, downloaded: false, ...value }, "other");
assert.ok(
  badgeOf({ id: "supertonic-3", recommended: true }).includes(
    'data-badge="recommended"',
  ),
  "a non-Pocket model with the flag shows the badge",
);
assert.ok(
  !badgeOf({ recommended: false }).includes('data-badge="recommended"'),
  "Pocket without the flag shows no badge",
);
const ungatedPocket = badgeOf({ needs_token: false });
assert.ok(
  !ungatedPocket.includes("data-token-chip"),
  "the token chip follows needs_token, not the id",
);
assert.ok(
  badgeOf({ id: "supertonic-3", needs_token: true }).includes(
    'data-token-chip="required"',
  ),
);
const tokenReady = render(
  { ...model, downloaded: false, active: false },
  "other",
  null,
  undefined,
  true,
);
assert.ok(tokenReady.includes('data-token-chip="set"'));
assert.ok(!button(tokenReady, "Download296 MB").includes("disabled"));
const supertonic = render(
  {
    ...model,
    id: "supertonic-3",
    downloaded: false,
    active: false,
    needs_token: false,
  },
  "other",
);
assert.ok(!supertonic.includes("data-token-chip"));
assert.ok(!button(supertonic, "Download296 MB").includes("disabled"));
const ready = render({ ...model, active: false }, "other");
assert.ok(!button(ready, "Use").includes("disabled"));
const select = ready.match(/<select[^>]*>(.*?)<\/select>/);
assert.ok(select);
assert.ok(select[1].includes('<option value="auto"'));
assert.ok(select[1].includes('<option value="cpu"'));
assert.ok(select[1].includes('<option value="npu"'));
assert.ok(!select[1].includes('<option value="gpu"'));
const license = active.match(/<a[^>]*>(.*?)<\/a>/);
assert.ok(license);
assert.ok(license[0].includes(`href="${model.card_url}"`));
assert.ok(license[0].includes('target="_blank"'));
assert.ok(license[0].includes('title="Voice attribution"'));
assert.ok(license[1].includes("CC-BY-4.0"));
const downloading = render(
  { ...model, downloaded: false, active: false },
  "other",
  "pocket-en",
);
assert.ok(downloading.includes('data-badge="downloading"'));
assert.ok(!button(downloading, "Cancel").includes("disabled"));
const progress = render(
  { ...model, downloaded: false },
  "other",
  "pocket-en",
  42,
);
const downloadBar = progress.match(
  /<progress[^>]*aria-label="Model download progress"[^>]*>/,
);
assert.ok(downloadBar, progress);
assert.ok(downloadBar[0].includes('value="42"'));
assert.ok(downloadBar[0].includes('max="295738958"'));
assert.throws(
  () =>
    completeRating({
      ...model,
      rating: { quality: 9, devices: { cpu: rating } },
    }),
  /invalidRatings/,
);
console.log(
  "model card: active/download/cancel/Run on/preparing/hidden-device row assertions passed",
);

const invalidDriver = render(
  {
    ...model,
    npu_driver_too_old: true,
    preparation: { state: "ready", device: "gpu" },
  },
  "pocket-en",
);
assert.ok(!invalidDriver.includes('data-device="npu"'));
assert.ok(invalidDriver.match(/<option value="npu"[^>]*disabled/));
assert.ok(invalidDriver.includes("NPU driver too old"));
console.log(
  "Card states: active preparing, available Pocket without/with token, available Supertonic, downloaded inactive, downloading, progress, invalid NPU passed",
);

const tokenActions = tokenEntry(createTokenPresence(), async () => true);
tokenCardProps({
  entry: tokenActions,
  state: tokenActions.snapshot(),
  present: false,
}).setToken();
assert.equal(
  tokenActions.snapshot().expanded,
  true,
  "Models page Set token callback opens the entry",
);
const field = render(
  { ...model, downloaded: false },
  "other",
  null,
  undefined,
  false,
  <TokenField state={tokenActions.snapshot()} actions={tokenActions} />,
  "tts.errors.tokenRequired",
);
const tokenForm = field.match(
  /<form[^>]*data-tts-token-field[^>]*>(.*?)<\/form>/,
)?.[1];
assert.ok(
  tokenForm?.includes('type="password"'),
  "card token entry defaults to password",
);
assert.ok(
  tokenForm?.includes(english.tts.tokenHelp),
  "card explains memory-only Pocket token",
);
assert.ok(tokenForm?.includes("Clear token"));
assert.ok(tokenForm?.includes("Show token"));
assert.ok(
  field
    .match(/<p role="alert"[^>]*>(.*?)<\/p>/)?.[1]
    .includes(english.tts.errors.tokenRequired),
  "gated download error appears on its card",
);
console.log("token entry and access error render within the Pocket card");

// delete_button_asks_and_confirm_names_the_cost
const deleteCalls: string[] = [];
const deleteProps = {
  confirmDelete: () => deleteCalls.push("confirmDelete"),
  cancelDelete: () => deleteCalls.push("cancelDelete"),
};
const askingRow = rowActions(
  model,
  { selectedId: model.id, downloadId: null, deletingId: null },
  {
    use: () => deleteCalls.push("use"),
    download: () => deleteCalls.push("download"),
    delete: (id) => deleteCalls.push(`ask:${id}`),
  },
);
const handlers = modelDeleteHandlers(askingRow, deleteProps);
handlers.press();
assert.deepEqual(deleteCalls, ["ask:pocket-en"], "Delete asks, never deletes");
handlers.confirm();
handlers.cancel();
assert.deepEqual(deleteCalls, [
  "ask:pocket-en",
  "confirmDelete",
  "cancelDelete",
]);
const renderConfirming = (selectedId: string) =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <ModelCard
        model={{ ...model, active: selectedId === model.id }}
        available={["cpu", "gpu", "npu"]}
        state={{ selectedId, downloadId: null, deletingId: null }}
        actions={{ use: () => {}, download: () => {}, delete: () => {} }}
        confirming
        confirmDelete={() => {}}
        cancelDelete={() => {}}
        runOn={() => {}}
        cancel={() => {}}
      />
    </I18nextProvider>,
  );
const confirmingSelected = renderConfirming(model.id);
assert.ok(
  confirmingSelected.includes("Delete Pocket TTS? It frees 296 MB."),
  confirmingSelected,
);
assert.ok(
  confirmingSelected.includes(
    "Read aloud stops working until you choose another model.",
  ),
);
assert.ok(confirmingSelected.includes(">Delete model</button>"));
assert.ok(!confirmingSelected.includes(">Use</button>"));
assert.ok(!confirmingSelected.includes("<span>Delete</span>"));
const confirmingOther = renderConfirming("other");
assert.ok(confirmingOther.includes("Delete Pocket TTS? It frees 296 MB."));
assert.ok(
  !confirmingOther.includes(
    "Read aloud stops working until you choose another model.",
  ),
);
assert.ok(!confirmingOther.includes(">Use</button>"));
assert.ok(button(active, "Delete"), "idle card keeps its Delete button");
console.log("delete_button_asks_and_confirm_names_the_cost passed");

// models_page_delete_asks_and_drops_a_gone_model
const pageCalls: string[] = [];
const asked: (string | null)[] = [];
let downloadedIds = ["pocket-en", "kokoro"];
const page = modelCardCallbacks({
  use: (id) => pageCalls.push(`use:${id}`),
  download: (id) => pageCalls.push(`download:${id}`),
  remove: (id) => pageCalls.push(`remove:${id}`),
  show: (id) => asked.push(id),
  downloaded: (id) => downloadedIds.includes(id),
});
const pageRow = rowActions(
  model,
  { selectedId: "other", downloadId: null, deletingId: null },
  page.actions,
);
pageRow.delete();
assert.deepEqual(pageCalls, [], "the card's Delete only asks");
assert.deepEqual(asked, ["pocket-en"]);
page.confirmDelete();
page.confirmDelete();
assert.deepEqual(pageCalls, ["remove:pocket-en"], "confirm removes once");
page.actions.delete("kokoro");
page.cancelDelete();
page.confirmDelete();
assert.deepEqual(pageCalls, ["remove:pocket-en"], "nothing after Cancel");
page.actions.delete("kokoro");
downloadedIds = ["pocket-en"];
page.prune();
page.confirmDelete();
assert.deepEqual(
  pageCalls,
  ["remove:pocket-en"],
  "a gone model's question drops",
);
assert.deepEqual(asked, ["pocket-en", null, "kokoro", null, "kokoro", null]);
page.actions.use("kokoro");
page.actions.download("kokoro");
assert.deepEqual(pageCalls.slice(1), ["use:kokoro", "download:kokoro"]);
console.log("models_page_delete_asks_and_drops_a_gone_model passed");
