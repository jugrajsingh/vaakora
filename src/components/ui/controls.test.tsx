import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import * as ts from "typescript";
import ar from "../../i18n/locales/ar/translation.json";
import de from "../../i18n/locales/de/translation.json";
import en from "../../i18n/locales/en/translation.json";
import { endNudgeClass, fillTowards } from "@/lib/utils/rangeFill";
import { AudioPlayer } from "./AudioPlayer";
import { Button } from "./Button";
import { Dropdown } from "./Dropdown";
import { InfoTooltip } from "./InfoTooltip";
import { PathDisplay } from "./PathDisplay";
import { Slider } from "./Slider";
import { TextDisplay } from "./TextDisplay";
const {
  describe,
  it,
}: {
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => Promise<void> | void) => void;
} = createRequire(import.meta.url)("bun:test");

const VARIANTS = [
  "primary",
  "primary-soft",
  "secondary",
  "outline",
  "warning",
  "danger",
  "danger-ghost",
  "ghost",
] as const;

const SOURCE_ROOT = new URL("../../", import.meta.url);

/** The opening tag of the element whose attributes contain `anchor` (the anchor must be unique in the file). */
function openingTag(file: string, anchor: string): string {
  const source = readFileSync(new URL(file, SOURCE_ROOT), "utf8");
  assert.equal(source.split(anchor).length - 1, 1, `${file}: ${anchor}`);
  const at = source.indexOf(anchor);
  const starts = [
    ...source
      .slice(0, at)
      .matchAll(/<(button|summary|select|li|div|input|label)\b/g),
  ];
  const start = starts[starts.length - 1].index;
  let depth = 0;
  let quote = "";
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === quote && source[i - 1] !== "\\") quote = "";
    } else if (c === '"' || (depth > 0 && (c === "'" || c === "`"))) {
      quote = c;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
    } else if (c === ">" && depth === 0 && source[i - 1] !== "=") {
      return source.slice(start, i + 1);
    }
  }
  throw new Error(`${file}: no end of tag after ${anchor}`);
}

function assertRingInsteadOfOutline(name: string, tag: string) {
  assert.ok(tag.includes("outline-none"), `${name}: native outline stays`);
  assert.ok(tag.includes("focus-visible:ring-2"), `${name}: no ring-2`);
  assert.ok(
    tag.includes("focus-visible:ring-logo-primary"),
    `${name}: no ring`,
  );
}

