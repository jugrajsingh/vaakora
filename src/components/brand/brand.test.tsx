import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { appName, brand, i18nInterpolation } from "@/lib/brand";
import en from "../../i18n/locales/en/translation.json";
import wordmark from "../../../brand/generated/wordmark-latin.json";
import { BrandLockup } from "./BrandLockup";
import { BrandMark } from "./BrandMark";
import { TrayGlyph } from "./TrayGlyph";
import { LinuxGuide } from "../onboarding/LinuxGuide";
import { SecureInputHelp } from "../SecureInputWarning";

const {
  describe,
  it,
}: {
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => void) => void;
} = createRequire(import.meta.url)("bun:test");

const i18n = i18next.createInstance();
await i18n.init({
  lng: "en",
  resources: { en: { translation: en } },
  interpolation: i18nInterpolation,
});

const render = (node: React.ReactElement) =>
  renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("BrandLockup", () => {
  it("lockup_names_vaakora", () => {
    const html = render(<BrandLockup size={26} />);
    assert.equal(appName, "Vaakora");
    // The root element carries the accessible name: the mark inside it is
    // aria-hidden and its own label must not satisfy this.
    const root = /^<[a-z]+\b([^>]*)>/.exec(html)?.[1] ?? "";
    assert.ok(root.includes('role="img"'), `root is an image: ${root}`);
    assert.ok(root.includes('aria-label="Vaakora"'), `root is named: ${root}`);
    // The 26 px lockup uses the 16 master (rects only), so every <path is a glyph.
    assert.equal(count(html, "<path"), wordmark.paths.length);
    assert.ok(/class="[^"]*text-wordmark/.test(html), "word colour class");
    assert.ok(html.includes('fill="currentColor"'));
    assert.ok(count(html, 'aria-hidden="true"') >= 2, "mark and word hidden");
  });

  it("sizes the word from the svg viewBox, cap height 0.537 of the mark", () => {
    const [x, y, w, h] = wordmark.viewBox.split(" ").map(Number);
    assert.equal(x, 0);
    assert.ok(y < 0, "the Latin viewBox starts above the baseline");
    const size = 40;
    const html = render(<BrandLockup size={size} />);
    const scale = (size * 0.537) / wordmark.cap;
    assert.ok(
      html.includes(`viewBox="${wordmark.viewBox}"`),
      "viewBox is read",
    );
    assert.ok(html.includes(`width="${(w * scale).toFixed(2)}"`), "word width");
    assert.ok(
      html.includes(`height="${(h * scale).toFixed(2)}"`),
      "word height",
    );
    assert.ok(
      html.includes(`gap:${size / 4}px`),
      "gap is a quarter of the mark",
    );
  });
});

describe("BrandMark", () => {
  it("mark_picks_the_master_by_size", () => {
    const rects = [
      'x="10" y="2" width="2" height="12"',
      'x="8" y="2" width="6" height="2"',
      'x="8" y="12" width="6" height="2"',
      'x="2" y="6" width="2" height="4"',
      'x="5" y="3" width="2" height="10"',
    ];
    for (const size of [16, 32]) {
      const html = render(<BrandMark size={size} />);
      assert.ok(html.includes('viewBox="0 0 16 16"'), `${size}: 16 master`);
      assert.ok(html.includes(`width="${size}"`), `${size}: width`);
      for (const rect of rects)
        assert.ok(html.includes(rect), `${size}: ${rect}`);
    }
    assert.ok(render(<BrandMark size={22} />).includes('viewBox="0 0 22 22"'));
    assert.ok(render(<BrandMark size={24} />).includes('viewBox="0 0 24 24"'));
    const large = render(<BrandMark size={64} />);
    assert.ok(large.includes('viewBox="0 0 1024 1024"'));
    assert.ok(large.includes("<path"));
  });

  it("takes its colours from brand.json and keylines with a token", () => {
    for (const size of [16, 64]) {
      const html = render(<BrandMark size={size} className="x" />);
      for (const c of [brand.mark.tile, brand.mark.bars, brand.mark.cursor]) {
        assert.ok(html.includes(c), `${size}: ${c}`);
      }
      assert.ok(html.includes("var(--color-mark-keyline"), `${size}: token`);
      assert.ok(!html.includes(brand.mark.keyline), `${size}: no literal`);
      assert.ok(html.includes('role="img"'));
      assert.ok(html.includes('aria-label="Vaakora"'));
      assert.ok(html.includes('class="x"'));
    }
  });
});

