import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import i18next from "i18next";
import {
  canClearShortcut,
  clearButtonState,
  clearShortcut,
  generalShortcutRows,
  shortcutErrorText,
  shortcutNameKey,
} from "./shortcutPresentation";

// settings.cleanup.enable.description in every non-English locale at cfce1b85.
const CFCE1B85_CLEANUP_DESCRIPTION: Record<string, string> = {
  ar: "يضيف «اختصار المعالجة اللاحقة». يتم تنظيف النص الذي تمليه به قبل لصقه.",
  bg: "Добавя „Бърз клавиш за постобработка“. Текстът, продиктуван с него, се изчиства, преди да бъде поставен.",
  ca: "Afegeix la «Drecera de postprocessament». El text dictat amb ella es neteja abans d'enganxar-lo.",
  cs: "Přidá zkratku „Zkratka následného zpracování“. Text nadiktovaný pomocí ní se před vložením upraví.",
  da: "Tilføjer „Genvej til efterbehandling“. Tekst, der dikteres med den, ryddes op, før den indsættes.",
  de: "Fügt das „Nachbearbeitungs-Tastenkürzel“ hinzu. Damit diktierter Text wird vor dem Einfügen bereinigt.",
  es: "Añade el «Atajo de post proceso». El texto dictado con él se limpia antes de pegarse.",
  fr: "Ajoute le « Raccourci de post-traitement ». Le texte dicté avec lui est nettoyé avant d'être collé.",
  he: 'מוסיף את "קיצור מקשים לעיבוד משלים". טקסט שמוכתב בעזרתו מנוקה לפני ההדבקה.',
  hi: '"पोस्ट प्रोसेस शॉर्टकट" जोड़ता है। इससे बोले गए टेक्स्ट को पेस्ट करने से पहले साफ़ किया जाता है।',
  id: 'Menambahkan "Pintasan Pascaproses". Teks yang didikte dengannya dirapikan sebelum ditempel.',
  it: "Aggiunge la «Scorciatoia Post-Elaborazione». Il testo dettato con essa viene ripulito prima di essere incollato.",
  ja: "「後処理のショートカット」を追加します。これで音声入力したテキストは、貼り付ける前に整形されます。",
  ko: "'후처리 단축키'를 추가합니다. 이 단축키로 받아쓴 텍스트는 붙여넣기 전에 정리됩니다.",
  ne: '"पोस्ट प्रोसेस सर्टकट" थप्छ। यसबाट बोलेर लेखिएको पाठ टाँस्नु अघि सफा गरिन्छ।',
  nl: 'Voegt de "Sneltoets voor naverwerking" toe. Tekst die ermee is gedicteerd, wordt opgeschoond voordat deze wordt geplakt.',
  pl: "Dodaje „Skrót postprocesu”. Tekst podyktowany za jego pomocą jest porządkowany przed wklejeniem.",
  pt: "Adiciona o «Atalho de Pós-Processamento». O texto ditado com ele é limpo antes de ser colado.",
  ru: "Добавляет «Горячая клавиша постобработки». Текст, надиктованный с ее помощью, очищается перед вставкой.",
  sv: "Lägger till ”Kortkommando för efterbearbetning”. Text som dikteras med det rensas upp innan den klistras in.",
  tr: '"Son İşlem Kısayolu" kısayolunu ekler. Bununla dikte edilen metin yapıştırılmadan önce temizlenir.',
  uk: "Додає «Гаряча клавіша постобробки». Текст, надиктований з її допомогою, очищається перед вставленням.",
  vi: 'Thêm "Phím tắt xử lý sau". Văn bản đọc chính tả bằng phím này được làm sạch trước khi dán.',
  zh: "添加“后处理快捷键”。用它听写的文字会在粘贴前先清理。",
  "zh-TW": "新增「後處理快捷鍵」。用它聽寫的文字會在貼上前先清理。",
};