/** Controls that carried neither the ring nor the outline suppression at base; [name, file under src, a unique piece of its opening tag]. */
const PLAIN_CONTROLS: ReadonlyArray<readonly [string, string, string]> = [
  ["Dropdown option", "components/ui/Dropdown.tsx", "key={option.value}"],
  [
    "ModelTable search input",
    "components/shared/modelTable/ModelTable.tsx",
    "ref={searchRef}",
  ],
  ["Dropdown trigger", "components/ui/Dropdown.tsx", "ref={triggerRef}"],
  [
    "LanguageSelector trigger",
    "components/settings/LanguageSelector.tsx",
    "onClick={handleToggle}",
  ],
  [
    "LanguageSelector detector row",
    "components/settings/LanguageSelector.tsx",
    "onClick={detector.download}",
  ],
  [
    "LanguageSelector option",
    "components/settings/LanguageSelector.tsx",
    "handleLanguageSelect(language.value)",
  ],
  [
    "LanguagePicker soft chip",
    "components/shared/LanguagePicker.tsx",
    "onClick={onRemove}",
  ],
  [
    "LanguagePicker chip",
    "components/shared/LanguagePicker.tsx",
    "pe-[6px] text-small",
  ],
  [
    "LanguagePicker option",
    "components/shared/LanguagePicker.tsx",
    "onClick={onPick}",
  ],
  [
    "Welcome script radio",
    "components/onboarding/screens/Welcome.tsx",
    "set({ script: s.id })",
  ],
  [
    "Model picked radio",
    "components/onboarding/screens/Model.tsx",
    "rounded-panel border-[1.5px]",
  ],
  [
    "Model grid radio",
    "components/onboarding/screens/Model.tsx",
    "grid-cols-[18px_minmax(0,1fr)_auto]",
  ],
  [
    "Model row radio",
    "components/onboarding/screens/Model.tsx",
    "relative flex w-full min-w-0 cursor-pointer items-center",
  ],
  [
    "Model show all",
    "components/onboarding/screens/Model.tsx",
    "border-dashed border-line-strong",
  ],
  [
    "ModelMigration toggle",
    "components/onboarding/ModelMigration.tsx",
    "onToggle(retired.id)}\n      onKeyDown",
  ],
  [
    "AppLanguageMenu trigger",
    "components/onboarding/AppLanguageMenu.tsx",
    "ref={triggerRef}",
  ],
  [
    "AppLanguageMenu listbox",
    "components/onboarding/AppLanguageMenu.tsx",
    'role="listbox"',
  ],
  [
    "ShortcutInput Clear",
    "components/settings/ShortcutInput.tsx",
    "disabled={clearState.disabled}",
  ],
  [
    "HistoryActions icon",
    "components/settings/history/HistoryActions.tsx",
    "disabled:text-text/20",
  ],
  [
    "Read history Copy",
    "components/settings/tts/history/ReadHistoryTab.tsx",
    "p-1.5 rounded-md flex items-center justify-center text-ink-2",
  ],
  [
    "HistoryList Change",
    "components/shared/HistoryList.tsx",
    "onClick={change}",
  ],
  [
    "LocalLlm model card",
    "components/settings/post-processing/LocalLlmAttribution.tsx",
    "cardAction(model, open)",
  ],
  [
    "LocalLlm licence",
    "components/settings/post-processing/LocalLlmAttribution.tsx",
    "licenseAction(model, open)",
  ],
  [
    "PreferredLanguages row",
    "components/settings/PreferredLanguages.tsx",
    "aria-pressed={picked}",
  ],
  [
    "PreferredLanguages more",
    "components/settings/PreferredLanguages.tsx",
    "title={moreLabel}",
  ],
  [
    "PreferredLanguages add",
    "components/settings/PreferredLanguages.tsx",
    "ref={addRef}",
  ],
  [
    "KeyboardDiagnostic run",
    "components/settings/debug/KeyboardDiagnostic.tsx",
    "onClick={runDiagnostic}",
  ],
  ["ResetButton", "components/ui/ResetButton.tsx", "aria-label={ariaLabel}"],
  ["TextLink", "components/ui/TextLink.tsx", "type={type}"],
  ["InfoTooltip", "components/ui/InfoTooltip.tsx", "cursor-help text-ink-3"],
  ["TextDisplay Copy", "components/ui/TextDisplay.tsx", "onClick={handleCopy}"],
  ["AudioPlayer Play", "components/ui/AudioPlayer.tsx", "onClick={togglePlay}"],
  [
    "UpdateChecker Close",
    "components/update-checker/UpdateChecker.tsx",
    "setShowPortableUpdateDialog(false)}",
  ],
  [
    "UpdateChecker Download",
    "components/update-checker/UpdateChecker.tsx",
    "bg-logo-primary text-white",
  ],
  ["Onboarding preview exit", "App.tsx", "setOnboardingPreview(null)}"],
  [
    "Vocabulary scope checkbox",
    "components/settings/tts/vocabulary/EntryDialog.tsx",
    "accent-logo-primary",
  ],
];

/** Search fields whose input keeps `outline-none` because the wrapper that looks like the field shows the ring; [name, file under src, a unique piece of the wrapper tag, a unique piece of the input tag]. */
const WRAPPED_INPUTS: ReadonlyArray<readonly [string, string, string, string]> =
  [
    [
      "PreferredLanguages search",
      "components/settings/PreferredLanguages.tsx",
      "border-b border-line px-3 text-ink-3",
      "h-9 w-full min-w-0 bg-transparent",
    ],
    [
      "LanguagePicker search",
      "components/shared/LanguagePicker.tsx",
      "flex min-h-[46px] cursor-text",
      "h-[30px] flex-1 border-0",
    ],
    [
      "ManagerTable search",
      "components/shared/modelTable/ManagerTable.tsx",
      "cursor-text items-center gap-[8px] rounded-control",
      'type="search"',
    ],
  ];

/** JSX attributes and props whose value is read or announced to the user. */
const TEXT_PROP =
  /^(aria-(label|description|valuetext|roledescription|placeholder)|title|placeholder|alt|label|\w+(Label|Title|Placeholder))$/;
/** Default props named like text. */
const TEXT_NAME = /(label|title|placeholder|text|message|caption|hint)$/i;
/** Literals allowed where TEXT_PROP or TEXT_NAME applies; [file under src, literal, reason]. Empty: none are needed. */
const LITERAL_ALLOW: ReadonlyArray<readonly [string, string, string]> = [];

const EQUALITY = [
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
];

/** True when `node` is compared, used as an index key or names a property, so it is never shown. */
function notShown(node: ts.Node): boolean {
  const p = node.parent;
  return (
    (ts.isBinaryExpression(p) && EQUALITY.includes(p.operatorToken.kind)) ||
    (ts.isElementAccessExpression(p) && p.argumentExpression === node) ||
    (ts.isPropertyAccessExpression(p) && p.name === node)
  );
}

