import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import en from "../../../i18n/locales/en/translation.json";
import de from "../../../i18n/locales/de/translation.json";
import { createRequire } from "node:module";
import type { LLMPrompt, LocalLlmModelInfo } from "@/bindings";
import type { PromptDialogProps } from "./PromptDialog";
const {
  describe,
  it,
  mock,
}: {
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => void | Promise<void>) => void;
  mock: { module: (name: string, factory: () => unknown) => void };
} = createRequire(import.meta.url)("bun:test");

mock.module("@/i18n", () => ({ default: i18next }));

const llmModel = (prompt_style: LocalLlmModelInfo["prompt_style"]) =>
  ({
    id: "local-a",
    display_name: "Local A",
    downloaded: true,
    prompt_style,
  }) as LocalLlmModelInfo;
let llmModels: LocalLlmModelInfo[] = [];
const stored: Record<string, unknown> = {};
mock.module("@/hooks/useSettings", () => ({
  useSettings: () => ({
    getSetting: (key: string) => stored[key],
    updateSetting: async () => {},
    isUpdating: () => false,
    refreshSettings: async () => refreshed(),
  }),
}));
// What a settings refresh does; the delete test makes it publish the backend's new selection.
let refreshed = async () => {};
const deleted: string[] = [];
const realBindings = await import("@/bindings");
mock.module("@/bindings", () => ({
  ...realBindings,
  commands: {
    deletePostProcessPrompt: async (id: string) => {
      deleted.push(id);
      return { status: "ok", data: null };
    },
  },
}));
// The dialog state of the prompts component is read and set through `dialogState`, and the
// dialog itself is replaced by a recorder of the props it is given.
let dialogState: unknown = null;
let takeDialogState = false;
const realReact = await import("react");
const realUseState = realReact.useState;
mock.module("react", () => ({
  ...realReact,
  useState: <S,>(initial: S | (() => S)) => {
    if (takeDialogState && initial === null) {
      takeDialogState = false;
      return [
        dialogState,
        (next: unknown) => {
          dialogState = next;
        },
      ];
    }
    return realUseState(initial);
  },
}));
const realDialog = await import("./PromptDialog");
let shown: PromptDialogProps | undefined;
mock.module("@/components/settings/post-processing/PromptDialog", () => ({
  ...realDialog,
  PromptDialog: (props: PromptDialogProps) => {
    shown = props;
    return null;
  },
}));
type ButtonProps = Parameters<
  typeof import("@/components/ui/Button").Button
>[0];
const buttons: ButtonProps[] = [];
const { Button: RealButton } = await import("@/components/ui/Button");
mock.module("@/components/ui/Button", () => ({
  Button: (props: ButtonProps) => {
    buttons.push(props);
    return RealButton(props);
  },
}));

const noop = () => {};
const baseState = {
  providerOptions: [
    { value: "openai", label: "OpenAI" },
    { value: "custom", label: "Custom" },
    { value: "local_llm", label: "Local (in-app)" },
    { value: "apple_intelligence", label: "Apple Intelligence" },
  ],
  selectedProviderId: "openai",
  selectedProvider: { id: "openai" },
  isCustomProvider: false,
  isAppleProvider: false,
  appleIntelligenceUnavailable: false,
  baseUrl: "",
  handleBaseUrlChange: noop,
  isBaseUrlUpdating: false,
  apiFormat: "openai",
  handleApiFormatChange: noop,
  isApiFormatUpdating: false,
  apiKey: "",
  handleApiKeyChange: noop,
  isApiKeyUpdating: false,
  model: "",
  handleModelChange: noop,
  modelOptions: [],
  isModelUpdating: false,
  isFetchingModels: false,
  handleProviderSelect: noop,
  handleModelSelect: noop,
  handleModelCreate: noop,
  handleRefreshModels: noop,
};
let state: Record<string, unknown> = baseState;
mock.module(
  "@/components/settings/PostProcessingSettingsApi/usePostProcessProviderState",
  () => ({ usePostProcessProviderState: () => state }),
);
let loadState: "loading" | "loaded" | "failed" = "loaded";
const selectedIds: string[] = [];
const realLocalLlm = await import(
  "@/components/settings/post-processing/LocalLlmSettings"
);
mock.module("@/components/settings/post-processing/LocalLlmSettings", () => ({
  ...realLocalLlm,
  LOCAL_LLM_PROVIDER_ID: "local_llm",
  LocalLlmSettings: () => <div data-marker="LocalLlmSettings" />,
  useLocalLlmModels: () => ({
    models: llmModels,
    loadState,
    reloadChecked: async () => {},
  }),
  useLocalLlmActions: () => ({
    actions: {
      select: async (id: string) => {
        selectedIds.push(id);
      },
    },
    deletingId: null,
    error: null,
  }),
}));
const {
  PostProcessingSettings,
  PostProcessingSettingsPrompts,
  CleanupModelSelect,
} = await import("./PostProcessingSettings");
const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: en } } });

