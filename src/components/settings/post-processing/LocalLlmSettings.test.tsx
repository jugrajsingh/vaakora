import assert from "node:assert/strict";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import en from "../../../i18n/locales/en/translation.json";
import type { AppSettings, LocalLlmModelInfo } from "@/bindings";
const {
  describe,
  it,
  mock,
}: {
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => Promise<void> | void) => void;
  mock: { module: (name: string, factory: () => unknown) => void };
} = createRequire(import.meta.url)("bun:test");

// Environment shim: `@/i18n` reads locales with a bundler-only glob; every settings test stubs it.
mock.module("@/i18n", () => ({ default: i18next }));
const { LocalLlmSettings, cleanupJobState } = await import(
  "./LocalLlmSettings"
);
const { useSettingsStore } = await import("@/stores/settingsStore");
const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: en } } });

const s1: LocalLlmModelInfo = {
  id: "s1-mini-q4km",
  display_name: "S1-mini",
  attribution: "Superwhisper",
  card_url: "https://superwhisper.com",
  license: "Apache-2.0",
  license_url: "https://example.com/license",
  license_note: null,
  size_bytes: 484_219_808,
  prompt_style: "s1_control_line",
  downloaded: true,
  source: null,
};
const quill: LocalLlmModelInfo = {
  ...s1,
  id: "quill-0-8b-q4km",
  display_name: "Quill 0.8B",
  prompt_style: "plain_system_prompt",
};

function render(
  props: { models?: LocalLlmModelInfo[]; actionError?: string | null } = {},
  selectedId: string | null = s1.id,
): string {
  useSettingsStore.setState({
    settings: {
      post_process_provider_id: "local_llm",
      local_llm_model_id: selectedId,
      post_process_prompts: [],
      post_process_selected_prompt_id: null,
    } as unknown as AppSettings,
  });
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <LocalLlmSettings
        models={props.models ?? [s1, quill]}
        actionError={props.actionError ?? null}
      />
    </I18nextProvider>,
  );
}

describe("LocalLlmSettings", () => {
  it("keeps_status_controls_and_attribution_and_drops_the_model_list", () => {
    const html = render();
    assert.ok(html.includes("Status"), "the status row stays");
    assert.ok(html.includes("Not loaded"));
    assert.ok(html.includes("Styling"), "the S1 controls stay");
    assert.ok(html.includes(">Superwhisper</button>"), "attribution stays");
    assert.equal(html.includes("data-confirm-row"), false, "no model list");
    for (const word of [
      ">Use</button>",
      ">Download</button>",
      ">Delete</button>",
      "Downloaded</span>",
    ]) {
      assert.equal(html.includes(word), false, word);
    }
  });

  it("plain_model_has_no_s1_controls", () => {
    const html = render({}, quill.id);
    assert.equal(html.includes("Styling"), false);
  });

  it("shows_the_action_error_the_page_passes", () => {
    const html = render({ actionError: "select failed" });
    assert.ok(html.includes("Error: select failed"), html);
    assert.equal(render().includes("Error: "), false, "none without an error");
  });

  it("job_state_waits_for_the_list_and_reports_a_failed_load", () => {
    assert.equal(cleanupJobState("loading", []), "loading");
    assert.equal(cleanupJobState("failed", [s1]), "failed");
    assert.equal(cleanupJobState("loaded", []), "empty");
    assert.equal(
      cleanupJobState("loaded", [{ ...s1, downloaded: false }]),
      "empty",
      "a model that is not downloaded does not count",
    );
    assert.equal(cleanupJobState("loaded", [s1, quill]), "ready");
  });
});
