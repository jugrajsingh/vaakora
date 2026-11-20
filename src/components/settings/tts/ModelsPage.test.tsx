import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import en from "../../../i18n/locales/en/translation.json";
import type { DeviceRating, TtsModelInfo } from "@/bindings";
import type { DownloadSnapshot } from "./actions";
import {
  openChange,
  pageActions,
  pageLife,
  type PageDeps,
} from "./pageActions";
import { createTokenPresence, tokenEntry, type TokenEntryState } from "./token";
import {
  ReadAloudRows,
  VoiceList,
  applyFor,
  askedFor,
  completeRating,
  legendMachine,
  presentFor,
  runOutcome,
  runsAccelerated,
  type DeleteView,
  type ReadAloudRowsProps,
} from "./ReadAloudRows";

const {
  describe,
  it,
}: {
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => Promise<void> | void) => void;
} = createRequire(import.meta.url)("bun:test");

const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: en } } });

const supported: DeviceRating = {
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

function info(id: string, patch: Partial<TtsModelInfo> = {}): TtsModelInfo {
  return {
    id,
    display_name: id,
    license: "CC-BY-4.0",
    attribution: "Voice attribution",
    card_url: "https://huggingface.co/example/model",
    recommended: false,
    needs_token: false,
    size_bytes: 295738958,
    voices: ["alba", "marius"],
    default_voice: "alba",
    downloaded: true,
    downloading: false,
    npu_driver_too_old: false,
    active: false,
    rating: {
      quality: 9,
      devices: {
        cpu: supported,
        gpu: { ...supported, supported: false, recommended: false },
        npu: { ...supported, recommended: false },
      },
    },
    run_on: "auto",
    preparation: { state: "idle" },
    languages: ["en"],
    measured: { machine: "Test laptop", date: "2026-11-08" },
    memory_bytes: {},
    sources: [],
    ...patch,
  };
}

const pocket = info("pocket-en", {
  display_name: "Pocket TTS",
  needs_token: true,
  active: true,
});
const kokoro = info("kokoro-82m-int8", { display_name: "Kokoro" });
const supertonic = info("supertonic-3", {
  display_name: "Supertonic 3",
  downloaded: false,
});

const emptyToken: TokenEntryState = {
  visible: false,
  draft: "",
  pending: false,
  error: null,
};
const tokenActions = tokenEntry(createTokenPresence(), async () => true);

const idle: DownloadSnapshot = {
  active: [],
  progress: {},
  error: null,
  errors: {},
};

const props = (
  patch: Partial<ReadAloudRowsProps> = {},
): ReadAloudRowsProps => ({
  models: [pocket, kokoro, supertonic],
  available: ["cpu", "gpu", "npu"],
  downloads: idle,
  deletingId: null,
  tokenSet: false,
  tokenState: emptyToken,
  tokenActions,
  deletion: {
    asking: null,
    ask: () => {},
    cancel: () => {},
    confirm: () => {},
  },
  asked: null,
  openId: null,
  onOpenChange: () => {},
  act: {
    use: () => {},
    download: () => {},
    cancel: () => {},
    runOn: () => {},
    preview: async () => {},
    ask: () => {},
  },
  ...patch,
});

function render(patch: Partial<ReadAloudRowsProps> = {}): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <ReadAloudRows {...props(patch)} />
    </I18nextProvider>,
  );
}

/** One row's markup: from its `data-row` to the next row or the end. */
function rowOf(html: string, id: string): string {
  const start = html.indexOf(`data-row="${id}"`);
  assert.ok(start >= 0, `row ${id} is rendered`);
  const next = html.indexOf('data-row="', start + 1);
  return html.slice(start, next < 0 ? undefined : next);
}

/** The opening tag of the button carrying this aria-label, or undefined. */
function buttonLabelled(html: string, label: string): string | undefined {
  return html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0];
}

/** The `disabled` attribute itself; the class list also spells "disabled:". */
const isDisabled = (tag: string | undefined): boolean =>
  tag !== undefined && /\sdisabled=""/.test(tag);