function render(
  provider: string,
  baseUrl: string,
  models: LocalLlmModelInfo[] = [],
  manage: () => void = () => {},
  opts: { selected?: string | null; i18n?: typeof i18n } = {},
): string {
  buttons.length = 0;
  state = {
    ...baseState,
    selectedProviderId: provider,
    selectedProvider: { id: provider },
    isCustomProvider: provider === "custom",
    isAppleProvider: provider === "apple_intelligence",
    baseUrl,
  };
  llmModels = models;
  stored.post_process_provider_id = provider;
  stored.local_llm_model_id =
    "selected" in opts ? opts.selected : models[0]?.id;
  stored.post_process_prompts = [
    { id: "p1", name: "Clean up", prompt: "Fix the text.\n${output}" },
  ];
  stored.post_process_selected_prompt_id = "p1";
  return renderToStaticMarkup(
    <I18nextProvider i18n={opts.i18n ?? i18n}>
      <PostProcessingSettings manage={manage} />
    </I18nextProvider>,
  );
}
function renderPrompts() {
  shown = undefined;
  buttons.length = 0;
  takeDialogState = true;
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <PostProcessingSettingsPrompts />
    </I18nextProvider>,
  );
}
const groupTitles = (html: string) =>
  [...html.matchAll(/<h2[^>]*>(.*?)<\/h2>/g)].map((match) => match[1]);
const rowTitles = (html: string) =>
  [...html.matchAll(/<h3[^>]*>(.*?)<\/h3>/g)].map((match) => match[1]);