/** Calls `visit` on every node under `node` outside translation calls. */
function untranslated(node: ts.Node, visit: (n: ts.Node) => void) {
  if (
    ts.isCallExpression(node) &&
    /^(t|i18n\.t|i18next\.t)$/.test(node.expression.getText())
  ) {
    return;
  }
  visit(node);
  ts.forEachChild(node, (c) => untranslated(c, visit));
}

/** Hard-coded text in text attributes, and string defaults of props named like text or rendered in JSX, as `file:line: "literal"`. */
function hardCodedText(file: string, source: string): string[] {
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const found: string[] = [];
  const report = (node: ts.Node, text: string) => {
    if (!/\p{L}/u.test(text)) return;
    if (LITERAL_ALLOW.some(([f, l]) => f === file && l === text)) return;
    const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    found.push(`${file}:${line}: ${JSON.stringify(text)}`);
  };
  const isTextAttribute = (n: ts.Node): n is ts.JsxAttribute =>
    ts.isJsxAttribute(n) && TEXT_PROP.test(n.name.getText()) && !!n.initializer;
  const rendered = new Set<string>();
  const collect = (node: ts.Node) => {
    const shownExpression =
      (ts.isJsxExpression(node) &&
        (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) ||
      isTextAttribute(node);
    if (shownExpression) {
      untranslated(node, (n) => {
        if (ts.isIdentifier(n) && !notShown(n)) rendered.add(n.text);
      });
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);
  const visit = (node: ts.Node) => {
    if (isTextAttribute(node)) {
      untranslated(node.initializer!, (n) => {
        if (
          (ts.isStringLiteral(n) ||
            ts.isNoSubstitutionTemplateLiteral(n) ||
            ts.isTemplateLiteralToken(n)) &&
          !notShown(n)
        ) {
          report(n, n.text);
        }
      });
    }
    if (
      (ts.isBindingElement(node) || ts.isParameter(node)) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isStringLiteral(node.initializer) ||
        ts.isNoSubstitutionTemplateLiteral(node.initializer)) &&
      (TEXT_NAME.test(node.name.text) || rendered.has(node.name.text))
    ) {
      report(node.initializer, node.initializer.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Every non-test .tsx file under `dir` (relative to src), recursively. */
function tsxFiles(dir: string): string[] {
  return readdirSync(new URL(dir, SOURCE_ROOT), { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? tsxFiles(`${dir}${e.name}/`)
        : e.name.endsWith(".tsx") && !e.name.includes(".test.")
          ? [`${dir}${e.name}`]
          : [],
    )
    .sort();
}

async function instance(lng: "en" | "ar" | "de") {
  const i18n = i18next.createInstance();
  await i18n.init({
    lng,
    resources: {
      en: { translation: en },
      ar: { translation: ar },
      de: { translation: de },
    },
  });
  return i18n;
}

function slider(i18n: Awaited<ReturnType<typeof instance>>): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <Slider
        value={0.25}
        min={0}
        max={1}
        onChange={() => {}}
        label="Volume"
        description="How loud"
      />
    </I18nextProvider>,
  );
}

describe("upstream ui controls", () => {
  it("every_button_variant_shows_a_focus_ring", () => {
    for (const variant of VARIANTS) {
      const html = renderToStaticMarkup(
        <Button variant={variant}>{variant}</Button>,
      );
      const classes = /<button[^>]*class="([^"]*)"/.exec(html)?.[1] ?? "";
      const list = classes.split(/\s+/);
      assert.ok(list.includes("focus-visible:ring-2"), variant);
      assert.ok(list.includes("focus-visible:ring-logo-primary"), variant);
      assert.ok(!list.some((c) => c.startsWith("focus:ring")), variant);
    }
  });

  it("dropdown_trigger_and_options_replace_the_outline", async () => {
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={await instance("en")}>
        <Dropdown
          options={[{ value: "a", label: "A" }]}
          selectedValue="a"
          onSelect={() => {}}
        />
      </I18nextProvider>,
    );
    const trigger = /<button[^>]*aria-expanded="false"[^>]*>/.exec(html)?.[0];
    assert.ok(trigger, html);
    const classes = (/class="([^"]*)"/.exec(trigger)?.[1] ?? "").split(/\s+/);
    assert.ok(classes.includes("focus:outline-none"));
    assert.ok(classes.includes("focus-visible:ring-2"));
    assert.ok(classes.includes("focus-visible:ring-logo-primary"));
    const option = openingTag(
      "components/ui/Dropdown.tsx",
      "key={option.value}",
    );
    assert.ok(option.includes("focus:outline-none"));
    assert.ok(option.includes("focus-visible:ring-2"));
    assert.ok(option.includes("focus-visible:ring-logo-primary"));
  });

  it("shortcut_clear_has_a_ring", () => {
    const clear = openingTag(
      "components/settings/ShortcutInput.tsx",
      "disabled={clearState.disabled}",
    );
    assert.ok(clear.includes("focus:outline-none"));
    assert.ok(clear.includes("focus-visible:ring-2"));
    assert.ok(clear.includes("focus-visible:ring-logo-primary"));
  });

  it("plain_controls_replace_the_native_outline_with_the_ring", () => {
    for (const [name, file, anchor] of PLAIN_CONTROLS) {
      assertRingInsteadOfOutline(name, openingTag(file, anchor));
    }
  });

  it("search_fields_show_the_ring_on_the_input_or_the_field_wrapper", () => {
    for (const [name, file, wrapper, input] of WRAPPED_INPUTS) {
      const wrapperTag = openingTag(file, wrapper);
      assert.ok(
        wrapperTag.includes("focus-within:ring-2"),
        `${name}: wrapper ring-2`,
      );
      assert.ok(
        wrapperTag.includes("focus-within:ring-logo-primary"),
        `${name}: wrapper ring colour`,
      );
      assert.ok(
        openingTag(file, input).includes("outline-none"),
        `${name}: input`,
      );
    }
  });

  it("try_note_window_shows_the_ring_while_the_note_has_focus", () => {
    const css = readFileSync(
      new URL("components/onboarding/screens/tryit.css", SOURCE_ROOT),
      "utf8",
    );
    const rule = /\.try-notes:focus-within\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    assert.ok(/0 0 0 2px var\(--color-logo-primary\)/.test(rule), rule);
    assert.ok(/\.try-note-page\s*\{[^}]*outline:\s*none/.test(css));
  });

  it("help_play_and_copy_buttons_are_named_in_the_ui_language", async () => {
    const i18n = await instance("de");
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <InfoTooltip text="x" />
        <AudioPlayer src="clip.wav" />
        <TextDisplay label="Path" description="d" value="v" copyable />
        <TextDisplay label="Path" description="d" value="" />
      </I18nextProvider>,
    );
    const name = (tag: RegExp) => tag.exec(html)?.[1];
    assert.equal(
      name(/<button[^>]*aria-label="([^"]*)"[^>]*cursor-help/),
      "Weitere Informationen",
    );
    assert.equal(
      name(
        /<button[^>]*text-text hover:text-logo-primary[^>]*aria-label="([^"]*)"/,
      ),
      "Wiedergabe",
    );
    assert.equal(
      name(/<button[^>]*title="([^"]*)"/),
      "In die Zwischenablage kopieren",
    );
    assert.ok(html.includes("Nicht verfügbar"), html);
    for (const english of [
      "More information",
      'label="Play"',
      "Copy to clipboard",
      "Not available",
    ]) {
      assert.ok(!html.includes(english), english);
    }
    const audio = readFileSync(
      new URL("components/ui/AudioPlayer.tsx", SOURCE_ROOT),
      "utf8",
    );
    assert.ok(
      audio.includes('isPlaying ? t("common.pause") : t("common.play")'),
    );
    assert.equal(de.common.pause, "Pause");
  });

  it("dropdown_placeholder_follows_the_ui_language", async () => {
    const shown = async (lng: "en" | "de", placeholder?: string) => {
      const html = renderToStaticMarkup(
        <I18nextProvider i18n={await instance(lng)}>
          <Dropdown
            options={[{ value: "a", label: "A" }]}
            selectedValue=""
            onSelect={() => {}}
            placeholder={placeholder}
          />
        </I18nextProvider>,
      );
      return /<span class="truncate">([^<]*)<\/span>/.exec(html)?.[1];
    };
    assert.equal(await shown("de"), "Option auswählen...");
    assert.equal(await shown("en"), "Select an option...");
    assert.equal(await shown("de", "Mikrofon"), "Mikrofon");
  });

  it("shared_controls_carry_no_hard_coded_text", () => {
    const sample = [
      'const A = ({ hint = "Pick one", size = "sm", note = "Later" }) => (',
      '  <b title="Hi" aria-label={on ? t("a.b") : "Off"} placeholder={`${n}%`} data-x={size === "sm" ? 1 : 2}>{note}</b>',
      ");",
    ].join("\n");
    assert.deepEqual(hardCodedText("x.tsx", sample), [
      'x.tsx:1: "Pick one"',
      'x.tsx:1: "Later"',
      'x.tsx:2: "Hi"',
      'x.tsx:2: "Off"',
    ]);
    const files = [
      ...tsxFiles("components/ui/"),
      ...tsxFiles("components/shared/"),
    ];
    assert.ok(files.includes("components/ui/Dropdown.tsx"), files.join());
    assert.ok(files.includes("components/shared/modelTable/ManagerRow.tsx"));
    const found = files.flatMap((f) =>
      hardCodedText(f, readFileSync(new URL(f, SOURCE_ROOT), "utf8")),
    );
    assert.deepEqual(found, []);
  });

  it("range_fill_follows_direction", async () => {
    assert.equal(fillTowards("rtl"), "left");
    assert.equal(fillTowards("ltr"), "right");
    assert.ok(
      slider(await instance("en")).includes("linear-gradient(to right"),
    );
    assert.ok(slider(await instance("ar")).includes("linear-gradient(to left"));
    const audio = readFileSync(
      new URL("./AudioPlayer.tsx", import.meta.url),
      "utf8",
    );
    assert.ok(!audio.includes("linear-gradient(to right"));
    assert.ok(audio.includes("fillTowards("));
  });

  it("audio_end_nudge_points_toward_the_end_in_both_directions", () => {
    const rtl = endNudgeClass("rtl").split(/\s+/);
    const ltr = endNudgeClass("ltr").split(/\s+/);
    assert.deepEqual(rtl, [
      "[&::-webkit-slider-thumb]:-translate-x-0.5",
      "[&::-moz-range-thumb]:-translate-x-0.5",
    ]);
    assert.deepEqual(ltr, [
      "[&::-webkit-slider-thumb]:translate-x-0.5",
      "[&::-moz-range-thumb]:translate-x-0.5",
    ]);
    const audio = readFileSync(
      new URL("./AudioPlayer.tsx", import.meta.url),
      "utf8",
    );
    assert.ok(
      audio.includes('progressPercent >= 99.5 ? endNudgeClass(direction) : ""'),
    );
  });

  it("range_inputs_show_the_keyboard_focus_ring", async () => {
    const i18n = await instance("en");
    const inputs = [
      ["Slider", slider(i18n)],
      [
        "AudioPlayer",
        renderToStaticMarkup(
          <I18nextProvider i18n={i18n}>
            <AudioPlayer src="clip.wav" />
          </I18nextProvider>,
        ),
      ],
    ];
    for (const [name, html] of inputs) {
      const tag = /<input[^>]*type="range"[^>]*>/.exec(html)?.[0] ?? "";
      const classes = (/class="([^"]*)"/.exec(tag)?.[1] ?? "").split(/\s+/);
      assert.ok(classes.includes("focus-visible:ring-2"), name);
      assert.ok(classes.includes("focus-visible:ring-logo-primary"), name);
      assert.ok(!classes.some((c) => c.startsWith("focus:ring")), name);
    }
  });

  it("paths_render_left_to_right", async () => {
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={await instance("en")}>
        <PathDisplay path="/home/u/.local/share/x" onOpen={() => {}} />
      </I18nextProvider>,
    );
    assert.ok(
      /<div[^>]*dir="ltr"[^>]*>\/home\/u\/\.local\/share\/x<\/div>/.test(html),
      html,
    );
    const vocabulary = readFileSync(
      new URL("../settings/tts/vocabulary/VocabularyView.tsx", import.meta.url),
      "utf8",
    );
    assert.ok(/<p dir="ltr"[^>]*>\s*\{table\.path\}\s*<\/p>/.test(vocabulary));
  });

  it("sound_preview_title_is_a_translated_key", async () => {
    const source = readFileSync(
      new URL("../settings/SoundPicker.tsx", import.meta.url),
      "utf8",
    );
    const tag = /<Button\b[^>]*onClick=\{handlePlayBothSounds\}[^>]*>/.exec(
      source,
    )?.[0];
    assert.ok(tag, "SoundPicker preview button");
    assert.ok(
      tag.includes('title={t("settings.sound.previewTheme")}'),
      `SoundPicker preview button title: ${tag}`,
    );
    assert.ok(!tag.includes("Preview sound theme"), tag);
    const german = await instance("de");
    const title = german.t("settings.sound.previewTheme");
    assert.ok(title !== "settings.sound.previewTheme", "key exists in de");
    assert.ok(title !== en.settings.sound.previewTheme, title);
    assert.ok(!/Preview/i.test(title), title);
  });
});