assert.deepEqual(generalShortcutRows(false, false), [
  "transcribe",
  "activation",
  "cancel",
  "read_aloud",
]);
assert.deepEqual(generalShortcutRows(true, false), [
  "transcribe",
  "transcribe_with_post_process",
  "activation",
  "cancel",
  "read_aloud",
]);
assert.deepEqual(generalShortcutRows(true, true), [
  "transcribe",
  "transcribe_with_post_process",
  "activation",
  "cancelHelp",
  "read_aloud",
]);
assert.deepEqual(generalShortcutRows(false, true), [
  "transcribe",
  "activation",
  "cancelHelp",
  "read_aloud",
]);
for (const cleanup of [false, true]) {
  assert.equal(generalShortcutRows(cleanup, true).includes("cancel"), false);
  assert.equal(
    generalShortcutRows(cleanup, false).includes("cancelHelp"),
    false,
  );
}

// clear_rules_per_binding
for (const enabled of [false, true]) {
  assert.equal(canClearShortcut("read_aloud", enabled), true);
  assert.equal(canClearShortcut("cancel", enabled), false);
  assert.equal(canClearShortcut("transcribe", enabled), enabled);
  assert.equal(
    canClearShortcut("transcribe_with_post_process", enabled),
    enabled,
  );
}
assert.equal(canClearShortcut("unknown", true), false);
for (const id of ["transcribe", "transcribe_with_post_process", "cancel"]) {
  for (const enabled of [false, true]) {
    for (const isRecording of [false, true]) {
      for (const isUpdating of [false, true]) {
        for (const disabled of [false, true]) {
          assert.deepEqual(
            clearButtonState({
              enabled,
              id,
              isRecording,
              isUpdating,
              disabled,
              bound: true,
            }),
            {
              visible: enabled && id !== "cancel",
              disabled: disabled || isRecording || isUpdating,
            },
          );
        }
      }
    }
  }
}
// clear_shows_only_for_a_bound_shortcut
const shown = (id: string, enabled: boolean, bound: boolean) =>
  clearButtonState({
    id,
    enabled,
    bound,
    isRecording: false,
    isUpdating: false,
    disabled: false,
  }).visible;