describe("PostProcessingSettings", () => {
  it("groups_are_provider_instructions_local_model", () => {
    const html = render("local_llm", "local-llm://in-app", [
      llmModel("plain_system_prompt"),
    ]);
    assert.deepEqual(groupTitles(html), [
      "Provider",
      "Instructions",
      "Local model",
    ]);
    const prompts = html.indexOf("Selected Prompt");
    assert.ok(
      html.indexOf(">Instructions</h2>") < prompts &&
        prompts < html.indexOf(">Local model</h2>"),
      "the prompt controls sit inside Instructions",
    );
    assert.ok(
      html.indexOf(">Local model</h2>") <
        html.indexOf('data-marker="LocalLlmSettings"'),
      "the model list sits in the Local model group",
    );
    assert.ok(!html.includes('role="note"'));
  });

  it("local_model_group_shows_the_model_row_and_no_model_list", () => {
    const second = { ...llmModel("plain_system_prompt"), id: "local-b" };
    const html = render("local_llm", "local-llm://in-app", [
      llmModel("plain_system_prompt"),
      { ...second, display_name: "Local B" },
    ]);
    assert.deepEqual(groupTitles(html), [
      "Provider",
      "Instructions",
      "Local model",
    ]);
    const group = html.slice(html.indexOf(">Local model</h2>"));
    assert.ok(group.includes(">Model</h3>"), "the Model row");
    assert.ok(group.includes("More information"), "its help trigger");
    assert.ok(group.includes("Local A"), "the selected model is shown");
    assert.equal(html.includes("data-confirm-row"), false, "no model list");
    for (const word of [
      ">Use</button>",
      ">Download</button>",
      ">Delete</button>",
    ]) {
      assert.equal(html.includes(word), false, word);
    }
    assert.equal(
      groupTitles(html).filter((title) => title === "Local model").length,
      1,
      "no group inside the group",
    );
  });

  it("manage_models_calls_the_passed_manage", () => {
    let calls = 0;
    render(
      "local_llm",
      "local-llm://in-app",
      [llmModel("plain_system_prompt")],
      () => {
        calls += 1;
      },
    );
    const manage = buttons.find(
      (button) => button.children === "Manage models",
    );
    assert.ok(manage, "the Model row offers Manage models");
    manage.onClick?.({} as never);
    assert.equal(calls, 1);
  });

  it("no_model_downloaded_shows_the_empty_state_with_choose_a_model", () => {
    let calls = 0;
    const html = render("local_llm", "local-llm://in-app", [], () => {
      calls += 1;
    });
    assert.ok(html.includes("No cleanup model yet."));
    assert.equal(html.includes('data-marker="LocalLlmSettings"'), false);
    const choose = buttons.find(
      (button) => button.children === "Choose a model",
    );
    assert.ok(choose);
    choose.onClick?.({} as never);
    assert.equal(calls, 1);
    loadState = "loading";
    const loading = render("local_llm", "local-llm://in-app", []);
    loadState = "loaded";
    assert.ok(loading.includes("Loading models"));
    assert.equal(loading.includes("No cleanup model yet."), false);
  });

  it("model_select_lists_downloaded_models_and_selects_through_the_actions", () => {
    const a = llmModel("plain_system_prompt");
    const b = { ...a, id: "local-b", display_name: "Local B" };
    const missing = {
      ...a,
      id: "local-c",
      display_name: "Local C",
      downloaded: false,
    };
    const picked: string[] = [];
    const element = CleanupModelSelect({
      models: [a, b, missing],
      selectedId: "local-a",
      busy: false,
      placeholder: "Choose a model",
      onSelect: (id) => picked.push(id),
    });
    assert.deepEqual(element.props.options, [
      { value: "local-a", label: "Local A" },
      { value: "local-b", label: "Local B" },
    ]);
    assert.equal(element.props.selectedValue, "local-a");
    assert.equal(element.props.disabled, false);
    element.props.onSelect("local-b");
    assert.deepEqual(picked, ["local-b"]);
    assert.equal(
      CleanupModelSelect({
        models: [a],
        selectedId: "local-a",
        busy: true,
        placeholder: "Choose a model",
        onSelect: () => {},
      }).props.disabled,
      true,
      "no choosing while a download or delete runs",
    );
  });

  it("model_select_shows_a_translated_placeholder_when_no_downloaded_model_is_selected", async () => {
    const german = i18next.createInstance();
    await german.init({ lng: "de", resources: { de: { translation: de } } });
    const models = [llmModel("plain_system_prompt")];
    const nothingSaved = render(
      "local_llm",
      "local-llm://in-app",
      models,
      () => {},
      {
        selected: null,
        i18n: german,
      },
    );
    const gone = render("local_llm", "local-llm://in-app", models, () => {}, {
      selected: "deleted-model",
      i18n: german,
    });
    const chosen = render("local_llm", "local-llm://in-app", models, () => {}, {
      i18n: german,
    });
    for (const [name, html] of [
      ["no saved model", nothingSaved],
      ["saved model is gone", gone],
    ]) {
      assert.ok(html.includes(">Modell wählen</span>"), name);
      assert.equal(html.includes("Select an option"), false, name);
      assert.equal(html.includes("Local A"), false, "nothing is auto-selected");
    }
    assert.ok(chosen.includes(">Local A</span>"), "a saved model still shows");
    assert.equal(chosen.includes("Select an option"), false);
  });

  it("remote_provider_has_no_local_model_group_and_names_the_host", () => {
    const html = render("openai", "https://api.openai.com/v1");
    assert.deepEqual(groupTitles(html), ["Provider", "Instructions"]);
    assert.ok(!html.includes('data-marker="LocalLlmSettings"'));
    const note = html.match(/<p role="note"[^>]*>(.*?)<\/p>/);
    assert.equal(
      note?.[1],
      "Dictations are sent to api.openai.com for cleanup.",
    );
    assert.ok(
      html.indexOf('role="note"') < html.indexOf(">API Key</h3>"),
      "the destination line precedes the API key row",
    );
    assert.deepEqual(rowTitles(html).slice(0, 2), ["Provider", "API Key"]);
  });

  it("custom_provider_names_its_host_with_port", () => {
    const html = render("custom", "http://localhost:11434/v1");
    assert.ok(
      html.includes("Dictations are sent to localhost:11434 for cleanup."),
    );
    assert.ok(
      html.indexOf('role="note"') < html.indexOf(">Base URL</h3>"),
      "the destination line precedes the remote fields",
    );
  });

  it("apple_shows_no_destination_line", () => {
    const html = render("apple_intelligence", "apple-intelligence://local");
    assert.ok(!html.includes('role="note"'));
    assert.deepEqual(groupTitles(html), ["Provider", "Instructions"]);
  });

  it("s1_note_sits_in_the_local_model_group", () => {
    const html = render("local_llm", "local-llm://in-app", [
      llmModel("s1_control_line"),
    ]);
    assert.deepEqual(groupTitles(html), ["Provider", "Local model"]);
    assert.ok(!html.includes("Selected Prompt"));
    assert.ok(
      html.indexOf('data-marker="LocalLlmSettings"') <
        html.indexOf("uses its own fixed prompt"),
      "the note follows the model controls inside the group",
    );
    assert.ok(
      html.indexOf(">Local model</h2>") <
        html.indexOf("uses its own fixed prompt"),
    );
  });

  it("prompt_row_has_edit_and_new_prompt_and_no_inline_editor", () => {
    const html = render("openai", "https://api.openai.com/v1");
    const buttons = [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map(
      (match) => match[1],
    );
    assert.ok(buttons.includes("Edit"), "Edit sits beside the Prompt list");
    assert.ok(buttons.includes("New prompt"));
    assert.ok(!html.includes("Update Prompt"));
    assert.ok(!html.includes("Delete Prompt"));
    assert.ok(!html.includes("Create Prompt"));
    assert.ok(!html.includes("Prompt Instructions"), "no inline editor");
    assert.ok(
      html.indexOf("Clean up") < html.indexOf(">Edit</button>") &&
        html.indexOf(">Edit</button>") < html.indexOf(">New prompt</button>"),
      "the list, then Edit, then New prompt",
    );
  });

  it("successful_delete_closes_the_editor_when_the_refresh_selects_another_prompt", async () => {
    const tidy: LLMPrompt = { id: "p1", name: "Tidy", prompt: "Fix." };
    const other: LLMPrompt = { id: "p2", name: "Other", prompt: "Shorten." };
    stored.post_process_provider_id = "openai";
    stored.post_process_prompts = [tidy, other];
    stored.post_process_selected_prompt_id = "p1";
    dialogState = null;
    deleted.length = 0;
    renderPrompts();
    buttons
      .find((button) => button.children === "Edit")
      ?.onClick?.({} as never);
    renderPrompts();
    const opened = shown;
    assert.equal(opened?.prompt?.id, "p1", "Edit opens the selected prompt");
    // The backend selects the remaining prompt, and the refresh publishes it before delete resolves.
    refreshed = async () => {
      stored.post_process_prompts = [other];
      stored.post_process_selected_prompt_id = "p2";
      renderPrompts();
    };
    let result = "pending";
    await realDialog.settlePrompt(
      () => opened?.remove?.() ?? Promise.resolve(false),
      {
        live: () => shown?.prompt?.id === opened?.prompt?.id,
        done: () => {
          opened?.close();
          result = "closed";
        },
        failed: () => {
          result = "failed";
        },
      },
    );
    refreshed = async () => {};
    assert.deepEqual(deleted, ["p1"]);
    assert.equal(result, "closed", "the delete outcome reaches its own editor");
    renderPrompts();
    assert.equal(dialogState, null, "the dialog mode is closed");
    assert.equal(
      shown,
      undefined,
      "no editor is shown for the remaining prompt",
    );
  });
});