const BUSY = "Wait for the current download or delete to finish.";
const TOKEN = "Needs a Hugging Face token. Add it in the details.";

describe("Models, Read aloud rows", () => {
  it("read_marks_follow_row_actions", () => {
    const busy = render({ downloads: { ...idle, active: ["supertonic-3"] } });
    const select = buttonLabelled(
      rowOf(busy, "kokoro-82m-int8"),
      "Select Kokoro",
    );
    assert.ok(select, "a downloaded model offers Select");
    assert.ok(isDisabled(select), select);
    assert.ok(select.includes(`title="${BUSY}"`), select);

    const idleHtml = render();
    const free = buttonLabelled(
      rowOf(idleHtml, "kokoro-82m-int8"),
      "Select Kokoro",
    );
    assert.ok(free && !isDisabled(free), free);
    const download = buttonLabelled(
      rowOf(idleHtml, "supertonic-3"),
      "Download Supertonic 3",
    );
    assert.ok(download && !isDisabled(download), download);

    const gated = info("pocket-en", {
      display_name: "Pocket TTS",
      needs_token: true,
      downloaded: false,
    });
    const noToken = render({ models: [gated, kokoro] });
    const blocked = buttonLabelled(
      rowOf(noToken, "pocket-en"),
      "Download Pocket TTS",
    );
    assert.ok(isDisabled(blocked), blocked);
    assert.ok(blocked?.includes(`title="${TOKEN}"`), blocked);
    const withToken = render({ models: [gated, kokoro], tokenSet: true });
    const open = buttonLabelled(
      rowOf(withToken, "pocket-en"),
      "Download Pocket TTS",
    );
    assert.ok(open && !isDisabled(open), open);

    const row = rowOf(busy, "supertonic-3");
    const cancel = buttonLabelled(row, "Stop downloading Supertonic 3");
    assert.ok(cancel && !isDisabled(cancel), cancel);
    assert.ok(!buttonLabelled(row, "Download Supertonic 3"));

    const selected = rowOf(idleHtml, "pocket-en");
    assert.ok(!buttonLabelled(selected, "Select Pocket TTS"));
    assert.ok(!selected.includes("Stop downloading"));
  });

  it("failed_download_shows_its_translated_error_and_retries", () => {
    const html = render({
      downloads: { ...idle, errors: { "supertonic-3": "tts.errors.download" } },
    });
    const row = rowOf(html, "supertonic-3");
    assert.ok(row.includes(en.tts.errors.download), row);
    assert.ok(
      buttonLabelled(row, "Download Supertonic 3"),
      "Retry is the download mark",
    );
  });

  it("downloading_row_shows_progress_and_size", () => {
    const html = render({
      downloads: {
        ...idle,
        active: ["supertonic-3"],
        progress: {
          "supertonic-3": {
            model_id: "supertonic-3",
            downloaded_bytes: 42,
            total_bytes: 100,
          },
        },
      },
    });
    assert.ok(
      rowOf(html, "supertonic-3").includes("Downloading 42% of 296 MB"),
    );
  });

  it("sections_split_on_this_computer_from_available", () => {
    const html = render();
    const onThisComputer = html.indexOf('data-section="downloaded"');
    const available = html.indexOf('data-section="available"');
    assert.ok(onThisComputer >= 0 && available > onThisComputer);
    const downloaded = html.slice(onThisComputer, available);
    assert.ok(downloaded.includes('data-row="pocket-en"'));
    assert.ok(downloaded.includes('data-row="kokoro-82m-int8"'));
    assert.ok(!downloaded.includes('data-row="supertonic-3"'));
    assert.ok(html.slice(available).includes('data-row="supertonic-3"'));
    assert.ok(html.includes("On this computer"));
    assert.ok(html.includes(">Available<"));
  });

  it("read_delete_rechecks_at_confirm", () => {
    const removed: string[] = [];
    const base: DeleteView = {
      asked: { id: "kokoro-82m-int8", selected: false },
      models: [pocket, kokoro, supertonic],
      active: [],
      deletingId: null,
    };
    let view: DeleteView = base;
    const present = presentFor(() => view);
    const apply = applyFor(
      () => view,
      (id) => removed.push(id),
    );

    assert.equal(present("kokoro-82m-int8"), true, "an idle, downloaded model");
    apply("kokoro-82m-int8");
    assert.deepEqual(removed, ["kokoro-82m-int8"], "Confirm deletes it once");

    removed.length = 0;
    view = { ...base, active: ["supertonic-3"] };
    assert.equal(present("kokoro-82m-int8"), false, "a download started");
    apply("kokoro-82m-int8");
    view = { ...base, deletingId: "pocket-en" };
    assert.equal(present("kokoro-82m-int8"), false, "another delete runs");
    apply("kokoro-82m-int8");
    view = { ...base, models: [pocket, supertonic] };
    assert.equal(present("kokoro-82m-int8"), false, "the model is gone");
    apply("kokoro-82m-int8");
    view = { ...base, asked: null };
    assert.equal(present("kokoro-82m-int8"), false, "no question asked");
    apply("kokoro-82m-int8");
    view = { ...base, asked: { id: "pocket-en", selected: true } };
    apply("kokoro-82m-int8");
    assert.deepEqual(removed, [], "every blocked Confirm deleted nothing");
  });

  it("read_delete_closes_when_the_selection_changes_under_it", () => {
    const removed: string[] = [];
    const remove = (id: string) => removed.push(id);
    // Asked while Pocket was selected; the tray then selected Kokoro.
    let view: DeleteView = {
      asked: { id: "pocket-en", selected: true },
      models: [
        info("pocket-en", { active: false }),
        info("kokoro-82m-int8", { active: true }),
      ],
      active: [],
      deletingId: null,
    };
    assert.equal(presentFor(() => view)("pocket-en"), false);
    applyFor(() => view, remove)("pocket-en");
    // Asked while Kokoro was not selected; the tray then selected it.
    view = { ...view, asked: { id: "kokoro-82m-int8", selected: false } };
    assert.equal(presentFor(() => view)("kokoro-82m-int8"), false);
    applyFor(() => view, remove)("kokoro-82m-int8");
    assert.deepEqual(removed, [], "neither stale question deletes");
    // Asked again for the model that is selected now, the question holds.
    view = { ...view, asked: { id: "kokoro-82m-int8", selected: true } };
    assert.equal(presentFor(() => view)("kokoro-82m-int8"), true);
  });

  it("read_select_failure_keeps_the_selection", async () => {
    const seen: (string | null)[] = [];
    const steps: string[] = [];
    const deps = {
      refresh: async () => {
        steps.push("refresh");
      },
      refreshSettings: async () => {
        steps.push("settings");
      },
      show: (error: string | null) => seen.push(error),
    };
    const failed = await runOutcome(
      Promise.resolve({ status: "error", error: "tts.errors.busy" } as const),
      deps,
    );
    assert.equal(failed, false);
    assert.deepEqual(steps, [], "a failed select reloads nothing");
    assert.deepEqual(seen, ["tts.errors.busy"], "the error is shown once");

    seen.length = 0;
    await runOutcome(Promise.reject(new Error("boom")), deps);
    assert.deepEqual(steps, []);
    assert.deepEqual(
      seen,
      ["tts.errors.generic"],
      "an unknown failure is generic",
    );

    seen.length = 0;
    const ok = await runOutcome(
      Promise.resolve({ status: "ok", data: null } as const),
      deps,
    );
    assert.equal(ok, true);
    assert.deepEqual(steps, ["refresh", "settings"]);
    assert.deepEqual(seen, [null], "success clears the error");

    const html = render({ models: [pocket, kokoro] });
    assert.ok(
      rowOf(html, "pocket-en").includes("data-selected"),
      "the previous model stays selected",
    );
    assert.ok(!rowOf(html, "kokoro-82m-int8").includes("data-selected"));
  });

  it("listen_only_on_the_selected_model", () => {
    const selectedOpen = rowOf(render({ openId: "pocket-en" }), "pocket-en");
    for (const voice of pocket.voices) {
      assert.ok(
        buttonLabelled(selectedOpen, `Listen to ${voice}`),
        `Listen to ${voice}`,
      );
    }
    assert.ok(selectedOpen.includes("2 voices"));

    const other = info("supertonic-3", {
      display_name: "Supertonic 3",
      voices: ["M1", "F1"],
    });
    const otherOpen = rowOf(
      render({ models: [pocket, other], openId: "supertonic-3" }),
      "supertonic-3",
    );
    assert.ok(otherOpen.includes("M1") && otherOpen.includes("F1"), otherOpen);
    assert.ok(
      !otherOpen.includes("Listen to"),
      "no Listen on a model that is not selected",
    );

    const remote = rowOf(render({ openId: "supertonic-3" }), "supertonic-3");
    assert.ok(!remote.includes("Listen to"));
  });

  it("listen_press_previews_that_voice", () => {
    const heard: string[] = [];
    const buttons: { onClick: () => void; label: string }[] = [];
    const walk = (node: React.ReactNode): void => {
      if (!React.isValidElement(node)) return;
      const element = node as React.ReactElement<{
        children?: React.ReactNode;
        onClick?: () => void;
        "aria-label"?: string;
      }>;
      if (element.type === "button" && element.props.onClick) {
        buttons.push({
          onClick: element.props.onClick,
          label: element.props["aria-label"] ?? "",
        });
      }
      React.Children.forEach(element.props.children, walk);
    };
    walk(
      VoiceList({
        voices: ["alba", "marius"],
        preview: async (voice) => {
          heard.push(voice);
        },
        t: i18n.t.bind(i18n),
      }),
    );
    assert.deepEqual(
      buttons.map((button) => button.label),
      ["Listen to alba", "Listen to marius"],
    );
    buttons[1].onClick();
    assert.deepEqual(heard, ["marius"], "one press previews one voice");
  });

  it("run_on_shows_in_the_details_of_downloaded_models_only", () => {
    const open = rowOf(
      render({ openId: "kokoro-82m-int8" }),
      "kokoro-82m-int8",
    );
    assert.ok(
      open.includes("<select"),
      "Run on control for a downloaded model",
    );
    const remote = rowOf(render({ openId: "supertonic-3" }), "supertonic-3");
    assert.ok(!remote.includes("<select"));
    assert.ok(
      !remote.includes(">Run on</dt>"),
      "no Run on row before the download",
    );
  });

  it("details_list_the_seven_read_aloud_labels", () => {
    const open = rowOf(render({ openId: "pocket-en" }), "pocket-en");
    for (const label of [
      "Languages",
      "Run on",
      "Memory",
      "Measured on",
      "Voices",
      "Licence",
      "Source",
    ]) {
      assert.ok(open.includes(`>${label}</dt>`), label);
    }
    assert.ok(open.includes("Test laptop, 2026-11-08"));
  });

  it("token_field_only_in_the_gated_row", () => {
    const gated = info("pocket-en", {
      display_name: "Pocket TTS",
      needs_token: true,
      downloaded: false,
    });
    const models = [gated, kokoro, supertonic];
    const fields = (html: string) =>
      html.split("data-tts-token-field").length - 1;
    const open = rowOf(render({ models, openId: "pocket-en" }), "pocket-en");
    assert.equal(fields(open), 1, "the gated row shows one field");
    assert.ok(open.includes('type="password"'));
    assert.ok(
      open.includes('autoComplete="off"') ||
        open.includes('autocomplete="off"'),
    );
    assert.ok(open.includes('spellcheck="false"'));
    const whole = render({ models, openId: "pocket-en" });
    assert.equal(fields(whole), 1, "no other row shows one");
    for (const id of ["supertonic-3", "kokoro-82m-int8"]) {
      const other = render({ models, openId: id });
      assert.equal(fields(other), 0, `${id} open shows no field`);
    }
    assert.equal(fields(render({ models })), 0, "a collapsed row shows none");
    const downloadedModels = [{ ...gated, downloaded: true }, kokoro];
    const downloadedWithout = render({
      models: downloadedModels,
      openId: "pocket-en",
      tokenSet: false,
    });
    assert.equal(
      fields(downloadedWithout),
      0,
      "a downloaded gated model without a token shows none",
    );
    const downloadedWith = render({
      models: downloadedModels,
      openId: "pocket-en",
      tokenSet: true,
    });
    assert.equal(
      fields(downloadedWith),
      1,
      "a downloaded gated model with a token keeps one field",
    );
    const kept = rowOf(downloadedWith, "pocket-en");
    assert.ok(kept.includes("Token set"));
    assert.ok(kept.includes(">Clear token</button>"));
    const keptOther = render({
      models: downloadedModels,
      openId: "kokoro-82m-int8",
      tokenSet: true,
    });
    assert.equal(fields(keptOther), 0, "no other row shows a field");
  });

  it("token_field_labels_and_presence", () => {
    const gated = info("pocket-en", { needs_token: true, downloaded: false });
    const open = (patch: Partial<ReadAloudRowsProps>) =>
      rowOf(
        render({ models: [gated], openId: "pocket-en", ...patch }),
        "pocket-en",
      );
    const without = open({});
    assert.ok(without.includes("Hugging Face token"));
    assert.ok(
      without.includes(
        "Accept the voice terms on Hugging Face first. The token is kept in memory until Handy restarts.",
      ),
    );
    assert.ok(without.includes(">Set token</button>"));
    assert.ok(without.includes(">Clear token</button>"));
    assert.ok(without.includes(">Show token</button>"));
    assert.ok(without.includes("Needs a Hugging Face token"));
    assert.ok(!without.includes("Token set"));
    const withToken = open({ tokenSet: true });
    assert.ok(withToken.includes("Token set"));
    const shown = open({ tokenState: { ...emptyToken, visible: true } });
    assert.ok(shown.includes('type="text"'));
    assert.ok(shown.includes(">Hide token</button>"));
  });

  it("token_value_never_rendered", () => {
    const draft: TokenEntryState = { ...emptyToken, draft: "hf_secret" };
    const gated = info("pocket-en", { needs_token: true, downloaded: false });
    const cases = [
      { downloaded: false, tokenSet: false },
      { downloaded: false, tokenSet: true },
      { downloaded: true, tokenSet: true },
    ];
    for (const { downloaded, tokenSet } of cases) {
      const html = rowOf(
        render({
          models: [{ ...gated, downloaded }],
          openId: "pocket-en",
          tokenState: draft,
          tokenSet,
        }),
        "pocket-en",
      );
      const outsideInput = html.replace(/<input[^>]*>/g, "");
      assert.ok(
        !outsideInput.includes("hf_secret"),
        "only the input holds the draft",
      );
      assert.ok(
        /<input[^>]*type="password"[^>]*value="hf_secret"|<input[^>]*value="hf_secret"[^>]*type="password"/.test(
          html,
        ),
      );
    }
    const closed = render({ models: [gated], tokenState: draft });
    assert.ok(
      !closed.includes("hf_secret"),
      "a collapsed row renders no draft",
    );
  });

  it("collapsing_or_switching_the_row_discards_the_draft", () => {
    const opened: (string | null)[] = [];
    const entry = tokenEntry(createTokenPresence(), async () => true);
    const change = openChange(entry.hide, (id) => opened.push(id));
    entry.edit("hf_secret");
    change(null);
    assert.equal(entry.snapshot().draft, "", "collapse clears the draft");
    assert.deepEqual(opened, [null]);
    entry.edit("hf_secret");
    change("kokoro-82m-int8");
    assert.equal(
      entry.snapshot().draft,
      "",
      "opening another row clears the draft",
    );
    assert.deepEqual(opened, [null, "kokoro-82m-int8"]);
  });

  it("advanced_has_no_token_row", () => {
    const here = new URL(".", import.meta.url).pathname;
    const src = join(here, "..", "..", "..");
    const needle = ["HfToken", "Setting"].join("");
    const advanced = readFileSync(
      join(src, "components/settings/advanced/AdvancedSettings.tsx"),
      "utf8",
    );
    assert.ok(!advanced.includes(needle), "Advanced has no token row");
    const hits = (
      readdirSync(src, { recursive: true, encoding: "utf8" }) as string[]
    )
      .filter((file) => /\.(ts|tsx)$/.test(file))
      .filter((file) => readFileSync(join(src, file), "utf8").includes(needle));
    assert.deepEqual(hits, []);
  });

  it("delete_trash_hides_while_a_download_or_delete_runs", () => {
    const idleRow = rowOf(render(), "kokoro-82m-int8");
    assert.ok(buttonLabelled(idleRow, "Delete Kokoro"));
    const downloading = rowOf(
      render({ downloads: { ...idle, active: ["supertonic-3"] } }),
      "kokoro-82m-int8",
    );
    assert.ok(!buttonLabelled(downloading, "Delete Kokoro"));
    const deleting = rowOf(
      render({ deletingId: "pocket-en" }),
      "kokoro-82m-int8",
    );
    assert.ok(!buttonLabelled(deleting, "Delete Kokoro"));
    assert.ok(
      buttonLabelled(rowOf(render(), "pocket-en"), "Delete Pocket TTS"),
      "the selected model can be deleted after its question",
    );
  });

  it("delete_question_names_what_goes_and_the_consequence", () => {
    const t = i18n.t.bind(i18n);
    const selected = askedFor(
      t,
      { ...pocket, display_name: "Pocket TTS" },
      true,
    );
    assert.deepEqual(
      { id: selected.id, selected: selected.selected },
      { id: "pocket-en", selected: true },
    );
    assert.equal(
      selected.message,
      "Delete Pocket TTS? It frees 296 MB. Read aloud stops working until you choose another model. Your vocabulary and history are kept.",
    );
    const other = askedFor(t, kokoro, false);
    assert.equal(
      other.message,
      "Delete Kokoro? It frees 296 MB. Your vocabulary and history are kept.",
    );
    const unknown = askedFor(t, { ...kokoro, size_bytes: 0 }, false);
    assert.ok(!unknown.message.includes("frees"), unknown.message);

    const asking = {
      asking: "pocket-en",
      ask: () => {},
      cancel: () => {},
      confirm: () => {},
    };
    const html = rowOf(
      render({ deletion: asking, asked: selected }),
      "pocket-en",
    );
    assert.ok(html.includes(">Delete model</button>"), html);
    assert.ok(html.includes("Read aloud stops working"), html);
    assert.ok(
      !buttonLabelled(html, "Delete Pocket TTS"),
      "the question replaces the trash",
    );
    const unasked = rowOf(
      render({ deletion: asking, asked: null }),
      "pocket-en",
    );
    assert.ok(!unasked.includes("Delete model"), "no snapshot, no question");
  });

  it("accelerated_chip_needs_a_supported_available_device", () => {
    const all = ["cpu", "gpu", "npu"] as const;
    const gpuOk = info("a", {
      rating: {
        quality: 9,
        devices: {
          cpu: supported,
          gpu: supported,
          npu: { ...supported, supported: false },
        },
      },
    });
    assert.equal(runsAccelerated(gpuOk, all), true);
    assert.equal(runsAccelerated(gpuOk, ["cpu"]), false, "no GPU here");
    assert.equal(
      runsAccelerated(pocket, ["cpu", "gpu"]),
      false,
      "GPU unsupported",
    );
    assert.equal(runsAccelerated(pocket, all), true, "NPU supported and here");
    assert.equal(
      runsAccelerated({ ...pocket, npu_driver_too_old: true }, all),
      false,
      "an NPU whose driver is too old does not count",
    );
    assert.ok(render().includes(">GPU or NPU<"), "the chip shows");
  });

  it("legend_names_one_machine_or_none", () => {
    assert.equal(legendMachine([pocket, kokoro]), "Test laptop");
    assert.equal(
      legendMachine([
        pocket,
        info("x", { measured: { machine: "Other", date: "2026-11-09" } }),
      ]),
      null,
    );
    assert.equal(legendMachine([info("y", { measured: null })]), null);
  });

  it("cards_are_gone", () => {
    const html = render({ openId: "pocket-en" });
    assert.ok(!html.includes("data-tts-model"));
    assert.ok(!html.includes("border-2"));
    assert.ok(!html.includes("<article"));
  });

  it("complete_rating_rejects_a_missing_device", () => {
    assert.throws(
      () =>
        completeRating({
          ...pocket,
          rating: { quality: 9, devices: { cpu: supported } },
        }),
      /invalidRatings/,
    );
  });
});

