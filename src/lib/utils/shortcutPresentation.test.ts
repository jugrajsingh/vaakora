import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import i18next from "i18next";
import {
  canClearShortcut,
  clearButtonState,
  generalShortcutRows,
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
assert.equal(generalShortcutRows(true, true).includes("cancel"), false);
assert.equal(generalShortcutRows(false, true).includes("cancel"), false);

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
}
assert.deepEqual(
  Object.keys(CFCE1B85_CLEANUP_DESCRIPTION).sort(),
  others.slice().sort(),
);
console.log("shortcutPresentation: all assertions passed");