describe("TrayGlyph", () => {
  // brand/tray/tray-16.svg: two bars, then the cursor (stem and caps).
  const bars = [
    'x="1" y="6" width="2" height="4"',
    'x="4" y="3" width="2" height="10"',
  ];
  const cursor = [
    'x="10" y="1" width="2" height="14"',
    'x="8" y="1" width="6" height="2"',
    'x="8" y="13" width="6" height="2"',
  ];

  it("draws the tray master's one silhouette in every state", () => {
    for (const state of ["idle", "recording", "transcribing"] as const) {
      const html = render(<TrayGlyph state={state} size={19} />);
      assert.ok(html.includes('viewBox="0 0 16 16"'), `${state}: 16 master`);
      assert.ok(html.includes('width="19"'), `${state}: width`);
      assert.ok(html.includes('aria-hidden="true"'), `${state}: decorative`);
      for (const rect of [...bars, ...cursor])
        assert.ok(html.includes(rect), `${state}: ${rect}`);
      assert.equal(count(html, "<path"), 0, `${state}: no traced outline`);
    }
  });

  it("tints only the cursor while recording, as the tray rasters do", () => {
    const idle = render(<TrayGlyph state="idle" size={16} />);
    const transcribing = render(<TrayGlyph state="transcribing" size={16} />);
    const recording = render(<TrayGlyph state="recording" size={16} />);
    assert.equal(transcribing, idle, "Transcribing keeps the idle glyph");
    assert.equal(count(idle, 'fill="currentColor"'), 2, "bars and cursor");
    assert.equal(count(recording, 'fill="currentColor"'), 1, "bars only");
    assert.equal(count(recording, "fill:var(--color-logo-primary)"), 1);
    assert.ok(!idle.includes("--color-logo-primary"));
    const tinted = recording.indexOf("fill:var(--color-logo-primary)");
    assert.ok(tinted > recording.indexOf(bars[1]), "the bars stay untinted");
    assert.ok(tinted < recording.indexOf(cursor[0]), "the cursor is tinted");
  });

  it("no component draws the old tray rasters or the traced hand", () => {
    const src = fileURLToPath(new URL("../../", import.meta.url));
    assert.ok(!existsSync(join(src, "components/icons/TrayIcon.tsx")));
    const old =
      /icons\/TrayIcon|tray_(idle|recording|transcribing)|handy(_warning)?\.png|resources\/(recording|transcribing)\.png|traced from src-tauri/;
    const self = fileURLToPath(import.meta.url);
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(tsx?|css)$/.test(entry.name) && path !== self) {
          const text = readFileSync(path, "utf8");
          if (old.test(text)) hits.push(path.slice(src.length));
        }
      }
    };
    walk(src);
    assert.deepEqual(hits, []);
  });
});

describe("documentation links", () => {
  it("render only when the brand has a docs site", () => {
    assert.equal(brand.links.docs, null, "brand.json has no docs site yet");
    assert.equal(render(<SecureInputHelp url={null} />), "");
    const help = render(<SecureInputHelp url="https://docs.example.test" />);
    assert.ok(help.includes("<button"));
    assert.ok(help.includes("focus:outline-none"));
    assert.ok(help.includes("focus-visible:ring-2"));
    assert.ok(help.includes("focus-visible:ring-logo-primary"));
  });

  it("LinuxGuide keeps its sentence without a link", () => {
    const view = (docsUrl: string | null) =>
      render(<LinuxGuide i18nKey="onboarding.linux.tryIt" docsUrl={docsUrl} />);
    const sentence = en.onboarding.linux.tryIt.replace(/<\/?guide>/g, "");
    const without = view(null);
    assert.ok(!without.includes("<button"), "no link without docs");
    assert.ok(
      without.replace(/<[^>]*>/g, "").includes(sentence.slice(0, 20)),
      "the sentence stays",
    );
    const withLink = view("https://docs.example.test");
    assert.ok(withLink.includes("<button"));
    assert.ok(
      withLink.includes("focus-visible:ring-2 focus-visible:ring-logo-primary"),
    );
  });
});