assert.equal(shown("read_aloud", true, false), false);
assert.equal(shown("read_aloud", true, true), true);
assert.equal(shown("read_aloud", false, false), false);
assert.equal(shown("transcribe", true, false), false);
assert.equal(shown("transcribe", true, true), true);
assert.equal(shown("transcribe", false, true), false);
assert.equal(shown("transcribe_with_post_process", false, true), false);
assert.equal(shown("cancel", true, true), false);
// clear_moves_focus_to_reset_only_when_cleared
{
  const events: string[] = [];
  await clearShortcut({
    clear: async () => {
      events.push("clear");
    },
    onCleared: () => events.push("cleared"),
    onError: () => events.push("error"),
  });
  assert.deepEqual(events, ["clear", "cleared"]);
  const refused: unknown[] = [];
  await clearShortcut({
    clear: async () => {
      throw new Error("shortcut.cannot_clear:transcribe");
    },
    onCleared: () => events.push("wrongly cleared"),
    onError: (error) => refused.push(String(error)),
  });
  assert.deepEqual(events, ["clear", "cleared"]);
  assert.deepEqual(refused, ["Error: shortcut.cannot_clear:transcribe"]);
}
{
  const input = readFileSync(
    new URL("../../components/settings/ShortcutInput.tsx", import.meta.url),
    "utf8",
  );
  assert.ok(input.includes("bound: Boolean(binding.current_binding),"));
  assert.ok(input.includes("onCleared: () => setCleared(true),"));
  assert.ok(input.includes("ref={resetRef}"));
  assert.ok(input.includes("resetRef.current?.focus();"));
  const reset = readFileSync(
    new URL("../../components/ui/ResetButton.tsx", import.meta.url),
    "utf8",
  );
  assert.ok(reset.includes("ref={ref}"), "Reset takes the focus Clear leaves");
}
const { default: en } = await import("../../i18n/locales/en/translation.json");
await i18next.init({
  lng: "en",
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
});
assert.equal(i18next.t(shortcutNameKey("transcribe")), "Dictate");
assert.equal(
  i18next.t(shortcutNameKey("transcribe_with_post_process")),
  "Dictate with cleanup",
);
assert.equal(i18next.t(shortcutNameKey("cancel")), "Cancel");
assert.equal(i18next.t(shortcutNameKey("read_aloud")), "Read aloud");
assert.equal(
  shortcutNameKey("other"),
  "settings.general.shortcut.bindings.other.name",
);
// refusals_name_the_shortcut: the refusal reaches the UI as String(new Error(text)).
const t = i18next.t.bind(i18next);
const refused = (text: string) => shortcutErrorText(String(new Error(text)), t);
assert.equal(
  refused(
    "Shortcut is already assigned to 'Raw' (shortcut.in_use:transcribe_with_post_process)",
  ),
  "Already used by Dictate with cleanup",
);
assert.equal(
  refused(
    "Shortcut is already assigned to 'Read' (shortcut.in_use:read_aloud)",
  ),
  "Already used by Read aloud",
);
assert.equal(
  refused("Shortcut is already assigned to 'X' (shortcut.in_use:custom_id)"),
  "Already used by custom_id",
);
assert.equal(
  refused(
    "The 'cancel' shortcut cannot be cleared (shortcut.cannot_clear:cancel)",
  ),
  `${en.settings.shortcuts.cancel} cannot be cleared`,
);
assert.equal(refused("boom"), "Error: boom");
assert.equal(shortcutErrorText("boom", t), "boom");
assert.equal(
  shortcutErrorText("shortcut.in_use:cancel", t),
  "Already used by Cancel",
);
const policySource = readFileSync(
  new URL("../../../src-tauri/src/shortcut/policy.rs", import.meta.url),
  "utf8",
);
assert.ok(policySource.includes("(shortcut.in_use:{other_id})"));
assert.ok(policySource.includes("(shortcut.cannot_clear:{id})"));
// Every place a shortcut refusal is shown maps it first.
for (const [file, calls] of [
  ["../../hooks/useShortcutCapture.ts", 2],
  ["../../components/settings/ShortcutInput.tsx", 1],
  ["../../stores/settingsStore.ts", 2],
] as const) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  assert.equal(source.split("shortcutErrorText(").length - 1, calls, file);
}
const newDescription =
  "Adds the Dictate with cleanup shortcut. Text dictated with it is cleaned up before it is pasted.";
assert.equal(en.settings.cleanup.enable.description, newDescription);
const localesDir = new URL("../../i18n/locales/", import.meta.url);
const others = readdirSync(localesDir).filter((dir) => dir !== "en");
assert.equal(others.length, 25);
for (const dir of others) {
  const { default: locale } = await import(
    `../../i18n/locales/${dir}/translation.json`
  );
  const text = locale.settings.cleanup.enable.description;
  assert.equal(typeof text, "string", dir);
  assert.notEqual(text, "", dir);
  assert.notEqual(text, CFCE1B85_CLEANUP_DESCRIPTION[dir], dir);
  const help = locale.settings.shortcuts.cancelLinuxHelp;
  assert.equal(typeof help, "string", dir);
  assert.notEqual(help, en.settings.shortcuts.cancelLinuxHelp, dir);
  assert.ok(help.includes("handy --cancel"), `${dir} names the command`);
}
assert.equal(
  en.settings.shortcuts.cancelLinuxHelp,
  "On Linux the cancel shortcut does not stop a dictation, because shortcuts registered during a dictation are unreliable there. Use the X on the overlay, Cancel in the tray menu, or run handy --cancel.",
);
assert.deepEqual(
  Object.keys(CFCE1B85_CLEANUP_DESCRIPTION).sort(),
  others.slice().sort(),
);
console.log("shortcutPresentation: all assertions passed");