/** A promise settled by hand, to land an outcome after the page is gone. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>((done) => setTimeout(done, 0));

function page(patch: Partial<PageDeps> = {}) {
  const log: string[] = [];
  const life = pageLife();
  const deps: PageDeps = {
    models: async () => [kokoro],
    devices: async () => ["cpu", "npu"],
    refreshDownloads: async () => {
      log.push("downloads");
    },
    refreshSettings: async () => {
      log.push("settings");
    },
    setModels: (models) => log.push(`models:${models.length}`),
    setAvailable: (devices) => log.push(`devices:${devices.join("+")}`),
    setError: (error) => log.push(`error:${error}`),
    setDeletingId: (id) => log.push(`deleting:${id}`),
    deleteModel: async () => ({ status: "ok", data: null }),
    speak: async () => {},
    ...patch,
  };
  return { log, life, actions: pageActions(life, deps) };
}

describe("Models, Read aloud page lifetime", () => {
  it("select_success_landing_after_disposal_applies_nothing", async () => {
    const live = page();
    const job = deferred<{ status: "ok"; data: null }>();
    const run = live.actions.run(job.promise);
    live.life.dispose();
    job.resolve({ status: "ok", data: null });
    assert.equal(await run, true);
    assert.deepEqual(
      live.log,
      ["settings"],
      "no model list, no error clear: only the store refresh runs",
    );
  });

  it("select_success_while_mounted_applies_the_new_state", async () => {
    const live = page();
    await live.actions.run(Promise.resolve({ status: "ok", data: null }));
    assert.deepEqual(live.log, ["models:1", "settings", "error:null"]);
  });

  it("select_failure_landing_after_disposal_shows_no_error", async () => {
    const rejected = page();
    const job = deferred<{ status: "ok"; data: null }>();
    const run = rejected.actions.run(job.promise);
    rejected.life.dispose();
    job.reject(new Error("tts.errors.busy"));
    assert.equal(await run, false);
    assert.deepEqual(rejected.log, []);

    const failed = page();
    const result = deferred<{ status: "error"; error: string }>();
    const second = failed.actions.run(result.promise);
    failed.life.dispose();
    result.resolve({ status: "error", error: "tts.errors.busy" });
    await second;
    assert.deepEqual(failed.log, []);

    const mounted = page();
    await mounted.actions.run(
      Promise.resolve({ status: "error", error: "tts.errors.busy" } as const),
    );
    assert.deepEqual(mounted.log, ["error:tts.errors.busy"]);
  });

  it("delete_success_landing_after_disposal_leaves_the_page_alone", async () => {
    const job = deferred<{ status: "ok"; data: null }>();
    const live = page({ deleteModel: () => job.promise });
    live.actions.remove("kokoro-82m-int8");
    assert.deepEqual(
      live.log,
      ["deleting:kokoro-82m-int8"],
      "busy starts at once",
    );
    live.life.dispose();
    job.resolve({ status: "ok", data: null });
    await flush();
    assert.deepEqual(
      live.log,
      ["deleting:kokoro-82m-int8", "settings"],
      "no refresh, no error, the busy mark is not cleared on a gone page",
    );
  });

  it("delete_while_mounted_clears_the_busy_mark_after_the_refresh", async () => {
    const live = page();
    live.actions.remove("kokoro-82m-int8");
    await flush();
    assert.deepEqual(live.log, [
      "deleting:kokoro-82m-int8",
      "models:1",
      "settings",
      "error:null",
      "deleting:null",
    ]);
  });

  it("delete_rejection_landing_after_disposal_applies_nothing", async () => {
    const job = deferred<{ status: "ok"; data: null }>();
    const live = page({ deleteModel: () => job.promise });
    live.actions.remove("kokoro-82m-int8");
    live.life.dispose();
    job.reject(new Error("boom"));
    await flush();
    assert.deepEqual(live.log, ["deleting:kokoro-82m-int8"]);
  });

  it("poll_landing_after_disposal_applies_nothing", async () => {
    const models = deferred<TtsModelInfo[]>();
    const live = page({ models: () => models.promise });
    const update = live.actions.update();
    live.life.dispose();
    models.resolve([kokoro]);
    await update;
    assert.deepEqual(
      live.log,
      ["downloads"],
      "only the download controller refreshes",
    );

    const failing = deferred<TtsModelInfo[]>();
    const broken = page({ models: () => failing.promise });
    const next = broken.actions.update();
    broken.life.dispose();
    failing.reject(new Error("boom"));
    await next;
    assert.deepEqual(broken.log, []);

    const mounted = page({
      models: async () => Promise.reject(new Error("boom")),
    });
    await mounted.actions.update();
    assert.deepEqual(mounted.log, ["error:tts.errors.generic"]);
  });

  it("devices_landing_after_disposal_are_dropped", async () => {
    const devices = deferred<("cpu" | "gpu" | "npu")[]>();
    const live = page({ devices: () => devices.promise });
    live.actions.loadDevices();
    live.life.dispose();
    devices.resolve(["cpu", "gpu"]);
    await flush();
    assert.deepEqual(live.log, []);

    const mounted = page();
    mounted.actions.loadDevices();
    await flush();
    assert.deepEqual(mounted.log, ["devices:cpu+npu"]);
  });

  it("preview_failure_landing_after_disposal_shows_no_error", async () => {
    const speech = deferred<void>();
    const live = page({ speak: () => speech.promise });
    const heard = live.actions.preview("alba");
    live.life.dispose();
    speech.reject(new Error("boom"));
    await heard;
    assert.deepEqual(live.log, []);

    const mounted = page({
      speak: async () => Promise.reject(new Error("boom")),
    });
    await mounted.actions.preview("alba");
    assert.deepEqual(mounted.log, ["error:tts.errors.generic"]);
  });

  it("preview_error_listener_registered_after_disposal_is_stopped_at_once", async () => {
    const stops: string[] = [];
    const registration = deferred<() => void>();
    const live = page();
    const stopWatching = live.actions.watchPreviewErrors(
      () => registration.promise,
    );
    live.life.dispose();
    stopWatching();
    registration.resolve(() => stops.push("stopped"));
    await flush();
    assert.deepEqual(stops, ["stopped"], "stopped when it arrives");
    assert.deepEqual(live.log, []);
  });

  it("preview_error_listener_shows_errors_and_stops_with_the_page", async () => {
    const stops: string[] = [];
    let emit: (payload: string) => void = () => {};
    const live = page();
    const stopWatching = live.actions.watchPreviewErrors(async (listener) => {
      emit = listener;
      return () => stops.push("stopped");
    });
    await flush();
    emit("tts.errors.audio");
    emit("something else");
    assert.deepEqual(live.log, [
      "error:tts.errors.audio",
      "error:tts.errors.generic",
    ]);
    stopWatching();
    assert.deepEqual(stops, ["stopped"], "the page's cleanup stops it once");
    live.life.dispose();
    emit("tts.errors.audio");
    assert.equal(live.log.length, 2, "an event after disposal is ignored");
  });

  it("a_remounted_page_applies_outcomes_again", async () => {
    const live = page();
    live.life.dispose();
    live.life.start();
    await live.actions.update();
    assert.deepEqual(live.log, ["models:1", "downloads"]);
  });
});
